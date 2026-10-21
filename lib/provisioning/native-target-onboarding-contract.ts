/* oxlint-disable eslint/complexity, sonarjs/expression-complexity -- The closed record validator checks independent approval, attempt and provider bindings together. */
import { createHash } from "node:crypto";
import { z } from "zod";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { hostedOperatorAppProjectSettingsSchema } from "./hosted-operator-app-project-settings";
import { builderAppIdSchema } from "./names";

const id = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const instant = z.iso.datetime({ offset: true });
const sqlName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u);
const projectName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/u);
const unique = (values: readonly string[]) => new Set(values).size === values.length;

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

export const nativeTargetOnboardingPlanSchema = z.strictObject({
  version: z.literal(1),
  appId: builderAppIdSchema,
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
});
export type NativeTargetOnboardingPlan = z.infer<typeof nativeTargetOnboardingPlanSchema>;
export type NativeTargetOnboardingOrigin = z.infer<typeof nativeTargetOnboardingOriginSchema>;
export type NativeTargetAuthority = z.infer<typeof hostedTenantAuthoritySchema>;

/** Bind semantic plan data, independent of caller property insertion order. */
export const nativeTargetOnboardingPlanDigest = (plan: NativeTargetOnboardingPlan) =>
  createHash("sha256")
    .update(JSON.stringify(nativeTargetOnboardingPlanSchema.parse(plan)))
    .digest("hex");

