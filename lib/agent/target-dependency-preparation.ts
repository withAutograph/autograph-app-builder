import type { SandboxSession } from "eve/sandbox";

import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  sha256,
  type AppBuilderWorkflowState,
  type DependencyPreparationReceipt,
} from "@/lib/agent/workflow-state";

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
  receipt: DependencyPreparationReceipt;
  reused: boolean;
};

/**
 * Prepares the dependencies needed by target planning. Cache observations are
 * performance hints only: a changed or missing cache is rebuilt rather than
 * treated as an authority failure.
 */
export async function prepareOrReuseDependencies(input: {
  current: DependencyPreparationState;
  sessionId: string;
  callId: string;
  environment: Readonly<Record<string, string | undefined>>;
  getSandbox: () => Promise<SandboxSession>;
}): Promise<TargetDependencyPreparationResult> {
  const { current } = input;
  const sandbox = await input.getSandbox();

  if (current.phase !== "app_spec_accepted") {
    return {
      state: current,
      sandbox,
      receipt: current.dependencyReceipt,
      reused: true,
    };
  }
  const unsigned = {
    version: 2 as const,
    sourceSha: current.workspace.sourceSha,
    sourceTree: current.workspace.sourceTree,
    sourceReceiptDigest: current.sourceReceipt.digest,
    eligibilityDigest: current.workspace.eligibilityDigest,
    workspaceDigest: current.workspace.workspaceDigest,
    imageDigest: "vercel-sandbox",
    dependencyCacheDigest: "checkout",
    appSpecDigest: current.appSpec.digest,
    artifactRevision: current.appSpec.artifactRevision,
    targetSha: current.workspace.sourceSha,
    targetTree: current.workspace.sourceTree,
    cacheManifestDigest: "checkout",
    cacheContentDigest: "checkout",
    dependencyLayout: {
      version: 1 as const,
      kind: "checkout" as const,
      roots: [] as [],
      workspaceLinks: [] as [],
    },
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
    receipt: dependencyReceipt,
    reused: false,
  };
}
