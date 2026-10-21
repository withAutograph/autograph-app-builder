import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { MessageStreamEvent } from "eve/client";

import {
  createPrivateOperatorApprovalCapture,
  privateOperatorApprovalObservationSchema,
  readPrivateOperatorApproval,
} from "./private-operator-approval-observation";
import type {
  PrivateOperatorApprovalCapture,
  PrivateOperatorApprovalObservation,
} from "./private-operator-approval-observation";
import type { PrivateHistoryObservation } from "./same-origin-http";
import type { OperatorOwnerContext } from "../provisioning/hosted-operator-contract";
import {
  nativeTargetOnboardingApprovalSchema,
  nativeTargetOnboardingPlanDigest,
  nativeTargetOnboardingPlanSchema,
  nativeTargetOnboardingRecordSchema,
  nativeTargetOnboardingRegistryId,
} from "../provisioning/native-target-onboarding-contract";
import type {
  NativeTargetOnboardingApproval,
  NativeTargetOnboardingRecord,
} from "../provisioning/native-target-onboarding-contract";
import type { NativeTargetCurrentOwner } from "../provisioning/native-target-onboarding-store";

const terminalSchema = z.strictObject({
  requestId: z.string().min(1),
  callId: z.string().min(1),
  responderPrincipalId: z.string().min(1),
  outcome: z.enum(["approved", "cancelled"]),
  observedAt: z.iso.datetime({ offset: true }),
});
type Terminal = z.infer<typeof terminalSchema>;
export const privateNativeTargetApprovalObservationSchema = z.strictObject({
  version: z.literal(1),
  native: privateOperatorApprovalObservationSchema,
  terminals: z.array(terminalSchema).superRefine((entries, context) => {
    if (new Set(entries.map((entry) => entry.requestId)).size !== entries.length) {
      context.addIssue({ code: "custom", message: "Ambiguous native target terminal proof." });
    }
  }),
});
export type PrivateNativeTargetApprovalObservation = z.infer<
  typeof privateNativeTargetApprovalObservationSchema
>;
export interface PrivateNativeTargetApprovalObservationPort {
  state?: PrivateNativeTargetApprovalObservation;
  save: (state: PrivateNativeTargetApprovalObservation) => Promise<void>;
}

const inputSchema = z.strictObject({
  appId: nativeTargetOnboardingPlanSchema.shape.appId,
  operationRef: z.uuid(),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  plan: nativeTargetOnboardingPlanSchema,
});

/** The frozen registry plan is the intent; event input is only its exact human-visible echo. */
export const createPrivateNativeTargetApprovalCapture = (input: {
  owner: NativeTargetCurrentOwner;
  record: NativeTargetOnboardingRecord;
  callId?: string;
  state?: PrivateOperatorApprovalCapture;
  terminals?: readonly Terminal[];
}) => {
  const record = nativeTargetOnboardingRecordSchema.parse(input.record);
  const operationRef = nativeTargetOnboardingRegistryId(input.owner.authority, record.appId);
  const expected = inputSchema.parse({
    appId: record.appId,
    operationRef,
    planDigest: record.planDigest,
    plan: record.plan,
  });
  if (nativeTargetOnboardingPlanDigest(record.plan) !== record.planDigest) {
    throw new Error("Native target approval plan changed.");
  }
  const capture = createPrivateOperatorApprovalCapture({
    request: {
      action: "native-target",
      planRef: operationRef,
      planDigest: record.planDigest,
      idempotencyKey: record.appId,
    },
    ownerUserId: input.owner.authority.ownerUserId,
    ...(input.callId === undefined ? {} : { callId: input.callId }),
    ...(input.state === undefined ? {} : { state: input.state }),
  });
  const retainedEntries = new Map(
    capture.snapshot().entries.map((entry) => [entry.requestId, entry]),
  );
  const terminals = new Map<string, Terminal>();
  for (const prior of input.terminals ?? []) {
    const terminal = terminalSchema.parse(prior);
    const entry = retainedEntries.get(terminal.requestId);
    if (entry !== undefined && entry.callId === terminal.callId) {
      if (terminals.has(terminal.requestId)) {
        throw new Error("Native target terminal proof is ambiguous.");
      }
      terminals.set(terminal.requestId, terminal);
    }
  }
  const proofFor = (entry: PrivateOperatorApprovalCapture["entries"][number]) => {
    const terminal = terminals.get(entry.requestId);
    const expectedOutcome = entry.cancelled ? "cancelled" : "approved";
    if (
      terminal === undefined ||
      terminal.callId !== entry.callId ||
      terminal.responderPrincipalId !== input.owner.authority.ownerUserId ||
      terminal.outcome !== expectedOutcome
    ) {
      throw new Error("Native target terminal proof is unavailable.");
    }
    return nativeTargetOnboardingApprovalSchema.parse({
      requestId: terminal.requestId,
      callId: terminal.callId,
      planDigest: record.planDigest,
      responderPrincipalId: terminal.responderPrincipalId,
      publicSessionId: record.plan.origin.publicSessionId,
      outcome: terminal.outcome,
      observedAt: terminal.observedAt,
    });
  };
  return {
    observe(event: MessageStreamEvent) {
      if (event.type === "input.requested") {
        for (const requested of event.data.requests) {
          if (
            requested.kind !== "tool-approval" ||
            requested.action.toolName !== "prepare-app-native-target"
          ) {
            continue;
          }
          const parsed = inputSchema.safeParse(requested.action.input);
          if (parsed.success && isDeepStrictEqual(parsed.data, expected)) {
            capture.acceptRequest(requested.requestId, requested.action.callId);
          }
        }
        return;
      }
      if (event.type !== "approval.settled") {
        return;
      }
      const entry = capture
        .snapshot()
        .entries.find((candidate) => candidate.requestId === event.data.requestId);
      if (entry === undefined) {
        return;
      }
      capture.settle(event);
      const outcome = event.data.outcome === "approved" ? "approved" : "cancelled";
      const previous = terminals.get(entry.requestId);
      if (previous === undefined || (previous.outcome === "approved" && outcome === "cancelled")) {
        terminals.set(
          entry.requestId,
          terminalSchema.parse({
            requestId: entry.requestId,
            callId: entry.callId,
            responderPrincipalId: event.data.responderPrincipalId,
            outcome,
            observedAt: event.meta.at,
          }),
        );
      }
    },
    read(): NativeTargetOnboardingApproval | null {
      const entries = capture
        .snapshot()
        .entries.filter((entry) => input.callId === undefined || entry.callId === input.callId);
      const cancelled = entries.filter((entry) => entry.cancelled);
      if (cancelled.length > 1) {
        throw new Error("Native target cancellation is ambiguous.");
      }
      if (cancelled[0] !== undefined) {
        return proofFor(cancelled[0]);
      }
      const receipt = capture.read();
      if (receipt === null) {
        return null;
      }
      const entry = entries.find((candidate) => candidate.requestId === receipt.approvalId);
      if (entry === undefined) {
        throw new Error("Native target approval request changed.");
      }
      return proofFor(entry);
    },
    snapshot: capture.snapshot,
    proveComplete: capture.proveComplete,
    terminalSnapshot: () =>
      [...terminals.values()].map((terminal) => terminalSchema.parse(terminal)),
  };
};

