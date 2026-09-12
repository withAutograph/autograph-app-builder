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
import { SOURCE_RECEIPT_VERSION } from "@/lib/repository/source-receipt";
import { canAutoSelectDevelopmentSource } from "@/lib/repository/development-source";
import { assertExactImmutableGitHubSourceReceipt } from "@/lib/repository/github-publication";
import {
  prepareDevelopmentSandboxWorkspace,
  prepareSupportedSandboxWorkspace,
  readPreparedSandboxWorkspaceRecord,
} from "@/lib/repository/supported-template";
import { inspectGitHubSourceSandboxWorkspace } from "@/lib/repository/sandbox-github-source";
import sourceStatus from "./source-status";

export default defineTool({
  description:
    "Prepare the current writable repository checkout for product work. This is automatic and records the provider-created checkout without treating normal source or layout changes as failures.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const development = canAutoSelectDevelopmentSource();
    const current = appBuilderWorkflowState.get();
    assertUpstreamMutationAllowed(current, "workspace preparation");
    if (development && sourceWorkflowState.get().phase === "empty")
      await sourceStatus.execute({}, ctx);
    const source = sourceWorkflowState.get();
    if (source.phase === "empty") throw new Error("No source was reviewed.");
    if (!development && source.githubSource !== undefined) {
      assertExactImmutableGitHubSourceReceipt(source.githubSource);
    }
    const sandbox = await ctx.getSandbox();
    const canonicalWorkspace = development
      ? undefined
      : source.receipt.version === SOURCE_RECEIPT_VERSION
        ? await (async () => {
            const observed = await readPreparedSandboxWorkspaceRecord(sandbox);
            if (observed === undefined)
              throw new Error("The canonical Arrusted workspace is missing.");
            return observed;
          })()
        : undefined;
    const githubWorkspace = development
      ? undefined
      : source.githubSource === undefined
        ? undefined
        : await inspectGitHubSourceSandboxWorkspace({
            sandbox,
            receipt: source.receipt,
            githubSource: source.githubSource,
          });
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
      current.githubSource?.digest !== source.githubSource?.digest
    )
      throw new Error("This app build already owns a different GitHub source binding.");
    if (
      !development &&
      currentWorkspace !== undefined &&
      currentWorkspace.workspaceId !== sandbox.id
    )
      throw new Error("This app build already owns a different workspace.");
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
      if (canonicalWorkspace === undefined)
        throw new Error("The canonical Arrusted workspace is missing.");
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
              version: APP_BUILDER_WORKFLOW_VERSION,
              phase: "prepared",
              preparedByCallId: ctx.callId,
              workspace,
              sourceReceipt: currentReceipt,
              ...(source.githubSource === undefined ? {} : { githubSource: source.githubSource }),
              artifacts: [],
            }
          : latest,
    });
    return workspace;
  },
});
