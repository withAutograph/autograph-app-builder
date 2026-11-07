import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { MessageStreamEvent } from "eve/client";

import {
  HostedOperatorError,
  operatorOwnerContextSchema,
} from "../provisioning/hosted-operator-contract";
import type { OperatorOwnerContext } from "../provisioning/hosted-operator-contract";
import { nativeTargetAuthOnlyApprovalSchema } from "../provisioning/native-target-auth-only-dispatch";
import type { NativeTargetAuthOnlyApproval } from "../provisioning/native-target-auth-only-dispatch";
import {
  nativeTargetAuthOnlyFinalRoutingPlanDigest,
  nativeTargetAuthOnlyFinalRoutingPlanSchema,
} from "../provisioning/native-target-auth-only-final-routing";
import type { NativeTargetCurrentOwner } from "../provisioning/native-target-onboarding-store";
import { privateNativeTargetApprovalObservationSchema } from "./private-native-target-approval";
import type { PrivateNativeTargetApprovalObservationPort } from "./private-native-target-approval";
import {
  createPrivateOperatorApprovalCapture,
  readPrivateOperatorApproval,
} from "./private-operator-approval-observation";
import type { PrivateOperatorApprovalCapture } from "./private-operator-approval-observation";
import type { PrivateHistoryObservation } from "./same-origin-http";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const denied = () => new HostedOperatorError("authorization_required");
type Terminal = z.infer<typeof privateNativeTargetApprovalObservationSchema>["terminals"][number];

export const nativeTargetAuthOnlyFinalRoutingApprovalAction =
  "native-target-auth-only-final-routing" as const;
export const nativeTargetAuthOnlyFinalRoutingApprovalTool =
  "prepare-app-native-target-auth-only-final-routing" as const;

/** Human approval carries only the retained parent and final-routing effect identities. */
export const nativeTargetAuthOnlyFinalRoutingApprovalInputSchema = z.strictObject({
  appId: nativeTargetAuthOnlyFinalRoutingPlanSchema.shape.target.shape.appId,
  deliveryPlanDigest: digest,
  operationRef: z.uuid(),
  routingOperationRef: z.uuid(),
  routingPlanDigest: digest,
});
export const nativeTargetAuthOnlyFinalRoutingPlanInputSchema =
  nativeTargetAuthOnlyFinalRoutingApprovalInputSchema.pick({
    appId: true,
    deliveryPlanDigest: true,
    operationRef: true,
  });

