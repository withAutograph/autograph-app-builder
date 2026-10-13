import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "eve/tools";

import sourceStatus from "../../agent/tools/source_status";
import workspaceStatus from "../../agent/tools/workspace_status";
import { appBaselineState } from "./app-baseline-state";
import type { SelectedAppBaseline } from "./app-baseline-state";
import { appBuilderWorkflowState, APP_BUILDER_WORKFLOW_VERSION } from "./workflow-state";
import type {
  AppBuilderWorkflowState,
  DependencyPreparationReceipt,
  TargetIdentityReceipt,
} from "./workflow-state";
import { sourceWorkflowState } from "./source-state";
import type { SourceWorkflowState } from "./source-state";
import { appBaselineReceiptSchema, appBaselineSelectionSchema } from "../repository/app-baseline";
import { createRepositoryObservation } from "../repository/github-publication";
import type { ImmutableGitHubSourceReceipt } from "../repository/github-publication";
import { inspectExistingRepositorySnapshotReceipt } from "../repository/source-receipt";
import { SUPPORTED_TEMPLATE_ADAPTER } from "../repository/supported-template";
import type { PreparedSandboxWorkspace } from "../repository/supported-template";
import type { TargetIdentity } from "../repository/target-planning";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const seal = <T extends object>(value: T) => ({ ...value, digest: sha256(JSON.stringify(value)) });
const sessionId = "status-session";
const platformSha = "a".repeat(40);
const platformTree = "b".repeat(40);
const historicalSha = "c".repeat(40);
const historicalTree = "d".repeat(40);
const repository = createRepositoryObservation({
  defaultBranch: "main",
  headSha: platformSha,
  headTree: platformTree,
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
  resolvedByCallId: "resolve",
  resolvedRef: "refs/heads/main",
  resolvedSha: platformSha,
  resolvedTree: platformTree,
  version: 2,
});
const sourceReceipt = inspectExistingRepositorySnapshotReceipt({
  contents: {},
  contract: [],
  dirtyPaths: [],
  sourcePath: "/workspace/repository",
  sourceSha: platformSha,
  sourceTree: platformTree,
});
const workspace: PreparedSandboxWorkspace = {
  adapter: SUPPORTED_TEMPLATE_ADAPTER,
  eligibilityDigest: "f".repeat(64),
  sourcePath: "/workspace/repository",
  sourceSha: platformSha,
  sourceTree: platformTree,
  workspaceDigest: "1".repeat(64),
  workspaceId: "workspace-1",
  workspacePath: "/workspace/repository",
};

const baseline = (input: { session?: string; prepared?: boolean } = {}): SelectedAppBaseline => {
  const selection = appBaselineSelectionSchema.parse({
    appId: "spend-review",
    historical: {
      commitSha: historicalSha,
      name: repository.name,
      owner: repository.owner,
      repositoryId: repository.repositoryId,
      treeSha: historicalTree,
    },
    selectedByCallId: "resolve",
    sessionId: input.session ?? sessionId,
    source: { commitSha: historicalSha, kind: "commit" },
  });
  if (input.prepared === false) {
    return { selection };
  }
  const receipt = appBaselineReceiptSchema.parse(
    seal({
      ...selection,
      platform: { commitSha: platformSha, ref: "refs/heads/main", treeSha: platformTree },
      platformSourceDigest: "2".repeat(64),
      projectedByCallId: "resolve",
      removedFiles: 1,
      restoredFiles: 2,
      retainedReleaseFiles: 0,
      sourceDigest: "3".repeat(64),
      unexposedReleaseDigest: "4".repeat(64),
      version: 1,
    }),
  );
  return { receipt, selection };
};

const sourceState: SourceWorkflowState = {
  githubSource,
  phase: "reviewed",
  receipt: sourceReceipt,
  version: 3,
};

const context: ToolContext = {
  abortSignal: new AbortController().signal,
  callId: "status",
  getSandbox: async () =>
    await Promise.reject(new Error("Simulated target must not open a sandbox.")),
  getToken: async () => await Promise.resolve({ token: "unused" }),
  requireAuth: () => {
    throw new Error("Status tools must not request authorization.");
  },
  session: {
    auth: { current: null, initiator: null },
    id: sessionId,
    turn: { id: "turn", sequence: 0 },
  },
  toolName: "source_status",
};

const acceptedAppSpec = {
  acceptedByCallId: "accept-spec",
  appId: "spend-review",
  artifactPath: "prototype/spend-review/app-spec.md",
  artifactRevision: "5".repeat(64),
  digest: "6".repeat(64),
};

