/* oxlint-disable anti-slop/no-module-mocking, typescript/no-unsafe-type-assertion, anti-slop/require-safety-comment-for-type-assertion -- Controlled owner/read/reconciliation ports exercise the real refresh hook without provider calls. */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { refreshPlanningSource } from "./refresh-planning-source";
import { PlanningReleaseConflictError } from "../repository/planning-source-reconciliation";

interface FixtureState {
  phase: string;
  appSpec: { appId: string; digest: string };
  artifacts: string[];
  applyReceipt: {
    digest: string;
    applyRoot: string;
    sourceReceiptDigest?: string;
    changes?: readonly { path: string }[];
  };
  dependencyReceipt: { digest: string };
  proposal: { digest: string };
  githubSource?: {
    digest: string;
    repository: { name: string; owner: string; repositoryId: string };
    resolvedRef: string;
    resolvedSha: string;
    resolvedTree?: string;
  };
  sourceReceipt?: {
    digest: string;
    sourceKind: string;
    sourcePath: string;
    sourceSha: string;
    sourceTree: string;
  };
  workspace: {
    sourceSha: string;
    workspacePath: string;
    sourcePath?: string;
    sourceTree?: string;
    workspaceDigest?: string;
    workspaceId?: string;
  };
}
const mocks = vi.hoisted(() => ({
  accessUpdate: vi.fn(),
  credential: vi.fn(),
  classify: vi.fn(),
  settledDelivery: vi.fn(),
  inspect: vi.fn(),
  observeLocal: vi.fn<() => Promise<void>>().mockResolvedValue(),
  prepare: vi.fn(),
  reconcile: vi.fn(),
  recoverRelease: vi.fn(),
  readPriorRelease: vi.fn(),
  readSettledMerge: vi.fn(),
  inspectCheckout: vi.fn(),
  retainedReleaseId: vi.fn(),
  readSavedRelease: vi.fn(),
  preserve: vi.fn(),
  sandbox: { id: "owned-sandbox", readBinaryFile: vi.fn() },
  sourceUpdate: vi.fn(),
  state: {} as FixtureState,
  updateWorkflow: vi.fn<(transition: (state: FixtureState) => FixtureState) => void>(),
}));
vi.mock("./refresh-local-planning-source", () => ({
  refreshLocalPlanningSource: mocks.observeLocal,
}));
vi.mock("./direct-production-state", () => ({
  readPriorApprovedMergedSchemaRelease: mocks.readPriorRelease,
  readSettledDirectProductionPlanningMerge: mocks.readSettledMerge,
  settledDirectProductionDelivery: mocks.settledDelivery,
}));
vi.mock("../repository/sandbox-github-source", () => ({
  assertRetainedGitHubSourceCheckout: mocks.inspectCheckout,
}));
vi.mock("../repository/github-publication", () => ({
  assertExactImmutableGitHubSourceReceipt: vi.fn(),
}));
vi.mock("./private-apply-authority", () => ({
  assertNoPendingPrivateApplyApproval: vi.fn<() => void>(),
  assertApprovedPrivateApplySession: vi.fn<() => void>(),
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
    vi.resetAllMocks();
    mocks.observeLocal.mockResolvedValue();
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
      sourceReceipt: {
        digest: "approved-source",
        sourceKind: "existing-repository",
        sourcePath: "/workspace/repository",
        sourceSha: "a".repeat(40),
        sourceTree: "b".repeat(40),
      },
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
  it.each([
    "approved historical cut",
    "current candidate cut",
    "changed CUE",
    "authored release",
  ] as const)(
    "uses the prior owned merged snapshot only for the approved historical conflict (%s)",
    async (scenario) => {
      const cue = Buffer.from('manifest: #AppManifest & {version: "v9"}');
      const approvedCueHash = createHash("sha256").update(cue).digest("hex");
      const releaseId = scenario === "current candidate cut" ? "v9" : "v8";
      const conflict = new PlanningReleaseConflictError(releaseId);
      const published = { mergeSha: "c".repeat(40), releaseId, files: {} };
      mocks.state.workspace.workspaceId = mocks.sandbox.id;
      mocks.state.applyReceipt.changes =
        scenario === "authored release"
          ? [{ path: "apps/spend-review/schema/release/v8/app-artifact.json" }]
          : [];
      mocks.reconcile.mockRejectedValueOnce(conflict);
      mocks.recoverRelease.mockResolvedValueOnce(null);
      mocks.readPriorRelease.mockResolvedValue(published);
      mocks.sandbox.readBinaryFile.mockResolvedValue(
        scenario === "changed CUE" ? Buffer.from("changed CUE") : cue,
      );
      const run = refreshPlanningSource(ctx as never, "schema-compilation", {
        approvedSchemaCueSha256: approvedCueHash,
      });
      if (scenario === "approved historical cut") {
        await expect(run).resolves.toBe(mocks.sandbox);
        expect(mocks.readPriorRelease).toHaveBeenCalledWith(ctx, releaseId, approvedCueHash);
        expect(mocks.reconcile).toHaveBeenLastCalledWith(
          expect.objectContaining({
            expectedApprovedSchemaCueSha256: approvedCueHash,
            publishedRelease: published,
          }),
        );
      } else {
        await expect(run).rejects.toBe(conflict);
        expect(mocks.readPriorRelease).not.toHaveBeenCalled();
        expect(mocks.reconcile).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("reproves the current approval on resume even when the legacy lookup found the same release", async () => {
    const cue = Buffer.from('manifest: #AppManifest & {version: "v9"}');
    const approvedSchemaCueSha256 = createHash("sha256").update(cue).digest("hex");
    const published = { mergeSha: "c".repeat(40), releaseId: "v8", files: {} };
    mocks.state.workspace.workspaceId = mocks.sandbox.id;
    mocks.state.applyReceipt.changes = [];
    mocks.sandbox.readBinaryFile.mockResolvedValue(cue);
    mocks.retainedReleaseId.mockReturnValueOnce(published.releaseId);
    mocks.recoverRelease.mockResolvedValueOnce(published);
    mocks.reconcile.mockRejectedValueOnce(
      new PlanningReleaseConflictError(published.releaseId, "approved-cue-required"),
    );
    mocks.readPriorRelease.mockResolvedValue(published);
    await expect(
      refreshPlanningSource(ctx as never, "schema-compilation", { approvedSchemaCueSha256 }),
    ).resolves.toBe(mocks.sandbox);
    expect(mocks.recoverRelease).toHaveBeenCalledOnce();
    expect(mocks.readPriorRelease).toHaveBeenCalledWith(
      ctx,
      published.releaseId,
      approvedSchemaCueSha256,
    );
    expect(mocks.reconcile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedApprovedSchemaCueSha256: approvedSchemaCueSha256,
        publishedRelease: published,
      }),
    );
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
  it.each(["reviewed", "validated"])(
    "adopts the verified CUE privately from a settled %s workflow",
    async (phase) => {
      mocks.state.phase = phase;
      mocks.state.applyReceipt.sourceReceiptDigest = mocks.state.sourceReceipt?.digest;
      const reconciliation = { digest: "prior-repair" };
      const publishedRelease = {
        mergeSha: "c".repeat(40),
        releaseId: "v8",
        files: { "app-artifact.json": "d".repeat(64) },
        cueSha256: "e".repeat(64),
      };
      mocks.settledDelivery.mockReturnValueOnce({ subject: { revision: { reconciliation } } });
      mocks.retainedReleaseId.mockReturnValueOnce("v8");
      mocks.recoverRelease.mockResolvedValueOnce(publishedRelease);
      mocks.credential.mockResolvedValueOnce({ token: "fixture-read-token" });
      await expect(
        refreshPlanningSource(ctx as never, "planning", {
          settledRevisionPlanning: "optional-field",
        }),
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
    },
  );
  const settledRefreshedCheckout = () => {
    const oldFoundation = {
      eligibilityDigest: "approved-eligibility",
      sourceReceiptDigest: "approved-source",
      sourceSha: "a".repeat(40),
      sourceTree: "b".repeat(40),
      workspaceDigest: "approved-workspace",
    };
    const currentFoundation = { sourceSha: "d".repeat(40), sourceTree: "e".repeat(40) };
    const appSpec = {
      ...mocks.state.appSpec,
      artifactPath: "app-spec.md",
      artifactRevision: "accepted-revision",
    };
    const proposal = { ...mocks.state.proposal, ...oldFoundation, appSpecDigest: appSpec.digest };
    const applyReceipt = {
      ...mocks.state.applyReceipt,
      ...oldFoundation,
      appSpecDigest: appSpec.digest,
      appSpecPath: appSpec.artifactPath,
      artifactRevision: appSpec.artifactRevision,
      proposalDigest: proposal.digest,
      targetReceipt: { appId: appSpec.appId },
    };
    mocks.state = {
      ...mocks.state,
      appSpec,
      applyReceipt,
      githubSource: {
        digest: "original-binding",
        repository: { name: "repo", owner: "owned", repositoryId: "owned-repo" },
        resolvedRef: "refs/heads/main",
        resolvedSha: currentFoundation.sourceSha,
        resolvedTree: currentFoundation.sourceTree,
      },
      phase: "reviewed",
      proposal,
      sourceReceipt: {
        ...currentFoundation,
        digest: "refreshed-source",
        sourceKind: "existing-repository",
        sourcePath: "/workspace/repository",
      },
      workspace: {
        ...mocks.state.workspace,
        ...currentFoundation,
        sourcePath: "/workspace/repository",
        workspaceDigest: "refreshed-workspace",
        workspaceId: mocks.sandbox.id,
      },
    };
    const reconciliation = { digest: "prior-corrected-repair" };
    const effect = { effectDigest: "corrected-effect", subject: { revision: { reconciliation } } };
    const publishedRelease = {
      mergeSha: "c".repeat(40),
      releaseId: "v8",
      files: { "app-artifact.json": "d".repeat(64) },
      cueSha256: "e".repeat(64),
    };
    mocks.settledDelivery.mockReturnValue(effect);
    mocks.retainedReleaseId.mockReturnValue("v8");
    mocks.recoverRelease.mockResolvedValue(publishedRelease);
    mocks.credential.mockResolvedValue({ token: "fixture-read-token" });
    return { currentFoundation, effect, publishedRelease, reconciliation };
  };

  it("uses the effective corrected delivery to prove a refreshed connected checkout for the next plan", async () => {
    const { currentFoundation, effect, publishedRelease, reconciliation } =
      settledRefreshedCheckout();
    const proofs: (() => void)[] = [];
    await refreshPlanningSource(ctx as never, "planning", {
      settledRevisionPlanning: "optional-field",
      recordSettledSourcePlanningProof: (proof) => {
        proofs.push(proof);
      },
    });
    expect(mocks.recoverRelease).toHaveBeenCalledWith(
      expect.objectContaining({ reconciliationAnchor: reconciliation }),
    );
    expect(mocks.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPreservedSource: {
          sha: currentFoundation.sourceSha,
          tree: currentFoundation.sourceTree,
        },
        preserveSourceHead: true,
        publishedRelease,
      }),
    );
    expect(proofs).toHaveLength(1);
    expect(() => {
      proofs[0]?.();
    }).not.toThrow();
    expect(mocks.updateWorkflow).not.toHaveBeenCalled();
    mocks.settledDelivery.mockReturnValue({ ...effect, effectDigest: "different-effect" });
    expect(() => {
      proofs[0]?.();
    }).toThrow("changed during revision planning");
  });

  it("keeps the historical Build closed when its immutable source does not match the approved proposal", async () => {
    settledRefreshedCheckout();
    mocks.state.applyReceipt = { ...mocks.state.applyReceipt, sourceReceiptDigest: "other-source" };
    const recordSettledSourcePlanningProof = vi.fn<(proof: () => void) => void>();
    await expect(
      refreshPlanningSource(ctx as never, "planning", {
        settledRevisionPlanning: "optional-field",
        recordSettledSourcePlanningProof,
      }),
    ).rejects.toThrow("original Build");
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(recordSettledSourcePlanningProof).not.toHaveBeenCalled();
  });
  const directlyMergedRefreshedCheckout = () => {
    const { currentFoundation, effect } = settledRefreshedCheckout();
    mocks.settledDelivery.mockReturnValue({
      ...effect,
      subject: {
        repositoryId: "owned-repo",
        repositoryFullName: "owned/repo",
        baseBranch: "main",
        installationId: "owned-installation",
      },
    });
    mocks.readSettledMerge.mockResolvedValue("f".repeat(40));
    return { currentFoundation, effect };
  };

  it("proves a directly merged revision for copy edits without restoring generated schema files", async () => {
    const { currentFoundation, effect } = directlyMergedRefreshedCheckout();
    const recordSettledSourcePlanningProof = vi.fn<(proof: () => void) => void>();
    await expect(
      refreshPlanningSource(ctx as never, "planning", {
        settledRevisionPlanning: "existing-files",
        recordSettledSourcePlanningProof,
      }),
    ).resolves.toBe(mocks.sandbox);
    expect(mocks.readSettledMerge).toHaveBeenCalledWith(ctx, effect.effectDigest);
    expect(mocks.inspectCheckout).toHaveBeenCalledWith(mocks.sandbox, {
      repository: "https://github.com/owned/repo.git",
      sourceSha: currentFoundation.sourceSha,
      sourceTree: currentFoundation.sourceTree,
    });
    expect(recordSettledSourcePlanningProof).toHaveBeenCalledOnce();
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.recoverRelease).not.toHaveBeenCalled();
    expect(mocks.updateWorkflow).not.toHaveBeenCalled();
  });

  it("withholds successor planning proof when the reviewed merge or connected checkout is unavailable", async () => {
    directlyMergedRefreshedCheckout();
    const recordSettledSourcePlanningProof = vi.fn<(proof: () => void) => void>();
    const options = {
      settledRevisionPlanning: "existing-files" as const,
      recordSettledSourcePlanningProof,
    };
    mocks.readSettledMerge.mockResolvedValueOnce(null);
    await expect(refreshPlanningSource(ctx as never, "planning", options)).rejects.toThrow(
      "reviewed merge",
    );
    expect(mocks.inspectCheckout).not.toHaveBeenCalled();
    mocks.inspectCheckout.mockRejectedValueOnce(new Error("Selected checkout changed"));
    await expect(refreshPlanningSource(ctx as never, "planning", options)).rejects.toThrow(
      "Selected checkout changed",
    );
    expect(recordSettledSourcePlanningProof).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it("leaves an unsettled connected checkout on the ordinary repair path", async () => {
    directlyMergedRefreshedCheckout();
    mocks.settledDelivery.mockReset();
    const recordSettledSourcePlanningProof = vi.fn<(proof: () => void) => void>();
    await expect(
      refreshPlanningSource(ctx as never, "planning", {
        settledRevisionPlanning: "existing-files",
        recordSettledSourcePlanningProof,
      }),
    ).resolves.toBe(mocks.sandbox);
    expect(recordSettledSourcePlanningProof).not.toHaveBeenCalled();
    expect(mocks.readSettledMerge).not.toHaveBeenCalled();
    expect(mocks.inspectCheckout).not.toHaveBeenCalled();
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
