import { appIntegrationCapabilityPointerSchema } from "./app-integration-release-contract";
import { z } from "zod";
import { operatorOwnerContextSchema } from "./hosted-operator-contract";
import {
  publicReleaseApprovalInputSchema,
  publicReleasePlanSchema,
  publicReleaseEffectSchema,
} from "./public-release-contract";
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
export const publicReleaseTransportRequestSchema = z
  .discriminatedUnion("action", [
    z.strictObject({
      ...common,
      action: z.literal("public-release-plan"),
      appId: publicReleasePlanSchema.shape.selection.shape.appId,
      integrationCapability: appIntegrationCapabilityPointerSchema.optional(),
    }),
    z.strictObject({
      ...common,
      action: z.literal("public-release-run"),
      input: publicReleaseApprovalInputSchema,
    }),
  ])
  .superRefine((input, context) => {
    if (
      input.adapterSessionId !== input.ownerContext.adapterSessionId ||
      input.execution.logicalSessionId !== input.adapterSessionId ||
      (input.action === "public-release-run" &&
        input.input.plan.selection.sessionId !== input.ownerContext.sessionId)
    ) {
      context.addIssue({ code: "custom", message: "Public release callback owner differs" });
    }
  });
export { publicReleaseApprovalInputSchema as publicReleasePlanResultSchema } from "./public-release-contract";
export const publicReleaseResultSchema = z.union([
  z.strictObject({
    status: z.enum(["pending", "ready"]),
    purpose: z.enum(["auth-bootstrap", "application"]).optional(),
    operationRef: z.uuid(),
    observation: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("pending") }),
      z.strictObject({
        status: z.literal("ready"),
        deploymentId: z.string().min(1),
        projectId: z.string().min(1),
        environment: z.literal("production"),
        publicOrigin: z.url(),
        releaseId: z.string().min(1),
      }),
    ]),
    authenticatedBehavior: z.literal("unassessed"),
  }),
  z.strictObject({
    status: z.literal("reconciliation-required"),
    operationRef: z.uuid(),
    effect: publicReleaseEffectSchema,
  }),
]);
