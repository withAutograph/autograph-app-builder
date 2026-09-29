import { defineHook } from "eve/hooks";
import type { HookContext } from "eve/hooks";
import { sourceWorkflowState } from "../../lib/agent/source-state";
import { appBuilderWorkflowState } from "../../lib/agent/workflow-state";
import { repositoryAccessReceiptState } from "../../lib/agent/repository-access-state";
import { repositoryAccessRuntimeForSession } from "../../lib/agent/deployment-repository-access-runtime";
import {
  restoreSelectedGitHubSandboxSource,
  selectedGitHubSourceForSandboxRestore,
} from "../../lib/agent/restore-selected-github-sandbox-source";
import {
  hasLiveWorkingPreview,
  workingPreviewState,
  workingPreviewAttemptState,
} from "../../lib/agent/working-preview-state";
import { getVercelPreviewProvider } from "../../lib/sandbox/vercel-preview-provider";

import {
  acquireHostedSandboxExecutionLease,
  isHostedSandboxExecutionEnabled,
  releaseHostedSandboxExecutionLease,
} from "../../lib/sandbox/deployment-execution-lease";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function release(
  ctx: HookContext,
  reason:
    | "turn-completed"
    | "turn-cancelled"
    | "turn-failed"
    | "session-completed"
    | "session-failed",
) {
  const environment = process.env;
  const hosted = isHostedSandboxExecutionEnabled(environment);
  const preview = workingPreviewState.get();
  const pending = workingPreviewAttemptState.get();
  if (!hosted && preview === null && pending === null) {
    return;
  }
  try {
    const sandbox = await ctx.getSandbox();
    if (
      (reason === "turn-completed" || reason === "session-completed") &&
      hasLiveWorkingPreview(preview, sandbox.id)
    ) {
      const provider = await getVercelPreviewProvider(sandbox.id, undefined, false);
      const command =
        preview !== null &&
        provider.status === "running" &&
        provider.currentSession().sessionId === preview.providerSessionId
          ? await provider.getCommand(preview.commandId)
          : undefined;
      if (command?.exitCode === null) {
        // Keep only the same still-running preview process. A resumed or
        // replaced VM must not inherit an old claim of readiness.
        return;
      }
    }
    workingPreviewState.update(() => null);
    if (!hosted) {
      // Local development uses the same cancellation and failure lifecycle.
      await sandbox.stop();
      workingPreviewAttemptState.update(() => null);
      return;
    }
    await releaseHostedSandboxExecutionLease({
      environment,
      reason,
      sandbox,
      sessionAuth: ctx.session.auth,
      sessionId: ctx.session.id,
    });
  } catch {
    // The hard provider timeout remains authoritative. Keep the durable lease
    // active so its slot cannot be reused until orphan reconciliation claims it.
  }
}

export default defineHook({
  events: {
    "session.completed"(_event, ctx) {
      return release(ctx, "session-completed");
    },
    "session.failed"(_event, ctx) {
      return release(ctx, "session-failed");
    },
    "turn.cancelled"(_event, ctx) {
      return release(ctx, "turn-cancelled");
    },
    "turn.completed"(_event, ctx) {
      return release(ctx, "turn-completed");
    },
    "turn.failed"(_event, ctx) {
      return release(ctx, "turn-failed");
    },
    async "turn.started"(_event, ctx) {
      const environment = process.env;
      if (!isHostedSandboxExecutionEnabled(environment)) {
        return;
      }
      const source = sourceWorkflowState.get();
      const workflow = appBuilderWorkflowState.get();
      console.info(
        JSON.stringify({
          event: "autograph.sandbox.restore-source-state",
          sourceHasGitHubBinding: source.phase !== "empty" && source.githubSource !== undefined,
          sourcePhase: source.phase,
          workflowHasGitHubBinding:
            workflow.phase !== "empty" && workflow.githubSource !== undefined,
          workflowPhase: workflow.phase,
        }),
      );
      const githubSource = selectedGitHubSourceForSandboxRestore({
        sourceState: source.phase === "empty" ? undefined : source.githubSource,
        workflowState: workflow.phase === "empty" ? undefined : workflow.githubSource,
      });
      if (githubSource !== undefined) {
        console.info(JSON.stringify({ event: "autograph.sandbox.restore-source-selected" }));
        restoreSelectedGitHubSandboxSource({
          accessReceipt: repositoryAccessReceiptState.get(),
          githubSource,
          runtime: () => repositoryAccessRuntimeForSession(ctx.session.auth),
          sessionId: ctx.session.id,
        });
      }
      await acquireHostedSandboxExecutionLease({
        environment,
        sandbox: await ctx.getSandbox(),
        sessionAuth: ctx.session.auth,
        sessionId: ctx.session.id,
      });
    },
  },
});
