import { defineHook } from "eve/hooks";
import type { HookContext } from "eve/hooks";
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
  if (!hosted && preview === null && pending === null) {return;}
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
      await acquireHostedSandboxExecutionLease({
        environment,
        sandbox: await ctx.getSandbox(),
        sessionAuth: ctx.session.auth,
        sessionId: ctx.session.id,
      });
    },
  },
});
