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

const defaultDependencies = {
  acquireSource: sourceStatus.execute,
  assertExactImmutableGitHubSourceReceipt,
  assertUpstreamMutationAllowed,
  canAutoSelectDevelopmentSource,
  getRepositoryAccess: () => repositoryAccessReceiptState.get(),
  getSource: () => sourceWorkflowState.get(),
  getSourceBoundSandbox,
  getWorkflow: () => appBuilderWorkflowState.get(),
  inspectGitHubSourceSandboxWorkspace,
  prepareDevelopmentSandboxWorkspace,
  prepareSupportedSandboxWorkspace,
  readPreparedSandboxWorkspaceRecord,
  updateExactWorkflow,
  workflowWorkspace,
};

const shouldRefreshLocalSource = (
  development: boolean,
  current: ReturnType<typeof defaultDependencies.getWorkflow>,
) => development && "appSpec" in current && current.githubSource === undefined;

const requireCanonicalWorkspace = (
  workspace: Awaited<ReturnType<typeof defaultDependencies.readPreparedSandboxWorkspaceRecord>>,
) => {
  if (workspace === undefined) {
    throw new Error("The canonical Arrusted workspace is missing.");
  }
  return workspace;
};

export const createPrepareWorkspace = (overrides: Partial<typeof defaultDependencies> = {}) => {
  const dependencies = { ...defaultDependencies, ...overrides };

  const assertWorkspaceBinding = (
    development: boolean,
    current: ReturnType<typeof dependencies.getWorkflow>,
    source: Exclude<ReturnType<typeof dependencies.getSource>, { phase: "empty" }>,
    githubSource: ReturnType<typeof selectedGitHubSourceForSandboxRestore>,
    sandbox: Awaited<ReturnType<typeof dependencies.getSourceBoundSandbox>>,
  ) => {
    const currentWorkspace = dependencies.workflowWorkspace(current);
    if (
      !development &&
      current.phase !== "empty" &&
      current.githubSource?.digest !== githubSource?.digest
    ) {
      throwSavedBindingGuard(current, source, "prepare-workspace");
    }
    if (
      !development &&
      githubSource === undefined &&
      currentWorkspace !== undefined &&
      currentWorkspace.workspaceId !== getBuilderSandboxId(sandbox)
    ) {
      throw new Error("This app build already owns a different workspace.");
    }
  };

  const recoverBinding = (
    development: boolean,
    recoveryInput: Parameters<typeof recoverSavedWorkflowGitHubBinding>[0],
    sandbox: Awaited<ReturnType<typeof dependencies.getSourceBoundSandbox>>,
    current: ReturnType<typeof dependencies.getWorkflow>,
  ) => {
    if (!development) {
      const recovered = recoverSavedWorkflowGitHubBinding({
        ...recoveryInput,
        providerWorkspaceId: getBuilderSandboxId(sandbox),
      });
      if (recovered.recovered) {
        dependencies.updateExactWorkflow({
          expected: current,
          operation: "recover saved GitHub source binding",
          transition: () => recovered.workflow,
        });
        return recovered.workflow;
      }
    }
    return current;
  };

  const selectedSource = (
    development: boolean,
    current: ReturnType<typeof dependencies.getWorkflow>,
  ) => {
    const source = dependencies.getSource();
    if (source.phase === "empty") {
      throw new Error(
        "Select the app source first: source_status for a new app or resolve_github_source for an existing GitHub app.",
      );
    }
    const githubSource = selectedGitHubSourceForSandboxRestore({
      sourceState: source.githubSource,
      workflowState: current.phase === "empty" ? undefined : current.githubSource,
    });
    if (!development && githubSource !== undefined) {
      dependencies.assertExactImmutableGitHubSourceReceipt(githubSource);
    }
    return { githubSource, source };
  };

  const reconciledWorkspace = () => {
    const refreshed = dependencies.getWorkflow();
    if (!("workspace" in refreshed)) {
      throw new Error("The reconciled local app workspace is unavailable.");
    }
    return refreshed.workspace;
  };

  return defineTool({
    description:
      "Prepare the current writable repository checkout for product work. This is automatic and records the provider-created checkout without treating normal source or layout changes as failures.",
    async execute(_input, ctx) {
      try {
        const development = dependencies.canAutoSelectDevelopmentSource();
        let current = dependencies.getWorkflow();
        dependencies.assertUpstreamMutationAllowed(current, "workspace preparation");
        if (dependencies.getSource().phase === "empty" && development) {
          await dependencies.acquireSource({}, ctx);
        }
        if (shouldRefreshLocalSource(development, current)) {
          const reconciled = await refreshLocalPlanningSource(ctx);
          if (reconciled !== undefined) {
            return reconciledWorkspace();
          }
        }
        const { githubSource, source } = selectedSource(development, current);
        const recoveryInput = {
          access: dependencies.getRepositoryAccess(),
          sessionId: ctx.session.id,
          source,
          stage: "prepare-workspace" as const,
          workflow: current,
        };
        // Prove original authority before a provider can open replacement compute.
        if (!development) {
          recoverSavedWorkflowGitHubBinding(recoveryInput);
        }
        const sandbox = await dependencies.getSourceBoundSandbox(ctx);
        current = recoverBinding(development, recoveryInput, sandbox, current);
        let canonicalWorkspace;
        if (!development && source.receipt.version === SOURCE_RECEIPT_VERSION) {
          canonicalWorkspace = await (async () => {
            const observed = await dependencies.readPreparedSandboxWorkspaceRecord(sandbox);
            if (observed === undefined) {
              throw new Error("The canonical Arrusted workspace is missing.");
            }
            return observed;
          })();
        }
        let githubWorkspace;
        if (!development && githubSource !== undefined) {
          githubWorkspace = await dependencies.inspectGitHubSourceSandboxWorkspace({
            githubSource,
            sandbox,
          });
        }
        const currentReceipt = source.receipt;
        const {
          sourcePath: path,
          sourceSha: expectedSha,
          eligibilityDigest: expectedEligibilityDigest,
        } = currentReceipt;
        assertWorkspaceBinding(development, current, source, githubSource, sandbox);
        let workspace;
        if (development) {
          workspace = await dependencies.prepareDevelopmentSandboxWorkspace(
            path,
            sandbox,
            ctx.callId,
            source.receipt.sourceKind === "existing-repository" ? "planning" : "full",
          );
        } else if (githubWorkspace !== undefined) {
          workspace = githubWorkspace;
        } else if (currentReceipt.version === SOURCE_RECEIPT_VERSION) {
          workspace = requireCanonicalWorkspace(canonicalWorkspace);
        } else {
          workspace = await dependencies.prepareSupportedSandboxWorkspace(
            path,
            expectedSha,
            expectedEligibilityDigest,
            sandbox,
            ctx.callId,
            false,
            source.receipt.sourceKind === "existing-repository" ? "planning" : "full",
          );
        }
        dependencies.updateExactWorkflow({
          expected: current,
          operation: "workspace preparation",
          transition: (latest) =>
            workspacePreparationTransition(latest, () => {
              const prepared = { artifacts: [] };
              const withSource =
                githubSource === undefined ? prepared : { ...prepared, githubSource };
              return {
                ...withSource,
                phase: "prepared",
                preparedByCallId: ctx.callId,
                sourceReceipt: currentReceipt,
                version: APP_BUILDER_WORKFLOW_VERSION,
                workspace,
              };
            }),
        });
        return workspace;
      } catch (error) {
        return await localSourcePrerequisiteResponse(error, ctx);
      }
    },
    inputSchema: z.object({}),
  });
};

export default createPrepareWorkspace();
