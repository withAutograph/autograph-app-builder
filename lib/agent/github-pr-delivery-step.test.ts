/* oxlint-disable anti-slop/no-module-mocking -- Substitute persisted Eve session state and the scoped runtime at the workflow step boundary. */
import { beforeEach, expect, it, vi } from "vitest";

import type { GitHubPrDeliveryObservation } from "../repository/github-pr-delivery";
import type { GitHubPrDeliveryApproval } from "./github-pr-delivery-approval";
import { approveGitHubPrDelivery, continueGitHubPrDelivery } from "./github-pr-delivery-step";

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  getCandidate: vi.fn(),
  inspect: vi.fn(),
  inspectReconciled: vi.fn(),
  run: vi.fn(),
  production: vi.fn(),
  captureAuthority: vi.fn(),
  readAuthority: vi.fn(),
  readGrant: vi.fn(),
}));
vi.mock("./github-pr-delivery-authority", () => ({
  captureGitHubPrDeliveryAuthority: mocks.captureAuthority,
  readGitHubPrDeliveryAuthority: mocks.readAuthority,
}));
vi.mock("./direct-production-state", () => ({ currentDirectProductionGrant: mocks.readGrant }));
vi.mock("./draft-reconciliation-state", () => ({
  draftReconciliationState: { get: mocks.getCandidate },
}));
vi.mock("./workflow-state", () => ({ appBuilderWorkflowState: { get: mocks.getState } }));
vi.mock("./github-production-delivery-readiness", () => ({
  githubProductionSetupContinuation: (setup: { preparationRequired: boolean; appId: string }) => ({
    tool: setup.preparationRequired ? "plan-app-production" : "get-app-production",
    input: { appId: setup.appId },
  }),
  readGitHubProductionDeliveryReadiness: mocks.production,
}));
vi.mock("./deployment-github-publication-runtime", () => ({
  // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
  githubPublicationRuntimeForSession: () =>
    Promise.resolve({
      inspectPublishedPullRequest: mocks.inspect,
      inspectPublishedReconciliationHead: mocks.inspectReconciled,
      runPublishedPullRequestEffect: mocks.run,
    }),
}));

const reviewedTarget = {
  baseBranch: "main",
  headSha: "a".repeat(40),
  name: "example-app",
  owner: "withAutograph",
  pullRequestNumber: 42,
  repositoryId: "100",
};
const approval: GitHubPrDeliveryApproval = {
  ...reviewedTarget,
  proposalDigest: "b".repeat(64),
};
const readyAt = "2026-11-05T15:30:00Z";
const mergeCommitSha = "c".repeat(40);
const session = { auth: {}, id: "session-fixture" };
const callId = "approved-delivery-call";
const abortSignal = new AbortController().signal;
const observe = (changes: Partial<GitHubPrDeliveryObservation> = {}) => ({
  baseBranch: reviewedTarget.baseBranch,
  checks: "pending",
  draft: false,
  headSha: reviewedTarget.headSha,
  readyAt,
  reviewedRevision: true,
  reviewedTarget,
  state: "open",
  ...changes,
});

// oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
const approve = (toolInput: GitHubPrDeliveryApproval) =>
  // SAFETY: The approval callback reads only the supplied session.id and toolInput.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Narrow fixture context to fields used by the approval callback.
  approveGitHubPrDelivery({ session, toolInput, callId, abortSignal } as never);

// oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
const step = (input: GitHubPrDeliveryApproval, cycle?: string) =>
  continueGitHubPrDelivery(
    input,
    // SAFETY: The workflow step reads only the supplied call ID, abort signal, and session identity.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Narrow fixture context to fields used by the workflow step.
    { abortSignal, callId, session } as never,
    cycle,
  );

beforeEach(() => {
  mocks.captureAuthority.mockReset();
  mocks.readGrant.mockReset();
  mocks.captureAuthority.mockResolvedValue(null);
  mocks.readAuthority.mockReset();
  mocks.readAuthority.mockResolvedValue({ subject: { appId: "example-app" }, requirements: [] });
  mocks.inspect.mockReset();
  mocks.inspectReconciled.mockReset();
  mocks.getCandidate.mockReset();
  mocks.run.mockReset();
  mocks.production.mockReset();
  mocks.production.mockResolvedValue({
    version: 1,
    appId: "example-app",
    repositoryId: reviewedTarget.repositoryId,
    repositoryFullName: `${reviewedTarget.owner}/${reviewedTarget.name}`,
    applicable: false,
  });
  mocks.getState.mockReturnValue({
    appSpec: { appId: "example-app" },
    githubDraftProposal: { proposal: { digest: approval.proposalDigest } },
    reviewReceipt: { digest: "original-review" },
    githubSource: { digest: "selected-source" },
    phase: "reviewed",
  });
});

