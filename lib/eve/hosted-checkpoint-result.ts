import {
  eveSessionResultSchema,
  type EveSessionResult,
} from "../mcp/contracts";
import type { HostedSessionCheckpoint } from "./hosted-store";

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
    sessionId,
    status: checkpoint.status === "working" ? "waiting" : checkpoint.status,
    cursor: Math.min(
      effectiveCursor + events.length,
      offset + checkpoint.events.length,
    ),
    events,
    ...(checkpoint.inputRequests === undefined
      ? {}
      : { inputRequests: checkpoint.inputRequests }),
    ...(checkpoint.prototype === undefined
      ? {}
      : { prototype: checkpoint.prototype }),
    ...(checkpoint.implementationPlan === undefined
      ? {}
      : { implementationPlan: checkpoint.implementationPlan }),
  });
}
