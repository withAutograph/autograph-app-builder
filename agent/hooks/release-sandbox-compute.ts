import { defineHook } from "eve/hooks";
import type { HookContext } from "eve/hooks";

import {
  acquireHostedSandboxExecutionLease,
  isHostedSandboxExecutionEnabled,
  releaseHostedSandboxExecutionLease,
} from "../../lib/sandbox/deployment-execution-lease";

async function release(
  ctx: HookContext,
  reason:
    | "turn-completed"
    | "turn-cancelled"
    | "turn-failed"
    | "session-completed"
    | "session-failed"
) {
  const environment = process.env;
  if (!isHostedSandboxExecutionEnabled(environment)) {
    return;
  }
  try {
    await releaseHostedSandboxExecutionLease({
      environment,
      reason,
      sandbox: await ctx.getSandbox(),
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
      if (!isHostedSandboxExecutionEnabled(environment)) return;
      await acquireHostedSandboxExecutionLease({
        sessionId: ctx.session.id,
        sessionAuth: ctx.session.auth,
        sandbox: await ctx.getSandbox(),
        environment,
      });
    },
  },
});
