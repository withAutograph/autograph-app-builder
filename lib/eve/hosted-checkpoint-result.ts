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
  return eveSessionResultSchema.parse({
    cursor: Math.min(effectiveCursor + events.length, offset + checkpoint.events.length),
    events,
    sessionId,
    status: checkpoint.status === "working" ? "waiting" : checkpoint.status,
    ...(checkpoint.inputRequests === undefined ? {} : { inputRequests: checkpoint.inputRequests }),
    ...(checkpoint.prototype === undefined ? {} : { prototype: checkpoint.prototype }),
    ...(checkpoint.uiPreview === undefined ? {} : { uiPreview: checkpoint.uiPreview }),
    ...(checkpoint.workingPreview === undefined
      ? {}
      : {
          workingPreview:
            checkpoint.status === "cancelled" || checkpoint.status === "failed"
              ? null
              : currentWorkingPreview(checkpoint.workingPreview),
        }),
  });
}