const dependencyReceipt: DependencyPreparationReceipt = {
  appSpecDigest: acceptedAppSpec.digest,
  artifactRevision: acceptedAppSpec.artifactRevision,
  cacheContentDigest: "7".repeat(64),
  cacheManifestDigest: "8".repeat(64),
  dependencyCacheDigest: `sha256:${"9".repeat(64)}`,
  dependencyLayout: { kind: "fixture", roots: [], version: 1, workspaceLinks: [] },
  digest: "a".repeat(64),
  eligibilityDigest: workspace.eligibilityDigest,
  imageDigest: `fixture@sha256:${"0".repeat(64)}`,
  preparedByCallId: "prepare-dependencies",
  sourceReceiptDigest: sourceReceipt.digest,
  sourceSha: platformSha,
  sourceTree: platformTree,
  targetSha: platformSha,
  targetTree: platformTree,
  version: 2,
  workspaceDigest: workspace.workspaceDigest,
};

const identity: TargetIdentity = {
  appId: "spend-review",
  appSpecPath: ".config/app-specs/spend-review.md",
  appSpecSourcePath: ".config/app-specs/spend-review.md",
  baseRoutes: ["/", "/reviews"],
  cueSourcePath: "apps/spend-review/schema.cue",
  packageName: "@autograph/spend-review",
  projectName: "spend-review",
  schemaCuePath: "apps/spend-review/schema.cue",
  title: "Spend Review",
  workspacePath: "apps/spend-review",
};

const identityReceipt: TargetIdentityReceipt = {
  appSpecDigest: acceptedAppSpec.digest,
  artifactRevision: acceptedAppSpec.artifactRevision,
  dependencyCacheDigest: dependencyReceipt.dependencyCacheDigest,
  digest: "b".repeat(64),
  eligibilityDigest: workspace.eligibilityDigest,
  identity,
  imageDigest: dependencyReceipt.imageDigest,
  resolvedByCallId: "resolve-identity",
  sourceReceiptDigest: sourceReceipt.digest,
  sourceSha: platformSha,
  sourceTree: platformTree,
  version: 1,
  workspaceDigest: workspace.workspaceDigest,
};

const workflowState = (
  phase: "app_spec_accepted" | "dependencies_prepared" | "identity_resolved",
): Extract<
  AppBuilderWorkflowState,
  { phase: "app_spec_accepted" | "dependencies_prepared" | "identity_resolved" }
> => {
  const shared = {
    artifacts: [],
    githubSource,
    preparedByCallId: "prepare",
    sourceReceipt,
    version: APP_BUILDER_WORKFLOW_VERSION,
    workspace,
  } as const;
  if (phase === "app_spec_accepted") {
    return { ...shared, appSpec: acceptedAppSpec, phase };
  }
  if (phase === "dependencies_prepared") {
    return { ...shared, appSpec: acceptedAppSpec, dependencyReceipt, phase };
  }
  return { ...shared, appSpec: acceptedAppSpec, dependencyReceipt, identityReceipt, phase };
};

