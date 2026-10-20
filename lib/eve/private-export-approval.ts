import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { MessageStreamEvent } from "eve/client";
import type { HostedPrincipal } from "./hosted-auth";
import {
  hostedTenantExportPlanSchema,
  hostedTenantExportRequestSchema,
  parseHostedTenantExportRequestForPlan,
} from "../provisioning/hosted-operator-export-contract";
import type {
  HostedTenantExportPlan,
  HostedTenantExportRequest,
} from "../provisioning/hosted-operator-export-contract";
import type { ExportApproval } from "../provisioning/hosted-operator-export";

/** Human-visible echo only; resource authority is the operator's own frozen journal. */
export const tenantExportApprovalInputSchema = z
  .strictObject({
    ...hostedTenantExportRequestSchema.shape,
    plan: hostedTenantExportPlanSchema,
  })
  .superRefine((value, ctx) => {
    try {
      parseHostedTenantExportRequestForPlan(
        {
          action: value.action,
          planRef: value.planRef,
          planDigest: value.planDigest,
          idempotencyKey: value.idempotencyKey,
        },
        value.plan,
      );
    } catch {
      ctx.addIssue({ code: "custom", message: "Export approval intent differs." });
    }
  });
export type TenantExportApprovalInput = z.infer<typeof tenantExportApprovalInputSchema>;

/** Reads only the authored exact human approval pair from the owner-authenticated Eve stream. */
export const createPrivateTenantExportApprovalCapture = (input: {
  plan: HostedTenantExportPlan;
  request: HostedTenantExportRequest;
  principal: HostedPrincipal;
  callId?: string;
}) => {
  const pending = new Map<string, { callId: string }>();
  let receipt: ExportApproval | null = null;
  let cancelled = false;
  return {
    observe(event: MessageStreamEvent) {
      if (event.type === "input.requested") {
        for (const requested of event.data.requests) {
          if (
            requested.kind !== "tool-approval" ||
            requested.action.toolName !== "export-app-hosted-data"
          ) {
            continue;
          }
          const parsed = tenantExportApprovalInputSchema.safeParse(requested.action.input);
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
        throw new Error("Export approval is ambiguous.");
      }
      receipt = next;
    },
    read: () => (cancelled ? null : receipt),
  };
};
