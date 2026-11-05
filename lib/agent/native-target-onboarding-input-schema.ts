import { z } from "zod";

import { nativeTargetOnboardingPlanSchema } from "../provisioning/native-target-onboarding-plan-schema";
import { nativeTargetProviderAuthorizationSchema } from "../provisioning/native-target-vercel-authorization";

const appId = nativeTargetOnboardingPlanSchema.shape.appId;
export const nativeTargetPlanRequestSchema = z.strictObject({
  appId,
  resourceProfileId: nativeTargetOnboardingPlanSchema.shape.resourceProfileId,
  project: nativeTargetOnboardingPlanSchema.shape.project.omit({ protection: true }),
  branch: nativeTargetOnboardingPlanSchema.shape.branch,
  conflictPolicy: nativeTargetOnboardingPlanSchema.shape.conflictPolicy,
});
export type NativeTargetPlanRequest = z.infer<typeof nativeTargetPlanRequestSchema>;
export const nativeTargetPreparationRequestSchema = z.strictObject({
  appId,
  operationRef: z.uuid(),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  plan: nativeTargetOnboardingPlanSchema,
});
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