describe("source and workspace status guidance", () => {
  const getSourceState = vi.spyOn(sourceWorkflowState, "get");
  const getBaselineState = vi.spyOn(appBaselineState, "get");
  const getWorkflowState = vi.spyOn(appBuilderWorkflowState, "get");
  const updateWorkflowState = vi.spyOn(appBuilderWorkflowState, "update");

  beforeEach(() => {
    vi.clearAllMocks();
    getSourceState.mockReturnValue(sourceState);
    getBaselineState.mockReturnValue(baseline());
    getWorkflowState.mockReturnValue({ phase: "empty", version: APP_BUILDER_WORKFLOW_VERSION });
  });

  it("explains a prepared historical app baseline on the platform checkout", async () => {
    const result = await sourceStatus.execute({}, context);
    if (!("appBaseline" in result)) {
      throw new Error("Expected the owned prepared baseline summary.");
    }
    if (result.appBaseline.status !== "prepared") {
      throw new Error("Expected the owned prepared baseline summary.");
    }
    expect(result).toMatchObject({
      appBaseline: {
        commitSha: historicalSha,
        status: "prepared",
      },
      receipt: { sourceSha: platformSha },
      sourceShaScope: "platform",
    });
    expect(result.appBaseline.guidance).toContain("no separate activation or HEAD switch");
    expect(result.appBaseline).not.toHaveProperty("active");
    expect(result.appBaseline).not.toHaveProperty("ready");
    expect(result.appBaseline.guidance).toContain("Platform Git HEAD, including main");
    expect(result.appBaseline.guidance).toContain("appBaseline.commitSha");
    expect(updateWorkflowState).not.toHaveBeenCalled();
  });

  it("keeps pending and foreign baselines distinct from owned prepared guidance", async () => {
    getBaselineState.mockReturnValue(baseline({ prepared: false }));
    const pending = await sourceStatus.execute({}, context);
    if (!("appBaseline" in pending)) {
      throw new Error("Expected the owned pending baseline summary.");
    }
    expect(pending.appBaseline).toMatchObject({ commitSha: historicalSha, status: "pending" });
    expect(pending.appBaseline).not.toHaveProperty("guidance");

    getBaselineState.mockReturnValue(baseline({ session: "another-session" }));
    const foreign = await sourceStatus.execute({}, context);
    expect(foreign).not.toHaveProperty("appBaseline");
    expect(foreign).toMatchObject({ sourceShaScope: "platform" });
    expect(updateWorkflowState).not.toHaveBeenCalled();
  });

  it("keeps prepared-baseline guidance when the selected platform ref changes", async () => {
    const movedPlatformSha = "5".repeat(40);
    const movedPlatformTree = "6".repeat(40);
    const movedRepository = createRepositoryObservation({
      defaultBranch: "main",
      headSha: movedPlatformSha,
      headTree: movedPlatformTree,
      installationIdentityDigest: repository.installationIdentityDigest,
      name: repository.name,
      owner: repository.owner,
      releaseGate: { configured: false, name: "REPOSITORY_RELEASE_ENABLED" },
      repositoryId: repository.repositoryId,
      visibility: "private",
    });
    const movedSource: ImmutableGitHubSourceReceipt = seal({
      installationIdentityDigest: movedRepository.installationIdentityDigest,
      repository: movedRepository,
      resolvedByCallId: "refresh",
      resolvedRef: "refs/heads/release",
      resolvedSha: movedPlatformSha,
      resolvedTree: movedPlatformTree,
      version: 2,
    });
    const movedSourceReceipt = inspectExistingRepositorySnapshotReceipt({
      contents: {},
      contract: [],
      dirtyPaths: [],
      sourcePath: "/workspace/repository",
      sourceSha: movedPlatformSha,
      sourceTree: movedPlatformTree,
    });
    getSourceState.mockReturnValue({
      ...sourceState,
      githubSource: movedSource,
      receipt: movedSourceReceipt,
    });
    getWorkflowState.mockReturnValue({
      ...workflowState("app_spec_accepted"),
      githubSource: movedSource,
      sourceReceipt: movedSourceReceipt,
    });

    const result = await sourceStatus.execute({}, context);
    if (!("appBaseline" in result)) {
      throw new Error("Expected the owned prepared baseline summary after source refresh.");
    }
    if (result.appBaseline.status !== "prepared") {
      throw new Error("Expected the owned prepared baseline summary after source refresh.");
    }
    expect(result.appBaseline).toMatchObject({ commitSha: historicalSha, status: "prepared" });
    expect(result.appBaseline.guidance).toContain("selected platform checkout");
    expect(result.appBaseline).not.toHaveProperty("platformRef");
    expect(updateWorkflowState).not.toHaveBeenCalled();
  });

  it.each(["app_spec_accepted", "dependencies_prepared", "identity_resolved"] as const)(
    "gives an advisory planning action at %s without creating a proposal or approval",
    async (phase) => {
      const accepted = workflowState(phase);
      getWorkflowState.mockReturnValue(accepted);
      const result = await workspaceStatus.execute({}, context);
      if (!("nextAction" in result) || !("appSpec" in result)) {
        throw new Error("Expected status guidance for an accepted AppSpec without a proposal.");
      }
      expect(result).toMatchObject({
        phase,
      });
      expect(result.nextAction).toContain("canonical implementation proposal");
      expect(result.nextAction).toContain("existingAppChanges");
      expect(result.nextAction).toContain("complete replacement contents");
      expect(result.nextAction).toContain("without applying app files");
      expect(result.nextAction).toContain("normal Build approval");
      expect(result).not.toHaveProperty("proposal");
      expect(result.appSpec).not.toHaveProperty("approvalReceipt");
      expect(getWorkflowState()).toBe(accepted);
      expect(updateWorkflowState).not.toHaveBeenCalled();
    },
  );
});
