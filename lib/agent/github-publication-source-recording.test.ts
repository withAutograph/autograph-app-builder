/* oxlint-disable anti-slop/no-module-mocking -- Isolate Eve state and trusted publication/recording ports while exercising the production tool execute boundaries. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { approvalReceiptSchema as ActualApprovalReceiptSchema } from "./approval-receipt";

import publishTool from "../../agent/tools/publish_github_draft_pr";
import updateTool from "../../agent/tools/update_github_draft_pr";
import reconcileTool from "../../agent/tools/reconcile_github_draft_pr";

const hooks = vi.hoisted(() => {
  const digest = "a".repeat(64);
  const review = { digest, changeSetDigest: "b".repeat(64), baseChanges: [] };
  const proposal = {
    digest,
    repositoryId: "repository",
    reviewDigest: digest,
    resolvedTree: "tree",
  };
  return {
    assertApproval: vi.fn(),
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
      proposal,
      review: { appId: "spend-review", digest, baseChanges: [] },
      validation: { resolvedTree: "tree" },
      githubSourceDigest: digest,
      originalReviewDigest: digest,
      root: "/workspace/resolved",
      workspaceRoot: "/workspace",
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
}));
vi.mock("./source-bound-sandbox", () => ({
  getSourceBoundSandbox: async () => await Promise.resolve({}),
}));
vi.mock("../repository/sandbox-draft-reconciliation", () => ({
  inspectDraftReconciliation: hooks.inspect,
}));
vi.mock("./published-app-source", () => ({ recordPublishedAppSourceForSession: hooks.record }));

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

describe("publication records actual source for its compiled app release", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hooks.record.mockReset().mockResolvedValue({ status: "recorded" });
    hooks.assertApproval.mockReset();
    hooks.inspect.mockResolvedValue({ unresolvedConflicts: [], resolvedTree: "tree" });
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
            appId: hooks.state.appSpec.appId,
            appSpecDigest: hooks.state.appSpec.digest,
            backendKind: hooks.state.appBackendKind,
            root:
              entry.tool === reconcileTool
                ? hooks.candidate.root
                : hooks.state.applyReceipt.applyRoot,
            adapterSessionId: ctx.session.id,
            sessionAuth: ctx.session.auth,
            callId: ctx.callId,
            review: hooks.state.reviewReceipt,
            ...(entry.tool === reconcileTool
              ? {
                  reconciliationReview: hooks.candidate.review,
                }
              : {}),
            publication,
          }),
        );
        expect(result).not.toHaveProperty("appSourceRecording.recoveryRequired");
        expect(entry.publish).toHaveBeenCalledTimes(1);
        expect(hooks.record).toHaveBeenCalledTimes(1);
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
      entry.publish.mockRejectedValue(new Error("publication outcome unknown"));
      // SAFETY: The mocked Eve/publication ports consume only the supplied session, call ID and sandbox fields.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Framework fixture supplies precisely the production execute path's consumed context.
      await expect(entry.tool.execute(input, ctx as never)).rejects.toThrow(
        "publication outcome unknown",
      );
      expect(hooks.record).not.toHaveBeenCalled();
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
});
