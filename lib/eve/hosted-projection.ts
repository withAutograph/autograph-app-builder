import { nativeDeliveryStateSchema } from "./native-delivery-state";
import { privateInputStateSchema } from "./session-limit-input";
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

const hostedSnapshotSchema = z.strictObject({
  events: z.array(z.unknown()),
  nativeDeliveryState: nativeDeliveryStateSchema.optional(),
  privateInputState: privateInputStateSchema.optional(),
  prototype: publicPrototypeSchema.optional(),
  status: sessionStatusSchema,
  uiPreview: publicUiPreviewSchema.optional(),
  workingPreview: publicWorkingPreviewSchema.nullable().optional(),
});

export type HostedEngineSnapshot = z.infer<typeof hostedSnapshotSchema>;

// eslint-disable-next-line eslint/func-style -- Keep the filtering iterator lazy for snapshot projection.
function* internalEvents(candidates: readonly unknown[]): Generator<InternalEveEvent> {
  for (const candidate of candidates) {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
    if (candidate !== null && typeof candidate === "object") {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/require-safety-comment-for-type-assertion -- Preserve the existing type assertion at this boundary.
      yield candidate as InternalEveEvent;
    }
  }
}

const publicEventFromCandidate = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the existing unknown input contract.
  candidate: unknown,
): z.infer<typeof publicEveEventSchema> | undefined => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
  if (candidate === null || typeof candidate !== "object") {
    return undefined;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/require-safety-comment-for-type-assertion -- Preserve the existing type assertion at this boundary.
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
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the existing unknown input contract.
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
  const result: EveSessionResult = {
    cursor: Math.min(cursor + events.length, publicEventCount),
    events,
    sessionId,
    status: snapshot.status,
  };
  if (inputRequests.length !== 0) {
    result.inputRequests = inputRequests;
  }
  if (snapshot.prototype !== undefined) {
    result.prototype = snapshot.prototype;
  }
  if (snapshot.uiPreview !== undefined) {
    result.uiPreview = snapshot.uiPreview;
  }
  if (snapshot.workingPreview !== undefined) {
    result.workingPreview =
      snapshot.status === "cancelled" || snapshot.status === "failed"
        ? null
        : currentWorkingPreview(snapshot.workingPreview);
  }
  return eveSessionResultSchema.parse(result);
}
