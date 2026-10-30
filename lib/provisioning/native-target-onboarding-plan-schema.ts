import { z } from "zod";

import { hostedOperatorAppProjectSettingsSchema } from "./hosted-operator-app-project-settings";
import { builderAppIdSchema } from "./names";

export const nativeTargetIdSchema = z.string().min(1);
export const nativeTargetDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const nativeTargetInstantSchema = z.iso.datetime({ offset: true });
export const nativeTargetProjectNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/u);
const sqlName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u);
const unique = (values: readonly string[]) => new Set(values).size === values.length;

const id = nativeTargetIdSchema;
const digest = nativeTargetDigestSchema;
const instant = nativeTargetInstantSchema;
const projectName = nativeTargetProjectNameSchema;

/** Initial effect provenance, not an admission condition on later app revisions. */
export const nativeTargetOnboardingOriginSchema = z.strictObject({
  publicSessionId: id,
  adapterSessionId: id,
  adapterGeneration: z.number().int().positive(),
  appSpecDigest: digest,
  release: z.strictObject({
    id,
    artifactRef: id,
    manifestSha256: digest,
    schemaSha256: digest,
  }),
});

/** Nonsecret source references. Resource credentials stay in their existing custody. */
export const nativeTargetProjectProtectionSchema = z.strictObject({
  ssoProtection: z.strictObject({ deploymentType: z.literal("all") }),
  oidcTokenConfig: z.strictObject({ enabled: z.literal(true), issuerMode: z.literal("team") }),
});
export type NativeTargetProjectProtection = z.infer<typeof nativeTargetProjectProtectionSchema>;
export const nativeTargetRequiredProjectProtection = {
  ssoProtection: { deploymentType: "all" },
  oidcTokenConfig: { enabled: true, issuerMode: "team" },
} as const satisfies NativeTargetProjectProtection;

export const nativeTargetOnboardingPlanSchema = z
  .strictObject({
    version: z.literal(1),
    appId: builderAppIdSchema,
    /** Deployment-owned owner/app resource selection; never a credential or caller scope. */
    resourceProfileId: id.optional(),
    resourceProfileAuthorityDigest: digest.optional(),
    /** Prevent a retired approval from becoming current when a resource selection returns. */
    resourceSelectionRevision: z.number().int().positive().optional(),
    origin: nativeTargetOnboardingOriginSchema,
    project: z.strictObject({
      name: projectName,
      teamId: id,
      installationId: id,
      projectSettings: hostedOperatorAppProjectSettingsSchema,
      protection: nativeTargetProjectProtectionSchema,
    }),
    branch: id,
    appDatabase: z
      .strictObject({
        resourceId: id,
        database: sqlName,
        migratorRole: sqlName,
        runtimeRole: sqlName,
      })
      .refine((value) => value.migratorRole !== value.runtimeRole),
    productRoles: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/u)).refine(unique),
    nativeNeon: z.strictObject({
      // Existing enrollment provenance when available; target creation does not authorize Neon effects.
      approvalReference: id.optional(),
      nativeStore: z.strictObject({ configurationId: id, resourceId: id, sourceProjectId: id }),
      scope: z.strictObject({
        projectId: id,
        branchId: id,
        endpointId: id,
        hostname: id,
        maintenanceDatabase: sqlName,
        maintenanceRole: sqlName,
      }),
    }),
    worker: z.strictObject({
      id,
      executablePath: id,
      sha256: digest,
      operationScope: z.literal("generated-app-release-install-v1"),
      subcommand: z.literal("protected-generated-app-install"),
    }),
    cost: z.strictObject({ ownership: z.literal("current-owner"), description: id }),
    retention: z.strictObject({ policy: id, expiresAt: instant.optional() }),
    conflictPolicy: z.enum(["stop-on-conflict", "suffix-on-confirmed-conflict"]),
  })
  .superRefine((plan, context) => {
    if (
      (plan.resourceProfileId === undefined) !==
        (plan.resourceProfileAuthorityDigest === undefined) ||
      (plan.resourceSelectionRevision !== undefined && plan.resourceProfileId === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Resource selection must bind its approved authority.",
      });
    }
  });
export type NativeTargetOnboardingPlan = z.infer<typeof nativeTargetOnboardingPlanSchema>;
export type NativeTargetOnboardingOrigin = z.infer<typeof nativeTargetOnboardingOriginSchema>;
