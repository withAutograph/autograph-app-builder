import { z } from "zod";
import { operatorOwnerContextSchema } from "./hosted-operator-contract";
import {
  centralHostCallerPlanSchema,
  centralHostSetupPlanSchema,
  centralHostOperationRef,
  centralHostPlanDigest,
  centralHostReadyReceiptSchema,
} from "./central-integration-host-contract";
import {
  centralHostPlanRequestSchema,
  centralHostSelectionSchema,
} from "./central-integration-host-service";

export {
  centralHostOperationRef,
  centralHostPlanDigest,
} from "./central-integration-host-contract";
export const centralHostPlanSchema = z.union([
  centralHostSetupPlanSchema,
  centralHostCallerPlanSchema,
]);
export type CentralHostPlan = z.infer<typeof centralHostPlanSchema>;
export const centralHostApprovalInputSchema = z
  .strictObject({
    operationRef: z.uuid(),
    plan: centralHostPlanSchema,
    planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .superRefine((input, context) => {
    if (
      input.operationRef !== centralHostOperationRef(input.plan) ||
      input.planDigest !== centralHostPlanDigest(input.plan)
    ) {
      context.addIssue({
        code: "custom",
        message: "Central approval must match the complete frozen plan",
      });
    }
  });
export type CentralHostApprovalInput = z.infer<typeof centralHostApprovalInputSchema>;
const common = {
  adapterSessionId: z.string().min(1),
  callId: z.string().min(1),
  execution: z.strictObject({
    logicalSessionId: z.string().min(1),
    ownerAnchorRunId: z.string().min(1).optional(),
    ownerRunId: z.string().min(1).optional(),
  }),
  ownerContext: operatorOwnerContextSchema,
};
export const centralHostReadInputSchema = centralHostSelectionSchema.extend({
  appId: centralHostPlanRequestSchema.shape.appId,
});
export const centralHostTransportRequestSchema = z
  .discriminatedUnion("action", [
    z.strictObject({
      ...common,
      action: z.literal("central-integration-host-plan"),
      input: centralHostPlanRequestSchema,
    }),
    z.strictObject({
      ...common,
      action: z.literal("central-integration-host-prepare"),
      input: centralHostApprovalInputSchema,
    }),
    z.strictObject({
      ...common,
      action: z.literal("central-integration-host-read"),
      input: centralHostReadInputSchema,
    }),
  ])
  .superRefine((input, context) => {
    if (
      input.adapterSessionId !== input.ownerContext.adapterSessionId ||
      input.execution.logicalSessionId !== input.adapterSessionId ||
      (input.action === "central-integration-host-prepare" &&
        input.input.plan.selection.sessionId !== input.ownerContext.sessionId)
    ) {
      context.addIssue({ code: "custom", message: "Central callback owner differs" });
    }
  });
export const centralHostResultSchema = z.strictObject({
  status: z.enum(["pending", "waiting-native-deployment", "ready"]),
  ...centralHostSelectionSchema.shape,
  receipt: centralHostReadyReceiptSchema.optional(),
});

/** Read-only unchanged caller grant reuse is not a new approval input. */
export const centralHostReadyPlanResultSchema = z
  .strictObject({
    status: z.literal("ready"),
    ...centralHostSelectionSchema.shape,
    receipt: centralHostReadyReceiptSchema,
  })
  .superRefine((value, context) => {
    if (
      value.operationRef !== value.receipt.callerSetup.operationRef ||
      value.planDigest !== value.receipt.callerSetup.planDigest
    ) {
      context.addIssue({ code: "custom", message: "Canonical caller receipt pointer required" });
    }
  });
export const centralHostPlanResultSchema = z.union([
  centralHostApprovalInputSchema,
  centralHostReadyPlanResultSchema,
]);
