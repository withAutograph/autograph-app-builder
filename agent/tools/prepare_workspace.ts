import { localSourcePrerequisiteResponse } from "@/lib/agent/local-source-prerequisite-response";
import { workspacePreparationTransition } from "../../lib/agent/workspace-preparation-transition";
import { refreshLocalPlanningSource } from "@/lib/agent/refresh-local-planning-source";
import { getBuilderSandboxId } from "../../lib/sandbox/builder-sandbox";
import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  assertUpstreamMutationAllowed,
  updateExactWorkflow,
  workflowWorkspace,
} from "@/lib/agent/workflow-state";
import { sourceWorkflowState } from "@/lib/agent/source-state";
import type { SourceWorkflowState } from "@/lib/agent/source-state";
import { repositoryAccessReceiptState } from "@/lib/agent/repository-access-state";
import {
  recoverSavedWorkflowGitHubBinding,
  throwSavedBindingGuard,
} from "@/lib/agent/saved-github-binding";
import { selectedGitHubSourceForSandboxRestore } from "@/lib/agent/restore-selected-github-sandbox-source";
import { SOURCE_RECEIPT_VERSION } from "@/lib/repository/source-receipt";
import { canAutoSelectDevelopmentSource } from "@/lib/repository/development-source";
import { assertExactImmutableGitHubSourceReceipt } from "@/lib/repository/github-publication";
import {
  prepareDevelopmentSandboxWorkspace,
  prepareSupportedSandboxWorkspace,
  readPreparedSandboxWorkspaceRecord,
} from "@/lib/repository/supported-template";
import { inspectGitHubSourceSandboxWorkspace } from "@/lib/repository/sandbox-github-source";
import sourceStatus from "./source_status";
import { getSourceBoundSandbox } from "@/lib/agent/source-bound-sandbox";

const resolveDevelopmentSource = async (
  development: boolean,
  current: ReturnType<typeof appBuilderWorkflowState.get>,
  ctx: Parameters<NonNullable<Parameters<typeof defineTool>[0]["execute"]>>[1],
): Promise<void> => {
  if (!development || !("appSpec" in current) || current.githubSource !== undefined) {
    return;
  }
  const reconciled = await refreshLocalPlanningSource(ctx);
  if (reconciled === undefined) {
    return;
  }
  const refreshed = appBuilderWorkflowState.get();
  if (!("workspace" in refreshed)) {
    throw new Error("The reconciled local app workspace is unavailable.");
  }
};

const selectSource = async (
  development: boolean,
  ctx: Parameters<NonNullable<Parameters<typeof defineTool>[0]["execute"]>>[1],
): Promise<Exclude<SourceWorkflowState, { phase: "empty" }>> => {
  if (sourceWorkflowState.get().phase === "empty" && development) {
    await sourceStatus.execute({}, ctx);
  }
  const source = sourceWorkflowState.get();
  if (source.phase === "empty") {
    throw new Error(
      "Select the app source first: source_status for a new app or resolve_github_source for an existing GitHub app.",
    );
  }
  return source;
};

const prepareWorkspace = async (
  source: Awaited<ReturnType<typeof selectSource>>,
  development: boolean,
  githubSource: ReturnType<typeof selectedGitHubSourceForSandboxRestore>,
  sandbox: Awaited<ReturnType<typeof getSourceBoundSandbox>>,
  callId: string,
): Promise<Awaited<ReturnType<typeof prepareDevelopmentSandboxWorkspace>>> => {
  const {
    sourcePath: path,
    sourceSha: expectedSha,
    eligibilityDigest: expectedEligibilityDigest,
  } = source.receipt;
  if (development) {
    return await prepareDevelopmentSandboxWorkspace(
      path,
      sandbox,
      callId,
      source.receipt.sourceKind === "existing-repository" ? "planning" : "full",
    );
  }
  if (githubSource !== undefined) {
    return await inspectGitHubSourceSandboxWorkspace({ githubSource, sandbox });
  }
  if (source.receipt.version === SOURCE_RECEIPT_VERSION) {
    const observed = await readPreparedSandboxWorkspaceRecord(sandbox);
    if (observed === undefined) {
      throw new Error("The canonical Arrusted workspace is missing.");
    }
    return observed;
  }
  return await prepareSupportedSandboxWorkspace(
    path,
    expectedSha,
    expectedEligibilityDigest,
    sandbox,
    callId,
    false,
    source.receipt.sourceKind === "existing-repository" ? "planning" : "full",
  );
};

