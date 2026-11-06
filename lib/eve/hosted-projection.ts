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

const hostedSnapshotSchema = z
  .strictObject({
    events: z.array(
      z.strictObject({
        callId: z.string().optional(),
        code: z.string().optional(),
        frameworkSessionLimit: z.boolean().optional(),
        identityInvitation: z
          .strictObject({
            callId: z.string(),
            expiresAt: z.string(),
            url: z.string(),
          })
          .optional(),
        index: z.number(),
        label: z.string().optional(),
        message: z.string().optional(),
        request: z.unknown().optional(),
        requestIds: z.array(z.string()).optional(),
        resolutionKind: z.literal("authorization").optional(),
        state: z.string().optional(),
        status: sessionStatusSchema.optional(),
        text: z.string().optional(),
        turnId: z.string().optional(),
        type: z.string(),
      }),
    ),
    nativeDeliveryState: nativeDeliveryStateSchema.optional(),
    privateInputState: privateInputStateSchema.optional(),
    prototype: publicPrototypeSchema.optional(),
    status: sessionStatusSchema,
    uiPreview: publicUiPreviewSchema.optional(),
    workingPreview: publicWorkingPreviewSchema.nullable().optional(),
  })
  .strict();

export type HostedEngineSnapshot = z.output<typeof hostedSnapshotSchema>;

type HostedProjectionResult = Pick<EveSessionResult, "cursor" | "events" | "sessionId" | "status"> &
  Partial<Pick<EveSessionResult, "inputRequests" | "prototype" | "uiPreview" | "workingPreview">>;

const internalEventSchema = z
  .strictObject({
    callId: z.string().optional(),
    code: z.string().optional(),
    frameworkSessionLimit: z.boolean().optional(),
    identityInvitation: z
      .strictObject({
        callId: z.string(),
        expiresAt: z.string(),
        url: z.string(),
      })
      .optional(),
    index: z.number(),
    label: z.string().optional(),
    message: z.string().optional(),
    request: z.unknown().optional(),
    requestIds: z.array(z.string()).optional(),
    resolutionKind: z.literal("authorization").optional(),
    state: z.string().optional(),
    status: sessionStatusSchema.optional(),
    text: z.string().optional(),
    turnId: z.string().optional(),
    type: z.string(),
  })
  .pipe(z.custom<InternalEveEvent>());

const publicEventFromCandidate = (
  candidate: HostedEngineSnapshot["events"][number],
): z.infer<typeof publicEveEventSchema> | undefined => {
  const parsedCandidate = internalEventSchema.safeParse(candidate);
  if (!parsedCandidate.success) {
    return undefined;
  }
  const projected = toPublicEvent(parsedCandidate.data);
  if (projected === null) {
    return undefined;
  }
  const parsed = publicEveEventSchema.safeParse(projected);
  return parsed.success ? parsed.data : undefined;
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function projectHostedSnapshot(
  sessionId: string,
  snapshotInput: HostedEngineSnapshot,
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
  const inputRequests = outstandingInternalEveRequests(snapshot.events);
  const result: HostedProjectionResult = {
    cursor: Math.min(cursor + events.length, publicEventCount),
    events,
    sessionId,
    status: snapshot.status,
  };
  if (inputRequests.length > 0) result.inputRequests = inputRequests;
  if (snapshot.prototype !== undefined) result.prototype = snapshot.prototype;
  if (snapshot.uiPreview !== undefined) result.uiPreview = snapshot.uiPreview;
  if (snapshot.workingPreview !== undefined) {
    result.workingPreview =
      snapshot.status === "cancelled" || snapshot.status === "failed"
        ? null
        : currentWorkingPreview(snapshot.workingPreview);
  }
  return eveSessionResultSchema.parse(result);
}