it("requires approval for the session's current reviewed publication", async () => {
  await expect(approve(approval)).resolves.toBe("user-approval");
  await expect(approve({ ...approval, sessionId: "another-session" })).resolves.toMatchObject({
    type: "denied",
  });
  await expect(approve({ ...approval, proposalDigest: "d".repeat(64) })).resolves.toMatchObject({
    type: "denied",
  });
  expect(mocks.inspect).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
});

it("uses the original Production grant only for the exact current reviewed GitHub revision", async () => {
  const grantDigest = "7".repeat(64);
  const installationId = "10";
  const approved = { ...approval, installationId };
  mocks.getState.mockReturnValue({
    ...mocks.getState(),
    githubDestinationReview: { installation: { installationId } },
  });
  mocks.readGrant.mockReturnValue({ digest: grantDigest });
  mocks.inspect.mockResolvedValue(observe({ draft: true }));

  await expect(approve(approved)).resolves.toBe("approved");
  expect(mocks.captureAuthority).toHaveBeenCalledWith(approved, expect.anything(), {
    directProductionGrantDigest: grantDigest,
  });
  await expect(approve({ ...approved, headSha: "f".repeat(40) })).resolves.toMatchObject({
    type: "denied",
  });
  expect(mocks.run).not.toHaveBeenCalled();
});

it("requires provider proof of the retained reconciliation before approving its exact head", async () => {
  const reconciliation = { digest: "e".repeat(64) };
  const reconciled = { ...approval, reconciliationDigest: reconciliation.digest };
  mocks.getCandidate.mockReturnValue({
    appId: "example-app",
    originalReviewDigest: "original-review",
    githubSourceDigest: "selected-source",
    publishedReconciliation: reconciliation,
  });
  mocks.inspectReconciled.mockResolvedValue(reconciled.headSha);
  await expect(approve(reconciled)).resolves.toBe("user-approval");
  expect(mocks.inspectReconciled).toHaveBeenCalledWith(approval.proposalDigest, reconciliation);
  await expect(approve({ ...reconciled, headSha: "f".repeat(40) })).resolves.toMatchObject({
    type: "denied",
  });
  mocks.inspect.mockResolvedValue(observe({ draft: true }));
  mocks.run.mockResolvedValue({ evidence: { kind: "pr-ready", readyAt }, status: "succeeded" });
  await expect(step(reconciled)).resolves.toEqual({ readyAt, status: "waiting-for-checks" });
  expect(mocks.inspect).toHaveBeenCalledWith(approval.proposalDigest, approval.headSha);
  expect(mocks.run).toHaveBeenCalledWith(
    expect.objectContaining({
      reconciledHeadSha: approval.headSha,
      reviewedTarget,
    }),
  );
});

it("rechecks the approved proposal in the authenticated workflow without a model-carried session ID", async () => {
  mocks.inspect.mockResolvedValue(observe());
  const callback = { abortSignal, callId, session: { ...session, id: "workflow-session" } };
  // SAFETY: These are the only callback fields the step reads.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Partial workflow fixture.
  await expect(continueGitHubPrDelivery(approval, callback as never, readyAt)).resolves.toEqual({
    readyAt,
    status: "waiting-for-checks",
  });
  expect(mocks.inspect).toHaveBeenCalledExactlyOnceWith(approval.proposalDigest);
  expect(mocks.run).not.toHaveBeenCalled();
});

it("refuses a mismatch between the approval target and the live reviewed publication", async () => {
  mocks.inspect.mockResolvedValue(observe());
  await expect(step({ ...approval, headSha: "d".repeat(40) })).resolves.toEqual({
    status: "revision-changed",
  });
  expect(mocks.run).not.toHaveBeenCalled();
});

