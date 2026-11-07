import { createPrivateOperatorApprovalCapture } from "./private-operator-approval-observation";
import type { PrivateOperatorApprovalCapture } from "./private-operator-approval-observation";
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
          idempotencyKey: value.idempotencyKey,
          planDigest: value.planDigest,
          planRef: value.planRef,
        },
        value.plan,
      );
    } catch {
      ctx.addIssue({ code: "custom", message: "Continuity approval intent differs." });
    }
  });
export type ContinuityApprovalInput = z.infer<typeof continuityApprovalInputSchema>;

/** Compact model input is a locator; canonical owner-scoped readback remains authority. */
export const continuityApprovalToolInputSchema = z.union([
  hostedContinuityRequestSchema,
  continuityApprovalInputSchema,
]);
export type ContinuityApprovalToolInput = z.infer<typeof continuityApprovalToolInputSchema>;
export const continuityApprovalIntentId = (input: ContinuityApprovalToolInput): string => {
  const parsed = continuityApprovalToolInputSchema.parse(input);
  const intentId = z.uuid().parse(parsed.planRef.split("/").at(-1));
  if (parsed.planRef !== `_protected-operator/continuity-plans/${intentId}`) {
    throw new Error("Continuity intent reference differs.");
  }
  return intentId;
};

/** A fresh exact consent may be requested after owner-authorized intent readback. */
export const verifySavedContinuityIntent = (
  input: ContinuityApprovalToolInput,
  saved: { plan: HostedContinuityPlan; request: HostedContinuityRequest },
) => {
  const savedInput = continuityApprovalInputSchema.safeParse({
    ...saved.request,
    plan: saved.plan,
  });
  if (!savedInput.success) {
    throw new Error("Continuity intent differs.");
  }
  const canonical = savedInput.data;
  const parsed = continuityApprovalToolInputSchema.parse(input);
  const { plan, ...request } = "plan" in parsed ? parsed : { ...parsed, plan: canonical.plan };
  if (!isDeepStrictEqual(canonical.plan, plan) || !isDeepStrictEqual(saved.request, request)) {
    throw new Error("Continuity intent differs.");
  }
  return request;
};

/** Reads only the authored exact human approval pair from the owner-authenticated Eve stream. */
export const createPrivateContinuityApprovalCapture = (input: {
  plan: HostedContinuityPlan;
  request: HostedContinuityRequest;
  principal: HostedPrincipal;
  callId?: string;
  state?: PrivateOperatorApprovalCapture;
}) => {
  parseContinuityRequestForPlan(input.request, input.plan);
  const { issuer, audience, workspaceId, ownerUserId } = input.principal;
  if (!isDeepStrictEqual(input.plan.authority, { audience, issuer, ownerUserId, workspaceId })) {
    throw new Error("Private approval owner differs from its frozen plan.");
  }
  const captureOptions: Parameters<typeof createPrivateOperatorApprovalCapture>[0] = {
    ownerUserId: input.principal.ownerUserId,
    request: input.request,
  };
  if (input.callId !== undefined) {
    captureOptions.callId = input.callId;
  }
  if (input.state !== undefined) {
    captureOptions.state = input.state;
  }
  const capture = createPrivateOperatorApprovalCapture(captureOptions);
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
          const parsed = continuityApprovalToolInputSchema.safeParse(requested.action.input);
          if (parsed.success) {
            let verified = false;
            try {
              verifySavedContinuityIntent(parsed.data, { plan: input.plan, request: input.request });
              verified = true;
            } catch {
              // A request for another intent is not captured.
            }
            if (verified) {
              capture.acceptRequest(requested.requestId, requested.action.callId);
            }
          }
        }
        return;
      }
      if (event.type !== "approval.settled") {
        return;
      }
      capture.settle(event);
    },
    proveComplete: capture.proveComplete,
    read: (): ContinuityApproval | null => {
      const receipt = capture.read();
      return receipt === null ? null : { ...input.request, ...receipt };
    },
    snapshot: capture.snapshot,
  };
};
