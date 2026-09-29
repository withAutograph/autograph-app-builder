import { z } from "zod";

import {
  eveSessionResultSchema,
  publicEveEventSchema,
  publicPrototypeSchema,
  publicUiPreviewSchema,
  publicWorkingPreviewSchema,
  sessionStatusSchema,
} from "../mcp/contracts";
import type { EveSessionResult } from "../mcp/contracts";
import {
  currentWorkingPreview,
  outstandingInternalEveRequests,
  toPublicEvent,
} from "./public-events";
import type { InternalEveEvent } from "./public-events";

const hostedSnapshotSchema = z
  .object({
    events: z.array(z.unknown()),
    prototype: publicPrototypeSchema.optional(),
    status: sessionStatusSchema,
    uiPreview: publicUiPreviewSchema.optional(),
    workingPreview: publicWorkingPreviewSchema.nullable().optional(),
  })
  .strict();

export type HostedEngineSnapshot = z.infer<typeof hostedSnapshotSchema>;

// eslint-disable-next-line eslint/func-style -- Keep the filtering iterator lazy for snapshot projection.
function* internalEvents(candidates: readonly unknown[]): Generator<InternalEveEvent> {
  for (const candidate of candidates) {
    if (candidate !== null && typeof candidate === "object") {
      yield candidate as InternalEveEvent;
    }
  }
}

const publicEventFromCandidate = (
  candidate: unknown,
): z.infer<typeof publicEveEventSchema> | undefined => {
  if (candidate === null || typeof candidate !== "object") {
    return undefined;
  }
  const projected = toPublicEvent(candidate as InternalEveEvent);
  if (projected === null) {
    return undefined;
  }
  const parsed = publicEveEventSchema.safeParse(projected);
  return parsed.success ? parsed.data : undefined;
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function projectHostedSnapshot(
  sessionId: string,
  snapshotInput: unknown,
  cursor = 0,
  limit = 100,
): EveSessionResult {
  const snapshot = hostedSnapshotSchema.parse(snapshotInput);
  const events: z.infer<typeof publicEveEventSchema>[] = [];
  let publicEventCount = 0;
  for (const candidate of snapshot.events) {
    const publicEvent = publicEventFromCandidate(candidate);
    if (publicEvent !== undefined) {
      if (publicEventCount >= cursor && events.length < limit) {
        events.push({ ...publicEvent, index: publicEventCount });
      }
      publicEventCount += 1;
    }
  }
  const inputRequests = outstandingInternalEveRequests(internalEvents(snapshot.events));
  return eveSessionResultSchema.parse({
    cursor: Math.min(cursor + events.length, publicEventCount),
    events,
    sessionId,
    status: snapshot.status,
    ...(inputRequests.length === 0 ? {} : { inputRequests }),
    ...(snapshot.prototype === undefined ? {} : { prototype: snapshot.prototype }),
    ...(snapshot.uiPreview === undefined ? {} : { uiPreview: snapshot.uiPreview }),
    ...(snapshot.workingPreview === undefined
      ? {}
      : {
          workingPreview:
            snapshot.status === "cancelled" || snapshot.status === "failed"
              ? null
              : currentWorkingPreview(snapshot.workingPreview),
        }),
  });
}