it("marks the approved draft ready and returns the observed cycle without merging", async () => {
  mocks.inspect.mockResolvedValue(observe({ draft: true }));
  mocks.run.mockResolvedValue({ evidence: { kind: "pr-ready", readyAt }, status: "succeeded" });
  await expect(step(approval)).resolves.toEqual({ readyAt, status: "waiting-for-checks" });
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith({
    abortSignal,
    approvedByCallId: callId,
    kind: "pr-ready",
    proposalDigest: approval.proposalDigest,
    reviewedTarget,
  });
});

it("waits for managed setup and the current required check in a delegated Production delivery", async () => {
  mocks.readAuthority.mockResolvedValue({
    subject: { appId: "example-app" },
    requirements: [],
    directProduction: true,
  });
  mocks.inspect.mockResolvedValue(observe({ draft: true }));
  await expect(step(approval)).rejects.toThrow("restore this app’s managed Production setup");
  expect(mocks.run).not.toHaveBeenCalled();

  const managedSetup = {
    version: 1,
    appId: "example-app",
    repositoryId: reviewedTarget.repositoryId,
    repositoryFullName: `${reviewedTarget.owner}/${reviewedTarget.name}`,
    applicable: true,
    operationRef: "11111111-1111-4111-8111-111111111111",
  };
  mocks.production.mockResolvedValue({
    ...managedSetup,
    state: "setting-up-data",
    preparationRequired: true,
  });
  await expect(step(approval)).resolves.toMatchObject({
    status: "production-setup-required",
    nextCall: { tool: "plan-app-production" },
  });
  expect(mocks.run).not.toHaveBeenCalled();

  mocks.production.mockResolvedValue({
    ...managedSetup,
    state: "ready",
    preparationRequired: false,
  });
  mocks.run.mockResolvedValue({ evidence: { kind: "pr-ready", readyAt }, status: "succeeded" });
  await expect(step(approval)).resolves.toEqual({ readyAt, status: "waiting-for-checks" });

  mocks.inspect.mockResolvedValue(observe({ checks: "pending" }));
  await expect(step(approval, readyAt)).resolves.toEqual({ readyAt, status: "waiting-for-checks" });
  expect(mocks.run).toHaveBeenCalledTimes(1);

  mocks.inspect.mockResolvedValue(observe({ checks: "passed" }));
  mocks.run.mockResolvedValue({
    evidence: { kind: "pr-merge", mergeCommitSha },
    status: "succeeded",
  });
  await expect(step(approval, readyAt)).resolves.toMatchObject({
    status: "merged",
    mergeCommitSha,
    nativeProductionTarget: { appId: "example-app" },
  });
  expect(mocks.run).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ kind: "pr-merge", readyAt, reviewedTarget }),
  );
});

it.each([
  [observe({ checks: "pending" }), { readyAt, status: "waiting-for-checks" }],
  [observe({ checks: "failed" }), { status: "checks-failed" }],
  [
    observe({ checks: "passed", readyAt: "2026-11-05T15:45:00Z" }),
    { status: "ready-cycle-changed" },
  ],
])("does not merge pending, failed, or superseded checks", async (observation, result) => {
  mocks.inspect.mockResolvedValue(observation);
  await expect(step(approval, readyAt)).resolves.toEqual(result);
  expect(mocks.run).not.toHaveBeenCalled();
});

it.each([
  [
    { evidence: { kind: "pr-merge", mergeCommitSha }, status: "succeeded" },
    { mergeCommitSha, status: "merged" },
  ],
  [{ status: "pending" }, { status: "merge-unconfirmed" }],
])("merges the approved revision only after its current checks pass", async (receipt, result) => {
  mocks.inspect.mockResolvedValue(observe({ checkRunId: 42, checks: "passed" }));
  mocks.run.mockResolvedValue(receipt);
  await expect(step(approval, readyAt)).resolves.toEqual(result);
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith({
    abortSignal,
    approvedByCallId: callId,
    kind: "pr-merge",
    proposalDigest: approval.proposalDigest,
    readyAt,
    reviewedTarget,
  });
});

