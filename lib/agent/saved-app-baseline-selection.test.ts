/* oxlint-disable anti-slop/no-module-mocking, sonarjs/no-undefined-assignment -- SAFETY: terminal Eve state/provider seams stay in-memory; actual resolver, access recording, and selection guards execute without external effects. */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImmutableGitHubSourceReceipt } from "../repository/github-publication";
import { createRepositoryObservation } from "../repository/github-publication";
import { appBaselineReceiptSchema, appBaselineSelectionSchema } from "../repository/app-baseline";
import type { assertInitialAppBaseline, SelectedAppBaseline } from "./app-baseline-state";
import type {
  assertExactWorkflowState,
  assertUpstreamMutationAllowed,
  workflowWorkspace,
} from "./workflow-state";
import type {
  recordRepositoryAccessReceipt,
  RepositoryAccessReceipt,
} from "./repository-access-state";
import type { SourceWorkflowState } from "./source-state";
import type { SourceReceipt } from "../repository/source-receipt";
import { inspectExistingRepositorySnapshotReceipt } from "../repository/source-receipt";
import { savedAppBaselineBranchCorrection } from "./saved-app-baseline-selection";
import resolveSource, { inputSchema } from "../../agent/tools/resolve_github_source";
import sourceStatus from "../../agent/tools/source_status";

interface FixtureWorkflow {
  phase: string;
  githubSource?: ImmutableGitHubSourceReceipt;
  sourceReceipt?: SourceReceipt;
}
interface FixtureRuntime {
  access?: RepositoryAccessReceipt;
  baseline?: SelectedAppBaseline;
  baselineUpdate: ReturnType<typeof vi.fn>;
  boundSandbox: ReturnType<typeof vi.fn>;
  classify: ReturnType<typeof vi.fn>;
  inspectBranch: ReturnType<typeof vi.fn>;
  inspectHistorical: ReturnType<typeof vi.fn>;
  inspectWorkspace: ReturnType<typeof vi.fn>;
  prepare: ReturnType<typeof vi.fn>;
  source: SourceWorkflowState;
  sourceUpdate: ReturnType<typeof vi.fn>;
  workflow: FixtureWorkflow;
  workflowUpdate: ReturnType<typeof vi.fn>;
}
const mocks = vi.hoisted((): FixtureRuntime => ({
  baselineUpdate: vi.fn(),
  boundSandbox: vi.fn(),
  classify: vi.fn(),
  inspectBranch: vi.fn(),
  inspectHistorical: vi.fn(),
  inspectWorkspace: vi.fn(),
  prepare: vi.fn(),
  source: { phase: "empty", version: 3 },
  sourceUpdate: vi.fn(),
  workflow: { phase: "empty" },
  workflowUpdate: vi.fn(),
}));
vi.mock("./source-state", () => ({
  APP_BUILDER_SOURCE_VERSION: 3,
  sourceWorkflowState: { get: () => mocks.source, update: mocks.sourceUpdate },
}));
vi.mock("./app-baseline-state", async (importOriginal) => ({
  ...(await importOriginal<{ assertInitialAppBaseline: typeof assertInitialAppBaseline }>()),
  appBaselineState: { get: () => mocks.baseline, update: mocks.baselineUpdate },
}));
vi.mock("./workflow-state", async (importOriginal) => ({
  ...(await importOriginal<{
    assertExactWorkflowState: typeof assertExactWorkflowState;
    assertUpstreamMutationAllowed: typeof assertUpstreamMutationAllowed;
    workflowWorkspace: typeof workflowWorkspace;
  }>()),
  appBuilderWorkflowState: { get: () => mocks.workflow, update: mocks.workflowUpdate },
}));
vi.mock("./repository-access-state", async (importOriginal) => ({
  ...(await importOriginal<{
    recordRepositoryAccessReceipt: typeof recordRepositoryAccessReceipt;
  }>()),
  repositoryAccessReceiptState: {
    get: () => mocks.access,
    update: (update: (current: RepositoryAccessReceipt | undefined) => RepositoryAccessReceipt) => {
      mocks.access = update(mocks.access);
    },
  },
}));
vi.mock("./deployment-repository-access-runtime", () => ({
  repositoryAccessRuntimeForSession: async () =>
    await Promise.resolve({ classify: mocks.classify, prepareExistingSource: mocks.prepare }),
}));
vi.mock("./deployment-github-publication-runtime", () => ({
  githubPublicationRuntimeForSession: async () =>
    await Promise.resolve({
      inspectHistoricalAppSource: mocks.inspectHistorical,
      inspectSourceBranch: mocks.inspectBranch,
    }),
}));
vi.mock("./source-bound-sandbox", () => ({ getSourceBoundSandbox: mocks.boundSandbox }));
vi.mock("../repository/sandbox-github-source", () => ({
  inspectGitHubSourceSandboxWorkspace: mocks.inspectWorkspace,
}));

