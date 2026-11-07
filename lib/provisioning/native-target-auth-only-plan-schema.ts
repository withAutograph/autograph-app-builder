import { createHash } from "node:crypto";
import { z } from "zod";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { appDescriptionSchema } from "../repository/app-description";
import { builderAppIdSchema } from "./names";
import { hostedOperatorAppProjectSettingsSchema } from "./hosted-operator-app-project-settings";
import {
  nativeTargetDigestSchema,
  nativeTargetIdSchema,
  nativeTargetInstantSchema,
  nativeTargetProjectNameSchema,
  nativeTargetProjectProtectionSchema,
} from "./native-target-onboarding-plan-schema";
import { publishedAppSourceSchema } from "./hosted-operator-artifact-selection";
import type { PublishedAppSource } from "./hosted-operator-artifact-selection";

const id = nativeTargetIdSchema;
const digest = nativeTargetDigestSchema;

/**
 * First-stage contract for a static app that needs isolated Auth only.
 * This is intentionally separate from generated Postgres onboarding; it carries
 * no product database, Neon installer, or app-data capability.
 */
export const nativeTargetAuthOnlyPlanSchema = z
  .strictObject({
    appId: builderAppIdSchema,
    /** One existing app-scoped, non-privileged role is required for policy installation. */
    appRole: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/u)
      .refine((role) => !/(?:^|[_-])(?:owner|admin|administrator)(?:[_-]|$)/u.test(role)),
    /** Auth custody is deployment-owned and isolated from product app data. */
    authResource: z.strictObject({
      profileId: id,
      authorityDigest: digest,
      resourceId: id,
      database: id,
      endpointId: id,
      hostname: id,
    }),
    /** Trusted immutable Auth schema artifact and worker selection, captured before approval. */
    authSchema: z.strictObject({
      artifactRef: id,
      planDigest: digest,
      targetDigest: digest,
      installer: z.strictObject({ reference: id, sha256: digest }),
    }),
    branch: id,
    cost: z.strictObject({ ownership: z.literal("current-owner"), description: id }),
    kind: z.literal("native-target-auth-only"),
    origin: z.strictObject({
      authority: hostedTenantAuthoritySchema,
      publicSessionId: id,
      adapterSessionId: id,
      adapterGeneration: z.number().int().positive(),
      appSpecDigest: digest,
      capturedDescription: z.strictObject({
        appId: builderAppIdSchema,
        kind: z.literal("static"),
        sha256: digest,
      }),
    }),
    project: z.strictObject({
      name: nativeTargetProjectNameSchema,
      teamId: id,
      installationId: id,
      projectSettings: hostedOperatorAppProjectSettingsSchema,
      protection: nativeTargetProjectProtectionSchema,
    }),
    /** Exact independently observed reviewed publication, part of the approval digest. */
    publishedSource: publishedAppSourceSchema,
    retention: z.strictObject({ policy: id, expiresAt: nativeTargetInstantSchema.optional() }),
    signupPolicy: z.strictObject({
      eligibility: z.literal("approved-email-list"),
      requireVerifiedEmail: z.literal(true),
    }),
    version: z.literal(1),
  })
  .superRefine((plan, context) => {
    if (plan.authResource.profileId.length === 0 || plan.authResource.resourceId.length === 0) {
      context.addIssue({ code: "custom", message: "An isolated Auth resource must be selected." });
    }
    if (plan.origin.capturedDescription.appId !== plan.appId) {
      context.addIssue({ code: "custom", message: "Captured description belongs to another app." });
    }
  });

export type NativeTargetAuthOnlyPlan = z.infer<typeof nativeTargetAuthOnlyPlanSchema>;

/** Digest the canonical captured static AppDescription, not model-authored metadata. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This captured-description boundary immediately parses untrusted input with appDescriptionSchema before hashing it.
export const capturedStaticDescriptionProvenance = (description: unknown) => {
  const parsed = appDescriptionSchema.parse(description);
  if (parsed.backend.kind !== "static") {
    throw new Error("Auth-only onboarding requires a captured static AppDescription.");
  }
  return {
    appId: parsed.app.id,
    kind: "static" as const,
    sha256: createHash("sha256").update(JSON.stringify(parsed)).digest("hex"),
  };
};

export const nativeTargetAuthOnlyPlanDigest = (plan: NativeTargetAuthOnlyPlan) =>
  createHash("sha256")
    .update(JSON.stringify(nativeTargetAuthOnlyPlanSchema.parse(plan)))
    .digest("hex");

export const nativeTargetAuthOnlySchemaEffectDigest = (
  plan: NativeTargetAuthOnlyPlan,
  source: PublishedAppSource,
) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        appRole: plan.appRole,
        kind: "native-target-auth-schema-effect-v1",
        planDigest: nativeTargetAuthOnlyPlanDigest(plan),
        resourceId: plan.authResource.resourceId,
        signupPolicy: plan.signupPolicy,
        source: publishedAppSourceSchema.parse(source),
      }),
    )
    .digest("hex");
