/* oxlint-disable anti-slop/no-module-mocking, eslint/require-await, anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Isolate persisted Eve state while exercising the actual public tool retry behavior. */
import { beforeEach, expect, it, vi } from "vitest";
import type { DraftReconciliationCandidate } from "./draft-reconciliation-state";
import type { CandidateDependencyCatalogIntent } from "../repository/candidate-dependency-catalog";
import normalizeCatalog from "../../agent/tools/normalize_github_draft_pr_dependency_catalog";

const mocks = vi.hoisted(() => ({
  candidate: null as DraftReconciliationCandidate | null,
  plan: vi.fn(),
  apply: vi.fn(),
  inspect: vi.fn(),
}));
vi.mock("eve/tools", () => ({ defineTool: <T>(tool: T): T => tool }));
vi.mock("./published-draft-repair", () => ({ currentDraftCandidateSource: () => ({}) }));
vi.mock("./source-bound-sandbox", () => ({ getSourceBoundSandbox: vi.fn(async () => ({})) }));
vi.mock("./workflow-state", () => ({
  appBuilderWorkflowState: {
    get: () => ({ phase: "reviewed", reviewReceipt: { digest: "review" } }),
  },
}));
vi.mock("./draft-reconciliation-state", () => ({
  draftReconciliationState: { get: () => mocks.candidate },
  updateExactDraftReconciliation: ({
    transition,
  }: {
    transition: () => DraftReconciliationCandidate;
  }) => {
    mocks.candidate = transition();
  },
}));
vi.mock("../repository/sandbox-draft-reconciliation", () => ({
  inspectDraftReconciliation: mocks.inspect,
}));
vi.mock(import("../repository/candidate-dependency-catalog"), async (original) => ({
  ...(await original()),
  planCandidateDependencyCatalog: mocks.plan,
  normalizeCandidateDependencyCatalog: mocks.apply,
}));
const intent: CandidateDependencyCatalogIntent = {
  root: "/workspace/candidate",
  appId: "example",
  dependency: "fixture-tool",
  version: "1.2.3",
  index: "original-index",
  files: [],
  lockGenerated: false,
  lockExitCode: 7,
  diagnostic: "lock resolution failed",
};
const context = { abortSignal: new AbortController().signal } as never;
beforeEach(() => {
  vi.clearAllMocks();
  // SAFETY: Only source identity and cleared receipt fields are observed by this controlled tool fixture.
  mocks.candidate = {
    originalReviewDigest: "review",
    validation: {},
    validationRun: {},
    review: {},
    proposal: {},
  } as DraftReconciliationCandidate;
  mocks.plan.mockResolvedValue(intent);
  mocks.apply.mockImplementation(async () => {
    expect(mocks.candidate?.dependencyCatalogPending).toEqual(intent);
    expect(mocks.candidate?.validation).toBeUndefined();
    expect(mocks.candidate?.review).toBeUndefined();
    throw new Error("sandbox process lost after metadata rename");
  });
});
it("persists the exact intent before writes and resumes it after loss without absorbing new source", async () => {
  await expect(normalizeCatalog.execute({ dependency: "fixture-tool" }, context)).rejects.toThrow(
    "process lost",
  );
  expect(mocks.candidate?.dependencyCatalogPending).toEqual(intent);
  await expect(normalizeCatalog.execute({ dependency: "other" }, context)).rejects.toThrow(
    "Resume the pending",
  );
  mocks.apply.mockResolvedValueOnce({
    dependency: "fixture-tool",
    version: "1.2.3",
    lockGenerated: false,
    lockExitCode: 7,
    diagnostic: "lock resolution failed",
    files: [],
    receipt: { files: [], nonAppIndexDigest: "new-index" },
  });
  await expect(
    normalizeCatalog.execute({ dependency: "fixture-tool" }, context),
  ).resolves.toMatchObject({ status: "lock_generation_failed", lockExitCode: 7 });
  expect(mocks.plan).toHaveBeenCalledOnce();
  expect(mocks.inspect).toHaveBeenCalledOnce();
  expect(mocks.candidate?.dependencyCatalogPending).toBeUndefined();
  expect(mocks.candidate?.dependencyCatalog).toEqual({ files: [], nonAppIndexDigest: "new-index" });
});