const seal = <T extends object>(value: T) => ({
  ...value,
  digest: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
});
const repository = createRepositoryObservation({
  defaultBranch: "main",
  headSha: "c".repeat(40),
  headTree: "d".repeat(40),
  installationIdentityDigest: "e".repeat(64),
  name: "arrusted",
  owner: "example",
  releaseGate: { configured: false, name: "REPOSITORY_RELEASE_ENABLED" },
  repositoryId: "100",
  visibility: "private",
});
const githubSource: ImmutableGitHubSourceReceipt = seal({
  installationIdentityDigest: repository.installationIdentityDigest,
  repository,
  resolvedByCallId: "original-resolve",
  resolvedRef: "refs/heads/main",
  resolvedSha: repository.headSha,
  resolvedTree: repository.headTree,
  version: 2,
});
const baseline = (): SelectedAppBaseline => {
  const selection = appBaselineSelectionSchema.parse({
    appId: "spend-review",
    historical: {
      commitSha: "a".repeat(40),
      name: repository.name,
      owner: repository.owner,
      repositoryId: repository.repositoryId,
      treeSha: "b".repeat(40),
    },
    selectedByCallId: "original-resolve",
    sessionId: "owned-session",
    source: { commitSha: "a".repeat(40), kind: "commit" },
  });
  const receipt = appBaselineReceiptSchema.parse(
    seal({
      ...selection,
      platform: {
        commitSha: githubSource.resolvedSha,
        ref: githubSource.resolvedRef,
        treeSha: githubSource.resolvedTree,
      },
      platformSourceDigest: "e".repeat(64),
      projectedByCallId: "original-project",
      removedFiles: 1,
      restoredFiles: 2,
      retainedReleaseFiles: 1,
      sourceDigest: "f".repeat(64),
      unexposedReleaseDigest: "0".repeat(64),
      version: 1,
    }),
  );
  return { receipt, selection };
};
const ctx = () => ({
  abortSignal: new AbortController().signal,
  callId: "retry",
  getSandbox: vi.fn(),
  getToken: vi.fn(),
  requireAuth: (): never => {
    throw new Error("Unexpected auth request");
  },
  session: {
    auth: { current: null, initiator: null },
    id: "owned-session",
    turn: { id: "turn", sequence: 0 },
  },
  toolName: "resolve_github_source",
});
const execute = async (branch: string) =>
  await resolveSource.execute(
    inputSchema.parse({ branch, repository: "example/arrusted", selectedInstallationId: null }),
    ctx(),
  );

