import { operatorWorkerSourceCaptureSchema } from "./operator-worker-source-capture";
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
  adapterGeneration: z.number().int().positive(),
  adapterSessionId: id,
  appSpecDigest: digest,
  publicSessionId: id,
  release: z.strictObject({
    artifactRef: id,
    id,
    manifestSha256: digest,
    schemaSha256: digest,
  }),
});

/** Nonsecret source references. Resource credentials stay in their existing custody. */
export const nativeTargetProjectProtectionSchema = z.strictObject({
  oidcTokenConfig: z.strictObject({ enabled: z.literal(true), issuerMode: z.literal("team") }),
  ssoProtection: z.strictObject({ deploymentType: z.literal("all") }),
});
export type NativeTargetProjectProtection = z.infer<typeof nativeTargetProjectProtectionSchema>;
export const nativeTargetRequiredProjectProtection = {
  oidcTokenConfig: { enabled: true, issuerMode: "team" },
  ssoProtection: { deploymentType: "all" },
} as const satisfies NativeTargetProjectProtection;

export const nativeTargetOnboardingPlanSchema = z
  .strictObject({
    appDatabase: z
      .strictObject({
        database: sqlName,
        migratorRole: sqlName,
        resourceId: id,
        runtimeRole: sqlName,
      })
      .refine((value) => value.migratorRole !== value.runtimeRole),
    appId: builderAppIdSchema,
    branch: id,
    conflictPolicy: z.enum(["stop-on-conflict", "suffix-on-confirmed-conflict"]),
    cost: z.strictObject({ description: id, ownership: z.literal("current-owner") }),
    nativeNeon: z.strictObject({
      // Existing enrollment provenance when available; target creation does not authorize Neon effects.
      approvalReference: id.optional(),
      nativeStore: z.strictObject({ configurationId: id, resourceId: id, sourceProjectId: id }),
      scope: z.strictObject({
        branchId: id,
        endpointId: id,
        hostname: id,
        maintenanceDatabase: sqlName,
        maintenanceRole: sqlName,
        projectId: id,
      }),
    }),
    origin: nativeTargetOnboardingOriginSchema,
    productRoles: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/u)).refine(unique),
    project: z.strictObject({
      installationId: id,
      name: projectName,
      projectSettings: hostedOperatorAppProjectSettingsSchema,
      protection: nativeTargetProjectProtectionSchema,
      teamId: id,
    }),
    resourceProfileAuthorityDigest: digest.optional(),
    /** Deployment-owned owner/app resource selection; never a credential or caller scope. */
    resourceProfileId: id.optional(),
    /** Prevent a retired approval from becoming current when a resource selection returns. */
    resourceSelectionRevision: z.number().int().positive().optional(),
    retention: z.strictObject({ expiresAt: instant.optional(), policy: id }),
    version: z.literal(1),
    worker: z.strictObject({
      executablePath: id,
      id,
      operationScope: z.literal("generated-app-release-install-v1"),
      sha256: digest,
      sourceCapture: operatorWorkerSourceCaptureSchema.optional(),
      subcommand: z.literal("protected-generated-app-install"),
    }),
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
