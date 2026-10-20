import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { MessageStreamEvent } from "eve/client";
import type { HostedPrincipal } from "./hosted-auth";
import {
  hostedContinuityPlanSchema,
  hostedContinuityRequestSchema,
  parseContinuityRequestForPlan,
} from "../provisioning/hosted-operator-continuity-contract";
import type {
  HostedContinuityPlan,
  HostedContinuityRequest,
  ContinuityApproval,
} from "../provisioning/hosted-operator-continuity-contract";

/** Human-visible echo only; resource authority is the operator's own frozen journal. */
export const continuityApprovalInputSchema = z
  .strictObject({
    ...hostedContinuityRequestSchema.shape,
    plan: hostedContinuityPlanSchema,
  })
  .superRefine((value, ctx) => {
    try {
      parseContinuityRequestForPlan(
        {
          action: value.action,
          planRef: value.planRef,
          planDigest: value.planDigest,
          idempotencyKey: value.idempotencyKey,
        },
        value.plan,
      );
    } catch {
      ctx.addIssue({ code: "custom", message: "Continuity approval intent differs." });
    }
  });
export type ContinuityApprovalInput = z.infer<typeof continuityApprovalInputSchema>;

/** Reads only the authored exact human approval pair from the owner-authenticated Eve stream. */
export const createPrivateContinuityApprovalCapture = (input: {
  plan: HostedContinuityPlan;
  request: HostedContinuityRequest;
  principal: HostedPrincipal;
  callId?: string;
}) => {
  const pending = new Map<string, { callId: string }>();
  let receipt: ContinuityApproval | null = null;
  let cancelled = false;
  return {
    observe(event: MessageStreamEvent) {
      if (event.type === "input.requested") {
        for (const requested of event.data.requests) {
          if (
            requested.kind !== "tool-approval" ||
            requested.action.toolName !== "run-app-continuity-tests"
          ) {
            continue;
          }
          const parsed = continuityApprovalInputSchema.safeParse(requested.action.input);
          if (
            !parsed.success ||
            (input.callId !== undefined && requested.action.callId !== input.callId)
          ) {
            continue;
          }
          const { plan, ...request } = parsed.data;
          if (!isDeepStrictEqual(plan, input.plan) || !isDeepStrictEqual(request, input.request)) {
            continue;
          }
          pending.set(requested.requestId, { callId: requested.action.callId });
        }
        return;
      }
      if (event.type !== "approval.settled") {
        return;
      }
      const requested = pending.get(event.data.requestId);
      if (requested === undefined) {
        return;
      }
      if (
        event.data.outcome !== "approved" ||
        event.data.responderPrincipalId !== input.principal.ownerUserId
      ) {
        cancelled = true;
        return;
      }
      const next = {
        ...input.request,
        approvalId: event.data.requestId,
        approvedByCallId: requested.callId,
      };
      if (receipt !== null && !isDeepStrictEqual(receipt, next)) {
        throw new Error("Continuity approval is ambiguous.");
      }
      receipt = next;
    },
    read: () => (cancelled ? null : receipt),
  };
};
