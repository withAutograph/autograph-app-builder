import { createPrivateOperatorApprovalCapture } from "./private-operator-approval-observation";
import type { PrivateOperatorApprovalCapture } from "./private-operator-approval-observation";
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
  state?: PrivateOperatorApprovalCapture;
}) => {
  parseHostedTenantExportRequestForPlan(input.request, input.plan);
  const { issuer, audience, workspaceId, ownerUserId } = input.principal;
  if (!isDeepStrictEqual(input.plan.authority, { issuer, audience, workspaceId, ownerUserId })) {
    throw new Error("Private approval owner differs from its frozen plan.");
  }
  const capture = createPrivateOperatorApprovalCapture({
    request: input.request,
    ownerUserId: input.principal.ownerUserId,
    ...(input.callId === undefined ? {} : { callId: input.callId }),
    ...(input.state === undefined ? {} : { state: input.state }),
  });
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
          if (!parsed.success) {
            continue;
          }
          const { plan, ...request } = parsed.data;
          if (!isDeepStrictEqual(plan, input.plan) || !isDeepStrictEqual(request, input.request)) {
            continue;
          }
          capture.acceptRequest(requested.requestId, requested.action.callId);
        }
        return;
      }
      if (event.type !== "approval.settled") {
        return;
      }
      capture.settle(event);
    },
    read: (): ExportApproval | null => {
      const receipt = capture.read();
      return receipt === null ? null : { ...input.request, ...receipt };
    },
    snapshot: capture.snapshot,
    proveComplete: capture.proveComplete,
  };
};
