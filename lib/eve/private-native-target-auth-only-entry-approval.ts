import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import type { MessageStreamEvent } from "eve/client";

import {
  HostedOperatorError,
  operatorOwnerContextSchema,
} from "../provisioning/hosted-operator-contract";
import type { OperatorOwnerContext } from "../provisioning/hosted-operator-contract";
import { nativeTargetAuthOnlyApprovalSchema } from "../provisioning/native-target-auth-only-dispatch";
import type { NativeTargetAuthOnlyApproval } from "../provisioning/native-target-auth-only-dispatch";
import { nativeTargetAuthOnlyEntryApprovalInputSchema } from "../provisioning/native-target-auth-only-entry-plan-store";
import type {
  createPostgresNativeTargetAuthOnlyEntryPlanStore,
  NativeTargetAuthOnlyEntryApprovalInput,
  NativeTargetAuthOnlyEntryPlanKey,
} from "../provisioning/native-target-auth-only-entry-plan-store";
import { privateNativeTargetApprovalObservationSchema } from "./private-native-target-approval";
import type { PrivateNativeTargetApprovalObservationPort } from "./private-native-target-approval";
import {
  createPrivateOperatorApprovalCapture,
  readPrivateOperatorApproval,
} from "./private-operator-approval-observation";
import type { PrivateOperatorApprovalCapture } from "./private-operator-approval-observation";
import type { PrivateHistoryObservation } from "./same-origin-http";

export const nativeTargetAuthOnlyEntryApprovalAction = "native-target-auth-only-entry" as const;
export const nativeTargetAuthOnlyEntryApprovalTool =
  "prepare-app-native-target-auth-only-entry" as const;
const denied = () => new HostedOperatorError("authorization_required");
type Store = ReturnType<typeof createPostgresNativeTargetAuthOnlyEntryPlanStore>;
type Terminal = z.infer<typeof privateNativeTargetApprovalObservationSchema>["terminals"][number];

/** Read the original same-session human approval. The tool request carries only retained identifiers and digests. */
export const readPrivateNativeTargetAuthOnlyEntryApproval = async (input: {
  historyOwner: OperatorOwnerContext;
  key: NativeTargetAuthOnlyEntryPlanKey;
  approvalInput: NativeTargetAuthOnlyEntryApprovalInput;
  store: Pick<Store, "read">;
  observation?: PrivateNativeTargetApprovalObservationPort;
  readHistory: (
    startIndex: number,
    onEvent: (event: MessageStreamEvent) => void,
  ) => Promise<PrivateHistoryObservation>;
  assertCurrentOwner: () => Promise<void>;
}): Promise<NativeTargetAuthOnlyApproval | null> => {
  const owner = operatorOwnerContextSchema.parse(input.historyOwner);
  const expected = nativeTargetAuthOnlyEntryApprovalInputSchema.parse(input.approvalInput);
  const key = structuredClone(input.key);
  if (!isDeepStrictEqual(owner.authority, key.authority) || owner.sessionId !== key.sessionId) {
    throw denied();
  }
  const readExact = async () => {
    await input.assertCurrentOwner();
    const current = await input.store.read(key);
    if (current === undefined || !isDeepStrictEqual(current.approvalInput, expected)) {
      throw denied();
    }
    return current;
  };
  const initial = await readExact();
  const retainedApproval = initial.record.approval;
  const assertOwner = async () => {
    const current = await readExact();
    if (!isDeepStrictEqual(current.record.approval, retainedApproval)) {
      throw denied();
    }
  };
  const saved =
    input.observation?.state === undefined
      ? undefined
      : privateNativeTargetApprovalObservationSchema.parse(input.observation.state);
  const save = input.observation?.save;
  const terminals = new Map<string, Terminal>();
  return await readPrivateOperatorApproval({
    owner,
    ...(save === undefined
      ? {}
      : {
          observation: {
            ...(saved === undefined ? {} : { state: saved.native }),
            save: async (native) => {
              await save(
                privateNativeTargetApprovalObservationSchema.parse({
                  native,
                  terminals: [...terminals.values()],
                  version: 1,
                }),
              );
            },
          },
        }),
    capture: (state?: PrivateOperatorApprovalCapture) => {
      const capture = createPrivateOperatorApprovalCapture({
        ownerUserId: owner.authority.ownerUserId,
        request: {
          action: nativeTargetAuthOnlyEntryApprovalAction,
          idempotencyKey: expected.appId,
          planDigest: expected.childPlanDigest,
          planRef: expected.childOperationRef,
        },
        ...(retainedApproval === undefined ? {} : { callId: retainedApproval.callId }),
        ...(state === undefined ? {} : { state }),
      });
      for (const terminal of saved?.terminals ?? []) {
        const retained = capture
          .snapshot()
          .entries.find((entry) => entry.requestId === terminal.requestId);
        if (retained?.callId === terminal.callId) {
          terminals.set(terminal.requestId, terminal);
        }
      }
      const proofFor = (entry: PrivateOperatorApprovalCapture["entries"][number]) => {
        const terminal = terminals.get(entry.requestId);
        const outcome = entry.cancelled ? "cancelled" : "approved";
        if (
          terminal === undefined ||
          terminal.callId !== entry.callId ||
          terminal.responderPrincipalId !== owner.authority.ownerUserId ||
          terminal.outcome !== outcome
        ) {
          throw denied();
        }
        const proof = nativeTargetAuthOnlyApprovalSchema.parse({
          ...terminal,
          planDigest: expected.deliveryPlanDigest,
          publicSessionId: key.sessionId,
          sourceDigest: expected.childPlanDigest,
        });
        if (retainedApproval !== undefined && !isDeepStrictEqual(retainedApproval, proof)) {
          const sameRequest =
            retainedApproval.requestId === proof.requestId &&
            retainedApproval.callId === proof.callId;
          if (
            !sameRequest ||
            retainedApproval.outcome !== "approved" ||
            proof.outcome !== "cancelled"
          ) {
            throw denied();
          }
        }
        return proof;
      };
      return {
        observe(event: MessageStreamEvent) {
          if (event.type === "input.requested") {
            for (const request of event.data.requests) {
              if (
                request.kind === "tool-approval" &&
                request.action.toolName === nativeTargetAuthOnlyEntryApprovalTool &&
                isDeepStrictEqual(request.action.input, expected)
              ) {
                capture.acceptRequest(request.requestId, request.action.callId);
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
          if (
            previous === undefined ||
            (previous.outcome === "approved" && outcome === "cancelled")
          ) {
            terminals.set(entry.requestId, {
              requestId: entry.requestId,
              callId: entry.callId,
              responderPrincipalId: event.data.responderPrincipalId,
              observedAt: event.meta.at,
              outcome,
            });
          }
        },
        proveComplete: capture.proveComplete,
        read() {
          const entries = capture.snapshot().entries;
          const cancelled = entries.filter((entry) => entry.cancelled);
          if (cancelled.length > 1) {
            throw denied();
          }
          if (cancelled[0] !== undefined) {
            return proofFor(cancelled[0]);
          }
          const receipt = capture.read();
          if (receipt === null) {
            if (retainedApproval !== undefined) {
              throw denied();
            }
            return null;
          }
          const entry = entries.find((candidate) => candidate.requestId === receipt.approvalId);
          if (entry === undefined) {
            throw denied();
          }
          return proofFor(entry);
        },
        snapshot: capture.snapshot,
      };
    },
    readHistory: input.readHistory,
    assertOwner,
  });
};
