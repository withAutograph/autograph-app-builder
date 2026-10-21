import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { MessageStreamEvent } from "eve/client";
import { HostedSessionReadTimeoutError } from "./hosted-session-read-timeout-error";
import type { OperatorOwnerContext } from "../provisioning/hosted-operator-contract";
import type { PrivateHistoryObservation } from "./same-origin-http";

const requestSchema = z.strictObject({
  action: z.enum(["export", "continuity", "native-target"]),
  planRef: z.string().min(1),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  idempotencyKey: z.string().min(1),
});
export const privateOperatorApprovalCaptureSchema = z
  .strictObject({
    request: requestSchema,
    ownerUserId: z.string().min(1),
    entries: z.array(
      z.strictObject({
        requestId: z.string().min(1),
        callId: z.string().min(1),
        approved: z.boolean(),
        cancelled: z.boolean(),
        completedApproved: z.boolean().default(false),
        completedCancelled: z.boolean().default(false),
      }),
    ),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.entries.map((entry) => entry.requestId)).size !== value.entries.length) {
      ctx.addIssue({ code: "custom", message: "Ambiguous private approval capture." });
    }
  });
export type PrivateOperatorApprovalCapture = z.infer<typeof privateOperatorApprovalCaptureSchema>;
export const privateOperatorApprovalObservationSchema = z.strictObject({
  adapterSessionId: z.string().min(1),
  adapterGeneration: z.number().int().positive(),
  nextNativeIndex: z.number().int().nonnegative(),
  capture: privateOperatorApprovalCaptureSchema,
});
export type PrivateOperatorApprovalObservation = z.infer<
  typeof privateOperatorApprovalObservationSchema
>;
export interface PrivateOperatorApprovalObservationPort {
  state?: PrivateOperatorApprovalObservation;
  save: (state: PrivateOperatorApprovalObservation) => Promise<void>;
}

export const createPrivateOperatorApprovalCapture = (input: {
  request: z.infer<typeof requestSchema>;
  ownerUserId: string;
  callId?: string;
  state?: PrivateOperatorApprovalCapture;
}) => {
  const saved =
    input.state === undefined ? undefined : privateOperatorApprovalCaptureSchema.parse(input.state);
  if (
    saved !== undefined &&
    (!isDeepStrictEqual(saved.request, input.request) || saved.ownerUserId !== input.ownerUserId)
  ) {
    throw new Error("Private approval checkpoint belongs to another intent or owner.");
  }
  const entries = new Map((saved?.entries ?? []).map((entry) => [entry.requestId, { ...entry }]));
  return {
    acceptRequest(requestId: string, callId: string) {
      const previous = entries.get(requestId);
      if (previous !== undefined && previous.callId !== callId) {
        throw new Error("Private approval request changed call identity.");
      }
      entries.set(
        requestId,
        previous ?? {
          requestId,
          callId,
          approved: false,
          cancelled: false,
          completedApproved: false,
          completedCancelled: false,
        },
      );
    },
    settle(event: Extract<MessageStreamEvent, { type: "approval.settled" }>) {
      const entry = entries.get(event.data.requestId);
      if (entry === undefined) {
        return;
      }
      if (
        event.data.outcome !== "approved" ||
        event.data.responderPrincipalId !== input.ownerUserId
      ) {
        entry.cancelled = true;
      } else {
        entry.approved = true;
      }
    },
    proveComplete: () => {
      for (const entry of entries.values()) {
        entry.completedApproved = entry.approved;
        entry.completedCancelled = entry.cancelled;
      }
    },
    read() {
      const matched = [...entries.values()].filter(
        (entry) => input.callId === undefined || entry.callId === input.callId,
      );
      if (matched.some((entry) => entry.cancelled)) {
        return null;
      }
      const approved = matched.filter((entry) => entry.approved);
      if (approved.length > 1) {
        throw new Error("Private approval is ambiguous.");
      }
      const entry = approved[0];
      return entry === undefined
        ? null
        : { approvalId: entry.requestId, approvedByCallId: entry.callId };
    },
    snapshot: (): PrivateOperatorApprovalCapture =>
      privateOperatorApprovalCaptureSchema.parse({
        request: input.request,
        ownerUserId: input.ownerUserId,
        entries: [...entries.values()],
      }),
  };
};

/** A native cursor and its private request/settlement pairs form one atomic checkpoint. */
export const readPrivateOperatorApproval = async <Approval>(input: {
  owner: OperatorOwnerContext;
  observation?: PrivateOperatorApprovalObservationPort;
  capture: (state?: PrivateOperatorApprovalCapture) => {
    observe: (event: MessageStreamEvent) => void;
    read: () => Approval | null;
    snapshot: () => PrivateOperatorApprovalCapture;
    proveComplete: () => void;
  };
  readHistory: (
    startIndex: number,
    onEvent: (event: MessageStreamEvent) => void,
  ) => Promise<PrivateHistoryObservation>;
  assertOwner: () => Promise<void>;
}): Promise<Approval | null> => {
  const saved = input.observation?.state;
  const sameAdapter =
    saved !== undefined &&
    saved.adapterSessionId === input.owner.adapterSessionId &&
    saved.adapterGeneration === input.owner.adapterGeneration;
  const startIndex = sameAdapter ? saved.nextNativeIndex : 0;
  const state =
    saved === undefined
      ? undefined
      : {
          ...saved.capture,
          // Approval grants require a completed tail; authenticated cancellation is
          // monotone denial even when observed during a later partial read.
          entries: sameAdapter
            ? saved.capture.entries
            : saved.capture.entries.flatMap((entry) =>
                entry.completedApproved || entry.cancelled || entry.completedCancelled
                  ? [
                      {
                        ...entry,
                        approved: entry.completedApproved,
                        cancelled: entry.cancelled || entry.completedCancelled,
                      },
                    ]
                  : [],
              ),
        };
  const capture = input.capture(state);
  const observed = await input.readHistory(startIndex, capture.observe);
  await input.assertOwner();
  if (observed.complete) {
    capture.proveComplete();
  }
  const approval = observed.complete ? capture.read() : null;
  let persisted = false;
  if (
    approval === null &&
    input.observation !== undefined &&
    (observed.complete || observed.nextNativeIndex > startIndex)
  ) {
    const checkpoint = privateOperatorApprovalObservationSchema.parse({
      adapterSessionId: input.owner.adapterSessionId,
      adapterGeneration: input.owner.adapterGeneration,
      nextNativeIndex: observed.nextNativeIndex,
      capture: capture.snapshot(),
    });
    if (!isDeepStrictEqual(saved, checkpoint)) {
      await input.observation.save(checkpoint);
      persisted = true;
    }
  }
  try {
    console.info("[builder:operator-approval-read]", {
      sessionIdHash: `sha256:${createHash("sha256").update(input.owner.sessionId).digest("hex")}`,
      nativeStartIndex: startIndex,
      nativeNextIndex: observed.nextNativeIndex,
      nativeTailIndex: observed.nativeTailIndex,
      complete: observed.complete,
      progressPersisted: persisted,
    });
  } catch {
    /* Diagnostic delivery never changes approval authority. */
  }
  if (!observed.complete) {
    throw new HostedSessionReadTimeoutError();
  }
  return approval;
};
