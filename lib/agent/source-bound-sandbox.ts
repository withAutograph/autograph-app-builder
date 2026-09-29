import type { SandboxSession } from "eve/sandbox";

import { repositoryAccessRuntimeForSession } from "./deployment-repository-access-runtime";
import { repositoryAccessReceiptState } from "./repository-access-state";
import {
  restoreSelectedGitHubSandboxSource,
  selectedGitHubSourceForSandboxRestore,
} from "./restore-selected-github-sandbox-source";
import { sourceWorkflowState } from "./source-state";
import { appBuilderWorkflowState } from "./workflow-state";

/** Bind the saved source in the same invocation that opens a sandbox. */
export const getSourceBoundSandbox = async (ctx: {
  getSandbox: () => Promise<SandboxSession>;
  session: { auth: unknown; id: string };
}): Promise<SandboxSession> => {
  const source = sourceWorkflowState.get();
  const workflow = appBuilderWorkflowState.get();
  const githubSource = selectedGitHubSourceForSandboxRestore({
    sourceState: source.phase === "empty" ? undefined : source.githubSource,
    workflowState: workflow.phase === "empty" ? undefined : workflow.githubSource,
  });
  if (githubSource !== undefined) {
    restoreSelectedGitHubSandboxSource({
      accessReceipt: repositoryAccessReceiptState.get(),
      githubSource,
      runtime: async () => await repositoryAccessRuntimeForSession(ctx.session.auth),
      sessionId: ctx.session.id,
    });
  }
  return await ctx.getSandbox();
};
