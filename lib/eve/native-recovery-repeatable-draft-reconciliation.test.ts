import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { approvalReceiptForExistingDraftUpdate } from "../agent/approval-receipt";
import {
  createGitHubInstallationIdentity,
  createRepositoryObservation,
} from "../repository/github-publication";
import type { ImmutableGitHubSourceReceipt } from "../repository/github-publication";
import type { ExistingDraftReconciliationProposal } from "../repository/github-draft-reconciliation";
import { createReconciliationReviewReceipt } from "../repository/github-draft-reconciliation";
import { authorizeRepeatableDraftReconciliationCalls } from "./native-recovery-repeatable-draft-reconciliation";

type FixtureDigestMaterial =
  | readonly unknown[]
  | Omit<ImmutableGitHubSourceReceipt, "digest">
  | Omit<ExistingDraftReconciliationProposal, "digest">
  | Omit<ExistingDraftReconciliationProposal, "digest" | "idempotencyKey">;
const hash = (value: FixtureDigestMaterial) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const digest = "a".repeat(64);
const sourceDigest = "b".repeat(64);
const originReviewDigest = "c".repeat(64);
const fixture = () => {
  const sourceInstallation = createGitHubInstallationIdentity({
    accountId: "103",
    accountLogin: "fixture-owner",
    accountType: "Organization",
    installationId: "102",
    operation: "resolve-existing-source",
    repositorySelection: "selected",
    selectedRepositoryIds: ["101"],
  });
  const publicationInstallation = createGitHubInstallationIdentity({
    ...sourceInstallation,
    operation: "publish-draft-pull-request",
  });
  const repository = createRepositoryObservation({
    defaultBranch: "main",
    headSha: "1".repeat(40),
    headTree: "2".repeat(40),
    installationIdentityDigest: sourceInstallation.digest,
    name: "fixture",
    owner: "fixture-owner",
    releaseGate: { configured: false, name: "REPOSITORY_RELEASE_ENABLED" },
    repositoryId: "101",
    visibility: "private",
  });
  const unsignedSource = {
    installationIdentityDigest: sourceInstallation.digest,
    repository,
    resolvedByCallId: "source-read",
    resolvedRef: "refs/heads/app-builder/fixture",
    resolvedSha: repository.headSha,
    resolvedTree: repository.headTree,
    version: 2 as const,
  };
  const source = { ...unsignedSource, digest: hash(unsignedSource) };
  const compilation = {
    context: {
      authority: {
        issuer: "https://builder.example/api/auth",
        audience: "https://builder.example/mcp",
        workspaceId: "workspace",
        ownerUserId: "owner",
      },
      target: { appId: "fixture-app", sessionId: "original-public-session" },
    },
    release: { status: "not-required" as const },
  };
  const validation = {
    resolvedTree: "3".repeat(40),
    commands: [{ command: "mise app:check", exitCode: 0 }],
    validatedByCallId: "validate",
    compilation,
  };
  const review = createReconciliationReviewReceipt({
    version: 1,
    appId: "fixture-app",
    headSha: repository.headSha,
    headTree: repository.headTree,
    baseSha: "4".repeat(40),
    baseTree: "5".repeat(40),
    resolvedTree: validation.resolvedTree,
    baseChanges: [
      { kind: "added", path: "apps/fixture-app/example.ts", after: { mode: "644", digest } },
    ],
    headChanges: [
      { kind: "added", path: "apps/fixture-app/example.ts", after: { mode: "644", digest } },
    ],
  });
  const unsignedProposal = {
    approvedPaths: review.approvedPaths,
    baseBranch: "main",
    baseChangesDigest: hash(review.baseChanges),
    branchName: "app-builder/fixture",
    expectedBaseSha: review.baseSha,
    expectedBaseTree: review.baseTree,
    expectedHeadSha: review.headSha,
    expectedHeadTree: review.headTree,
    headChangesDigest: hash(review.headChanges),
    installationIdentityDigest: publicationInstallation.digest,
    intendedOutcome: "reconcile-existing-draft-pull-request" as const,
    name: repository.name,
    originMarker: "origin-marker",
    owner: repository.owner,
    priorPublicationDigest: "e".repeat(64),
    pullRequestId: "fixture-pr",
    pullRequestNumber: 42,
    repositoryId: repository.repositoryId,
    resolvedTree: review.resolvedTree,
    reviewDigest: review.digest,
    version: 1 as const,
  };
  const idempotencyKey = hash(unsignedProposal);
  const proposal = {
    ...unsignedProposal,
    digest: hash({ ...unsignedProposal, idempotencyKey }),
    idempotencyKey,
  };
  const completion = {
    preparation: "sealed-before-approval",
    proposal,
    review,
    appReview: {
      appSpecDigest: digest,
      changeSetDigest: sourceDigest,
      digest: originReviewDigest,
    },
    appId: "fixture-app",
    root: "/workspace/fixture",
    githubSourceDigest: source.digest,
    compilation,
  };
  const candidate = {
    version: 1,
    kind: "reconciliation",
    appId: "fixture-app",
    githubSourceDigest: source.digest,
    originalReviewDigest: originReviewDigest,
    repositoryId: repository.repositoryId,
    pullRequestNumber: 42,
    root: completion.root,
    workspaceRoot: "/workspace",
    headSha: review.headSha,
    headTree: review.headTree,
    baseSha: review.baseSha,
    baseTree: review.baseTree,
    conflicts: [],
    proposal,
    review,
    validation,
  };
  const input = {
    expectedProposalDigest: proposal.digest,
    approvalReceipt: approvalReceiptForExistingDraftUpdate(proposal),
    recordCurrentEquivalentRelease: true,
  };
  const call = {
    type: "tool-call",
    toolCallId: "reconcile-call",
    toolName: "reconcile_github_draft_pr",
    input,
    providerExecuted: false,
  };
  const request = {
    kind: "tool-approval",
    requestId: "human-request",
    action: { callId: call.toolCallId, toolName: call.toolName, input: structuredClone(input) },
  };
  // SAFETY: This controlled native fixture exposes the two actual outcomes for denial variants below.
  const settlement = {
    requestId: request.requestId,
    outcome: "approved" as "approved" | "cancelled",
    responderPrincipalId: "owner",
  };
  const nativeEvents = [
    { type: "input.requested", data: { requests: [request] } },
    {
      type: "approval.settled",
      data: settlement,
    },
  ];
  const history = [
    {
      role: "assistant",
      content: [
        call,
        { type: "tool-approval-request", toolCallId: call.toolCallId, approvalId: "approval" },
      ],
    },
    {
      role: "tool",
      content: [{ type: "tool-approval-response", approvalId: "approval", approved: true }],
    },
    { role: "assistant", content: "An intervening ordinary question" },
  ];
  const context = {
    "eve.sessionId": "logical",
    "autograph-app-builder.workflow.v17": {
      phase: "reviewed",
      appSpec: { appId: "fixture-app", digest },
      sourceReceipt: { digest: sourceDigest, sourceKind: "fresh-template" },
      githubSource: source,
      reviewReceipt: {
        digest: originReviewDigest,
        appSpecDigest: digest,
        changeSetDigest: sourceDigest,
      },
    },
    "autograph-app-builder.draft-reconciliation.v1": candidate,
    "autograph-app-builder.draft-reconciliation-completions.v1": [completion],
  };
  return {
    input: {
      descriptor: {
        logicalSessionId: "logical",
        originalAuthoritySessionId: "original-public-session",
      },
      binding: { ownerRunId: "physical", logicalSessionId: "logical" },
      expectedPrincipalId: "owner",
      payload: {
        binding: { ownerRunId: "physical", logicalSessionId: "logical" },
        candidates: [
          {
            origin: { slot: 24 },
            serializedContext: context,
            sessionState: { snapshot: { session: { sessionId: "logical", history } } },
          },
        ],
        nativeEvents,
      },
    },
    context,
    candidate,
    completion,
    call,
    request,
    nativeEvents,
    history,
    settlement,
    sourceInstallation,
    publicationInstallation,
  };
};