const recoverWorkflowBinding = (
  recoveryInput: Parameters<typeof recoverSavedWorkflowGitHubBinding>[0],
  sandbox: Awaited<ReturnType<typeof getSourceBoundSandbox>>,
): ReturnType<typeof recoverSavedWorkflowGitHubBinding> =>
  recoverSavedWorkflowGitHubBinding({
    ...recoveryInput,
    providerWorkspaceId: getBuilderSandboxId(sandbox),
  });

const assertWorkspaceOwnership = (
  development: boolean,
  current: ReturnType<typeof appBuilderWorkflowState.get>,
  githubSource: ReturnType<typeof selectedGitHubSourceForSandboxRestore>,
  source: Awaited<ReturnType<typeof selectSource>>,
  currentWorkspace: ReturnType<typeof workflowWorkspace>,
  sandbox: Awaited<ReturnType<typeof getSourceBoundSandbox>>,
): void => {
  if (development) {
    return;
  }
  if (current.phase !== "empty" && current.githubSource?.digest !== githubSource?.digest) {
    throwSavedBindingGuard(current, source, "prepare-workspace");
  }
  if (
    githubSource === undefined &&
    currentWorkspace !== undefined &&
    currentWorkspace.workspaceId !== getBuilderSandboxId(sandbox)
  ) {
    throw new Error("This app build already owns a different workspace.");
  }
};

export default defineTool({
  description:
    "Prepare the current writable repository checkout for product work. This is automatic and records the provider-created checkout without treating normal source or layout changes as failures.",
  async execute(_input, ctx) {
    try {
      const development = canAutoSelectDevelopmentSource();
      let current = appBuilderWorkflowState.get();
      assertUpstreamMutationAllowed(current, "workspace preparation");
      await resolveDevelopmentSource(development, current, ctx);
      const source = await selectSource(development, ctx);
      const githubSource = selectedGitHubSourceForSandboxRestore({
        sourceState: source.githubSource,
        workflowState: current.phase === "empty" ? undefined : current.githubSource,
      });
      if (!development && githubSource !== undefined) {
        assertExactImmutableGitHubSourceReceipt(githubSource);
      }
      const recoveryInput = {
        access: repositoryAccessReceiptState.get(),
        sessionId: ctx.session.id,
        source,
        stage: "prepare-workspace" as const,
        workflow: current,
      };
      // Prove original authority before a provider can open replacement compute.
      if (!development) {
        recoverSavedWorkflowGitHubBinding(recoveryInput);
      }
      const sandbox = await getSourceBoundSandbox(ctx);
      const recovered = development ? undefined : recoverWorkflowBinding(recoveryInput, sandbox);
      if (recovered?.recovered === true) {
        updateExactWorkflow({
          expected: current,
          operation: "recover saved GitHub source binding",
          transition: () => recovered.workflow,
        });
        current = recovered.workflow;
      }
      const currentReceipt = source.receipt;
      const currentWorkspace = workflowWorkspace(current);
      assertWorkspaceOwnership(
        development,
        current,
        githubSource,
        source,
        currentWorkspace,
        sandbox,
      );
      const workspace = await prepareWorkspace(
        source,
        development,
        githubSource,
        sandbox,
        ctx.callId,
      );
      const preparedState = {
        artifacts: [],
        phase: "prepared",
        preparedByCallId: ctx.callId,
        sourceReceipt: currentReceipt,
        version: APP_BUILDER_WORKFLOW_VERSION,
        workspace,
      } satisfies {
        artifacts: [];
        phase: "prepared";
        preparedByCallId: string;
        sourceReceipt: typeof currentReceipt;
        version: typeof APP_BUILDER_WORKFLOW_VERSION;
        workspace: typeof workspace;
      };
      if (githubSource !== undefined) {
        Object.assign(preparedState, { githubSource });
      }
      updateExactWorkflow({
        expected: current,
        operation: "workspace preparation",
        transition: (latest) => workspacePreparationTransition(latest, () => preparedState),
      });
      return workspace;
    } catch (error) {
      return await localSourcePrerequisiteResponse(error, ctx);
    }
  },
  inputSchema: z.object({}),
});
