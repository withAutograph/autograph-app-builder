/* oxlint-disable anti-slop/no-module-mocking, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, typescript/no-unsafe-type-assertion, typescript/no-unsafe-assignment, eslint/require-await -- Isolated Eve state and sandbox stubs verify formatting cannot retain a stale review. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import formatCandidate from "../../agent/tools/format_github_draft_pr_candidate";

const digest = "a".repeat(64);
const mocks = vi.hoisted(() => ({
  candidate: null as Record<string, unknown> | null,
  inspect: vi.fn(),
  run: vi.fn(),
  workflow: null as Record<string, unknown> | null,
}));

vi.mock("eve/tools", () => ({ defineTool: <T>(value: T): T => value }));
vi.mock("./source-bound-sandbox", () => ({
  getSourceBoundSandbox: async () => ({ run: mocks.run }),
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
vi.mock("../repository/sandbox-draft-reconciliation", () => ({
  inspectDraftReconciliation: mocks.inspect,
}));
vi.mock("../repository/target-validation", () => ({
  sanitizeValidationDiagnosticText: (value: string) => value,
  validationOutputExcerpt: (stdout: string, stderr: string) => ({ stderr, stdout }),
}));

const context = { abortSignal: new AbortController().signal } as never;
const change = (fileDigest: string) => ({
  after: { digest: fileDigest },
  path: "apps/example/app/page.tsx",
});

describe("draft reconciliation app formatter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.candidate = {
      appId: "example",
      githubSourceDigest: digest,
      originalReviewDigest: digest,
      proposal: { digest },
      review: { digest },
      root: "/workspace/candidate",
      validation: { resolvedTree: "b".repeat(40) },
      validationRun: { nextIndex: 2 },
      version: 1,
    };
    mocks.workflow = {
      githubSource: { digest },
      phase: "reviewed",
      reviewReceipt: { digest },
    };
    mocks.inspect
      .mockResolvedValueOnce({
        baseChanges: [change("old")],
        resolvedTree: "b".repeat(40),
        unresolvedConflicts: [],
      })
      .mockResolvedValueOnce({
        baseChanges: [change("new")],
        resolvedTree: "c".repeat(40),
        unresolvedConflicts: [],
      });
    mocks.run.mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });
  });

  it("runs the repository formatter and requires fresh validation and review", async () => {
    await expect(formatCandidate.execute({}, context)).resolves.toMatchObject({
      formattedPaths: ["apps/example/app/page.tsx"],
      status: "formatted",
    });
    expect(mocks.run).toHaveBeenCalledWith({
      abortSignal: expect.any(AbortSignal),
      command: "mise run --skip-tools format:app",
      workingDirectory: "/workspace/candidate",
    });
    expect(mocks.candidate?.validation).toBeUndefined();
    expect(mocks.candidate?.validationRun).toBeUndefined();
    expect(mocks.candidate?.review).toBeUndefined();
    expect(mocks.candidate?.proposal).toBeUndefined();
  });

  it("reports formatter failure without retaining a new review", async () => {
    mocks.run.mockResolvedValue({ exitCode: 1, stderr: "formatter failed", stdout: "" });
    await expect(formatCandidate.execute({}, context)).resolves.toMatchObject({
      command: "mise run --skip-tools format:app",
      exitCode: 1,
      status: "needs_repair",
    });
    expect(mocks.inspect).toHaveBeenCalledTimes(1);
  });

  it("rejects an unrelated source review before running the formatter", async () => {
    mocks.workflow = {
      githubSource: { digest: "different" },
      phase: "reviewed",
      reviewReceipt: { digest },
    };
    await expect(formatCandidate.execute({}, context)).rejects.toThrow("no longer matches");
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("does not retain a validation when formatting changes a platform-owned path", async () => {
    mocks.inspect.mockReset();
    mocks.inspect
      .mockResolvedValueOnce({
        baseChanges: [change("old")],
        resolvedTree: "b".repeat(40),
        unresolvedConflicts: [],
      })
      .mockRejectedValueOnce(
        new Error("Builder cannot accept reconciliation edit packages/platform/file.ts"),
      );
    await expect(formatCandidate.execute({}, context)).rejects.toThrow("packages/platform/file.ts");
    expect(mocks.candidate?.validation).toBeUndefined();
    expect(mocks.candidate?.proposal).toBeUndefined();
  });
});
