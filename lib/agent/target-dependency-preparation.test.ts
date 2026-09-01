import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolContext } from "eve/tools";

import type { AppBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { DependencyCacheMissingError } from "@/lib/repository/dependency-cache";

const mocks = vi.hoisted(() => {
  const workspace = {
    workspaceId: "sandbox",
    workspacePath: "/workspace/repository",
    sourcePath: "/source",
    sourceSha: "a".repeat(40),
    sourceTree: "b".repeat(40),
    workspaceDigest: "c".repeat(64),
    adapter: "arrusted-development-v0",
    eligibilityDigest: "d".repeat(64),
  } as const;
  const cache = {
    manifest: {
      version: 2,
      scope: "development-execution",
      platform: "linux/arm64",
      dependencyKey: "1".repeat(64),
      lockfiles: {
        ".config/mise/config.toml": "2".repeat(64),
        ".config/mise/mise.lock": "3".repeat(64),
        "bun.lock": "4".repeat(64),
        "Cargo.lock": "5".repeat(64),
      },
      runtime: {
        node: "24.18.0",
        bun: "1.3.14",
        mise: "2026.8.12",
        rust: "1.97.1",
      },
      closure: {
        package: "@vercel/microfrontends",
        version: "2.4.0",
        archivePath: "/opt/app-builder/dependency-cache/node-modules.tar.gz",
        archiveSha256: "6".repeat(64),
        archiveBytes: 1,
        cargoArchivePath:
          "/opt/app-builder/dependency-cache/cargo-closure.tar.gz",
        cargoArchiveSha256: "7".repeat(64),
        cargoArchiveBytes: 1,
      },
    },
    manifestDigest: "8".repeat(64),
    contentDigest: "6".repeat(64),
  } as const;
  class MissingDependencyCache extends Error {
    readonly code = "dependency_cache_missing" as const;
  }
  return {
    current: undefined as AppBuilderWorkflowState | undefined,
    workspace,
    cache,
    MissingDependencyCache,
    exactPrototypeArtifact: vi.fn(),
    assertUpstreamMutationAllowed: vi.fn(),
    bootstrapLiveTemplateDependencies: vi.fn(async () => cache),
    inspectDependencyCache: vi.fn(async () => cache),
    materializeOfflineDependencies: vi.fn(async () => cache),
    materializePlanningOverlay: vi.fn(async () => undefined),
    inspectSourceBoundSandboxWorkspace: vi.fn(async () => undefined),
    executeTargetIdentityAndPlanning: vi.fn(),
  };
});

vi.mock("@/lib/agent/prototype-artifacts", () => ({
  exactPrototypeArtifact: mocks.exactPrototypeArtifact,
}));

vi.mock("@/lib/agent/workflow-state", () => ({
  APP_BUILDER_WORKFLOW_VERSION: 15,
  appBuilderWorkflowState: {
    get: () => mocks.current,
    update: (
      update: (current: AppBuilderWorkflowState) => AppBuilderWorkflowState,
    ) => {
      if (mocks.current === undefined) throw new Error("missing test state");
      mocks.current = update(mocks.current);
    },
  },
  assertExactWorkflowState: (
    latest: AppBuilderWorkflowState,
    expected: AppBuilderWorkflowState,
  ) => {
    expect(latest).toEqual(expected);
  },
  assertUpstreamMutationAllowed: mocks.assertUpstreamMutationAllowed,
  sha256: () => "f".repeat(64),
}));

vi.mock("@/lib/repository/dependency-cache", () => ({
  DependencyCacheMissingError: mocks.MissingDependencyCache,
  assertExactDependencyTargetBinding: ({
    workspace,
    sourceReceipt,
    dependencyReceipt,
  }: {
    workspace: { sourceSha: string; sourceTree: string };
    sourceReceipt: { sourceSha: string; sourceTree: string };
    dependencyReceipt?: {
      sourceSha: string;
      sourceTree: string;
      targetSha: string;
      targetTree: string;
    };
  }) => {
    if (
      workspace.sourceSha !== sourceReceipt.sourceSha ||
      workspace.sourceTree !== sourceReceipt.sourceTree ||
      (dependencyReceipt !== undefined &&
        (dependencyReceipt.sourceSha !== workspace.sourceSha ||
          dependencyReceipt.sourceTree !== workspace.sourceTree ||
          dependencyReceipt.targetSha !== workspace.sourceSha ||
          dependencyReceipt.targetTree !== workspace.sourceTree))
    )
      throw new Error(
        "The prepared source does not match the immutable dependency target.",
      );
  },
  bootstrapLiveTemplateDependencies: mocks.bootstrapLiveTemplateDependencies,
  dependencyTargetForWorkspace: (
    _cache: unknown,
    workspace: { sourceSha: string; sourceTree: string },
  ) => ({ sha: workspace.sourceSha, tree: workspace.sourceTree }),
  inspectDependencyCache: mocks.inspectDependencyCache,
  materializeOfflineDependencies: mocks.materializeOfflineDependencies,
}));

vi.mock("@/lib/repository/source-receipt", () => ({
  SOURCE_RECEIPT_VERSION: 4,
}));

vi.mock("@/lib/repository/arrusted-template", () => ({
  inspectSourceBoundSandboxWorkspace: mocks.inspectSourceBoundSandboxWorkspace,
}));

vi.mock("@/lib/repository/target-planning", () => ({
  executeTargetIdentityAndPlanning: mocks.executeTargetIdentityAndPlanning,
  fixtureTargetCommandExecutor: () => ({ kind: "fixture" }),
  materializePlanningOverlay: mocks.materializePlanningOverlay,
  sandboxTargetCommandExecutor: () => ({ kind: "sandbox" }),
  targetExecutionBinding: () => ({
    fixture: true,
    imageDigest: `fixture@sha256:${"9".repeat(64)}`,
    dependencyCacheDigest: `sha256:${mocks.cache.manifestDigest}`,
  }),
}));

vi.mock(
  "@/lib/agent/target-dependency-preparation",
  async () => import("./target-dependency-preparation"),
);

import planAppCreation from "../../agent/tools/plan_app_creation";
import prepareTargetDependencies from "../../agent/tools/prepare_target_dependencies";

const appSpecDigest = "e".repeat(64);
const artifactRevision = "0".repeat(64);

function acceptedState(
  workspace: typeof mocks.workspace = mocks.workspace,
): AppBuilderWorkflowState {
  return {
    version: 15,
    phase: "app_spec_accepted",
    preparedByCallId: "prepare-call",
    workspace,
    sourceReceipt: {
      version: 4,
      sourceKind: "fresh-template",
      sourcePath: workspace.sourcePath,
      sourceSha: workspace.sourceSha,
      sourceTree: workspace.sourceTree,
      adapter: "arrusted-development-v0",
      eligibilityDigest: workspace.eligibilityDigest,
      contractDigest: "a".repeat(64),
      releaseEnabled: false,
      provenance: {
        repository: "https://github.com/withAutograph/arrusted-development.git",
        ref: "refs/heads/main",
        method: "git-clone-v1",
        readinessDigest: "b".repeat(64),
      },
      digest: "c".repeat(64),
    },
    artifacts: [
      {
        appId: "expense-review",
        path: "prototype/expense-review/app-spec.md",
        mediaType: "text/markdown",
        content: "accepted",
        digest: appSpecDigest,
        revision: artifactRevision,
        sessionId: "session-1",
        recordedByCallId: "artifact-call",
      },
    ],
    appSpec: {
      appId: "expense-review",
      artifactPath: "prototype/expense-review/app-spec.md",
      content: "accepted",
      digest: appSpecDigest,
      acceptedByCallId: "accept-call",
      artifactRevision,
    },
  };
}

function toolContext(callId = "plan-call") {
  const sandbox = { id: "sandbox" };
  const getSandbox = vi.fn(async () => sandbox);
  return {
    context: {
      callId,
      session: { id: "session-1" },
      getSandbox,
    } as unknown as ToolContext,
    getSandbox,
  };
}

function planningResult() {
  mocks.executeTargetIdentityAndPlanning.mockImplementationOnce(
    async ({ onIdentity }) => {
      onIdentity({
        appId: "expense-review",
        workspacePath: "apps/expense-review",
        packageName: "@autograph/expense-review",
        projectName: "apps-expense-review",
        baseRoutes: ["/expense-review", "/expense-review/:path*"],
        appSpecPath: "prototype/expense-review/app-spec.md",
        contractPath: "apps/expense-review/app.contract.json",
        kernelSchemaPath:
          "apps/expense-review/schema/expense-review-schema.json",
      });
      return {
        contractDigest: "d".repeat(64),
        proposal: { appId: "expense-review" },
      };
    },
  );
}

describe("target dependency preparation", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    mocks.current = undefined;
    mocks.inspectDependencyCache.mockImplementation(async () => mocks.cache);
    mocks.materializeOfflineDependencies.mockImplementation(
      async () => mocks.cache,
    );
  });

  it("lets planning prepare dependencies without selecting the diagnostic tool", async () => {
    mocks.current = acceptedState();
    planningResult();
    const { context, getSandbox } = toolContext();

    const result = await planAppCreation.execute(
      { expectedAppSpecDigest: appSpecDigest },
      context,
    );

    expect(result).toMatchObject({ reused: false });
    expect(mocks.current).toMatchObject({
      phase: "planned",
      dependencyReceipt: { preparedByCallId: "plan-call" },
      proposal: { plannedByCallId: "plan-call" },
    });
    expect(getSandbox).toHaveBeenCalledTimes(1);
    expect(mocks.bootstrapLiveTemplateDependencies).not.toHaveBeenCalled();
    expect(mocks.materializePlanningOverlay).toHaveBeenCalledTimes(1);
    expect(mocks.materializeOfflineDependencies).toHaveBeenCalledTimes(1);
    expect(mocks.executeTargetIdentityAndPlanning).toHaveBeenCalledTimes(1);
  });

  it("forwards ordered existing-app replacements without binding them to identity", async () => {
    mocks.current = acceptedState();
    planningResult();
    const existingAppChanges = [
      {
        path: "apps/expense-review/app/page.tsx",
        content: "export default function Page() { return 'updated'; }\n",
      },
      {
        path: "apps/expense-review/components/empty-state.tsx",
        content: "export function EmptyState() { return 'ready'; }\n",
      },
    ];

    await planAppCreation.execute(
      { expectedAppSpecDigest: appSpecDigest, existingAppChanges },
      toolContext().context,
    );

    expect(mocks.executeTargetIdentityAndPlanning).toHaveBeenCalledWith(
      expect.objectContaining({ existingAppChanges }),
    );
    expect(
      mocks.executeTargetIdentityAndPlanning.mock.calls[0]?.[0]
        .existingAppChanges,
    ).toEqual(existingAppChanges);
    expect(mocks.current).toMatchObject({ phase: "planned" });
    if (mocks.current?.phase !== "planned")
      throw new Error("planning fixture did not settle");
    expect(mocks.current.identityReceipt).not.toHaveProperty(
      "existingAppChanges",
    );
  });

  it("reuses one development closure for code-only source changes", async () => {
    vi.stubEnv("APP_BUILDER_EXECUTION_MODE", "development");
    const firstContext = toolContext("first-call");
    mocks.current = acceptedState();
    await prepareTargetDependencies.execute(
      { expectedAppSpecDigest: appSpecDigest },
      firstContext.context,
    );

    const changedWorkspace = {
      ...mocks.workspace,
      sourceSha: "1".repeat(40),
      sourceTree: "2".repeat(40),
      workspaceDigest: "3".repeat(64),
    } as const;
    mocks.current = acceptedState(changedWorkspace);
    await prepareTargetDependencies.execute(
      { expectedAppSpecDigest: appSpecDigest },
      toolContext("second-call").context,
    );
    planningResult();
    await planAppCreation.execute(
      { expectedAppSpecDigest: appSpecDigest },
      toolContext("plan-call").context,
    );

    expect(mocks.bootstrapLiveTemplateDependencies).not.toHaveBeenCalled();
    expect(mocks.inspectDependencyCache).toHaveBeenCalledTimes(3);
    expect(mocks.inspectDependencyCache).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ APP_BUILDER_EXECUTION_MODE: "development" }),
      mocks.workspace,
      false,
    );
    expect(mocks.inspectDependencyCache).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      expect.objectContaining({ APP_BUILDER_EXECUTION_MODE: "development" }),
      changedWorkspace,
      false,
    );
    expect(mocks.current).toMatchObject({
      phase: "planned",
      dependencyReceipt: {
        sourceSha: changedWorkspace.sourceSha,
        sourceTree: changedWorkspace.sourceTree,
        cacheContentDigest: mocks.cache.contentDigest,
      },
    });
  });

  it("reuses a durable receipt without repeating materialization", async () => {
    mocks.current = acceptedState();
    const first = await prepareTargetDependencies.execute(
      { expectedAppSpecDigest: appSpecDigest },
      toolContext("first-call").context,
    );
    const retry = await prepareTargetDependencies.execute(
      { expectedAppSpecDigest: appSpecDigest },
      toolContext("retry-call").context,
    );

    expect(first).toMatchObject({ reused: false });
    expect(retry).toMatchObject({ reused: true });
    expect(mocks.materializePlanningOverlay).toHaveBeenCalledTimes(1);
    expect(mocks.materializeOfflineDependencies).toHaveBeenCalledTimes(1);
  });

  it("bootstraps only a typed hosted cache miss", async () => {
    mocks.current = acceptedState();
    mocks.inspectDependencyCache
      .mockRejectedValueOnce(
        new DependencyCacheMissingError("hosted cache missing"),
      )
      .mockResolvedValue(mocks.cache);

    await prepareTargetDependencies.execute(
      { expectedAppSpecDigest: appSpecDigest },
      toolContext().context,
    );

    expect(mocks.bootstrapLiveTemplateDependencies).toHaveBeenCalledTimes(1);
  });

  it("rejects stale source and cache bindings instead of repairing them", async () => {
    const stale = acceptedState();
    if (stale.phase !== "app_spec_accepted") throw new Error("invalid fixture");
    mocks.current = {
      ...stale,
      sourceReceipt: {
        ...stale.sourceReceipt,
        sourceTree: "4".repeat(40),
      },
    };
    await expect(
      prepareTargetDependencies.execute(
        { expectedAppSpecDigest: appSpecDigest },
        toolContext().context,
      ),
    ).rejects.toThrow("prepared source does not match");
    expect(mocks.materializePlanningOverlay).not.toHaveBeenCalled();

    mocks.current = acceptedState();
    await prepareTargetDependencies.execute(
      { expectedAppSpecDigest: appSpecDigest },
      toolContext("first-call").context,
    );
    mocks.inspectDependencyCache.mockResolvedValueOnce({
      ...mocks.cache,
      contentDigest: "4".repeat(64),
    });
    await expect(
      prepareTargetDependencies.execute(
        { expectedAppSpecDigest: appSpecDigest },
        toolContext("retry-call").context,
      ),
    ).rejects.toThrow("changed after its durable receipt");
    expect(mocks.materializeOfflineDependencies).toHaveBeenCalledTimes(1);
  });

  it("rejects a stale design digest before sandbox or cache access", async () => {
    mocks.current = acceptedState();
    const { context, getSandbox } = toolContext();

    await expect(
      planAppCreation.execute(
        { expectedAppSpecDigest: "5".repeat(64) },
        context,
      ),
    ).rejects.toThrow("changed before dependency preparation");

    expect(getSandbox).not.toHaveBeenCalled();
    expect(mocks.inspectDependencyCache).not.toHaveBeenCalled();
    expect(mocks.materializePlanningOverlay).not.toHaveBeenCalled();
  });
});