/** A complete authenticated native tail yields the original settlement identity or pending. */
export const readPrivateNativeTargetApproval = async (input: {
  owner: NativeTargetCurrentOwner;
  record: NativeTargetOnboardingRecord;
  historyOwner: OperatorOwnerContext;
  callId?: string;
  observation?: PrivateNativeTargetApprovalObservationPort;
  readHistory: (
    startIndex: number,
    onEvent: (event: MessageStreamEvent) => void,
  ) => Promise<PrivateHistoryObservation>;
  assertOwner: () => Promise<void>;
}): Promise<
  | { status: "pending" }
  | { status: "approved" | "cancelled"; proof: NativeTargetOnboardingApproval }
> => {
  if (
    !isDeepStrictEqual(input.historyOwner.authority, input.owner.authority) ||
    input.historyOwner.sessionId !== input.owner.publicSessionId ||
    input.historyOwner.adapterSessionId !== input.owner.adapterSessionId ||
    input.historyOwner.adapterGeneration !== input.owner.adapterGeneration
  ) {
    throw new Error("Native target approval history owner changed.");
  }
  const saved =
    input.observation?.state === undefined
      ? undefined
      : privateNativeTargetApprovalObservationSchema.parse(input.observation.state);
  let capture: ReturnType<typeof createPrivateNativeTargetApprovalCapture> | undefined;
  const approval = await readPrivateOperatorApproval({
    owner: input.historyOwner,
    ...(input.observation === undefined
      ? {}
      : {
          observation: {
            ...(saved === undefined ? {} : { state: saved.native }),
            save: async (native: PrivateOperatorApprovalObservation) => {
              if (capture === undefined) {
                throw new Error("Native target approval capture is unavailable.");
              }
              await input.observation?.save(
                privateNativeTargetApprovalObservationSchema.parse({
                  version: 1,
                  native,
                  terminals: capture.terminalSnapshot(),
                }),
              );
            },
          },
        }),
    capture: (state) => {
      capture = createPrivateNativeTargetApprovalCapture({
        owner: input.owner,
        record: input.record,
        ...(input.callId === undefined ? {} : { callId: input.callId }),
        ...(state === undefined ? {} : { state }),
        ...(saved === undefined ? {} : { terminals: saved.terminals }),
      });
      return capture;
    },
    readHistory: input.readHistory,
    assertOwner: input.assertOwner,
  });
  return approval === null ? { status: "pending" } : { status: approval.outcome, proof: approval };
};
