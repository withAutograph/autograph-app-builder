import { defineHook, type HookContext } from "eve/hooks";

import {
  acquireHostedSandboxExecutionLease,
  releaseHostedSandboxExecutionLease,
} from "@/lib/sandbox/deployment-execution-lease";

async function release(
  ctx: HookContext,
  reason:
    | "turn-completed"
    | "turn-cancelled"
    | "turn-failed"
    | "session-completed"
    | "session-failed",
) {
  try {
    await releaseHostedSandboxExecutionLease({
      sessionId: ctx.session.id,
      sessionAuth: ctx.session.auth,
      sandbox: await ctx.getSandbox(),
      reason,
    });
  } catch {
    // The hard provider timeout remains authoritative. Keep the durable lease
    // active so its slot cannot be reused until orphan reconciliation claims it.
  }
}

export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      await acquireHostedSandboxExecutionLease({
        sessionId: ctx.session.id,
        sessionAuth: ctx.session.auth,
        sandbox: await ctx.getSandbox(),
      });
    },
    "turn.completed"(_event, ctx) {
      return release(ctx, "turn-completed");
    },
    "turn.cancelled"(_event, ctx) {
      return release(ctx, "turn-cancelled");
    },
    "turn.failed"(_event, ctx) {
      return release(ctx, "turn-failed");
    },
    "session.completed"(_event, ctx) {
      return release(ctx, "session-completed");
    },
    "session.failed"(_event, ctx) {
      return release(ctx, "session-failed");
    },
  },
});
