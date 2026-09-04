import type { SandboxSession } from "eve/sandbox";

import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  sha256,
  type AppBuilderWorkflowState,
  type DependencyPreparationReceipt,
} from "@/lib/agent/workflow-state";
import {
  bootstrapLiveTemplateDependencies,
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
  HOSTED_TOOLCHAIN_DOWNLOAD_HOSTS,
  HOSTED_TOOLCHAIN_PREWARM_TIMEOUT_MS,
  hostedToolchainBootstrapCommand,
} from "@/lib/sandbox/hosted-toolchain";
import {
  materializePlanningOverlay,
  targetExecutionBinding,
} from "@/lib/repository/target-planning";

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

async function prepareHostedToolchain(sandbox: SandboxSession) {
  await sandbox.setNetworkPolicy({
    allow: [...HOSTED_TOOLCHAIN_DOWNLOAD_HOSTS],
  });
  const result = await (async () => {
    try {
      return await sandbox.run({
        command: hostedToolchainBootstrapCommand(),
        workingDirectory: "/workspace",
        abortSignal: AbortSignal.timeout(HOSTED_TOOLCHAIN_PREWARM_TIMEOUT_MS),
      });
    } finally {
      await sandbox.setNetworkPolicy("deny-all");
    }
  })();
  if (result.exitCode !== 0) {
    const stage = `${result.stderr}\n${result.stdout}`.match(
      /hosted_toolchain_bootstrap_failed:([a-z-]+)/u,
    )?.[1];
    throw new Error(
      `The hosted planning toolchain could not be prepared (${stage ?? "provider-termination"}).`,
    );
  }
}

/**
 * Prepares the dependencies needed by target planning. Cache observations are
 * performance hints only: a changed or missing cache is rebuilt rather than
 * treated as an authority failure.
 */
export async function prepareOrReuseDependencies(input: {
  current: DependencyPreparationState;
  expectedAppSpecDigest?: string;
  sessionId: string;
  callId: string;
  environment: Readonly<Record<string, string | undefined>>;
  getSandbox: () => Promise<SandboxSession>;
}): Promise<TargetDependencyPreparationResult> {
  const { current } = input;
  const sandbox = await input.getSandbox();
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
    return {
      state: current,
      sandbox,
      cache,
      receipt: current.dependencyReceipt,
      reused: true,
    };
  }

  planningMarker("dependency-cache-inspection", "start");
  try {
    await inspectDependencyCache(
      sandbox,
      input.environment,
      current.workspace,
      preferLiveTemplate,
    );
  } catch (error) {
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
      await prepareHostedToolchain(sandbox);
      await bootstrapLiveTemplateDependencies({
        sandbox,
      });
    } else {
      throw error instanceof Error
        ? error
        : new Error("Dependencies could not be prepared for this repository.");
    }
    await inspectDependencyCache(
      sandbox,
      input.environment,
      current.workspace,
      preferLiveTemplate,
    );
    planningMarker("dependency-cache-inspection", "finish");
  }
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
  appBuilderWorkflowState.update(() => preparedState);
  return {
    state: preparedState,
    sandbox,
    cache,
    receipt: dependencyReceipt,
    reused: false,
  };
}
