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
    events: z.array(z.unknown()).max(100_000),
    prototype: publicPrototypeSchema.optional(),
    status: sessionStatusSchema,
    uiPreview: publicUiPreviewSchema.optional(),
    workingPreview: publicWorkingPreviewSchema.nullable().optional(),
  })
  .strict();

export type HostedEngineSnapshot = z.infer<typeof hostedSnapshotSchema>;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function projectHostedSnapshot(
  sessionId: string,
  snapshotInput: unknown,
  cursor = 0,
  limit = 100,
): EveSessionResult {
  const snapshot = hostedSnapshotSchema.parse(snapshotInput);
  const projected = snapshot.events
    .flatMap((candidate) => {
      if (candidate === null || typeof candidate !== "object") {
        return [];
      }
      const publicEvent = toPublicEvent(candidate as InternalEveEvent);
      if (publicEvent === null) {
        return [];
      }
      const parsed = publicEveEventSchema.safeParse(publicEvent);
      return parsed.success ? [parsed.data] : [];
    })
    .map((event, index) => ({ ...event, index }));
  const events = projected.slice(cursor, cursor + limit);
  const inputRequests = outstandingInternalEveRequests(
    snapshot.events.filter(
      (event): event is InternalEveEvent => event !== null && typeof event === "object",
    ),
  );
  return eveSessionResultSchema.parse({
    cursor: Math.min(cursor + events.length, projected.length),
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
