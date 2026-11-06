import { appIntegrationCapabilityPointerSchema } from "./app-integration-release-contract";
import { z } from "zod";
import { operatorOwnerContextSchema } from "./hosted-operator-contract";
import {
  publicReleaseApprovalInputSchema,
  publicReleasePlanSchema,
  publicReleaseEffectSchema,
} from "./public-release-contract";

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
    z.strictObject({
      ...common,
      action: z.literal("public-release-observe"),
      input: publicReleaseApprovalInputSchema,
    }),
  ])
  .superRefine((input, context) => {
    if (
      input.adapterSessionId !== input.ownerContext.adapterSessionId ||
      input.execution.logicalSessionId !== input.adapterSessionId ||
      (input.action !== "public-release-plan" &&
        input.input.plan.selection.sessionId !== input.ownerContext.sessionId)
    ) {
      context.addIssue({ code: "custom", message: "Public release callback owner differs" });
    }
  });
export { publicReleaseApprovalInputSchema as publicReleasePlanResultSchema } from "./public-release-contract";
export const publicReleaseResultSchema = z.union([
  z.strictObject({
    authenticatedBehavior: z.literal("unassessed"),
    observation: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("pending") }),
      z.strictObject({
        deploymentId: z.string().min(1),
        environment: z.literal("production"),
        projectId: z.string().min(1),
        publicOrigin: z.url(),
        releaseId: z.string().min(1),
        status: z.literal("ready"),
      }),
    ]),
    operationRef: z.uuid(),
    purpose: z.enum(["auth-bootstrap", "application"]).optional(),
    status: z.enum(["pending", "ready"]),
  }),
  z.strictObject({
    effect: publicReleaseEffectSchema,
    operationRef: z.uuid(),
    status: z.literal("reconciliation-required"),
  }),
]);
