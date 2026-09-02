import type { SandboxSession } from "eve/sandbox";

import { exactPrototypeArtifact } from "@/lib/agent/prototype-artifacts";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  assertExactDependencyPreparationReceipt,
  assertExactWorkflowState,
  sha256,
  type AppBuilderWorkflowState,
  type DependencyPreparationReceipt,
} from "@/lib/agent/workflow-state";
import {
  assertExactDependencyTargetBinding,
  bootstrapLiveTemplateDependencies,
  DependencyCacheMissingError,
  dependencyExecutionLayout,
  dependencyTargetForWorkspace,
  inspectDependencyCache,
  materializeOfflineDependencies,
  shouldPreferLiveTemplateDependencies,
  type ObservedDependencyCache,
} from "@/lib/repository/dependency-cache";
import {
  DEVELOPMENT_SANDBOX_DOWNLOAD_HOSTS,
  developmentVercelDependencyRepairCommand,
} from "@/lib/sandbox/development-toolchain";
import {
  materializePlanningOverlay,
  targetExecutionBinding,
} from "@/lib/repository/target-planning";
import { inspectSourceBoundSandboxWorkspace } from "@/lib/repository/arrusted-template";
import {
  canAutoSelectDevelopmentSource,
  developmentSourceReceipt,
} from "@/lib/repository/development-source";

function planningMarker(
  marker: string,
  phase: "start" | "finish" | "hit" | "miss" | "repair",
) {
  if (process.env.APP_BUILDER_EXECUTION_BUNDLE === "local-development")
    console.info(`[app-builder planning] ${marker} ${phase}`);
}

type DependencyPreparationState = Exclude<
  AppBuilderWorkflowState,
  { phase: "empty" | "prepared" | "ui_previewed" | "ui_accepted" }
>;

export type DependencyReadyState = Exclude<
  DependencyPreparationState,
  { phase: "app_spec_accepted" }
>;

export type TargetDependencyPreparationResult = {
  state: DependencyReadyState;
  sandbox: SandboxSession;
  cache: ObservedDependencyCache;
  receipt: DependencyPreparationReceipt;
  reused: boolean;
};

async function repairDevelopmentDependencyCache(input: {
  sandbox: SandboxSession;
  environment: Readonly<Record<string, string | undefined>>;
}) {
  const dependencyKey =
    input.environment.APP_BUILDER_DEVELOPMENT_DEPENDENCY_KEY;
  if (
    input.environment.APP_BUILDER_EXECUTION_MODE !== "development" ||
    dependencyKey === undefined
  )
    throw new Error("Development dependency repair was not authorized.");
  await input.sandbox.setNetworkPolicy({
    allow: [...DEVELOPMENT_SANDBOX_DOWNLOAD_HOSTS],
  });
  const result = await (async () => {
    try {
      return await input.sandbox.run({
        command: developmentVercelDependencyRepairCommand(dependencyKey),
        workingDirectory: "/workspace",
        abortSignal: AbortSignal.timeout(900_000),
      });
    } finally {
      await input.sandbox.setNetworkPolicy("deny-all");
    }
  })();
  if (result.exitCode !== 0) {
    const stage = result.stderr.match(
      /development_vercel_repair_failed:([a-z-]+)/u,
    )?.[1];
    throw new Error(
      `The development dependency cache could not be prepared (${stage ?? "unknown-stage"}).`,
    );
  }
}

function assertReceiptMatchesCache(
  receipt: DependencyPreparationReceipt,
  cache: ObservedDependencyCache,
  environment: Readonly<Record<string, string | undefined>>,
) {
  assertExactDependencyPreparationReceipt(receipt);
  const execution = targetExecutionBinding(cache, environment);
  const dependencyLayout = dependencyExecutionLayout(cache, environment);
  if (
    receipt.imageDigest !== execution.imageDigest ||
    receipt.dependencyCacheDigest !== execution.dependencyCacheDigest ||
    receipt.cacheManifestDigest !== cache.manifestDigest ||
    receipt.cacheContentDigest !== cache.contentDigest ||
    JSON.stringify(receipt.dependencyLayout) !==
      JSON.stringify(dependencyLayout)
  )
    throw new Error(
      "The offline dependency cache changed after its durable receipt.",
    );
  return execution;
}

