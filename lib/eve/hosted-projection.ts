import { z } from "zod";

import {
  eveSessionResultSchema,
  publicEveEventSchema,
  publicImplementationPlanSchema,
  publicPrototypeSchema,
  publicUiPreviewSchema,
  sessionStatusSchema,
  type EveSessionResult,
} from "../mcp/contracts";
import {
  outstandingInternalEveRequests,
  toPublicEvent,
  type InternalEveEvent,
} from "./public-events";

const hostedSnapshotSchema = z
  .object({
    status: sessionStatusSchema,
    events: z.array(z.unknown()).max(100_000),
    prototype: publicPrototypeSchema.optional(),
    uiPreview: publicUiPreviewSchema.optional(),
    implementationPlan: publicImplementationPlanSchema.optional(),
  })
  .strict();

export type HostedEngineSnapshot = z.infer<typeof hostedSnapshotSchema>;

export function projectHostedSnapshot(
  sessionId: string,
  snapshotInput: unknown,
  cursor = 0,
  limit = 100,
): EveSessionResult {
  const snapshot = hostedSnapshotSchema.parse(snapshotInput);
  const projected = snapshot.events
    .flatMap((candidate) => {
      if (candidate === null || typeof candidate !== "object") return [];
      const projected = toPublicEvent(candidate as InternalEveEvent);
      if (projected === null) return [];
      const parsed = publicEveEventSchema.safeParse(projected);
      return parsed.success ? [parsed.data] : [];
    })
    .map((event, index) => ({ ...event, index }));
  const events = projected.slice(cursor, cursor + limit);
  const inputRequests = outstandingInternalEveRequests(
    snapshot.events.filter(
      (event): event is InternalEveEvent =>
        event !== null && typeof event === "object",
    ),
  );
  return eveSessionResultSchema.parse({
    sessionId,
    status: snapshot.status,
    cursor: Math.min(cursor + events.length, projected.length),
    events,
    ...(inputRequests.length === 0 ? {} : { inputRequests }),
    ...(snapshot.prototype === undefined
      ? {}
      : { prototype: snapshot.prototype }),
    ...(snapshot.uiPreview === undefined
      ? {}
      : { uiPreview: snapshot.uiPreview }),
    ...(snapshot.implementationPlan === undefined
      ? {}
      : { implementationPlan: snapshot.implementationPlan }),
  });
}
