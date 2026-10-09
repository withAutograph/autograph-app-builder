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

export default defineTool({
  description:
    "Prepare the current writable repository checkout for product work. This is automatic and records the provider-created checkout without treating normal source or layout changes as failures.",
  async execute(_input, ctx) {
    const development = canAutoSelectDevelopmentSource();
    let current = appBuilderWorkflowState.get();
    assertUpstreamMutationAllowed(current, "workspace preparation");
    if (sourceWorkflowState.get().phase === "empty" && development) {
      await sourceStatus.execute({}, ctx);
    }
    const source = sourceWorkflowState.get();
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
    if (!development) {
      const recovered = recoverSavedWorkflowGitHubBinding({
        ...recoveryInput,
        providerWorkspaceId: getBuilderSandboxId(sandbox),
      });
      if (recovered.recovered) {
        updateExactWorkflow({
          expected: current,
          operation: "recover saved GitHub source binding",
          transition: () => recovered.workflow,
        });
        current = recovered.workflow;
      }
    }
    let canonicalWorkspace;
    if (!development && source.receipt.version === SOURCE_RECEIPT_VERSION) {
      canonicalWorkspace = await (async () => {
        const observed = await readPreparedSandboxWorkspaceRecord(sandbox);
        if (observed === undefined) {
          throw new Error("The canonical Arrusted workspace is missing.");
        }
        return observed;
      })();
    }
    let githubWorkspace;
    if (!development && githubSource !== undefined) {
      githubWorkspace = await inspectGitHubSourceSandboxWorkspace({
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
    const currentWorkspace = workflowWorkspace(current);
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
    let workspace;
    if (development) {
      workspace = await prepareDevelopmentSandboxWorkspace(
        path,
        sandbox,
        ctx.callId,
        source.receipt.sourceKind === "existing-repository" ? "planning" : "full",
      );
    } else if (githubWorkspace !== undefined) {
      workspace = githubWorkspace;
    } else if (currentReceipt.version === SOURCE_RECEIPT_VERSION) {
      if (canonicalWorkspace === undefined) {
        throw new Error("The canonical Arrusted workspace is missing.");
      }
      workspace = canonicalWorkspace;
    } else {
      workspace = await prepareSupportedSandboxWorkspace(
        path,
        expectedSha,
        expectedEligibilityDigest,
        sandbox,
        ctx.callId,
        false,
        source.receipt.sourceKind === "existing-repository" ? "planning" : "full",
      );
    }
    updateExactWorkflow({
      expected: current,
      operation: "workspace preparation",
      transition: (latest) =>
        latest.phase === "empty" || latest.phase === "prepared"
          ? {
              artifacts: [],
              ...(githubSource === undefined ? {} : { githubSource }),
              phase: "prepared",
              preparedByCallId: ctx.callId,
              sourceReceipt: currentReceipt,
              version: APP_BUILDER_WORKFLOW_VERSION,
              workspace,
            }
          : latest,
    });
    return workspace;
  },
  inputSchema: z.object({}),
});
