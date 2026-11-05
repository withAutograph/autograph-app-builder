import path from "node:path";
import type { ToolContext } from "eve/tools";
import { canAutoSelectDevelopmentSource } from "../repository/development-source";
import { readLocalOwnedSessionHistory } from "../eve/read-local-turn-evidence";
import { observePrivateApplyDenials } from "../eve/private-apply-denial-evidence";
import { readPrivateApplyAuthority, retainPrivateApplyDenials } from "./private-apply-authority";

/** Catch up only the exact owner-only local cycle's complete, genuine immutable history. */
export const reconcilePrivateApplyDecisions = async (
  ctx: Pick<ToolContext, "session" | "abortSignal">,
) => {
  const expected = readPrivateApplyAuthority();
  if (expected.pending.length === 0) {
    return;
  }
  if (!canAutoSelectDevelopmentSource()) {
    return;
  }
  const home = process.env.APP_BUILDER_DEV_RUNTIME_HOME;
  if (home === undefined || path.basename(home) !== "home") {
    throw new Error("The private Build decision history is unavailable.");
  }
  const cycleRoot = path.dirname(home);
  const cycleFile = path.join(path.dirname(path.dirname(path.dirname(cycleRoot))), "eve-cycle");
  if (cycleFile !== process.env.APP_BUILDER_LOCAL_EVE_CYCLE_FILE) {
    throw new Error("The private Build decision history belongs to another local cycle.");
  }
  ctx.abortSignal?.throwIfAborted();
  const history = await readLocalOwnedSessionHistory({
    cycleRoot,
    sessionId: ctx.session.id,
    signal: ctx.abortSignal,
  });
  ctx.abortSignal?.throwIfAborted();
  const proofs = observePrivateApplyDenials({
    ...history,
    calls: expected.pending.flatMap((entry) =>
      entry.scope.sessionId === ctx.session.id ? [entry.callId] : [],
    ),
  });
  retainPrivateApplyDenials({ expected, proofs });
};
