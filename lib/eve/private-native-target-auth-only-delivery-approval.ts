import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { MessageStreamEvent } from "eve/client";

import {
  createPrivateOperatorApprovalCapture,
  readPrivateOperatorApproval,
} from "./private-operator-approval-observation";
import type {
  PrivateOperatorApprovalCapture,
  PrivateOperatorApprovalObservation,
} from "./private-operator-approval-observation";
import { privateNativeTargetApprovalObservationSchema } from "./private-native-target-approval";
import type { PrivateNativeTargetApprovalObservationPort } from "./private-native-target-approval";
import type { PrivateHistoryObservation } from "./same-origin-http";
import { operatorOwnerContextSchema } from "../provisioning/hosted-operator-contract";
import type { OperatorOwnerContext } from "../provisioning/hosted-operator-contract";
import {
  nativeTargetAuthOnlyPlanSchema,
  nativeTargetAuthOnlyPlanDigest,
} from "../provisioning/native-target-auth-only-plan-schema";
import type { NativeTargetAuthOnlyPlan } from "../provisioning/native-target-auth-only-plan-schema";
import {
  nativeTargetAuthOnlyDeliveryPlanSchema,
  nativeTargetAuthOnlyDeliveryPlanDigest,
} from "../provisioning/native-target-auth-only-delivery-plan";
import { nativeTargetAuthOnlyApprovalSchema } from "../provisioning/native-target-auth-only-dispatch";
import type { NativeTargetAuthOnlyApproval } from "../provisioning/native-target-auth-only-dispatch";
import type { NativeTargetCurrentOwner } from "../provisioning/native-target-onboarding-store";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const terminalSchema = nativeTargetAuthOnlyApprovalSchema.pick({
  requestId: true,
  callId: true,
  responderPrincipalId: true,
  outcome: true,
  observedAt: true,
});
const unavailable = () => new Error("Auth-only delivery approval is unavailable.");
export const nativeTargetAuthOnlyDeliveryApprovalAction =
  "native-target-auth-only-delivery" as const;
export const nativeTargetAuthOnlyDeliveryApprovalTool =
  "prepare-app-native-target-auth-only-delivery" as const;

export const nativeTargetAuthOnlyDeliveryPreparationInputSchema = z.strictObject({
  appId: nativeTargetAuthOnlyPlanSchema.shape.appId,
  operationRef: z.uuid(),
  planDigest: digest,
  resourcePlanDigest: digest,
  deliveryPlanDigest: digest,
  deliveryPlan: nativeTargetAuthOnlyDeliveryPlanSchema,
});