/** Stable owner/app slot: source edits and new sessions do not allocate new targets. */
export const nativeTargetOnboardingRegistryId = (
  authority: NativeTargetAuthority,
  appId: string,
) => {
  const owner = hostedTenantAuthoritySchema.parse(authority);
  const hex = createHash("sha256")
    .update(
      JSON.stringify([
        "native-target-onboarding-v1",
        owner.issuer,
        owner.audience,
        owner.workspaceId,
        owner.ownerUserId,
        builderAppIdSchema.parse(appId),
      ]),
    )
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export const nativeTargetOnboardingApprovalSchema = z.strictObject({
  requestId: id,
  callId: id,
  planDigest: digest,
  responderPrincipalId: id,
  publicSessionId: id,
  outcome: z.enum(["approved", "cancelled"]),
  observedAt: instant,
});
export type NativeTargetOnboardingApproval = z.infer<typeof nativeTargetOnboardingApprovalSchema>;

export const nativeTargetOnboardingAttemptSchema = z.strictObject({
  attemptId: z.uuid(),
  candidateName: projectName,
  leaseId: z.uuid(),
  leaseExpiresAt: instant,
  startedAt: instant,
});
export type NativeTargetOnboardingAttempt = z.infer<typeof nativeTargetOnboardingAttemptSchema>;

export const nativeTargetNoCreationReasonSchema = z.enum([
  "name_conflict",
  "provider_permission_denied",
  "provider_validation_failed",
  "provider_rate_limited",
  "not_dispatched",
]);
export type NativeTargetNoCreationReason = z.infer<typeof nativeTargetNoCreationReasonSchema>;
export const nativeTargetCompletedAttemptSchema = nativeTargetOnboardingAttemptSchema.extend({
  reason: nativeTargetNoCreationReasonSchema,
});

export const nativeTargetProjectReadbackSchema = z.strictObject({
  projectId: id,
  name: projectName,
  teamId: id,
  installationId: id,
  projectSettings: hostedOperatorAppProjectSettingsSchema,
  protection: nativeTargetProjectProtectionSchema,
});
export const nativeTargetAcceptedCreationSchema = z.strictObject({
  attemptId: z.uuid(),
  projectId: id,
  acceptedAt: instant,
});
export type NativeTargetAcceptedCreation = z.infer<typeof nativeTargetAcceptedCreationSchema>;
export const nativeTargetOnboardingCreationProofSchema = z.strictObject({
  attemptId: z.uuid(),
  observed: nativeTargetProjectReadbackSchema,
  observedAt: instant,
});
export type NativeTargetOnboardingCreationProof = z.infer<
  typeof nativeTargetOnboardingCreationProofSchema
>;

export const nativeTargetCandidateAllowed = (plan: NativeTargetOnboardingPlan, candidate: string) =>
  candidate === plan.project.name ||
  (plan.conflictPolicy === "suffix-on-confirmed-conflict" &&
    new RegExp(`^${plan.project.name.slice(0, 93).replace(/-+$/u, "")}-[a-z0-9]{6}$`, "u").test(
      candidate,
    ));

export const nativeTargetCancellationProvenanceSchema = z.strictObject({
  plan: nativeTargetOnboardingPlanSchema,
  planDigest: digest,
  approval: nativeTargetOnboardingApprovalSchema,
  previousAttempts: z.array(nativeTargetCompletedAttemptSchema),
});
export type NativeTargetCancellationProvenance = z.infer<
  typeof nativeTargetCancellationProvenanceSchema
>;

const common = {
  kind: z.literal("native-target-onboarding"),
  version: z.literal(1),
  appId: builderAppIdSchema,
  plan: nativeTargetOnboardingPlanSchema,
  planDigest: digest,
  previousAttempts: z.array(nativeTargetCompletedAttemptSchema),
  priorCancellations: z.array(nativeTargetCancellationProvenanceSchema).optional(),
};
const approved = { ...common, approval: nativeTargetOnboardingApprovalSchema };
export const nativeTargetOnboardingRecordSchema = z
  .discriminatedUnion("stage", [
    z.strictObject({ ...common, stage: z.literal("planned") }),
    z.strictObject({ ...approved, stage: z.literal("approved") }),
    z.strictObject({
      ...approved,
      stage: z.literal("creating"),
      attempt: nativeTargetOnboardingAttemptSchema,
      dispatchAuthorizedAt: instant.optional(),
      acceptedCreation: nativeTargetAcceptedCreationSchema.optional(),
      cancelledBy: nativeTargetOnboardingApprovalSchema.optional(),
    }),
    z.strictObject({
      ...approved,
      stage: z.literal("unknown"),
      attempt: nativeTargetOnboardingAttemptSchema,
      dispatchAuthorizedAt: instant.optional(),
      acceptedCreation: nativeTargetAcceptedCreationSchema.optional(),
      cancelledBy: nativeTargetOnboardingApprovalSchema.optional(),
    }),
    z.strictObject({
      ...approved,
      stage: z.literal("ready"),
      attempt: nativeTargetOnboardingAttemptSchema,
      dispatchAuthorizedAt: instant,
      acceptedCreation: nativeTargetAcceptedCreationSchema,
      registration: nativeTargetOnboardingCreationProofSchema,
    }),
    z.strictObject({ ...approved, stage: z.literal("cancelled") }),
  ])
  .superRefine((record, context) => {
    const fail = (message: string) => {
      context.addIssue({ code: "custom", message });
    };
    if (
      record.appId !== record.plan.appId ||
      record.planDigest !== nativeTargetOnboardingPlanDigest(record.plan)
    ) {
      fail("Target plan identity mismatch.");
    }
    for (const prior of record.priorCancellations ?? []) {
      if (
        prior.plan.appId !== record.appId ||
        prior.planDigest !== nativeTargetOnboardingPlanDigest(prior.plan) ||
        prior.approval.outcome !== "cancelled" ||
        prior.approval.planDigest !== prior.planDigest ||
        prior.approval.publicSessionId !== prior.plan.origin.publicSessionId ||
        prior.previousAttempts.some((attempt) => attempt.reason !== "not_dispatched")
      ) {
        fail("Prior cancellation provenance does not establish an undispatched cancelled plan.");
      }
    }
    if (
      "approval" in record &&
      (record.approval.planDigest !== record.planDigest ||
        record.approval.publicSessionId !== record.plan.origin.publicSessionId ||
        record.approval.outcome !== (record.stage === "cancelled" ? "cancelled" : "approved"))
    ) {
      fail("Target approval does not match its frozen plan.");
    }
    if (
      "attempt" in record &&
      !nativeTargetCandidateAllowed(record.plan, record.attempt.candidateName)
    ) {
      fail("Target candidate is outside the approved name policy.");
    }
    if (
      "cancelledBy" in record &&
      record.cancelledBy !== undefined &&
      (record.cancelledBy.outcome !== "cancelled" ||
        record.cancelledBy.planDigest !== record.planDigest ||
        record.cancelledBy.publicSessionId !== record.plan.origin.publicSessionId)
    ) {
      fail("Target cancellation does not match its frozen plan.");
    }
    if (
      "acceptedCreation" in record &&
      record.acceptedCreation !== undefined &&
      (record.acceptedCreation.attemptId !== record.attempt.attemptId ||
        record.dispatchAuthorizedAt === undefined)
    ) {
      fail("Accepted project identity belongs to another attempt.");
    }
    if (record.stage === "ready") {
      const { observed, attemptId } = record.registration;
      if (
        attemptId !== record.attempt.attemptId ||
        record.acceptedCreation.attemptId !== attemptId ||
        record.acceptedCreation.projectId !== observed.projectId ||
        observed.name !== record.attempt.candidateName ||
        observed.teamId !== record.plan.project.teamId ||
        observed.installationId !== record.plan.project.installationId ||
        JSON.stringify(hostedOperatorAppProjectSettingsSchema.parse(observed.projectSettings)) !==
          JSON.stringify(
            hostedOperatorAppProjectSettingsSchema.parse(record.plan.project.projectSettings),
          ) ||
        JSON.stringify(nativeTargetProjectProtectionSchema.parse(observed.protection)) !==
          JSON.stringify(nativeTargetProjectProtectionSchema.parse(record.plan.project.protection))
      ) {
        fail("Target creation and independent readback do not match the approved attempt.");
      }
    }
  });
export type NativeTargetOnboardingRecord = z.infer<typeof nativeTargetOnboardingRecordSchema>;
export type NativeTargetReadyRegistration = Extract<
  NativeTargetOnboardingRecord,
  { stage: "ready" }
>;

export const nativeTargetOnboardingTableState = (record: NativeTargetOnboardingRecord) =>
  record.stage === "ready" || record.stage === "cancelled"
    ? ("settled" as const)
    : ("pending" as const);
