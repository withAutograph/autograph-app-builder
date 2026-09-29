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

import { getSourceBoundSandbox } from "@/lib/agent/source-bound-sandbox";
import { appBaselineState } from "@/lib/agent/app-baseline-state";
import { readableAppBaselinePaths } from "@/lib/repository/app-baseline";

const developmentWorkspacePath = "/workspace/repository";
const sandboxOverviewPaths = [
  "README.md",
  "AGENTS.md",
  "package.json",
  "tsconfig.json",
  ".config/typescript/workspace-paths.json",
  "docs/README.md",
] as const;

export default defineTool({
  description:
    "Inspect the current repository. With paths, read repository-relative text files, including public component exports, implementations, stories, and documentation. Resolve public imports from the current repository's tsconfig, workspace path maps, or package exports before requesting barrels. Read actual component props before composing a preview; do not guess APIs. Without paths, return the repository overview. Never writes or publishes.",
  async execute({ path, paths }, ctx) {
    if (!canAutoSelectDevelopmentSource() && sourceWorkflowState.get().phase === "empty") {
      throw new Error(
        "Select the app source before repository inspection: source_status for a new app or resolve_github_source for an existing GitHub app.",
      );
    }
    if (paths?.length) {
      const sandbox = await getSourceBoundSandbox(ctx);
      const readable = await readableAppBaselinePaths(
        sandbox,
        appBaselineState.get()?.selection,
        paths,
      );
      if (readable.length !== paths.length) {
        throw new Error(
          "A requested release archive is outside the selected app baseline and was not exposed as implementation input.",
        );
      }
      const files: { content: string; path: string }[] = [];
      const missingPaths: string[] = [];
      const readRequestedPath = async (index: number): Promise<void> => {
        const requestedPath = paths[index];
        if (requestedPath === undefined) {
          return;
        }
        const relativePath = requestedPath.replace(/^\/workspace\/repository\//u, "");
        const content = await sandbox.readTextFile({
          path: `/workspace/repository/${relativePath}`,
        });
        if (content === null) {
          missingPaths.push(requestedPath);
        } else {
          files.push({ content, path: requestedPath });
        }
        await readRequestedPath(index + 1);
      };
      await readRequestedPath(0);
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
      if (receipt === undefined) {
        throw new Error("The configured development source was unavailable.");
      }
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
          phase: "reviewed",
          receipt,
          version: APP_BUILDER_SOURCE_VERSION,
        }));
        updateExactWorkflow({
          expected: workflow,
          operation: "development workspace setup",
          transition: () => ({
            artifacts: [],
            phase: "prepared",
            preparedByCallId: ctx.callId,
            sourceReceipt: receipt,
            version: APP_BUILDER_WORKFLOW_VERSION,
            workspace,
          }),
        });
      }
      return inspectSupportedRepository(receipt.sourcePath);
    }
    if (canAutoSelectDevelopmentSource()) {
      return inspectSupportedRepository(path);
    }

    const sandbox = await ctx.getSandbox();
    const availablePaths: string[] = [];
    const missingPaths: string[] = [];
    const readOverviewPath = async (index: number): Promise<void> => {
      const overviewPath = sandboxOverviewPaths[index];
      if (overviewPath === undefined) {
        return;
      }
      const content = await sandbox.readTextFile({
        path: `repository/${overviewPath}`,
      });
      if (content === null) {
        missingPaths.push(overviewPath);
      } else {
        availablePaths.push(overviewPath);
      }
      await readOverviewPath(index + 1);
    };
    await readOverviewPath(0);
    return {
      availablePaths,
      workspacePath: developmentWorkspacePath,
      ...(missingPaths.length === 0 ? {} : { missingPaths }),
    };
  },
  inputSchema: z.object({
    path: z.string().min(1).default(developmentWorkspacePath),
    paths: z.array(z.string().min(1)).optional(),
  }),
});