it("does not dispatch merge when the managed app is missing its required Production setup", async () => {
  mocks.inspect.mockResolvedValue(observe({ checks: "passed" }));
  mocks.run.mockResolvedValue({
    evidence: { kind: "pr-merge", mergeCommitSha },
    status: "succeeded",
  });
  mocks.production.mockResolvedValue({
    version: 1,
    appId: "example-app",
    repositoryId: reviewedTarget.repositoryId,
    repositoryFullName: `${reviewedTarget.owner}/${reviewedTarget.name}`,
    applicable: true,
    operationRef: "11111111-1111-4111-8111-111111111111",
    state: "setting-up-data",
    preparationRequired: true,
  });
  await expect(step(approval, readyAt)).resolves.toMatchObject({
    status: "production-setup-required",
    nextCall: { tool: "plan-app-production", input: { appId: "example-app" } },
  });
  expect(mocks.run).not.toHaveBeenCalled();
});

it("retains the same review and ready cycle while saved setup is still progressing", async () => {
  mocks.inspect.mockResolvedValue(observe({ checks: "passed" }));
  mocks.production.mockResolvedValue({
    version: 1,
    appId: "example-app",
    repositoryId: reviewedTarget.repositoryId,
    repositoryFullName: `${reviewedTarget.owner}/${reviewedTarget.name}`,
    applicable: true,
    operationRef: "11111111-1111-4111-8111-111111111111",
    state: "checking-access",
    preparationRequired: false,
  });
  await expect(step(approval, readyAt)).resolves.toMatchObject({
    status: "production-setup-required",
    readyAt,
    nextCall: { tool: "get-app-production", input: { appId: "example-app" } },
  });
  expect(mocks.run).not.toHaveBeenCalled();
  mocks.production.mockResolvedValue({
    version: 1,
    appId: "example-app",
    repositoryId: reviewedTarget.repositoryId,
    repositoryFullName: `${reviewedTarget.owner}/${reviewedTarget.name}`,
    applicable: true,
    operationRef: "11111111-1111-4111-8111-111111111111",
    state: "ready",
    preparationRequired: false,
  });
  mocks.run.mockResolvedValue({
    evidence: { kind: "pr-merge", mergeCommitSha },
    status: "succeeded",
  });
  await expect(step(approval, readyAt)).resolves.toEqual({
    status: "merged",
    mergeCommitSha,
    nativeProductionTarget: {
      appId: "example-app",
      repositoryId: reviewedTarget.repositoryId,
      repositoryFullName: `${reviewedTarget.owner}/${reviewedTarget.name}`,
    },
  });
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      approvedByCallId: callId,
      reviewedTarget,
      readyAt,
      kind: "pr-merge",
    }),
  );
});

it("does not merge if the required setup service cannot be read", async () => {
  mocks.inspect.mockResolvedValue(observe({ checks: "passed" }));
  mocks.production.mockRejectedValue(new Error("Production setup is temporarily unavailable"));
  await expect(step(approval, readyAt)).rejects.toThrow(
    "Production setup is temporarily unavailable",
  );
  expect(mocks.run).not.toHaveBeenCalled();
});

it("recovers a ready transition after the original response is lost", async () => {
  mocks.inspect.mockResolvedValue(observe());
  mocks.run.mockResolvedValue({ evidence: { kind: "pr-ready", readyAt }, status: "succeeded" });
  await expect(step(approval)).resolves.toEqual({ readyAt, status: "waiting-for-checks" });
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith({
    abortSignal,
    approvedByCallId: callId,
    kind: "pr-ready",
    proposalDigest: approval.proposalDigest,
    reconcileOnly: true,
    reviewedTarget,
  });
});

it("recovers the same owned managed merge and passes its exact saved native target", async () => {
  const target = {
    appId: "example-app",
    repositoryId: reviewedTarget.repositoryId,
    repositoryFullName: `${reviewedTarget.owner}/${reviewedTarget.name}`,
  };
  mocks.readAuthority.mockResolvedValue({
    subject: { appId: target.appId },
    requirements: [{ ...target, operationRef: "11111111-1111-4111-8111-111111111111" }],
  });
  mocks.inspect.mockResolvedValue(observe({ state: "merged", mergeCommitSha }));
  await expect(step(approval, readyAt)).resolves.toEqual({
    status: "merged",
    mergeCommitSha,
    nativeProductionTarget: target,
  });
  expect(mocks.production).not.toHaveBeenCalled();
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ kind: "pr-merge", reconcileOnly: true }),
  );
});
