import { integrationProviderDiagnosticSchema } from "./app-integration-provider-diagnostic";
import { z } from "zod";
import { operatorOwnerContextSchema } from "./hosted-operator-contract";
import {
  appIntegrationCapabilityApprovalInputSchema,
  appIntegrationCapabilityPlanSchema,
  preparedAppIntegrationCapabilitySchema,
  integrationCapabilityEffectSchema,
} from "./app-integration-capability-contract";

const common = {
  ownerContext: operatorOwnerContextSchema,
  adapterSessionId: z.string().min(1),
  callId: z.string().min(1),
  execution: z.strictObject({
    logicalSessionId: z.string().min(1),
    ownerRunId: z.string().min(1).optional(),
    ownerAnchorRunId: z.string().min(1).optional(),
  }),
};
export const appIntegrationCapabilityTransportRequestSchema = z
  .discriminatedUnion("action", [
    z.strictObject({
      ...common,
      action: z.literal("app-integration-capability-plan"),
      appId: appIntegrationCapabilityPlanSchema.shape.selection.shape.appId,
    }),
    z.strictObject({
      ...common,
      action: z.literal("app-integration-capability-prepare"),
      input: appIntegrationCapabilityApprovalInputSchema,
    }),
  ])
  .superRefine((input, context) => {
    if (
      input.adapterSessionId !== input.ownerContext.adapterSessionId ||
      input.execution.logicalSessionId !== input.adapterSessionId ||
      (input.action === "app-integration-capability-prepare" &&
        input.input.plan.selection.sessionId !== input.ownerContext.sessionId)
    ) {
      context.addIssue({ code: "custom", message: "Public release callback owner differs" });
    }
  });
export { appIntegrationCapabilityApprovalInputSchema as appIntegrationCapabilityPlanResultSchema } from "./app-integration-capability-contract";
export const appIntegrationCapabilityResultSchema = z.union([
  z.strictObject({
    status: z.literal("prepared"),
    operationRef: z.uuid(),
    capability: preparedAppIntegrationCapabilitySchema,
    providerActivation: z.literal("unassessed"),
    hostedAcceptance: z.literal("unassessed"),
  }),
  z.strictObject({
    status: z.literal("reconciliation-required"),
    operationRef: z.uuid(),
    effect: integrationCapabilityEffectSchema,
    diagnostic: integrationProviderDiagnosticSchema.optional(),
  }),
]);
