import type { SandboxSession } from "eve/sandbox";

import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  sha256,
} from "@/lib/agent/workflow-state";
import type {
  AppBuilderWorkflowState,
  DependencyPreparationReceipt,
} from "@/lib/agent/workflow-state";

type DependencyPreparationState = Exclude<
  AppBuilderWorkflowState,
  { phase: "empty" | "prepared" | "ui_previewed" | "ui_accepted" }
>;

export type DependencyReadyState = Exclude<
  DependencyPreparationState,
  { phase: "app_spec_accepted" }
>;

export interface TargetDependencyPreparationResult {
  state: DependencyReadyState;
  sandbox: SandboxSession;
  receipt: DependencyPreparationReceipt;
  reused: boolean;
}

/**
 * Records checkout-backed planning state. Repository commands own dependency
 * installation; this helper does not install, inspect, or verify a cache.
 */
export async function prepareOrReuseDependencies(input: {
  current: DependencyPreparationState;
  callId: string;
  getSandbox: () => Promise<SandboxSession>;
}): Promise<TargetDependencyPreparationResult> {
  const { current } = input;
  const sandbox = await input.getSandbox();

  if (current.phase !== "app_spec_accepted") {
    return {
      receipt: current.dependencyReceipt,
      reused: true,
      sandbox,
      state: current,
    };
  }
  const unsigned = {
    appSpecDigest: current.appSpec.digest,
    artifactRevision: current.appSpec.artifactRevision,
    cacheContentDigest: "checkout",
    cacheManifestDigest: "checkout",
    dependencyCacheDigest: "checkout",
    dependencyLayout: {
      kind: "checkout" as const,
      roots: [] as [],
      version: 1 as const,
      workspaceLinks: [] as [],
    },
    eligibilityDigest: current.workspace.eligibilityDigest,
    imageDigest: "vercel-sandbox",
    preparedByCallId: input.callId,
    sourceReceiptDigest: current.sourceReceipt.digest,
    sourceSha: current.workspace.sourceSha,
    sourceTree: current.workspace.sourceTree,
    targetSha: current.workspace.sourceSha,
    targetTree: current.workspace.sourceTree,
    version: 2 as const,
    workspaceDigest: current.workspace.workspaceDigest,
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
    receipt: dependencyReceipt,
    reused: false,
    sandbox,
    state: preparedState,
  };
}
