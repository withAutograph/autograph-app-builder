import { defineTool } from "eve/tools";
import { z } from "zod";

import { APP_BUILDER_SOURCE_VERSION, sourceWorkflowState } from "@/lib/agent/source-state";
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
const sandboxOverviewPaths = ["README.md", "AGENTS.md", "package.json", "docs/README.md"] as const;

export default defineTool({
  description:
    "Inspect the current repository. With paths, read repository-relative text files, including public component exports, implementations, stories, and documentation. Read actual component props before composing a preview; do not guess APIs. Without paths, return the repository overview. Never writes or publishes.",
  inputSchema: z.object({
    path: z.string().min(1).default(developmentWorkspacePath),
    paths: z.array(z.string().min(1)).optional(),
  }),
  async execute({ path, paths }, ctx) {
    if (paths?.length) {
      const sandbox = await ctx.getSandbox();
      const files = [];
      const missingPaths = [];
      for (const requestedPath of paths) {
        const relativePath = requestedPath.replace(/^\/workspace\/repository\//u, "");
        // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
        const content = await sandbox.readTextFile({
          path: `/workspace/repository/${relativePath}`,
        });
        if (content === null) missingPaths.push(requestedPath);
        else files.push({ path: requestedPath, content });
      }
      return { files, missingPaths };
    }
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
    if (canAutoSelectDevelopmentSource()) return inspectSupportedRepository(path);

    const sandbox = await ctx.getSandbox();
    const availablePaths: string[] = [];
    const missingPaths: string[] = [];
    for (const overviewPath of sandboxOverviewPaths) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
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
