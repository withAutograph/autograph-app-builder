import type { SandboxSession } from "eve/sandbox";

import { exactPrototypeArtifact } from "@/lib/agent/prototype-artifacts";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  assertExactWorkflowState,
  sha256,
  type AppBuilderWorkflowState,
  type DependencyPreparationReceipt,
} from "@/lib/agent/workflow-state";
import {
  assertExactDependencyTargetBinding,
  bootstrapLiveTemplateDependencies,
  DependencyCacheMissingError,
  dependencyTargetForWorkspace,
  inspectDependencyCache,
  materializeOfflineDependencies,
  shouldPreferLiveTemplateDependencies,
  type ObservedDependencyCache,
} from "@/lib/repository/dependency-cache";
import {
  materializePlanningOverlay,
  targetExecutionBinding,
} from "@/lib/repository/target-planning";
import { inspectSourceBoundSandboxWorkspace } from "@/lib/repository/arrusted-template";

type DependencyPreparationState = Exclude<
  AppBuilderWorkflowState,
  { phase: "empty" | "prepared" }
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

function assertReceiptMatchesCache(
  receipt: DependencyPreparationReceipt,
  cache: ObservedDependencyCache,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const execution = targetExecutionBinding(cache, environment);
  if (
    receipt.imageDigest !== execution.imageDigest ||
    receipt.dependencyCacheDigest !== execution.dependencyCacheDigest ||
    receipt.cacheManifestDigest !== cache.manifestDigest ||
    receipt.cacheContentDigest !== cache.contentDigest
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
  const { current } = input;
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
  await inspectSourceBoundSandboxWorkspace({
    sandbox,
    receipt: current.sourceReceipt,
    expectedWorkspace: current.workspace,
    ...(current.githubSource === undefined
      ? {}
      : { githubSource: current.githubSource }),
  });
  const preferLiveTemplate = shouldPreferLiveTemplateDependencies(
    current.sourceReceipt.version,
    input.environment,
  );

  if (current.phase !== "app_spec_accepted") {
    const cache = await inspectDependencyCache(
      sandbox,
      input.environment,
      current.workspace,
      preferLiveTemplate,
    );
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
  try {
    observedCache = await inspectDependencyCache(
      sandbox,
      input.environment,
      current.workspace,
      preferLiveTemplate,
    );
  } catch (error) {
    if (!preferLiveTemplate || !(error instanceof DependencyCacheMissingError))
      throw error;
    await bootstrapLiveTemplateDependencies({
      sandbox,
      target: current.workspace,
    });
    observedCache = await inspectDependencyCache(
      sandbox,
      input.environment,
      current.workspace,
      true,
    );
  }
  assertExactDependencyTargetBinding({
    workspace: current.workspace,
    sourceReceipt: current.sourceReceipt,
    cache: observedCache,
  });
  await materializePlanningOverlay({
    sandbox,
    artifactRevision: current.appSpec.artifactRevision,
    appId: current.appSpec.appId,
    appSpecContent: current.appSpec.content,
    appSpecDigest: current.appSpec.digest,
  });
  const cache = await materializeOfflineDependencies({
    sandbox,
    artifactRevision: current.appSpec.artifactRevision,
    target: current.workspace,
    environment: input.environment,
    preferLiveTemplate,
  });
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
