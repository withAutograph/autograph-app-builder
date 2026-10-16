/* oxlint-disable anti-slop/no-module-mocking -- Isolate the actual inspection tool from Eve session state and repository commands. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, typescript/no-unsafe-type-assertion -- Minimal session state fixtures verify optional inspection behavior only. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import inspectReconciliation from "../../agent/tools/inspect_github_draft_pr_reconciliation";

const digest = "a".repeat(64);
const mocks = vi.hoisted(() => ({
  candidate: null as Record<string, unknown> | null,
  workflow: null as Record<string, unknown> | null,
  readDiff: vi.fn(),
  sandbox: vi.fn(),
}));
vi.mock("eve/tools", () => ({ defineTool: <T>(value: T): T => value }));
vi.mock("./draft-reconciliation-state", () => ({
  draftReconciliationState: { get: () => mocks.candidate },
}));
vi.mock("./workflow-state", () => ({ appBuilderWorkflowState: { get: () => mocks.workflow } }));
vi.mock("./source-bound-sandbox", () => ({
  getSourceBoundSandbox: mocks.sandbox,
}));
vi.mock("../repository/sandbox-draft-reconciliation", () => ({
  readDraftReconciliationConflict: vi.fn(),
  readDraftReconciliationDiff: mocks.readDiff,
}));
const context = { session: { auth: {} } } as never;

describe("optional reconciliation inspection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sandbox.mockResolvedValue({});
    mocks.candidate = {
      appId: "demo",
      githubSourceDigest: digest,
      originalReviewDigest: digest,
      review: {
        digest,
        resolvedTree: "b".repeat(40),
        baseChanges: [],
        headChanges: [{ kind: "added", path: "docs/platform.md", after: { mode: "644", digest } }],
      },
      validation: { resolvedTree: "b".repeat(40) },
    };
    mocks.workflow = { phase: "reviewed", githubSource: { digest }, reviewReceipt: { digest } };
    mocks.readDiff.mockResolvedValue({
      chunkBase64: Buffer.from("tail").toString("base64"),
      cursor: 40,
      nextCursor: null,
      totalBytes: 44,
    });
  });

  it("allows a targeted raw byte cursor without prior reads or progress mutation", async () => {
    const previous = structuredClone(mocks.candidate);
    await expect(
      inspectReconciliation.execute(
        { kind: "diff", against: "head", cursor: 40, path: "docs/platform.md" },
        context,
      ),
    ).resolves.toMatchObject({ content: "tail", cursor: 40, path: "docs/platform.md" });
    expect(mocks.readDiff).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: 40, path: "docs/platform.md" }),
    );
    expect(mocks.candidate).toEqual(previous);
  });

  it("exposes non-app metadata without reading raw diff bytes", async () => {
    await expect(
      inspectReconciliation.execute({ kind: "changes", against: "head" }, context),
    ).resolves.toMatchObject({
      status: "changes",
      totalFiles: 1,
      appOwnedFiles: 0,
      nonAppFiles: 1,
      changes: [expect.objectContaining({ path: "docs/platform.md" })],
    });
    expect(mocks.readDiff).not.toHaveBeenCalled();
    expect(mocks.sandbox).not.toHaveBeenCalled();
  });

  it("retains the selected-source boundary for optional reads", async () => {
    mocks.workflow = {
      phase: "reviewed",
      githubSource: { digest: "c".repeat(64) },
      reviewReceipt: { digest },
    };
    await expect(
      inspectReconciliation.execute({ kind: "changes", against: "head" }, context),
    ).rejects.toThrow("Prepare the current draft reconciliation");
    expect(mocks.readDiff).not.toHaveBeenCalled();
  });
});
