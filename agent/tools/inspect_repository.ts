import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  APP_BUILDER_SOURCE_VERSION,
  sourceWorkflowState,
} from "@/lib/agent/source-state";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  assertUpstreamMutationAllowed,
  updateExactWorkflow,
} from "@/lib/agent/workflow-state";
import {
  canAutoSelectDevelopmentSource,
  developmentSourceReceipt,
} from "@/lib/repository/development-source";
import {
  inspectSupportedRepository,
  prepareDevelopmentSandboxWorkspace,
} from "@/lib/repository/supported-template";

const developmentWorkspacePath = "/workspace/repository";
const sandboxOverviewPaths = [
  "README.md",
  "AGENTS.md",
  "package.json",
  "docs/README.md",
] as const;

export default defineTool({
  description:
    "Provide a no-content overview of the current session's repository without executing target-owned commands. Hosted inspection uses only the fixed session repository root; the input path remains a local-development checkout hint.",
  inputSchema: z.object({ path: z.string().min(1) }),
  async execute({ path }, ctx) {
    // Some models use the runtime-visible workspace path for their first
    // repository inspection. In local development that path does not exist on
    // the host running this tool yet. Treat it as the single configured source
    // only, materialize the writable sandbox overlay, and inspect the live
    // checkout. This keeps setup out of the conversation without granting any
    // other path special treatment.
    if (path === developmentWorkspacePath && canAutoSelectDevelopmentSource()) {
      const receipt = await developmentSourceReceipt("existing-repository");
      if (receipt === undefined)
        throw new Error("The configured development source was unavailable.");
      const workflow = appBuilderWorkflowState.get();
      if (workflow.phase === "empty") {
        assertUpstreamMutationAllowed(workflow, "development workspace setup");
        const workspace = await prepareDevelopmentSandboxWorkspace(
          receipt.sourcePath,
          await ctx.getSandbox(),
          ctx.callId,
          "planning",
        );
        sourceWorkflowState.update(() => ({
          version: APP_BUILDER_SOURCE_VERSION,
          phase: "reviewed",
          receipt,
        }));
        updateExactWorkflow({
          expected: workflow,
          operation: "development workspace setup",
          transition: () => ({
            version: APP_BUILDER_WORKFLOW_VERSION,
            phase: "prepared",
            preparedByCallId: ctx.callId,
            workspace,
            sourceReceipt: receipt,
            artifacts: [],
          }),
        });
      }
      return inspectSupportedRepository(receipt.sourcePath);
    }
    if (canAutoSelectDevelopmentSource())
      return inspectSupportedRepository(path);

    const sandbox = await ctx.getSandbox();
    const availablePaths: string[] = [];
    const missingPaths: string[] = [];
    for (const overviewPath of sandboxOverviewPaths) {
      const content = await sandbox.readTextFile({
        path: `repository/${overviewPath}`,
      });
      if (content === null) missingPaths.push(overviewPath);
      else availablePaths.push(overviewPath);
    }
    return {
      workspacePath: developmentWorkspacePath,
      availablePaths,
      ...(missingPaths.length === 0 ? {} : { missingPaths }),
    };
  },
});