/**
 * Establishes the dependency receipt needed by target planning. Durable receipt
 * retries only re-observe the already prepared cache; they never repeat the
 * network-enabled bootstrap or overlay materialization.
 */
export async function prepareOrReuseDependencies(input: {
  current: DependencyPreparationState;
  expectedAppSpecDigest: string;
  sessionId: string;
  callId: string;
  environment: Readonly<Record<string, string | undefined>>;
  getSandbox: () => Promise<SandboxSession>;
}): Promise<TargetDependencyPreparationResult> {
  let { current } = input;
  if (current.appSpec.digest !== input.expectedAppSpecDigest)
    throw new Error(
      "The accepted AppSpec changed before dependency preparation.",
    );
  exactPrototypeArtifact(current.artifacts, {
    path: current.appSpec.artifactPath,
    digest: current.appSpec.digest,
    revision: current.appSpec.artifactRevision,
    sessionId: input.sessionId,
  });
  const sandbox = await input.getSandbox();
  planningMarker("source-bound-workspace-inspection", "start");
  const observedWorkspace = await inspectSourceBoundSandboxWorkspace({
    sandbox,
    receipt: current.sourceReceipt,
    expectedWorkspace: current.workspace,
    ...(current.githubSource === undefined
      ? {}
      : { githubSource: current.githubSource }),
  });
  planningMarker("source-bound-workspace-inspection", "finish");
  if (
    canAutoSelectDevelopmentSource(input.environment) &&
    JSON.stringify(observedWorkspace) !== JSON.stringify(current.workspace)
  ) {
    const observedSource = await developmentSourceReceipt(
      current.sourceReceipt.sourceKind,
      undefined,
      input.environment,
    );
    if (observedSource === undefined)
      throw new Error("The current development source is unavailable.");
    const refreshed: DependencyPreparationState = {
      version: APP_BUILDER_WORKFLOW_VERSION,
      phase: "app_spec_accepted",
      preparedByCallId: current.preparedByCallId,
      workspace: observedWorkspace,
      sourceReceipt: observedSource,
      ...(current.githubSource === undefined
        ? {}
        : { githubSource: current.githubSource }),
      artifacts: current.artifacts,
      appSpec: current.appSpec,
    };
    appBuilderWorkflowState.update((latest) => {
      assertExactWorkflowState(
        latest,
        current,
        "development planning generation refresh",
      );
      return refreshed;
    });
    current = refreshed;
  }
  const preferLiveTemplate = shouldPreferLiveTemplateDependencies(
    current.sourceReceipt.version,
    input.environment,
  );

  if (current.phase !== "app_spec_accepted") {
    planningMarker("dependency-cache-inspection", "start");
    const cache = await inspectDependencyCache(
      sandbox,
      input.environment,
      current.workspace,
      preferLiveTemplate,
    );
    planningMarker("dependency-cache-inspection", "finish");
    planningMarker("dependency-cache", "hit");
    assertExactDependencyTargetBinding({
      workspace: current.workspace,
      sourceReceipt: current.sourceReceipt,
      cache,
      dependencyReceipt: current.dependencyReceipt,
    });
    assertReceiptMatchesCache(
      current.dependencyReceipt,
      cache,
      input.environment,
    );
    return {
      state: current,
      sandbox,
      cache,
      receipt: current.dependencyReceipt,
      reused: true,
    };
  }

  let observedCache: ObservedDependencyCache;
  planningMarker("dependency-cache-inspection", "start");
  try {
    observedCache = await inspectDependencyCache(
      sandbox,
      input.environment,
      current.workspace,
      preferLiveTemplate,
    );
  } catch (error) {
    if (!(error instanceof DependencyCacheMissingError)) throw error;
    planningMarker("dependency-cache-inspection", "finish");
    planningMarker("dependency-cache", "miss");
    if (input.environment.APP_BUILDER_EXECUTION_MODE === "development") {
      planningMarker("dependency-cache-repair", "repair");
      await repairDevelopmentDependencyCache({
        sandbox,
        environment: input.environment,
      });
    } else if (preferLiveTemplate) {
      planningMarker("dependency-cache-repair", "repair");
      await bootstrapLiveTemplateDependencies({
        sandbox,
      });
    } else {
      throw error;
    }
    await inspectSourceBoundSandboxWorkspace({
      sandbox,
      receipt: current.sourceReceipt,
      expectedWorkspace: current.workspace,
      ...(current.githubSource === undefined
        ? {}
        : { githubSource: current.githubSource }),
    });
    observedCache = await inspectDependencyCache(
      sandbox,
      input.environment,
      current.workspace,
      preferLiveTemplate,
    );
    planningMarker("dependency-cache-inspection", "finish");
  }
  assertExactDependencyTargetBinding({
    workspace: current.workspace,
    sourceReceipt: current.sourceReceipt,
    cache: observedCache,
  });
  planningMarker("planning-overlay", "start");
  await materializePlanningOverlay({
    sandbox,
    artifactRevision: current.appSpec.artifactRevision,
    appId: current.appSpec.appId,
    appSpecContent: current.appSpec.content,
    appSpecDigest: current.appSpec.digest,
  });
  planningMarker("planning-overlay", "finish");
  planningMarker("offline-dependency-materialization", "start");
  const cache = await materializeOfflineDependencies({
    sandbox,
    artifactRevision: current.appSpec.artifactRevision,
    target: current.workspace,
    environment: input.environment,
    preferLiveTemplate,
  });
  planningMarker("offline-dependency-materialization", "finish");
  assertExactDependencyTargetBinding({
    workspace: current.workspace,
    sourceReceipt: current.sourceReceipt,
    cache,
  });
  const execution = targetExecutionBinding(cache, input.environment);
  const dependencyTarget = dependencyTargetForWorkspace(
    cache,
    current.workspace,
  );
  const unsigned = {
    version: 2 as const,
    sourceSha: current.workspace.sourceSha,
    sourceTree: current.workspace.sourceTree,
    sourceReceiptDigest: current.sourceReceipt.digest,
    eligibilityDigest: current.workspace.eligibilityDigest,
    workspaceDigest: current.workspace.workspaceDigest,
    imageDigest: execution.imageDigest,
    dependencyCacheDigest: execution.dependencyCacheDigest,
    appSpecDigest: current.appSpec.digest,
    artifactRevision: current.appSpec.artifactRevision,
    targetSha: dependencyTarget.sha,
    targetTree: dependencyTarget.tree,
    cacheManifestDigest: cache.manifestDigest,
    cacheContentDigest: cache.contentDigest,
    dependencyLayout: cache.dependencyLayout,
    preparedByCallId: input.callId,
  };
  const dependencyReceipt = {
    ...unsigned,
    digest: sha256(JSON.stringify(unsigned)),
  };
  const preparedState: DependencyReadyState = {
    version: APP_BUILDER_WORKFLOW_VERSION,
    phase: "dependencies_prepared",
    preparedByCallId: current.preparedByCallId,
    workspace: current.workspace,
    sourceReceipt: current.sourceReceipt,
    ...(current.githubSource === undefined
      ? {}
      : { githubSource: current.githubSource }),
    artifacts: current.artifacts,
    appSpec: current.appSpec,
    dependencyReceipt,
  };
  appBuilderWorkflowState.update((latest) => {
    assertExactWorkflowState(latest, current, "dependency receipt recording");
    return preparedState;
  });
  return {
    state: preparedState,
    sandbox,
    cache,
    receipt: dependencyReceipt,
    reused: false,
  };
}
