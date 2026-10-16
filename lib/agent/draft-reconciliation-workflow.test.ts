/* oxlint-disable anti-slop/no-module-mocking -- Eve tool context and sandbox are isolated to verify the actual publication gate. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, typescript/no-unsafe-type-assertion -- Deliberately minimal Eve state and tool context stubs for this publication gate test. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import sealReconciliation from "../../agent/tools/seal_github_draft_pr_reconciliation";

const digest = "a".repeat(64);
const sha = "b".repeat(40);
const mocks = vi.hoisted(() => ({
  candidate: null as Record<string, unknown> | null,
  inspect: vi.fn(),
  seal: vi.fn(),
  workflow: null as Record<string, unknown> | null,
}));

vi.mock("eve/tools", () => ({ defineTool: <T>(value: T): T => value }));
vi.mock("./deployment-github-publication-runtime", () => ({
  githubPublicationRuntimeForSession: () => ({ sealExistingDraftReconciliation: mocks.seal }),
}));
vi.mock("./draft-reconciliation-state", () => ({
  draftReconciliationState: { get: () => mocks.candidate },
  updateExactDraftReconciliation: ({ transition }: { transition: () => unknown }) => {
    mocks.candidate = transition() as Record<string, unknown>;
  },
}));
vi.mock("./workflow-state", () => ({
  appBuilderWorkflowState: { get: () => mocks.workflow },
}));
vi.mock("./source-bound-sandbox", () => ({
  getSourceBoundSandbox: async (ctx: { getSandbox: () => Promise<unknown> }) =>
    await ctx.getSandbox(),
}));
vi.mock("../repository/sandbox-draft-reconciliation", () => ({
  inspectDraftReconciliation: mocks.inspect,
}));

const context = {
  callId: "seal",
  // oxlint-disable-next-line eslint/require-await -- Eve's sandbox accessor is asynchronous in production.
  async getSandbox() {
    return {};
  },
  session: { auth: {} },
} as never;

describe("draft reconciliation publication review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.candidate = {
      baseSha: sha,
      baseTree: sha,
      githubSourceDigest: digest,
      headSha: sha,
      headTree: sha,
      originalReviewDigest: digest,
      pullRequestNumber: 1500,
      review: { digest, resolvedTree: sha },
      root: "/workspace/.app-builder/draft-reconcile/candidate",
      validation: { resolvedTree: sha },
    };
    mocks.workflow = {
      githubSource: { digest, repository: { repositoryId: "1" } },
      phase: "reviewed",
      reviewReceipt: { digest },
    };
    mocks.inspect.mockResolvedValue({ resolvedTree: sha, unresolvedConflicts: [] });
    mocks.seal.mockResolvedValue({
      branchName: "app-builder/spend-review",
      digest: "c".repeat(64),
      expectedHeadSha: sha,
      name: "arrusted-development",
      owner: "withAutograph",
      repositoryId: "1",
    });
  });

  it.each([
    { name: "absent" },
    {
      name: "partial",
      progress: { baseComplete: true, headComplete: false, reviewDigest: digest },
    },
    {
      name: "stale",
      progress: { baseComplete: false, headComplete: false, reviewDigest: "old-review" },
    },
    {
      name: "complete",
      progress: { baseComplete: true, headComplete: true, reviewDigest: digest },
    },
  ])(
    "seals the exact validated tree with $name optional inspection progress",
    async ({ progress }) => {
      if (progress !== undefined) {
        mocks.candidate = { ...mocks.candidate, reviewReadProgress: progress };
      }
      await expect(
        sealReconciliation.execute({ expectedReviewDigest: digest }, context),
      ).resolves.toMatchObject({
        approvalReceipt: {
          baseRef: "refs/heads/app-builder/spend-review",
          baseSha: sha,
          outcome: "update-draft-pr",
          phase: "draft_update",
          subjectDigest: "c".repeat(64),
        },
        digest: "c".repeat(64),
      });
      expect(mocks.seal).toHaveBeenCalledOnce();
      expect(mocks.candidate).toHaveProperty("proposal.digest", "c".repeat(64));
    },
  );

  it.each([
    { field: "validation", reason: "candidate_validation_missing" },
    { field: "review", reason: "candidate_review_missing" },
  ])("refuses a missing candidate $field without publication", async ({ field, reason }) => {
    if (mocks.candidate === null) {
      throw new Error("Expected the retained fixture candidate.");
    }
    Reflect.deleteProperty(mocks.candidate, field);
    await expect(
      sealReconciliation.execute({ expectedReviewDigest: digest }, context),
    ).rejects.toThrow(new RegExp(`^${reason} `, "u"));
    expect(mocks.seal).not.toHaveBeenCalled();
  });

  it.each([
    {
      field: "githubSource",
      value: { digest: "changed-source" },
      reason: "source_binding_changed",
    },
    {
      field: "reviewReceipt",
      value: { digest: "changed-app-review" },
      reason: "app_review_changed",
    },
  ])("refuses changed $field authority without publication", async ({ field, value, reason }) => {
    mocks.workflow = { ...mocks.workflow, [field]: value };
    await expect(
      sealReconciliation.execute({ expectedReviewDigest: digest }, context),
    ).rejects.toThrow(new RegExp(`^${reason} `, "u"));
    expect(mocks.seal).not.toHaveBeenCalled();
  });

  it("refuses a stale requested reconciliation review without publication", async () => {
    await expect(
      sealReconciliation.execute({ expectedReviewDigest: "old-review" }, context),
    ).rejects.toThrow(/^seal_review_input_changed /u);
    expect(mocks.seal).not.toHaveBeenCalled();
  });

  it("refuses unresolved conflicts without publication", async () => {
    mocks.inspect.mockResolvedValue({
      resolvedTree: sha,
      unresolvedConflicts: ["apps/demo/main.ts"],
    });
    await expect(
      sealReconciliation.execute({ expectedReviewDigest: digest }, context),
    ).rejects.toThrow("changed after review");
    expect(mocks.seal).not.toHaveBeenCalled();
  });

  it("rejects a changed resolved tree after review", async () => {
    mocks.candidate = {
      ...mocks.candidate,
      reviewReadProgress: { baseComplete: true, headComplete: true, reviewDigest: digest },
    };
    mocks.inspect.mockResolvedValue({ resolvedTree: "d".repeat(40), unresolvedConflicts: [] });
    await expect(
      sealReconciliation.execute({ expectedReviewDigest: digest }, context),
    ).rejects.toThrow("changed after review");
    expect(mocks.seal).not.toHaveBeenCalled();
  });
});