/** Read the same-owner/session settlement for exact private retained routing bytes. */
export const readPrivateNativeTargetAuthOnlyFinalRoutingApproval = async (input: {
  owner: NativeTargetCurrentOwner;
  historyOwner: OperatorOwnerContext;
  approvalInput: z.infer<typeof nativeTargetAuthOnlyFinalRoutingApprovalInputSchema>;
  routingPlanBytes: Buffer;
  retainedApproval?: NativeTargetAuthOnlyApproval;
  observation?: PrivateNativeTargetApprovalObservationPort;
  readHistory: (
    startIndex: number,
    onEvent: (event: MessageStreamEvent) => void,
  ) => Promise<PrivateHistoryObservation>;
  /** Re-read the current owner/app linkage and registered profile for these retained bytes. */
  assertOwner: () => Promise<void>;
}): Promise<NativeTargetAuthOnlyApproval | null> => {
  const owner = structuredClone(input.owner);
  const historyOwner = operatorOwnerContextSchema.parse(input.historyOwner);
  const expected = nativeTargetAuthOnlyFinalRoutingApprovalInputSchema.parse(input.approvalInput);
  const bytes = Buffer.from(input.routingPlanBytes);
  const plan = nativeTargetAuthOnlyFinalRoutingPlanSchema.parse(
    JSON.parse(bytes.toString("utf-8")),
  );
  if (
    nativeTargetAuthOnlyFinalRoutingPlanDigest(bytes) !== expected.routingPlanDigest ||
    !isDeepStrictEqual(historyOwner.authority, owner.authority) ||
    historyOwner.sessionId !== owner.publicSessionId ||
    historyOwner.adapterSessionId !== owner.adapterSessionId ||
    historyOwner.adapterGeneration !== owner.adapterGeneration ||
    plan.target.appId !== expected.appId ||
    plan.target.sessionId !== owner.publicSessionId ||
    plan.operationRef !== expected.routingOperationRef ||
    plan.deliveryOperationRef !== expected.operationRef ||
    plan.operationRef === plan.deliveryOperationRef ||
    plan.deliveryPlanDigest !== expected.deliveryPlanDigest ||
    plan.source.ownerId !== plan.target.scopeId ||
    plan.source.projectId !== plan.gateway.projectId ||
    plan.source.publicOrigin !== plan.gateway.publicOrigin ||
    plan.bootstrap.operationRef !== expected.operationRef ||
    plan.bootstrap.projectId !== plan.gateway.projectId ||
    plan.bootstrap.branch !== plan.gateway.branch ||
    plan.bootstrap.repoId !== plan.gateway.repoId ||
    plan.app.operationRef !== expected.operationRef ||
    plan.app.projectId !== plan.target.projectId ||
    plan.app.branch !== plan.target.branch ||
    plan.projection.operationRef !== expected.operationRef ||
    plan.projection.deliveryPlanDigest !== expected.deliveryPlanDigest ||
    plan.projection.gatewayProjectId !== plan.gateway.projectId ||
    plan.projection.appDeploymentId !== plan.app.deploymentId
  ) {
    throw denied();
  }
  const retained =
    input.retainedApproval === undefined
      ? undefined
      : nativeTargetAuthOnlyApprovalSchema.parse(input.retainedApproval);
  if (
    retained !== undefined &&
    (retained.planDigest !== expected.routingPlanDigest ||
      retained.sourceDigest !== expected.routingPlanDigest ||
      retained.publicSessionId !== owner.publicSessionId ||
      retained.responderPrincipalId !== owner.authority.ownerUserId)
  ) {
    throw denied();
  }
  const saved =
    input.observation?.state === undefined
      ? undefined
      : privateNativeTargetApprovalObservationSchema.parse(input.observation.state);
  const save = input.observation?.save;
  const { assertOwner } = input;
  const { readHistory } = input;
  const terminals = new Map<string, Terminal>();
  await assertOwner();
  return await readPrivateOperatorApproval({
    owner: historyOwner,
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
          action: nativeTargetAuthOnlyFinalRoutingApprovalAction,
          idempotencyKey: expected.appId,
          planDigest: expected.routingPlanDigest,
          planRef: expected.routingOperationRef,
        },
        ...(retained === undefined ? {} : { callId: retained.callId }),
        ...(state === undefined ? {} : { state }),
      });
      for (const terminal of saved?.terminals ?? []) {
        const entry = capture
          .snapshot()
          .entries.find((item) => item.requestId === terminal.requestId);
        if (entry?.callId === terminal.callId) {
          terminals.set(terminal.requestId, terminal);
        }
      }
      const proofFor = (entry: PrivateOperatorApprovalCapture["entries"][number]) => {
        const terminal = terminals.get(entry.requestId);
        if (
          terminal === undefined ||
          terminal.callId !== entry.callId ||
          terminal.responderPrincipalId !== owner.authority.ownerUserId ||
          terminal.outcome !== (entry.cancelled ? "cancelled" : "approved")
        ) {
          throw denied();
        }
        const proof = nativeTargetAuthOnlyApprovalSchema.parse({
          ...terminal,
          planDigest: expected.routingPlanDigest,
          publicSessionId: owner.publicSessionId,
          sourceDigest: expected.routingPlanDigest,
        });
        if (retained !== undefined && !isDeepStrictEqual(retained, proof)) {
          const sameRequest =
            retained.requestId === proof.requestId && retained.callId === proof.callId;
          if (!sameRequest || retained.outcome !== "approved" || proof.outcome !== "cancelled") {
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
                request.action.toolName === nativeTargetAuthOnlyFinalRoutingApprovalTool &&
                isDeepStrictEqual(request.action.input, expected)
              ) {
                capture.acceptRequest(request.requestId, request.action.callId);
              }
            }
            return;
          }
          if (event.type !== "approval.settled") return;
          const entry = capture
            .snapshot()
            .entries.find((item) => item.requestId === event.data.requestId);
          if (entry === undefined) return;
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
          if (cancelled.length > 1) throw denied();
          if (cancelled[0] !== undefined) return proofFor(cancelled[0]);
          const receipt = capture.read();
          if (receipt === null) {
            if (retained !== undefined) throw denied();
            return null;
          }
          const entry = entries.find((item) => item.requestId === receipt.approvalId);
          if (entry === undefined) throw denied();
          return proofFor(entry);
        },
        snapshot: capture.snapshot,
      };
    },
    readHistory,
    assertOwner,
  });
};
