import { defineHook } from "eve/hooks";

import { releaseHostedSandboxExecutionLease } from "@/lib/sandbox/deployment-execution-lease";

async function release(
  sessionId: string,
  reason:
    | "waiting"
    | "turn-completed"
    | "turn-cancelled"
    | "turn-failed"
    | "session-completed"
    | "session-failed",
) {
  try {
    await releaseHostedSandboxExecutionLease({ sessionId, reason });
  } catch {
    // The hard provider timeout remains authoritative. Keep the durable lease
    // active so its slot cannot be reused until orphan reconciliation claims it.
  }
}

export default defineHook({
  events: {
    "session.waiting"(_event, ctx) {
      return release(ctx.session.id, "waiting");
    },
    "turn.completed"(_event, ctx) {
      return release(ctx.session.id, "turn-completed");
    },
    "turn.cancelled"(_event, ctx) {
      return release(ctx.session.id, "turn-cancelled");
    },
    "turn.failed"(_event, ctx) {
      return release(ctx.session.id, "turn-failed");
    },
    "session.completed"(_event, ctx) {
      return release(ctx.session.id, "session-completed");
    },
    "session.failed"(_event, ctx) {
      return release(ctx.session.id, "session-failed");
    },
  },
});