it("permits only the exact Git read-only reconciliation after independent original-human settlement", () => {
  const f = fixture();
  const before = structuredClone(f.input);
  expect(authorizeRepeatableDraftReconciliationCalls(f.input)).toEqual(["reconcile-call"]);
  expect(f.input).toEqual(before);
});
it("does not infer permission from history approval alone", () => {
  const f = fixture();
  f.nativeEvents.length = 0;
  expect(authorizeRepeatableDraftReconciliationCalls(f.input)).toEqual([]);
});
for (const principal of ["other", ""]) {
  it(`rejects a ${principal || "missing"} verified principal`, () => {
    const f = fixture();
    f.input.expectedPrincipalId = principal;
    expect(authorizeRepeatableDraftReconciliationCalls(f.input)).toEqual([]);
  });
}
it("rejects different physical, logical or original-public-session identity", () => {
  const first = fixture();
  first.input.binding.ownerRunId = "different";
  expect(authorizeRepeatableDraftReconciliationCalls(first.input)).toEqual([]);
  const second = fixture();
  second.input.descriptor.logicalSessionId = "different";
  expect(authorizeRepeatableDraftReconciliationCalls(second.input)).toEqual([]);
  const third = fixture();
  third.input.descriptor.originalAuthoritySessionId = "different";
  expect(authorizeRepeatableDraftReconciliationCalls(third.input)).toEqual([]);
});
it("requires exact native call arguments and one ordered approved decision by that owner", () => {
  const swapped = fixture();
  swapped.request.action.input.expectedProposalDigest = "f".repeat(64);
  expect(authorizeRepeatableDraftReconciliationCalls(swapped.input)).toEqual([]);
  const denied = fixture();
  denied.settlement.outcome = "cancelled";
  expect(authorizeRepeatableDraftReconciliationCalls(denied.input)).toEqual([]);
  const foreign = fixture();
  foreign.settlement.responderPrincipalId = "different";
  expect(authorizeRepeatableDraftReconciliationCalls(foreign.input)).toEqual([]);
  const reversed = fixture();
  reversed.nativeEvents.reverse();
  expect(authorizeRepeatableDraftReconciliationCalls(reversed.input)).toEqual([]);
  const conflicted = fixture();
  conflicted.nativeEvents.push({
    type: "approval.settled",
    data: { ...conflicted.settlement, outcome: "cancelled" },
  });
  expect(authorizeRepeatableDraftReconciliationCalls(conflicted.input)).toEqual([]);
});
it("does not cover draft updates, other publication tools or provider-executed calls", () => {
  for (const tool of ["update_github_draft_pr", "publish_github_draft_pr", "apply_app_creation"]) {
    const f = fixture();
    f.call.toolName = tool;
    f.request.action.toolName = tool;
    expect(authorizeRepeatableDraftReconciliationCalls(f.input)).toEqual([]);
  }
  const f = fixture();
  f.call.providerExecuted = true;
  expect(authorizeRepeatableDraftReconciliationCalls(f.input)).toEqual([]);
});
it("rejects malformed or ambiguous native approvals rather than ignoring conflicting frames", () => {
  const f = fixture();
  for (const extra of [
    { type: "approval.settled", data: { ...f.settlement, outcome: "unexpected" } },
    {
      type: "input.requested",
      data: { requests: [{ ...f.request, kind: "question", requestId: "other-request" }] },
    },
    {
      type: "input.requested",
      data: { requests: [{ ...f.request, action: { ...f.request.action, callId: "other-call" } }] },
    },
  ]) {
    expect(
      authorizeRepeatableDraftReconciliationCalls({
        ...f.input,
        payload: { ...f.input.payload, nativeEvents: [...f.nativeEvents, extra] },
      }),
    ).toEqual([]);
  }
});
it("leaves native result and incoming runtime outcome reconciliation to their original owner", () => {
  const f = fixture();
  expect(
    authorizeRepeatableDraftReconciliationCalls({
      ...f.input,
      payload: {
        ...f.input.payload,
        nativeEvents: [
          ...f.nativeEvents,
          { type: "action.result", data: { result: { callId: f.call.toolCallId } } },
        ],
      },
    }),
  ).toEqual([]);
  const candidate = f.input.payload.candidates[0];
  expect(
    authorizeRepeatableDraftReconciliationCalls({
      ...f.input,
      payload: {
        ...f.input.payload,
        candidates: [
          {
            ...candidate,
            incoming: { runtimeResults: { results: [{ callId: f.call.toolCallId }] } },
          },
        ],
      },
    }),
  ).toEqual([]);
});
it("rejects a completed or duplicate call without rewriting history", () => {
  const completed = fixture();
  expect(
    authorizeRepeatableDraftReconciliationCalls({
      ...completed.input,
      payload: {
        ...completed.input.payload,
        candidates: [
          {
            ...completed.input.payload.candidates[0],
            sessionState: {
              snapshot: {
                session: {
                  sessionId: "logical",
                  history: [
                    ...completed.history,
                    {
                      role: "tool",
                      content: [{ type: "tool-result", toolCallId: "reconcile-call" }],
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    }),
  ).toEqual([]);
  const duplicate = fixture();
  duplicate.history.push({ role: "assistant", content: [{ ...duplicate.call }] });
  expect(authorizeRepeatableDraftReconciliationCalls(duplicate.input)).toEqual([]);
});
it("rejects ambiguous retained completions and a later changed current candidate", () => {
  const ambiguous = fixture();
  ambiguous.context["autograph-app-builder.draft-reconciliation-completions.v1"].push(
    structuredClone(ambiguous.completion),
  );
  expect(authorizeRepeatableDraftReconciliationCalls(ambiguous.input)).toEqual([]);
  const changed = fixture();
  changed.candidate.root = "/workspace/later";
  expect(authorizeRepeatableDraftReconciliationCalls(changed.input)).toEqual([]);
  const invalid = fixture();
  invalid.candidate.validation.commands[0].exitCode = 1;
  expect(authorizeRepeatableDraftReconciliationCalls(invalid.input)).toEqual([]);
});
it("rejects a changed sealed target, receipt, source or compilation owner", () => {
  const target = fixture();
  target.completion.proposal.pullRequestNumber = 43;
  expect(authorizeRepeatableDraftReconciliationCalls(target.input)).toEqual([]);
  const receipt = fixture();
  receipt.call.input.approvalReceipt.repository = "other/repository";
  receipt.request.action.input = structuredClone(receipt.call.input);
  expect(authorizeRepeatableDraftReconciliationCalls(receipt.input)).toEqual([]);
  const source = fixture();
  source.context["autograph-app-builder.workflow.v17"].githubSource.resolvedSha = "9".repeat(40);
  expect(authorizeRepeatableDraftReconciliationCalls(source.input)).toEqual([]);
  const owner = fixture();
  owner.completion.compilation.context.authority.ownerUserId = "other";
  expect(authorizeRepeatableDraftReconciliationCalls(owner.input)).toEqual([]);
});

it("requires the retained sealed preparation and preserves literal read-only mode", () => {
  const legacy = fixture();
  legacy.completion.preparation = "legacy-recording-only";
  expect(authorizeRepeatableDraftReconciliationCalls(legacy.input)).toEqual([]);
  for (const mode of [false, undefined]) {
    const f = fixture();
    const input = { ...f.call.input, recordCurrentEquivalentRelease: mode };
    expect(
      authorizeRepeatableDraftReconciliationCalls({
        ...f.input,
        payload: {
          ...f.input.payload,
          nativeEvents: [
            {
              type: "input.requested",
              data: { requests: [{ ...f.request, action: { ...f.request.action, input } }] },
            },
            { type: "approval.settled", data: f.settlement },
          ],
          candidates: [
            {
              ...f.input.payload.candidates[0],
              sessionState: {
                snapshot: {
                  session: {
                    sessionId: "logical",
                    history: [
                      {
                        role: "assistant",
                        content: [
                          { ...f.call, input },
                          {
                            type: "tool-approval-request",
                            toolCallId: f.call.toolCallId,
                            approvalId: "approval",
                          },
                        ],
                      },
                      f.history[1],
                    ],
                  },
                },
              },
            },
          ],
        },
      }),
    ).toEqual([]);
  }
});
it("rejects changed source association, original review and compiled artifacts", () => {
  const review = fixture();
  review.completion.appReview.changeSetDigest = "f".repeat(64);
  expect(authorizeRepeatableDraftReconciliationCalls(review.input)).toEqual([]);
  const compilation = fixture();
  compilation.candidate.validation.compilation = structuredClone(
    compilation.completion.compilation,
  );
  compilation.candidate.validation.compilation.context.target.sessionId = "later-session";
  expect(authorizeRepeatableDraftReconciliationCalls(compilation.input)).toEqual([]);
});

it("rejects ambiguous latest checkpoints, unknown arguments and native mode changes", () => {
  const ambiguous = fixture();
  ambiguous.input.payload.candidates.push(structuredClone(ambiguous.input.payload.candidates[0]));
  expect(authorizeRepeatableDraftReconciliationCalls(ambiguous.input)).toEqual([]);
  const unknown = fixture();
  const withExtra = { ...unknown.call.input, publish: true };
  Object.assign(unknown.call, { input: withExtra });
  Object.assign(unknown.request.action, { input: structuredClone(withExtra) });
  expect(authorizeRepeatableDraftReconciliationCalls(unknown.input)).toEqual([]);
  const mode = fixture();
  mode.request.action.input.recordCurrentEquivalentRelease = false;
  expect(authorizeRepeatableDraftReconciliationCalls(mode.input)).toEqual([]);
});
it("rejects changed sealed merge bytes, review scope and current source", () => {
  const merge = fixture();
  const after = merge.completion.review.baseChanges[0].after;
  if (after === undefined) {
    throw new Error("The added-file fixture requires after bytes.");
  }
  after.digest = "f".repeat(64);
  expect(authorizeRepeatableDraftReconciliationCalls(merge.input)).toEqual([]);
  const source = fixture();
  source.candidate.githubSourceDigest = "f".repeat(64);
  expect(authorizeRepeatableDraftReconciliationCalls(source.input)).toEqual([]);
  const review = fixture();
  review.context["autograph-app-builder.workflow.v17"].reviewReceipt.digest = "f".repeat(64);
  expect(authorizeRepeatableDraftReconciliationCalls(review.input)).toEqual([]);
});

it("accepts distinct canonical read and publication identity scopes for the same installation", () => {
  const f = fixture();
  expect(f.sourceInstallation.installationId).toBe(f.publicationInstallation.installationId);
  expect(f.sourceInstallation.selectedRepositoryIds).toEqual(
    f.publicationInstallation.selectedRepositoryIds,
  );
  expect(f.sourceInstallation.digest).not.toBe(f.publicationInstallation.digest);
  expect(f.sourceInstallation.permissions).not.toEqual(f.publicationInstallation.permissions);
  expect(authorizeRepeatableDraftReconciliationCalls(f.input)).toEqual(["reconcile-call"]);
});
it("retains the approved publication installation digest binding", () => {
  const f = fixture();
  f.completion.proposal.installationIdentityDigest = f.sourceInstallation.digest;
  expect(authorizeRepeatableDraftReconciliationCalls(f.input)).toEqual([]);
});

it("validates old histories and preserves latest selection across unordered candidates", () => {
  const f = fixture();
  const latest = f.input.payload.candidates[0];
  const older = structuredClone(latest);
  older.origin.slot = 1;
  older.sessionState.snapshot.session.history = [];
  f.input.payload.candidates = [older, latest, structuredClone(older)];
  const before = structuredClone(f.input);
  expect(authorizeRepeatableDraftReconciliationCalls(f.input)).toEqual(["reconcile-call"]);
  expect(f.input).toEqual(before);
  const malformed = {
    ...older,
    sessionState: {
      snapshot: {
        session: { sessionId: "logical", history: [{ role: "assistant", content: [{ type: 7 }] }] },
      },
    },
  };
  expect(
    authorizeRepeatableDraftReconciliationCalls({
      ...f.input,
      payload: { ...f.input.payload, candidates: [latest, malformed] },
    }),
  ).toEqual([]);
});
it("retains historical runtime-result vetoes outside the latest candidate", () => {
  const f = fixture();
  const latest = f.input.payload.candidates[0];
  const older = {
    ...latest,
    origin: { slot: 1 },
    incoming: { runtimeResults: { results: [{ callId: f.call.toolCallId }] } },
  };
  expect(
    authorizeRepeatableDraftReconciliationCalls({
      ...f.input,
      payload: { ...f.input.payload, candidates: [older, latest] },
    }),
  ).toEqual([]);
});
it("validates unrelated native events and preserves approval ordering across them", () => {
  const f = fixture();
  const unrelated = { type: "assistant.output", data: { retained: "unrelated native evidence" } };
  const events = [unrelated, f.nativeEvents[0], unrelated, f.nativeEvents[1], unrelated];
  expect(
    authorizeRepeatableDraftReconciliationCalls({
      ...f.input,
      payload: { ...f.input.payload, nativeEvents: events },
    }),
  ).toEqual(["reconcile-call"]);
  expect(
    authorizeRepeatableDraftReconciliationCalls({
      ...f.input,
      payload: { ...f.input.payload, nativeEvents: [{ type: "unrelated", data: null }, ...events] },
    }),
  ).toEqual([]);
  expect(
    authorizeRepeatableDraftReconciliationCalls({
      ...f.input,
      payload: { ...f.input.payload, nativeEvents: events.toReversed() },
    }),
  ).toEqual([]);
});
