import type { SandboxSession } from "eve/sandbox";

import { repositoryAccessRuntimeForSession } from "./deployment-repository-access-runtime";
import { repositoryAccessReceiptState } from "./repository-access-state";
import {
  restoreSelectedGitHubSandboxSource,
  selectedGitHubSourceForSandboxRestore,
} from "./restore-selected-github-sandbox-source";
import { appBaselineState } from "./app-baseline-state";
import { projectAppBaseline, readAppBaselineMarker } from "../repository/app-baseline";
import { openAppBaselineSource } from "./app-baseline-sandbox";
import { writeSandboxGitHubSourceManifest } from "../repository/sandbox-github-source";
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
  const baseline = appBaselineState.get();
  return await openAppBaselineSource({
    baseline,
    bindSource() {
      if (githubSource !== undefined) {
        restoreSelectedGitHubSandboxSource({
          accessReceipt: repositoryAccessReceiptState.get(),
          frozenRevision: baseline?.receipt?.platform.commitSha,
          githubSource,
          runtime: async () => await repositoryAccessRuntimeForSession(ctx.session.auth),
          sessionId: ctx.session.id,
        });
      }
    },
    isPrepared: async (sandbox, selection) =>
      (await readAppBaselineMarker(sandbox, selection)) !== undefined,
    openSandbox: ctx.getSandbox,
    repository: githubSource?.repository,
    async restore(sandbox, saved) {
      const access = repositoryAccessReceiptState.get();
      if (access === undefined || githubSource === undefined) {
        throw new Error(
          "Reconnect this Builder session's selected repository before restoring its app baseline.",
        );
      }
      const runtime = await repositoryAccessRuntimeForSession(ctx.session.auth);
      const credential = await runtime.acquireExistingSourceCredential({
        installationId: access.scope.installationId,
        repository: githubSource.repository,
        sessionId: ctx.session.id,
      });
      await projectAppBaseline({
        callId: saved.receipt.projectedByCallId,
        platform: saved.receipt.platform,
        sandbox,
        selection: saved.selection,
        token: credential.token,
      });
      await writeSandboxGitHubSourceManifest(sandbox, {
        sourceSha: saved.receipt.platform.commitSha,
        sourceTree: saved.receipt.platform.treeSha,
      });
    },
    sessionId: ctx.session.id,
  });
};
