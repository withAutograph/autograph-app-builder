/* oxlint-disable anti-slop/no-module-mocking, typescript/no-unsafe-type-assertion, anti-slop/require-safety-comment-for-type-assertion -- Controlled owner/read/reconciliation ports exercise the real refresh hook without provider calls. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { refreshPlanningSource } from "./refresh-planning-source";
import { PlanningReleaseConflictError } from "../repository/planning-source-reconciliation";

interface FixtureState {
  phase: string;
  appSpec: { appId: string; digest: string };
  artifacts: string[];
  applyReceipt: { digest: string; applyRoot: string };
  dependencyReceipt: { digest: string };
  proposal: { digest: string };
  githubSource?: {
    digest: string;
    repository: { name: string; owner: string; repositoryId: string };
    resolvedRef: string;
    resolvedSha: string;
  };
  workspace: { sourceSha: string; workspacePath: string };
}
const mocks = vi.hoisted(() => ({
  accessUpdate: vi.fn(),
  credential: vi.fn(),
  classify: vi.fn(),
  currentGrant: vi.fn(),
  delivered: vi.fn(),
  inspect: vi.fn(),
  observeLocal: vi.fn<() => Promise<void>>().mockResolvedValue(),
  prepare: vi.fn(),
  reconcile: vi.fn(),
  recoverRelease: vi.fn(),
  retainedReleaseId: vi.fn(),
  readSavedRelease: vi.fn(),
  preserve: vi.fn(),
  sandbox: { id: "owned-sandbox" },
  sourceUpdate: vi.fn(),
  state: {} as FixtureState,
  updateWorkflow: vi.fn<(transition: (state: FixtureState) => FixtureState) => void>(),
}));
vi.mock("./refresh-local-planning-source", () => ({
  refreshLocalPlanningSource: mocks.observeLocal,
}));
vi.mock("./direct-production-state", () => ({
  currentDirectProductionGrant: mocks.currentGrant,
  currentDirectProductionProposalIsDelivered: mocks.delivered,
}));
vi.mock("./app-baseline-state", () => ({ appBaselineState: { get: () => {} } }));
vi.mock("./source-bound-sandbox", () => ({
  getSourceBoundSandbox: async () => await Promise.resolve(mocks.sandbox),
}));
vi.mock("./workflow-state", () => ({
  APP_BUILDER_WORKFLOW_VERSION: 17,
  appBuilderWorkflowState: { get: () => mocks.state, update: mocks.updateWorkflow },
  assertExactWorkflowState: vi.fn(),
}));
vi.mock("./repository-access-state", () => ({
  repositoryAccessReceiptState: {
    get: () => ({ scope: { installationId: "owned-installation" } }),
    update: mocks.accessUpdate,
  },
}));
vi.mock("./source-state", () => ({
  APP_BUILDER_SOURCE_VERSION: 3,
  sourceWorkflowState: { update: mocks.sourceUpdate },
}));
vi.mock("./deployment-repository-access-runtime", () => ({
  repositoryAccessRuntimeForSession: async () =>
    await Promise.resolve({
      acquireExistingSourceCredential: mocks.credential,
      classify: mocks.classify,
      prepareExistingSource: mocks.prepare,
    }),
}));
vi.mock("./deployment-github-publication-runtime", () => ({
  githubPublicationRuntimeForSession: async () =>
    await Promise.resolve({ inspectSourceBranch: mocks.inspect }),
}));
vi.mock("../repository/planning-source-reconciliation", async (importOriginal) => ({
  ...(await importOriginal<{
    PlanningReleaseConflictError: typeof PlanningReleaseConflictError;
  }>()),
  reconcilePlanningSource: mocks.reconcile,
}));
vi.mock("./merged-release-source-recovery", () => ({
  readMergedReleaseSourceRecovery: mocks.recoverRelease,
  retainedMergedSchemaReleaseId: mocks.retainedReleaseId,
}));
vi.mock("../provisioning/hosted-operator-callback-owner", () => ({
  hostedOperatorCallbackExecution: vi.fn(),
}));
vi.mock("./connected-schema-saved-predecessor", () => ({
  readConnectedSchemaSavedPredecessor: mocks.readSavedRelease,
}));
vi.mock("../repository/connected-schema-release-recovery", () => ({
  preserveUnissuedConnectedSchemaRelease: mocks.preserve,
}));
vi.mock("../sandbox/vercel-session-source", () => ({
  resolveVercelSessionGitSource: async () =>
    await Promise.resolve({
      token: "fixture-read-token",
      url: "https://github.com/owned/repo.git",
    }),
}));
const ctx = {
  abortSignal: new AbortController().signal,
  callId: "compile-refresh",
  getSandbox: vi.fn(),
  session: { auth: {}, id: "owned-session" },
};

describe("shared source refresh before schema compilation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state = {
      appSpec: { appId: "spend-review", digest: "accepted-product" },
      applyReceipt: { applyRoot: "/workspace/repository", digest: "approved-apply" },
      artifacts: ["retained-evidence"],
      dependencyReceipt: { digest: "existing-dependencies" },
      githubSource: {
        digest: "original-binding",
        repository: { name: "repo", owner: "owned", repositoryId: "owned-repo" },
        resolvedRef: "refs/heads/main",
        resolvedSha: "a".repeat(40),
      },
      phase: "applied",
      proposal: { digest: "approved-proposal" },
      workspace: { sourceSha: "a".repeat(40), workspacePath: "/workspace/repository" },
    };
    mocks.classify.mockResolvedValue({ status: "ready" });
    mocks.inspect.mockResolvedValue({ headSha: "b".repeat(40), headTree: "c".repeat(40) });
    mocks.prepare.mockImplementation(async (input: { sandbox: () => Promise<{ id: string }> }) => {
      await input.sandbox();
      return {
        accessReceipt: { owned: true },
        githubSource: {
          ...mocks.state.githubSource,
          digest: "refreshed-binding",
          resolvedSha: "b".repeat(40),
        },
        sourceReceipt: { digest: "refreshed-source" },
        workspace: { ...mocks.state.workspace, sourceSha: "b".repeat(40) },
      };
    });
  });
  it("binds local schema compilation to the applied checkout without observing the moving host", async () => {
    delete mocks.state.githubSource;
    await expect(refreshPlanningSource(ctx as never, "schema-compilation")).resolves.toBe(
      mocks.sandbox,
    );
    expect(mocks.observeLocal).not.toHaveBeenCalled();
    expect(mocks.classify).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });
  it("refreshes shared code while preserving applied product, approval and dependency receipts", async () => {
    const original = mocks.state;
    await expect(refreshPlanningSource(ctx as never, "schema-compilation")).resolves.toBe(
      mocks.sandbox,
    );
    const updated = mocks.updateWorkflow.mock.calls[0]?.[0](original);
    expect(updated).toMatchObject({
      appSpec: original.appSpec,
      applyReceipt: original.applyReceipt,
      artifacts: original.artifacts,
      dependencyReceipt: original.dependencyReceipt,
      githubSource: { resolvedRef: "refs/heads/main", resolvedSha: "b".repeat(40) },
      phase: "applied",
      proposal: original.proposal,
    });
    expect(mocks.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "spend-review",
        branchRef: "refs/heads/main",
        repository: "https://github.com/owned/repo.git",
        sandbox: mocks.sandbox,
        sessionId: "owned-session",
        targetSha: "b".repeat(40),
      }),
    );
  });
  it("retries only the proven merged release in the current applied proposal", async () => {
    const original = mocks.state;
    const proof = {
      mergeSha: "c".repeat(40),
      releaseId: "v8",
      files: { "app-artifact.json": "d".repeat(64) },
    };
    mocks.reconcile.mockRejectedValueOnce(new PlanningReleaseConflictError("v8"));
    mocks.recoverRelease.mockResolvedValueOnce(proof);
    await expect(refreshPlanningSource(ctx as never, "schema-compilation")).resolves.toBe(
      mocks.sandbox,
    );
    expect(mocks.recoverRelease).toHaveBeenCalledWith({
      current: original,
      ctx,
      installationId: "owned-installation",
      releaseId: "v8",
    });
    expect(mocks.reconcile.mock.calls[1]?.[0]).toEqual({
      ...mocks.reconcile.mock.calls[0]?.[0],
      publishedRelease: proof,
    });
    expect(mocks.updateWorkflow.mock.calls[0]?.[0](original)).toMatchObject({
      applyReceipt: original.applyReceipt,
      proposal: original.proposal,
    });
  });
  it("recovers the published predecessor for a saved, unpublished online revision", async () => {
    const artifact = "a".repeat(64);
    const oldManifest = "b".repeat(64);
    const publishedManifest = "c".repeat(64);
    const approvedCue = "d".repeat(64);
    const proof = {
      mergeSha: "c".repeat(40),
      releaseId: "v8",
      files: { "app-artifact.json": artifact, "release-manifest.json": publishedManifest },
    };
    mocks.retainedReleaseId.mockReturnValueOnce("v8");
    mocks.recoverRelease.mockResolvedValueOnce(proof);
    mocks.readSavedRelease.mockResolvedValueOnce({
      candidate: { releaseId: "v9", schemaSha256: "e".repeat(64), manifestSha256: "f".repeat(64) },
      prior: {
        releaseId: "v8",
        artifactSha256: artifact,
        onlineProof: true,
        previousManifestSha256: oldManifest,
      },
    });
    mocks.preserve.mockResolvedValueOnce(true);
    await expect(
      refreshPlanningSource(ctx as never, "schema-compilation", {
        approvedSchemaCueSha256: approvedCue,
      }),
    ).resolves.toBe(mocks.sandbox);
    expect(mocks.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ publishedRelease: proof }),
    );
    expect(mocks.preserve).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedCueSha256: approvedCue,
        expectedPredecessorArtifactSha256: artifact,
        releaseId: "v9",
        restoredPublishedPredecessor: {
          releaseId: "v8",
          previousManifestSha256: oldManifest,
          publishedManifestSha256: publishedManifest,
        },
      }),
    );
  });
  it("leaves the source conflict pending if the exact owned publication is unavailable", async () => {
    mocks.reconcile.mockRejectedValueOnce(new PlanningReleaseConflictError("v8"));
    mocks.recoverRelease.mockResolvedValueOnce(null);
    await expect(refreshPlanningSource(ctx as never, "schema-compilation")).rejects.toBeInstanceOf(
      PlanningReleaseConflictError,
    );
    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
    expect(mocks.updateWorkflow).not.toHaveBeenCalled();
  });
  it("adopts the verified CUE privately before planning a new optional field", async () => {
    mocks.state.phase = "reviewed";
    const reconciliation = { digest: "prior-repair" };
    const publishedRelease = {
      mergeSha: "c".repeat(40),
      releaseId: "v8",
      files: { "app-artifact.json": "d".repeat(64) },
      cueSha256: "e".repeat(64),
    };
    mocks.delivered.mockReturnValueOnce(true);
    mocks.currentGrant.mockReturnValueOnce({ subject: { revision: { reconciliation } } });
    mocks.retainedReleaseId.mockReturnValueOnce("v8");
    mocks.recoverRelease.mockResolvedValueOnce(publishedRelease);
    mocks.credential.mockResolvedValueOnce({ token: "fixture-read-token" });
    await expect(
      refreshPlanningSource(ctx as never, "planning", { optionalFieldPlanning: true }),
    ).resolves.toBe(mocks.sandbox);
    expect(mocks.recoverRelease).toHaveBeenCalledWith({
      current: mocks.state,
      ctx,
      includeSchemaCue: true,
      installationId: "owned-installation",
      reconciliationAnchor: reconciliation,
      releaseId: "v8",
    });
    expect(mocks.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        adoptPublishedSchemaCue: true,
        preserveSourceHead: true,
        publishedRelease,
        targetSha: "b".repeat(40),
      }),
    );
    expect(mocks.updateWorkflow).not.toHaveBeenCalled();
    expect(mocks.accessUpdate).not.toHaveBeenCalled();
  });
  it("keeps ordinary planning refresh out of already applied builds", async () => {
    await refreshPlanningSource(ctx as never);
    expect(mocks.observeLocal).toHaveBeenCalledWith(ctx);
    expect(mocks.classify).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });
  it("uses the same saved source when the branch has not changed", async () => {
    mocks.prepare.mockResolvedValue({
      githubSource: mocks.state.githubSource,
      workspace: mocks.state.workspace,
    });
    await refreshPlanningSource(ctx as never, "schema-compilation");
    expect(mocks.updateWorkflow).not.toHaveBeenCalled();
    expect(mocks.sourceUpdate).not.toHaveBeenCalled();
  });
  it("does not reconcile without current owner read access", async () => {
    mocks.classify.mockResolvedValue({ status: "authorization-required" });
    await expect(refreshPlanningSource(ctx as never, "schema-compilation")).rejects.toThrow(
      "existing read access is unavailable",
    );
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.updateWorkflow).not.toHaveBeenCalled();
  });
});
