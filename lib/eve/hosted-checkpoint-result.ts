import { currentWorkingPreview } from "./public-events";
import { eveSessionResultSchema } from "../mcp/contracts";
import type { EveSessionResult } from "../mcp/contracts";
import type { HostedSessionCheckpoint } from "./hosted-store";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function resultFromHostedCheckpoint(
  sessionId: string,
  checkpoint: HostedSessionCheckpoint,
  cursor = 0,
  limit = 100,
): EveSessionResult {
  const offset = checkpoint.truncatedBeforeIndex ?? 0;
  const effectiveCursor = Math.max(cursor, offset);
  const start = effectiveCursor - offset;
  const events = checkpoint.events.slice(start, start + limit);
  const result: EveSessionResult = {
    cursor: Math.min(effectiveCursor + events.length, offset + checkpoint.events.length),
    events,
    sessionId,
    status: checkpoint.status === "working" ? "waiting" : checkpoint.status,
  };

  if (checkpoint.inputRequests !== undefined) {
    result.inputRequests = checkpoint.inputRequests;
  }
  if (checkpoint.prototype !== undefined) {
    result.prototype = checkpoint.prototype;
  }
  if (checkpoint.uiPreview !== undefined) {
    result.uiPreview = checkpoint.uiPreview;
  }
  if (checkpoint.workingPreview !== undefined) {
    result.workingPreview =
      checkpoint.status === "cancelled" || checkpoint.status === "failed"
        ? null
        : currentWorkingPreview(checkpoint.workingPreview);
  }

  return eveSessionResultSchema.parse(result);
}