/** Reads the authenticated settlement for one immutable delivery projection and its two ordered effects. */
export const readPrivateNativeTargetAuthOnlyDeliveryApproval = async (input: {
  owner: NativeTargetCurrentOwner;
  historyOwner: OperatorOwnerContext;
  plan: NativeTargetAuthOnlyPlan;
  operationRef: string;
  deliveryPlanBytes: Buffer;
  resourcePlanDigest: string;
  deliveryPlanDigest: string;
  retainedApproval?: NativeTargetAuthOnlyApproval;
  observation?: PrivateNativeTargetApprovalObservationPort;
  readHistory: (
    startIndex: number,
    onEvent: (event: MessageStreamEvent) => void,
  ) => Promise<PrivateHistoryObservation>;
  assertOwner: () => Promise<void>;
}): Promise<NativeTargetAuthOnlyApproval | null> => {
  const owner = structuredClone(input.owner);
  const historyOwner = operatorOwnerContextSchema.parse(input.historyOwner);
  const plan = nativeTargetAuthOnlyPlanSchema.parse(input.plan);
  const planDigest = nativeTargetAuthOnlyPlanDigest(plan);
  const bytes = Buffer.from(input.deliveryPlanBytes);
  const deliveryPlanDigest = digest.parse(input.deliveryPlanDigest);
  const deliveryPlan = nativeTargetAuthOnlyDeliveryPlanSchema.parse(
    JSON.parse(bytes.toString("utf8")),
  );
  const operationRef = z.uuid().parse(input.operationRef);
  const resourcePlanDigest = digest.parse(input.resourcePlanDigest);
  if (
    createHash("sha256").update(bytes).digest("hex") !== deliveryPlanDigest ||
    nativeTargetAuthOnlyDeliveryPlanDigest(bytes) !== deliveryPlanDigest ||
    !isDeepStrictEqual(historyOwner.authority, owner.authority) ||
    !isDeepStrictEqual(plan.origin.authority, owner.authority) ||
    historyOwner.sessionId !== owner.publicSessionId ||
    historyOwner.adapterSessionId !== owner.adapterSessionId ||
    historyOwner.adapterGeneration !== owner.adapterGeneration ||
    plan.origin.publicSessionId !== owner.publicSessionId ||
    deliveryPlan.authOnlyPlanDigest !== planDigest ||
    deliveryPlan.resourcePlanDigest !== resourcePlanDigest ||
    deliveryPlan.target.appId !== plan.appId ||
    deliveryPlan.target.sessionId !== plan.origin.publicSessionId ||
    deliveryPlan.target.branch !== plan.branch ||
    deliveryPlan.source.branch !== plan.branch ||
    deliveryPlan.source.gitSha !== plan.publishedSource.gitSha ||
    deliveryPlan.source.repositoryId !== plan.publishedSource.repositoryId
  )
    throw unavailable();

  const expected = nativeTargetAuthOnlyDeliveryPreparationInputSchema.parse({
    appId: plan.appId,
    operationRef,
    planDigest,
    resourcePlanDigest,
    deliveryPlanDigest,
    deliveryPlan,
  });
  const retained =
    input.retainedApproval === undefined
      ? undefined
      : nativeTargetAuthOnlyApprovalSchema.parse(input.retainedApproval);
  if (
    retained !== undefined &&
    (retained.planDigest !== deliveryPlanDigest ||
      retained.sourceDigest !== deliveryPlanDigest ||
      retained.publicSessionId !== plan.origin.publicSessionId ||
      retained.responderPrincipalId !== owner.authority.ownerUserId)
  )
    throw unavailable();
  const saved =
    input.observation?.state === undefined
      ? undefined
      : privateNativeTargetApprovalObservationSchema.parse(input.observation.state);
  const terminals = new Map<string, z.infer<typeof terminalSchema>>();
  const assertOwner = input.assertOwner;
  await assertOwner();
  return await readPrivateOperatorApproval({
    owner: historyOwner,
    ...(input.observation?.save === undefined
      ? {}
      : {
          observation: {
            ...(saved === undefined ? {} : { state: saved.native }),
            save: async (native: PrivateOperatorApprovalObservation) => {
              await input.observation!.save(
                privateNativeTargetApprovalObservationSchema.parse({
                  version: 1,
                  native,
                  terminals: [...terminals.values()],
                }),
              );
            },
          },
        }),
    capture: (state?: PrivateOperatorApprovalCapture) => {
      const current = createPrivateOperatorApprovalCapture({
        request: {
          action: nativeTargetAuthOnlyDeliveryApprovalAction,
          planRef: operationRef,
          planDigest: deliveryPlanDigest,
          idempotencyKey: plan.appId,
        },
        ownerUserId: owner.authority.ownerUserId,
        ...(retained === undefined ? {} : { callId: retained.callId }),
        ...(state === undefined ? {} : { state }),
      });
      for (const terminal of saved?.terminals ?? []) {
        const entry = current
          .snapshot()
          .entries.find((candidate) => candidate.requestId === terminal.requestId);
        if (entry !== undefined && entry.callId === terminal.callId)
          terminals.set(terminal.requestId, terminalSchema.parse(terminal));
      }
      const proofFor = (entry: PrivateOperatorApprovalCapture["entries"][number]) => {
        const terminal = terminals.get(entry.requestId);
        if (
          terminal === undefined ||
          terminal.callId !== entry.callId ||
          terminal.responderPrincipalId !== owner.authority.ownerUserId ||
          terminal.outcome !== (entry.cancelled ? "cancelled" : "approved")
        )
          throw unavailable();
        const proof = nativeTargetAuthOnlyApprovalSchema.parse({
          ...terminal,
          planDigest: deliveryPlanDigest,
          sourceDigest: deliveryPlanDigest,
          publicSessionId: plan.origin.publicSessionId,
        });
        if (
          proof.outcome === "approved" &&
          retained !== undefined &&
          !isDeepStrictEqual(proof, retained)
        )
          throw unavailable();
        return proof;
      };
      return {
        observe(event: MessageStreamEvent) {
          if (event.type === "input.requested") {
            for (const request of event.data.requests) {
              if (
                request.kind !== "tool-approval" ||
                request.action.toolName !== nativeTargetAuthOnlyDeliveryApprovalTool
              )
                continue;
              if (
                nativeTargetAuthOnlyDeliveryPreparationInputSchema.safeParse(request.action.input)
                  .success &&
                isDeepStrictEqual(request.action.input, expected)
              )
                current.acceptRequest(request.requestId, request.action.callId);
            }
          } else if (event.type === "approval.settled") {
            const entry = current
              .snapshot()
              .entries.find((candidate) => candidate.requestId === event.data.requestId);
            if (entry === undefined) return;
            current.settle(event);
            const previous = terminals.get(entry.requestId);
            const outcome = event.data.outcome === "approved" ? "approved" : "cancelled";
            if (
              previous === undefined ||
              (previous.outcome === "approved" && outcome === "cancelled")
            ) {
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
          }
        },
        read(): NativeTargetAuthOnlyApproval | null {
          const entries = current.snapshot().entries;
          const cancelled = entries.filter((entry) => entry.cancelled);
          if (cancelled.length > 1) throw unavailable();
          if (cancelled[0] !== undefined) return proofFor(cancelled[0]);
          const receipt = current.read();
          if (receipt === null) {
            if (retained !== undefined) throw unavailable();
            return null;
          }
          const entry = entries.find((candidate) => candidate.requestId === receipt.approvalId);
          if (entry === undefined) throw unavailable();
          return proofFor(entry);
        },
        snapshot: current.snapshot,
        proveComplete: current.proveComplete,
      };
    },
    readHistory: input.readHistory,
    assertOwner,
  });
};