describe("saved projected app baseline selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.access = undefined;
    mocks.baseline = baseline();
    const receipt = inspectExistingRepositorySnapshotReceipt({
      contents: {},
      contract: [],
      dirtyPaths: [],
      sourcePath: "/workspace/repository",
      sourceSha: githubSource.resolvedSha,
      sourceTree: githubSource.resolvedTree,
    });
    mocks.source = { githubSource, phase: "reviewed", receipt, version: 3 };
    mocks.workflow = { githubSource, phase: "prepared", sourceReceipt: receipt };
    mocks.classify.mockResolvedValue({
      accessDigest: "1".repeat(64),
      repository: { ...repository, archived: false, repositoryVariableNames: [] },
      scope: { accountLogin: "example", accountType: "Organization", installationId: "10" },
      status: "ready",
    });
    mocks.boundSandbox.mockResolvedValue({ id: "same-sandbox" });
    mocks.inspectWorkspace.mockResolvedValue({ workspaceId: "same-sandbox" });
    mocks.inspectBranch.mockRejectedValue(new Error("GitHub branch inspection HTTP 422"));
  });

  it("keeps fresh access and the same selected source/receipt without inspecting its known app SHA as a branch", async () => {
    const { baseline: saved, source, workflow } = mocks;
    const result = await execute("a".repeat(40));
    expect(mocks.classify).toHaveBeenCalledOnce();
    expect(mocks.inspectBranch).not.toHaveBeenCalled();
    expect(mocks.inspectHistorical).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.boundSandbox).toHaveBeenCalledOnce();
    expect(mocks.inspectWorkspace).toHaveBeenCalledWith({
      githubSource,
      sandbox: { id: "same-sandbox" },
    });
    expect(result).toMatchObject({
      appBaseline: saved?.receipt,
      githubSource,
      selectedSource: { branch: "main" },
      selectionCorrection: {
        historicalAppCommitSha: "a".repeat(40),
        platformRef: "refs/heads/main",
        platformSha: githubSource.resolvedSha,
      },
    });
    expect(mocks.baseline).toBe(saved);
    expect(mocks.source).toBe(source);
    expect(mocks.workflow).toBe(workflow);
    expect(mocks.baselineUpdate).not.toHaveBeenCalled();
    expect(mocks.sourceUpdate).not.toHaveBeenCalled();
    expect(mocks.workflowUpdate).not.toHaveBeenCalled();
    expect(mocks.classify.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.boundSandbox.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it("reuses a moving platform source without a new SHA/tree admission gate", async () => {
    const advanced = { ...githubSource, resolvedSha: "f".repeat(40), resolvedTree: "0".repeat(40) };
    if (mocks.source.phase === "empty") {
      throw new Error("Expected selected source");
    }
    mocks.source.githubSource = advanced;
    mocks.workflow.githubSource = advanced;
    await expect(execute("a".repeat(40))).resolves.toMatchObject({
      githubSource: advanced,
      selectionCorrection: { platformSha: advanced.resolvedSha },
    });
    expect(mocks.inspectBranch).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it.each(["feature/app", "9".repeat(40)])(
    "retains actual branch observations/errors for %s",
    async (branch) => {
      await expect(execute(branch)).rejects.toThrow("GitHub branch inspection HTTP 422");
      expect(mocks.inspectBranch).toHaveBeenCalledWith(
        expect.objectContaining({
          branch,
          name: repository.name,
          owner: repository.owner,
          repositoryId: repository.repositoryId,
        }),
      );
      expect(mocks.boundSandbox).not.toHaveBeenCalled();
    },
  );

  it("does not coerce a SHA without a prepared saved baseline", async () => {
    mocks.baseline = { selection: baseline().selection };
    await expect(execute("a".repeat(40))).rejects.toThrow("GitHub branch inspection HTTP 422");
    mocks.baseline = undefined;
    await expect(execute("a".repeat(40))).rejects.toThrow("GitHub branch inspection HTTP 422");
    expect(mocks.inspectBranch).toHaveBeenCalledTimes(2);
  });

  it("fails fresh access before branch correction or workspace observation", async () => {
    mocks.classify.mockRejectedValueOnce(new Error("Current owner access unavailable"));
    await expect(execute("a".repeat(40))).rejects.toThrow("Current owner access unavailable");
    expect(mocks.inspectBranch).not.toHaveBeenCalled();
    expect(mocks.boundSandbox).not.toHaveBeenCalled();
  });

  it("does not silently coerce a foreign-session SHA request or an unoccupied workflow", async () => {
    const foreign = ctx();
    foreign.session.id = "foreign-session";
    await expect(
      resolveSource.execute(
        inputSchema.parse({
          branch: "a".repeat(40),
          repository: "example/arrusted",
          selectedInstallationId: null,
        }),
        foreign,
      ),
    ).rejects.toThrow("GitHub branch inspection HTTP 422");
    mocks.access = undefined;
    mocks.workflow = { phase: "empty" };
    await expect(execute("a".repeat(40))).rejects.toThrow("GitHub branch inspection HTTP 422");
    expect(mocks.inspectBranch).toHaveBeenCalledTimes(2);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("never corrects foreign session/repository authority or a mismatched projection selection", () => {
    const selected = baseline();
    const input = {
      baseline: selected,
      branch: "a".repeat(40),
      githubSource,
      repository,
      sessionId: "owned-session",
    };
    expect(savedAppBaselineBranchCorrection({ ...input, sessionId: "foreign-session" })).toBeNull();
    expect(
      savedAppBaselineBranchCorrection({
        ...input,
        repository: { ...repository, owner: "foreign" },
      }),
    ).toBeNull();
    expect(
      savedAppBaselineBranchCorrection({
        ...input,
        repository: { ...repository, name: "foreign" },
      }),
    ).toBeNull();
    expect(
      savedAppBaselineBranchCorrection({
        ...input,
        repository: { ...repository, repositoryId: "101" },
      }),
    ).toBeNull();
    expect(
      savedAppBaselineBranchCorrection({
        ...input,
        baseline: {
          ...selected,
          selection: { ...selected.selection, selectedByCallId: "other-selection" },
        },
      }),
    ).toBeNull();
  });

  it("reports actual baseline receipt summary separately from platform sourceSha", async () => {
    await expect(sourceStatus.execute({}, ctx())).resolves.toMatchObject({
      appBaseline: {
        appId: "spend-review",
        commitSha: "a".repeat(40),
        receiptDigest: mocks.baseline?.receipt?.digest,
        status: "prepared",
      },
      sourceShaScope: "platform",
    });
  });

  it("does not report absent, pending or foreign baselines as prepared", async () => {
    mocks.baseline = undefined;
    expect(await sourceStatus.execute({}, ctx())).not.toHaveProperty("appBaseline");
    mocks.baseline = { selection: baseline().selection };
    await expect(sourceStatus.execute({}, ctx())).resolves.toMatchObject({
      appBaseline: { status: "pending" },
    });
    mocks.baseline = baseline();
    const foreign = ctx();
    foreign.session.id = "foreign-session";
    expect(await sourceStatus.execute({}, foreign)).not.toHaveProperty("appBaseline");
  });
});
