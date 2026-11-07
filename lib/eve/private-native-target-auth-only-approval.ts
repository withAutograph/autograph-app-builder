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
import type { PrivateHistoryObservation } from "./same-origin-http";
import type { OperatorOwnerContext } from "../provisioning/hosted-operator-contract";
import {
  nativeTargetAuthOnlyPlanDigest,
  nativeTargetAuthOnlyPlanSchema,
  nativeTargetAuthOnlySchemaEffectDigest,
} from "../provisioning/native-target-auth-only-plan-schema";
import type { NativeTargetAuthOnlyPlan } from "../provisioning/native-target-auth-only-plan-schema";
import { nativeTargetAuthOnlyApprovalSchema } from "../provisioning/native-target-auth-only-dispatch";
import type { NativeTargetAuthOnlyApproval } from "../provisioning/native-target-auth-only-dispatch";
import type { NativeTargetCurrentOwner } from "../provisioning/native-target-onboarding-store";
import { privateNativeTargetApprovalObservationSchema } from "./private-native-target-approval";
import type { PrivateNativeTargetApprovalObservation } from "./private-native-target-approval";

const terminalSchema = z.strictObject({
  requestId: z.string().min(1),
  callId: z.string().min(1),
  responderPrincipalId: z.string().min(1),
  outcome: z.enum(["approved", "cancelled"]),
  observedAt: z.iso.datetime({ offset: true }),
});
const inputSchema = z.strictObject({
  appId: nativeTargetAuthOnlyPlanSchema.shape.appId,
  operationRef: z.string().min(1),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  plan: nativeTargetAuthOnlyPlanSchema,
});

/** Captures only a complete authenticated settlement of this exact Auth-only tool request. */
export const readPrivateNativeTargetAuthOnlyApproval = async (input: {
  owner: NativeTargetCurrentOwner;
  plan: NativeTargetAuthOnlyPlan;
  callId?: string;
  historyOwner: OperatorOwnerContext;
  observation?: {
    state?: PrivateNativeTargetApprovalObservation;
    save: (state: PrivateNativeTargetApprovalObservation) => Promise<void>;
  };
  readHistory: (
    startIndex: number,
    onEvent: (event: MessageStreamEvent) => void,
  ) => Promise<PrivateHistoryObservation>;
  assertOwner: () => Promise<void>;
}): Promise<NativeTargetAuthOnlyApproval | null> => {
  const plan = nativeTargetAuthOnlyPlanSchema.parse(input.plan);
  if (
    !isDeepStrictEqual(input.historyOwner.authority, input.owner.authority) ||
    input.historyOwner.sessionId !== input.owner.publicSessionId ||
    input.historyOwner.adapterSessionId !== input.owner.adapterSessionId ||
    input.historyOwner.adapterGeneration !== input.owner.adapterGeneration
  )
    throw new Error("Auth-only approval owner changed.");
  const planDigest = nativeTargetAuthOnlyPlanDigest(plan);
  const sourceDigest = nativeTargetAuthOnlySchemaEffectDigest(plan, plan.publishedSource);
  const expected = inputSchema.parse({
    appId: plan.appId,
    operationRef: planDigest,
    planDigest,
    plan,
  });
  const terminals = new Map<string, z.infer<typeof terminalSchema>>();
  const saved =
    input.observation?.state === undefined
      ? undefined
      : privateNativeTargetApprovalObservationSchema.parse(input.observation.state);
  for (const terminal of saved?.terminals ?? [])
    terminals.set(terminal.requestId, terminalSchema.parse(terminal));
  let capture: ReturnType<typeof createPrivateOperatorApprovalCapture> | undefined;
  const result = await readPrivateOperatorApproval({
    owner: input.historyOwner,
    ...(input.observation === undefined
      ? {}
      : {
          observation: {
            ...(saved === undefined ? {} : { state: saved.native }),
            save: async (native: PrivateOperatorApprovalObservation) => {
              if (capture === undefined) throw new Error("Auth-only capture is unavailable.");
              await input.observation?.save(
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
      capture = createPrivateOperatorApprovalCapture({
        request: {
          action: "native-target-auth-only",
          planRef: planDigest,
          planDigest,
          idempotencyKey: plan.appId,
        },
        ownerUserId: input.owner.authority.ownerUserId,
        ...(input.callId === undefined ? {} : { callId: input.callId }),
        ...(state === undefined ? {} : { state }),
      });
      return {
        observe(event: MessageStreamEvent) {
          if (event.type === "input.requested") {
            for (const requested of event.data.requests) {
              if (
                requested.kind === "tool-approval" &&
                requested.action.toolName === "prepare-app-native-target-auth-only"
              ) {
                const parsed = inputSchema.safeParse(requested.action.input);
                if (parsed.success && isDeepStrictEqual(parsed.data, expected))
                  capture?.acceptRequest(requested.requestId, requested.action.callId);
              }
            }
          } else if (event.type === "approval.settled") {
            const entry = capture
              ?.snapshot()
              .entries.find((candidate) => candidate.requestId === event.data.requestId);
            if (entry !== undefined) {
              capture?.settle(event);
              terminals.set(
                entry.requestId,
                terminalSchema.parse({
                  requestId: entry.requestId,
                  callId: entry.callId,
                  responderPrincipalId: event.data.responderPrincipalId,
                  outcome: event.data.outcome === "approved" ? "approved" : "cancelled",
                  observedAt: event.meta.at,
                }),
              );
            }
          }
        },
        read(): NativeTargetAuthOnlyApproval | null {
          const entries = capture?.snapshot().entries ?? [];
          // A settled cancellation denies this exact plan even when a later call is approved.
          if (entries.some((entry) => entry.cancelled)) return null;
          const receipt = capture?.read();
          if (receipt == null) return null;
          const entry = capture
            ?.snapshot()
            .entries.find((candidate) => candidate.requestId === receipt.approvalId);
          const terminal = terminals.get(receipt.approvalId);
          if (
            entry === undefined ||
            terminal === undefined ||
            entry.callId !== terminal.callId ||
            terminal.responderPrincipalId !== input.owner.authority.ownerUserId ||
            terminal.outcome !== "approved"
          )
            throw new Error("Auth-only approval settlement is unavailable.");
          return nativeTargetAuthOnlyApprovalSchema.parse({
            ...terminal,
            planDigest,
            sourceDigest,
            publicSessionId: plan.origin.publicSessionId,
          });
        },
        snapshot: () => capture!.snapshot(),
        proveComplete: () => capture?.proveComplete(),
      };
    },
    readHistory: input.readHistory,
    assertOwner: input.assertOwner,
  });
  return result;
};
