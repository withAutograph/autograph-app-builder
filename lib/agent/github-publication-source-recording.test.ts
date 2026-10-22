/* oxlint-disable anti-slop/no-module-mocking, typescript/no-unsafe-type-assertion -- Isolate Eve state and trusted publication/recording ports while exercising the production tool execute boundaries. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftReconciliationCompletion } from "./draft-reconciliation-state";
import type { approvalReceiptSchema as ActualApprovalReceiptSchema } from "./approval-receipt";

import publishTool from "../../agent/tools/publish_github_draft_pr";
import updateTool from "../../agent/tools/update_github_draft_pr";
import inspectReconciliation from "../../agent/tools/inspect_github_draft_pr_reconciliation";
import reconcileTool from "../../agent/tools/reconcile_github_draft_pr";

const hooks = vi.hoisted(() => {
  const digest = "a".repeat(64);
  const review = {
    digest,
    appSpecDigest: "c".repeat(64),
    changeSetDigest: "b".repeat(64),
    baseChanges: [],
  };
  const proposal: DraftReconciliationCompletion["proposal"] = {
    digest,
    repositoryId: "repository",
    reviewDigest: digest,
    resolvedTree: "tree",
    version: 1,
    intendedOutcome: "reconcile-existing-draft-pull-request",
    installationIdentityDigest: "d".repeat(64),
    owner: "fixture-owner",
    name: "fixture-repository",
    pullRequestNumber: 42,
    pullRequestId: "fixture-pr-42",
    branchName: "app-builder/fixture",
    baseBranch: "main",
    expectedHeadSha: "1".repeat(40),
    expectedHeadTree: "2".repeat(40),
    expectedBaseSha: "3".repeat(40),
    expectedBaseTree: "4".repeat(40),
    approvedPaths: [],
    baseChangesDigest: "e".repeat(64),
    headChangesDigest: "f".repeat(64),
    originMarker: "fixture-builder-origin",
    priorPublicationDigest: "b".repeat(64),
    idempotencyKey: "c".repeat(64),
  };
  const reconciliationReview: DraftReconciliationCompletion["review"] = {
    version: 1,
    appId: "spend-review",
    digest,
    resolvedTree: proposal.resolvedTree,
    baseChanges: [],
    headChanges: [],
    approvedPaths: [],
    baseSha: proposal.expectedBaseSha,
    baseTree: proposal.expectedBaseTree,
    headSha: proposal.expectedHeadSha,
    headTree: proposal.expectedHeadTree,
  };
  const compilation: DraftReconciliationCompletion["compilation"] = {
    context: {
      authority: {
        issuer: "https://fixture-builder.example/api/auth",
        audience: "https://fixture-builder.example/mcp",
        workspaceId: "fixture-workspace",
        ownerUserId: "fixture-owner",
      },
      target: { appId: "spend-review", sessionId: "original-owner-session" },
    },
    release: { status: "not-required" },
  };
  return {
    sandbox: vi.fn(),
    assertApproval: vi.fn(),
    assertOwner: vi.fn<() => Promise<void>>(),
    applied: vi.fn(),
    // SAFETY: The closed test fixture supplies only trusted completion metadata consumed by this tool.
    completions: [] as DraftReconciliationCompletion[],
    content: vi.fn(),
    inspect: vi.fn(),
    record: vi.fn(),
    publish: vi.fn(),
    update: vi.fn(),
    reconcile: vi.fn(),
    state: {
      phase: "reviewed",
      appBackendKind: "static",
      appSpec: { appId: "spend-review", digest: "c".repeat(64) },
      applyReceipt: { applyRoot: "/workspace/applied" },
      sourceReceipt: { sourceKind: "existing-repository" },
      githubSource: { digest, repository: { repositoryId: "repository" } },
      githubDraftProposal: { proposal },
      existingDraftUpdate: { proposal, githubSourceDigest: digest, reviewDigest: digest },
      reviewReceipt: review,
    },
    candidate: {
      appId: "spend-review",
      proposal,
      review: reconciliationReview,
      validation: {
        resolvedTree: "tree",
        compilation,
      },
      githubSourceDigest: digest,
      originalReviewDigest: digest,
      root: "/workspace/resolved",
      workspaceRoot: "/workspace",
      publishedReconciliation: undefined,
    },
  };
});

vi.mock("eve/tools", () => ({ defineTool: <T>(tool: T) => tool }));
vi.mock("./approval-receipt", async (importOriginal) => ({
  ...(await importOriginal<{ approvalReceiptSchema: typeof ActualApprovalReceiptSchema }>()),
  approvalTargetFromDraftProposal: () => ({}),
  approvalTargetFromExistingDraftUpdate: () => ({}),
  approvalTargetFromExistingDraftReconciliation: () => ({}),
  assertApprovalReceipt: hooks.assertApproval,
}));
vi.mock("./deployment-github-publication-runtime", () => ({
  githubPublicationRuntimeForSession: async () =>
    await Promise.resolve({
      publishDraftPullRequest: hooks.publish,
      updateExistingDraft: hooks.update,
      reconcileExistingDraft: hooks.reconcile,
      inspectAppliedExistingDraftReconciliation: hooks.applied,
    }),
}));
vi.mock("./github-publication-content-source", () => ({
  publicationContentSourceForReviewedWorkflow: hooks.content,
}));
vi.mock("./workflow-state", () => ({ appBuilderWorkflowState: { get: () => hooks.state } }));
vi.mock("./app-baseline-state", () => ({ appBaselineState: { get: () => null } }));
vi.mock("../repository/reviewed-change-set", () => ({ assertExistingAppReviewScope: () => {} }));
vi.mock("./draft-reconciliation-state", () => ({
  draftReconciliationState: { get: () => hooks.candidate },
  draftReconciliationCompletions: { get: () => hooks.completions },
  publishedDraftRepairCompletions: { get: () => [] },
  retainDraftReconciliationCompletion: (completion: DraftReconciliationCompletion) => {
    hooks.completions.push(completion);
  },
  updateExactDraftReconciliation: ({
    expected,
    operation,
    transition,
  }: {
    expected: unknown;
    operation: string;
    transition: (current: typeof hooks.candidate) => typeof hooks.candidate;
  }) => {
    if (JSON.stringify(hooks.candidate) !== JSON.stringify(expected)) {
      throw new Error(
        `The draft reconciliation changed while Builder was ${operation}. Inspect its current state, then retry.`,
      );
    }
    hooks.candidate = transition(hooks.candidate);
  },
}));
vi.mock("./source-bound-sandbox", () => ({
  getSourceBoundSandbox: hooks.sandbox,
}));
vi.mock("../repository/sandbox-draft-reconciliation", () => ({
  inspectDraftReconciliation: hooks.inspect,
}));
vi.mock("./published-app-source", () => ({
  recordPublishedAppSourceForSession: hooks.record,
  recordPublishedReconciliationForSession: hooks.record,
}));
vi.mock("./compiled-operator-artifacts", () => ({
  assertReconciliationCompletionOwnerForSession: hooks.assertOwner,
}));

const tools = [
  { name: "initial publication", tool: publishTool, publish: hooks.publish },
  { name: "existing draft update", tool: updateTool, publish: hooks.update },
  { name: "draft reconciliation", tool: reconcileTool, publish: hooks.reconcile },
];
const input = {
  expectedProposalDigest: "a".repeat(64),
  approvalReceipt: {
    baseRef: "refs/heads/main",
    baseSha: "b".repeat(40),
    format: "autograph-eve-approval-receipt-v2" as const,
    outcome: "create-draft-pr" as const,
    phase: "publication" as const,
    repository: "owner/repository",
    repositoryId: "123",
    subjectDigest: "a".repeat(64),
  },
};
const ctx = {
  callId: "approved-publication-call",
  session: { id: "adapter-session", auth: { principal: "original-owner" } },
  getSandbox: async () => await Promise.resolve({}),
};

const originalCandidate = structuredClone(hooks.candidate);
const originalState = structuredClone(hooks.state);
const completionFixture = (): DraftReconciliationCompletion => ({
  preparation: "sealed-before-approval",
  proposal: hooks.candidate.proposal,
  review: hooks.candidate.review,
  appId: hooks.state.appSpec.appId,
  appReview: hooks.state.reviewReceipt,
  githubSourceDigest: hooks.candidate.githubSourceDigest,
  root: hooks.candidate.root,
  compilation: hooks.candidate.validation.compilation,
});

const recoveryCompletionFixture = (): DraftReconciliationCompletion => {
  const completion = hooks.completions[0];
  if (completion === undefined) {
    throw new Error("Expected original retained completion");
  }
  const recovery = { ...completion, proposal: { ...completion.proposal, repositoryId: "123" } };
  hooks.completions = [recovery];
  return recovery;
};

describe("publication records actual source for its compiled app release", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hooks.sandbox.mockResolvedValue({});
    hooks.record.mockReset().mockResolvedValue({ status: "recorded" });
    hooks.assertApproval.mockReset();
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Vitest requires an explicit resolved value for its Promise<void> mock.
    hooks.assertOwner.mockReset().mockResolvedValue(undefined);
    hooks.applied.mockReset().mockResolvedValue({ applied: false });
    hooks.candidate = structuredClone(originalCandidate);
    hooks.state = structuredClone(originalState);
    hooks.completions = [completionFixture()];
    hooks.inspect.mockResolvedValue({ unresolvedConflicts: [], resolvedTree: "tree" });
    hooks.candidate.publishedReconciliation = undefined;
  });

  for (const entry of tools) {
    it.each(["recorded", "not-required"])(
      `${entry.name} propagates recording status %s after verified publication`,
      async (status) => {
        hooks.record.mockResolvedValue({ status });
        const publication = {
          repositoryId: "repository",
          headSha: "actual-new-head",
          recovered: true,
        };
        entry.publish.mockResolvedValue(publication);
        // SAFETY: The mocked Eve/publication ports consume only the supplied session, call ID and sandbox fields.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Framework fixture supplies precisely the production execute path's consumed context.
        const result = await entry.tool.execute(input, ctx as never);
        expect(result).toMatchObject({ ...publication, appSourceRecording: { status } });
        expect(hooks.record).toHaveBeenCalledWith(
          expect.objectContaining({
            ...(entry.tool === reconcileTool
              ? { completion: hooks.completions[0] }
              : {
                  appId: hooks.state.appSpec.appId,
                  appSpecDigest: hooks.state.appSpec.digest,
                  backendKind: hooks.state.appBackendKind,
                  root: hooks.state.applyReceipt.applyRoot,
                  callId: ctx.callId,
                  review: hooks.state.reviewReceipt,
                }),
            adapterSessionId: ctx.session.id,
            sessionAuth: ctx.session.auth,
            publication,
          }),
        );
        expect(result).not.toHaveProperty("appSourceRecording.recoveryRequired");
        expect(entry.publish).toHaveBeenCalledTimes(1);
        expect(hooks.record).toHaveBeenCalledTimes(1);
        if (entry.tool === reconcileTool) {
          expect(hooks.candidate.publishedReconciliation).toEqual(hooks.candidate.proposal);
        }
        expect(hooks.record.mock.invocationCallOrder[0]).toBeGreaterThan(
          entry.publish.mock.invocationCallOrder[0] ?? 0,
        );
      },
    );

    it(`${entry.name} preserves successful publication and exposes recoverable unavailable recording`, async () => {
      const publication = { repositoryId: "repository", headSha: "already-published-head" };
      entry.publish.mockResolvedValue(publication);
      hooks.record.mockRejectedValue(new Error("private artifact detail"));
      // SAFETY: The mocked Eve/publication ports consume only the supplied session, call ID and sandbox fields.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Framework fixture supplies precisely the production execute path's consumed context.
      const result = await entry.tool.execute(input, ctx as never);
      expect(result).toMatchObject({
        ...publication,
        appSourceRecording: { status: "unavailable", recoveryRequired: true },
      });
      expect(JSON.stringify(result)).not.toContain("private artifact detail");
      expect(entry.publish).toHaveBeenCalledTimes(1);
    });

    it(`${entry.name} does not record an unverified or failed publication`, async () => {
      const candidateBefore = structuredClone(hooks.candidate);
      entry.publish.mockRejectedValue(new Error("publication outcome unknown"));
      // SAFETY: The mocked Eve/publication ports consume only the supplied session, call ID and sandbox fields.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Framework fixture supplies precisely the production execute path's consumed context.
      await expect(entry.tool.execute(input, ctx as never)).rejects.toThrow(
        "publication outcome unknown",
      );
      expect(hooks.record).not.toHaveBeenCalled();
      expect(hooks.candidate).toEqual(candidateBefore);
    });

    it(`${entry.name} retains the publication approval boundary`, async () => {
      hooks.assertApproval.mockImplementation(() => {
        throw new Error("approval mismatch");
      });
      // SAFETY: The mocked Eve/publication ports consume only the supplied session, call ID and sandbox fields.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Framework fixture supplies precisely the production execute path's consumed context.
      await expect(entry.tool.execute(input, ctx as never)).rejects.toThrow("approval mismatch");
      expect(entry.publish).not.toHaveBeenCalled();
      expect(hooks.record).not.toHaveBeenCalled();
    });
  }
  it.each(["missing", "irrelevant"])(
    "discovers and consumes the exact normal recovery call when the candidate is %s",
    async (candidateState) => {
      const completion = recoveryCompletionFixture();
      // SAFETY: A missing candidate is deliberate; its independent trusted completion remains retained.
      hooks.candidate =
        candidateState === "missing"
          ? (null as never)
          : {
              ...hooks.candidate,
              appId: "another-app",
              root: "/workspace/irrelevant-failed-candidate",
            };
      hooks.state.phase = "applied";
      // SAFETY: The new read-only branch consumes only the same minimal session metadata as the existing publication fixtures.
      const found = await inspectReconciliation.execute(
        { kind: "publication-recovery" },
        ctx as never,
      );
      expect(found).toMatchObject({ status: "publication-recovery", verification: "unverified" });
      if (!("status" in found) || found.status !== "publication-recovery") {
        throw new Error("Expected retained recovery discovery");
      }
      const recovery = found.recoveries[0];
      if (recovery === undefined) {
        throw new Error("Expected original retained completion");
      }
      expect(recovery.proposalDigest).toBe(completion?.proposal.digest);
      expect(recovery.nextCall.tool).toBe("reconcile_github_draft_pr");
      expect(recovery.nextCall.arguments.approvalReceipt.subjectDigest).toBe(
        completion?.proposal.digest,
      );
      expect(hooks.assertOwner).toHaveBeenCalled();
      expect(hooks.applied).not.toHaveBeenCalled();
      expect(hooks.assertApproval).not.toHaveBeenCalled();
      expect(hooks.record).not.toHaveBeenCalled();
      expect(hooks.sandbox).not.toHaveBeenCalled();
      hooks.applied.mockResolvedValue({
        applied: true,
        observation: { headSha: "verified-existing-head" },
      });
      // SAFETY: Consume the actual discovery result through the real reconciliation tool with controlled owner/Git ports.
      await expect(
        reconcileTool.execute(recovery.nextCall.arguments, ctx as never),
      ).resolves.toMatchObject({ appSourceRecording: { status: "recorded" } });
      expect(hooks.assertApproval).toHaveBeenCalledWith(
        expect.objectContaining({ actual: recovery.nextCall.arguments.approvalReceipt }),
      );
      expect(hooks.record).toHaveBeenCalledWith(
        expect.objectContaining({ completion, recordCurrentEquivalentRelease: true }),
      );
      expect(hooks.reconcile).not.toHaveBeenCalled();
      expect(hooks.sandbox).not.toHaveBeenCalled();
    },
  );
  it("lists an approval subject without granting approval to execute its returned call", async () => {
    recoveryCompletionFixture();
    // SAFETY: Controlled owner and publication ports isolate the read-only discovery branch.
    const found = await inspectReconciliation.execute(
      { kind: "publication-recovery" },
      ctx as never,
    );
    if (
      !("status" in found) ||
      found.status !== "publication-recovery" ||
      found.recoveries[0] === undefined
    ) {
      throw new Error("Expected retained recovery");
    }
    hooks.assertApproval.mockImplementation(() => {
      throw new Error("Human approval required");
    });
    // SAFETY: Generated receipt metadata is passed to the normal tool; the existing approval port rejects it.
    await expect(
      reconcileTool.execute(found.recoveries[0].nextCall.arguments, ctx as never),
    ).rejects.toThrow("Human approval required");
    expect(hooks.applied).not.toHaveBeenCalled();
    expect(hooks.record).not.toHaveBeenCalled();
    expect(hooks.reconcile).not.toHaveBeenCalled();
  });
  it.each(["empty", "another-app", "another-spec"])(
    "reports no matching recovery for %s without inventing a context or checking Git",
    async (condition) => {
      if (condition === "empty") {
        hooks.completions = [];
      }
      if (condition === "another-app") {
        hooks.state.appSpec.appId = "another-app";
      }
      if (condition === "another-spec") {
        hooks.state.appSpec.digest = "f".repeat(64);
      }
      // SAFETY: This intentionally contains no matching completion and can only return owner-private metadata.
      const found = await inspectReconciliation.execute(
        { kind: "publication-recovery" },
        ctx as never,
      );
      expect(found).toMatchObject({
        status: "publication-recovery",
        verification: "unverified",
        recoveries: [],
      });
      expect(hooks.applied).not.toHaveBeenCalled();
      expect(hooks.record).not.toHaveBeenCalled();
      expect(hooks.reconcile).not.toHaveBeenCalled();
      expect(hooks.sandbox).not.toHaveBeenCalled();
    },
  );
  it("refuses to expose recovery calls after owner revocation", async () => {
    hooks.assertOwner.mockRejectedValue(new Error("owner revoked"));
    // SAFETY: The canonical owner check is controlled to reject before any metadata is returned.
    await expect(
      inspectReconciliation.execute({ kind: "publication-recovery" }, ctx as never),
    ).rejects.toThrow("owner revoked");
    expect(hooks.applied).not.toHaveBeenCalled();
    expect(hooks.record).not.toHaveBeenCalled();
    expect(hooks.sandbox).not.toHaveBeenCalled();
  });
  it("returns selection-changed if the accepted specification moves during discovery", async () => {
    hooks.assertOwner.mockImplementation(() => {
      hooks.state.appSpec.digest = "f".repeat(64);
      return Promise.resolve();
    });
    // SAFETY: A controlled in-flight state change simulates the existing current-owner asynchronous boundary.
    await expect(
      inspectReconciliation.execute({ kind: "publication-recovery" }, ctx as never),
    ).resolves.toMatchObject({
      status: "selection-changed",
      verification: "unverified",
      recoveries: [],
    });
    expect(hooks.applied).not.toHaveBeenCalled();
    expect(hooks.record).not.toHaveBeenCalled();
    expect(hooks.sandbox).not.toHaveBeenCalled();
  });

  it("uses normal approved read-only reconciliation to associate a current equivalent capture without Git writes", async () => {
    const completion = hooks.completions[0];
    hooks.applied.mockResolvedValue({
      applied: true,
      observation: { repositoryId: "repository", headSha: "verified-existing-head" },
    });
    hooks.inspect.mockRejectedValue(
      new Error("Current candidate must not be read in this recovery"),
    );
    // SAFETY: Controlled owner and publication ports consume the same minimal session context used by the existing tool fixtures.
    await expect(
      reconcileTool.execute({ ...input, recordCurrentEquivalentRelease: true }, ctx as never),
    ).resolves.toMatchObject({
      headSha: "verified-existing-head",
      appSourceRecording: { status: "recorded" },
    });
    expect(hooks.record).toHaveBeenCalledWith(
      expect.objectContaining({ completion, recordCurrentEquivalentRelease: true }),
    );
    expect(hooks.assertApproval).toHaveBeenCalled();
    expect(hooks.assertOwner).toHaveBeenCalled();
    expect(hooks.reconcile).not.toHaveBeenCalled();
    expect(hooks.inspect).not.toHaveBeenCalled();
  });
  it("reports a changed current capture as recovery required rather than a recorded current release", async () => {
    hooks.applied.mockResolvedValue({
      applied: true,
      observation: { headSha: "verified-existing-head" },
    });
    hooks.record.mockResolvedValue({ status: "selection-changed" });
    // SAFETY: Trusted publication and owner ports are controlled; the minimal session context cannot access a provider.
    await expect(
      reconcileTool.execute({ ...input, recordCurrentEquivalentRelease: true }, ctx as never),
    ).resolves.toMatchObject({
      appSourceRecording: { status: "selection-changed", recoveryRequired: true },
    });
    expect(hooks.reconcile).not.toHaveBeenCalled();
    expect(hooks.inspect).not.toHaveBeenCalled();
  });

  it("never turns record-current-equivalent mode into a fresh Git publication when applied proof is absent", async () => {
    // SAFETY: Controlled ports consume only the supplied session and call ID; no real provider work is possible.
    await reconcileTool.execute({ ...input, recordCurrentEquivalentRelease: true }, ctx as never);
    expect(hooks.applied).toHaveBeenCalled();
    expect(hooks.reconcile).not.toHaveBeenCalled();
    expect(hooks.record).not.toHaveBeenCalled();
    expect(hooks.inspect).not.toHaveBeenCalled();
  });
  it("keeps original approval and owner checks in record-current-equivalent mode", async () => {
    hooks.applied.mockResolvedValue({ applied: true, observation: { headSha: "verified-head" } });
    hooks.assertApproval.mockImplementation(() => {
      throw new Error("approval mismatch");
    });
    // SAFETY: Controlled owner and publication ports consume the same minimal session context used by the existing tool fixtures.
    await expect(
      reconcileTool.execute({ ...input, recordCurrentEquivalentRelease: true }, ctx as never),
    ).rejects.toThrow("approval mismatch");
    expect(hooks.applied).not.toHaveBeenCalled();
    expect(hooks.record).not.toHaveBeenCalled();
    expect(hooks.reconcile).not.toHaveBeenCalled();
  });
  it("does not infer an original completion for record-current-equivalent mode", async () => {
    hooks.completions = [];
    // SAFETY: Simulate a missing retained candidate to exercise the existing completion recovery boundary.
    hooks.candidate = null as never;
    // SAFETY: Controlled owner and publication ports consume the same minimal session context used by the existing tool fixtures.
    await expect(
      reconcileTool.execute({ ...input, recordCurrentEquivalentRelease: true }, ctx as never),
    ).resolves.toMatchObject({ status: "completion_context_missing" });
    expect(hooks.applied).not.toHaveBeenCalled();
    expect(hooks.record).not.toHaveBeenCalled();
    expect(hooks.reconcile).not.toHaveBeenCalled();
  });

  it("recovers an accepted write/readback failure after the candidate is lost, with zero further Git writes", async () => {
    const completion = hooks.completions[0];
    hooks.reconcile.mockRejectedValueOnce(
      new Error("GitHub accepted update; readback unavailable"),
    );
    // SAFETY: Minimal context supplies the exact fields used by the real tool.
    await expect(reconcileTool.execute(input, ctx as never)).rejects.toThrow(
      "readback unavailable",
    );
    expect(hooks.record).not.toHaveBeenCalled();
    expect(hooks.completions[0]).toBe(completion);
    // SAFETY: Simulate a lost/replaced candidate without changing its independent sealed context.
    hooks.candidate = null as never;
    const publication = { repositoryId: "repository", headSha: "verified-applied-head" };
    hooks.applied.mockResolvedValue({ applied: true, observation: publication });
    hooks.inspect.mockRejectedValue(new Error("candidate sandbox is gone"));
    // SAFETY: Same approved session context is reused for completion only.
    await expect(reconcileTool.execute(input, ctx as never)).resolves.toMatchObject({
      ...publication,
      appSourceRecording: { status: "recorded" },
    });
    expect(hooks.reconcile).toHaveBeenCalledTimes(1);
    expect(hooks.record).toHaveBeenCalledWith(expect.objectContaining({ completion }));
  });

  it("recovers an original publication after a new candidate changes without inspecting it", async () => {
    const original = hooks.completions[0];
    hooks.candidate = {
      ...hooks.candidate,
      root: "/workspace/new-candidate",
      proposal: { ...hooks.candidate.proposal, digest: "new-proposal" },
    };
    hooks.state.appSpec.digest = "changed-current-app-spec";
    hooks.state.reviewReceipt.digest = "changed-current-app-review";
    hooks.applied.mockResolvedValue({ applied: true, observation: { headSha: "approved-head" } });
    // SAFETY: Minimal production tool context with trusted ports mocked.
    await reconcileTool.execute(input, ctx as never);
    expect(hooks.inspect).not.toHaveBeenCalled();
    expect(hooks.reconcile).not.toHaveBeenCalled();
    expect(hooks.record).toHaveBeenCalledWith(expect.objectContaining({ completion: original }));
  });

  it("keeps fresh publication checkout checks and never writes a changed tree", async () => {
    hooks.inspect.mockResolvedValue({ unresolvedConflicts: [], resolvedTree: "changed-tree" });
    // SAFETY: Minimal production tool context with trusted ports mocked.
    await expect(reconcileTool.execute(input, ctx as never)).rejects.toThrow("checkout changed");
    expect(hooks.reconcile).not.toHaveBeenCalled();
    expect(hooks.record).not.toHaveBeenCalled();
  });

  it.each(["missing-capture", "new-validation-tree"])(
    "reports missing canonical legacy context for %s without effects",
    async (condition) => {
      hooks.completions = [];
      if (condition === "new-validation-tree") {
        hooks.candidate.validation.resolvedTree = "new-validated-capture-tree";
      } else {
        Reflect.deleteProperty(hooks.candidate.validation, "compilation");
      }
      // SAFETY: The legacy fixture deliberately omits required captured metadata or its original tree binding.
      await expect(reconcileTool.execute(input, ctx as never)).resolves.toMatchObject({
        status: "completion_context_missing",
      });
      expect(hooks.applied).not.toHaveBeenCalled();
      expect(hooks.reconcile).not.toHaveBeenCalled();
      expect(hooks.record).not.toHaveBeenCalled();
    },
  );

  it("can record canonical legacy context only after exact applied proof, never perform its fresh write", async () => {
    hooks.completions = [];
    // SAFETY: Canonical old context is retained but no preapproval seal checkpoint exists.
    await expect(reconcileTool.execute(input, ctx as never)).resolves.toMatchObject({
      status: "completion_context_missing",
    });
    expect(hooks.reconcile).not.toHaveBeenCalled();
    expect(hooks.record).not.toHaveBeenCalled();
    // A later call cannot promote this in-tool legacy state into fresh-write eligibility.
    // SAFETY: Same minimal fixture exercises a second ordinary invocation.
    await expect(reconcileTool.execute(input, ctx as never)).resolves.toMatchObject({
      status: "completion_context_missing",
    });
    expect(hooks.reconcile).not.toHaveBeenCalled();
    hooks.applied.mockResolvedValue({
      applied: true,
      observation: { headSha: "canonical-applied" },
    });
    // SAFETY: Current approval still checked; only the proof result changes.
    await expect(reconcileTool.execute(input, ctx as never)).resolves.toMatchObject({
      appSourceRecording: { status: "recorded" },
    });
    expect(hooks.reconcile).not.toHaveBeenCalled();
  });

  it("rejects current owner mismatch before provider or recording work", async () => {
    hooks.assertOwner.mockRejectedValue(new Error("owner changed"));
    // SAFETY: Minimal production tool context with owner port refusing authorization.
    await expect(reconcileTool.execute(input, ctx as never)).rejects.toThrow("owner changed");
    expect(hooks.applied).not.toHaveBeenCalled();
    expect(hooks.reconcile).not.toHaveBeenCalled();
    expect(hooks.record).not.toHaveBeenCalled();
  });

  it("does not turn unavailable applied proof into a fresh publication", async () => {
    hooks.applied.mockRejectedValue(new Error("provider read unavailable"));
    // SAFETY: Minimal production tool context with read-only proof unavailable.
    await expect(reconcileTool.execute(input, ctx as never)).rejects.toThrow(
      "provider read unavailable",
    );
    expect(hooks.inspect).not.toHaveBeenCalled();
    expect(hooks.reconcile).not.toHaveBeenCalled();
    expect(hooks.record).not.toHaveBeenCalled();
  });
});
