import { z } from "zod";

import {
  nativeTargetOnboardingPlanSchema,
  nativeTargetPreparationRequestSchema,
} from "../provisioning/native-target-onboarding-plan-schema";
import { nativeTargetProviderAuthorizationSchema } from "../provisioning/native-target-vercel-authorization";
import {
  nativeTargetAuthOnlyPlanDigest,
  nativeTargetAuthOnlyPlanSchema,
} from "../provisioning/native-target-auth-only-plan-schema";
import { nativeTargetAuthOnlyResourcePreparationInputSchema } from "../eve/private-native-target-auth-only-resource-approval";

export { nativeTargetPreparationRequestSchema } from "../provisioning/native-target-onboarding-plan-schema";

export const nativeTargetAuthOnlyPlanRequestSchema = z.strictObject({
  appId: nativeTargetAuthOnlyPlanSchema.shape.appId,
  authProfileId: z.string().min(1),
  project: z.strictObject({
    name: nativeTargetAuthOnlyPlanSchema.shape.project.shape.name,
    teamId: z.string().min(1),
    installationId: z.string().min(1),
  }),
  branch: nativeTargetAuthOnlyPlanSchema.shape.branch,
  appRole: nativeTargetAuthOnlyPlanSchema.shape.appRole,
});
export type NativeTargetAuthOnlyPlanRequest = z.infer<typeof nativeTargetAuthOnlyPlanRequestSchema>;
export const nativeTargetAuthOnlyPlanResultSchema = z.strictObject({
  status: z.literal("planned"),
  plan: nativeTargetAuthOnlyPlanSchema,
  planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type NativeTargetAuthOnlyPlanResult = z.infer<typeof nativeTargetAuthOnlyPlanResultSchema>;
export const nativeTargetAuthOnlyPreparationRequestSchema = z
  .strictObject({
    appId: nativeTargetAuthOnlyPlanSchema.shape.appId,
    operationRef: z.string().min(1),
    planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    plan: nativeTargetAuthOnlyPlanSchema,
  })
  .superRefine((input, context) => {
    if (
      input.appId !== input.plan.appId ||
      input.operationRef !== input.planDigest ||
      nativeTargetAuthOnlyPlanDigest(input.plan) !== input.planDigest
    )
      {context.addIssue({
        code: "custom",
        message: "Auth-only preparation must echo its exact plan digest.",
      });}
  });
export type NativeTargetAuthOnlyPreparationRequest = z.infer<
  typeof nativeTargetAuthOnlyPreparationRequestSchema
>;
export const nativeTargetAuthOnlyDispatchResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("created"), projectId: z.string().min(1) }),
  z.strictObject({
    status: z.literal("resource-approval-required"),
    projectId: z.string().min(1),
    resourceApprovalInput: nativeTargetAuthOnlyResourcePreparationInputSchema,
  }),
  z.strictObject({ status: z.literal("unknown"), projectId: z.string().min(1).optional() }),
  z.strictObject({
    status: z.literal("rejected"),
    reason: z.enum([
      "authorization_denied",
      "collision",
      "permission_denied",
      "provider_rejected",
      "rate_limited",
    ]),
  }),
]);
export type NativeTargetAuthOnlyDispatchResult = z.infer<
  typeof nativeTargetAuthOnlyDispatchResultSchema
>;

const appId = nativeTargetOnboardingPlanSchema.shape.appId;
export const nativeTargetPlanRequestSchema = z.strictObject({
  appId,
  resourceProfileId: nativeTargetOnboardingPlanSchema.shape.resourceProfileId,
  project: nativeTargetOnboardingPlanSchema.shape.project.omit({ protection: true }),
  branch: nativeTargetOnboardingPlanSchema.shape.branch,
  conflictPolicy: nativeTargetOnboardingPlanSchema.shape.conflictPolicy,
});
export type NativeTargetPlanRequest = z.infer<typeof nativeTargetPlanRequestSchema>;
export type NativeTargetPreparationRequest = z.infer<typeof nativeTargetPreparationRequestSchema>;
export const nativeTargetOnboardingResultSchema = nativeTargetPreparationRequestSchema
  .extend({
    status: z.enum(["planned", "pending", "ready", "cancelled", "approval-pending", "blocked"]),
    projectId: z.string().min(1).optional(),
    // Advisory same-credential GET evidence, never a project-creation grant.
    providerAuthorization: nativeTargetProviderAuthorizationSchema.optional(),
    reason: z
      .enum([
        "authorization_denied",
        "collision",
        "permission_denied",
        "provider_rejected",
        "rate_limited",
      ])
      .optional(),
  })
  .superRefine((result, context) => {
    if (result.status === "ready" && result.projectId === undefined) {
      context.addIssue({
        code: "custom",
        message: "Ready native target requires its verified project ID.",
      });
    }
  });
export type NativeTargetOnboardingResult = z.infer<typeof nativeTargetOnboardingResultSchema>;
