/* oxlint-disable sonarjs/expression-complexity, sonarjs/no-nested-conditional -- Preserve the exact frozen v1/v2/v3 destination and ingress guards together; no capability or version is inferred. */
import { existingPlatformIntegrationPlanReferenceSchema } from "./existing-platform-integration-contract";
import { integrationProviderDiagnosticSchema } from "./app-integration-provider-diagnostic";
import {
  appIntegrationProviderConfigurationSchema,
  appIntegrationMachineIngressSchema,
} from "../repository/app-integration-metadata";
import { createHash } from "node:crypto";
import { z } from "zod";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { builderAppIdSchema } from "./names";

const prepareControlDatabaseEffect = "prepare-control-database";
const installControlSchemaEffect = "install-control-schema";
const bindServiceMembershipsEffect = "bind-service-memberships";
const registerCentralAppEffect = "register-central-app";
const prepareProviderDestinationEffect = "prepare-provider-destination";
const id = z.string().min(1).max(256);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sqlName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u);
const role = sqlName.refine((value) => !["postgres", "neondb_owner"].includes(value));
const origin = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && value === url.origin && !url.username && !url.password;
});
export const integrationCapabilityResourceSchema = z.strictObject({
  database: sqlName,
  environment: z.literal("preview"),
  hostname: z.string().regex(/^[a-z0-9.-]+\.neon\.tech$/u),
  migratorRole: role,
  port: z.literal(5432),
  resourceId: id,
  runtimeRole: role,
  schema: z.literal("public"),
});
export const integrationCapabilityMembershipSchema = z.strictObject({
  actorId: id,
  organizationId: id,
  role: sqlName,
});
export const integrationCapabilityEffectSchema = z.enum([
  prepareControlDatabaseEffect,
  installControlSchemaEffect,
  bindServiceMembershipsEffect,
  registerCentralAppEffect,
  prepareProviderDestinationEffect,
]);
export type IntegrationCapabilityEffect = z.infer<typeof integrationCapabilityEffectSchema>;
export const appIntegrationCapabilityPlanSchema = z
  .strictObject({
    authority: hostedTenantAuthoritySchema,
    control: z.strictObject({
      activationKeyId: id,
      activationPublicKeySha256: digest,
      centralHostSetup: z
        .strictObject({
          callerOperationRef: z.uuid(),
          callerPlanDigest: digest,
          operationRef: z.uuid(),
          planDigest: digest,
          projectId: id,
          providerDeploymentId: id,
          teamId: id,
          trustedSourcesGrantSha256: digest,
        })
        .optional(),
      database: integrationCapabilityResourceSchema,
      existingPlatform: existingPlatformIntegrationPlanReferenceSchema.optional(),
      neon: z.strictObject({
        branchId: id,
        endpointId: id,
        projectId: id,
        source: z.literal("synthetic-only"),
      }),
      origin,
      registrationIdentitySha256: digest,
      resourceProfileId: id,
      schema: z.strictObject({ artifactRef: id, sha256: digest }),
    }),
    effects: z.union([
      z.tuple([
        z.literal(prepareControlDatabaseEffect),
        z.literal(installControlSchemaEffect),
        z.literal(bindServiceMembershipsEffect),
        z.literal(registerCentralAppEffect),
      ]),
      z.tuple([
        z.literal(prepareControlDatabaseEffect),
        z.literal(installControlSchemaEffect),
        z.literal(bindServiceMembershipsEffect),
        z.literal(prepareProviderDestinationEffect),
        z.literal(registerCentralAppEffect),
      ]),
    ]),
    kind: z.enum([
      "app-integrations-capability-plan-v1",
      "app-integrations-capability-plan-v2",
      "app-integrations-capability-plan-v3",
    ]),
    machineIngress: appIntegrationMachineIngressSchema.optional(),
    privateConfigurationSeed: z.strictObject({ reference: z.uuid(), sha256: digest }),
    profileDigest: digest,
    profileId: id,
    project: z.strictObject({
      installationId: id,
      projectId: id,
      provisioningDigest: digest,
      provisioningRequestId: z.uuid(),
      teamId: id,
    }),
    provider: z.strictObject({
      authorizationOrigins: z.array(origin).min(1),
      integrationId: id,
      kind: z.literal("quickbooksSandbox"),
      payloadHosts: z.array(z.string().regex(/^[a-z0-9.-]+$/u)).min(1),
      projectId: id,
      readObjectsSha256: digest,
      recipeId: id,
      recipeVersion: id,
    }),
    providerConfiguration: appIntegrationProviderConfigurationSchema.safeExtend({
      artifactRef: id,
    }),
    providerDestination: z
      .strictObject({
        existing: z
          .strictObject({ destinationId: id, secretRef: z.uuid(), secretSha256: digest })
          .optional(),
        name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u),
        origin,
        path: z.string().startsWith("/"),
      })
      .optional(),
    publicOrigin: origin,
    readinessPath: z
      .string()
      .startsWith("/")
      .refine((value) => !value.includes("?") && !value.includes("#") && !value.startsWith("//")),
    release: z.strictObject({
      appSpecDigest: id,
      artifactRef: id,
      artifactSha256: digest,
      id,
      manifestSha256: digest,
    }),
    resourceWorker: z
      .strictObject({ id: z.literal("neon-resource-bootstrap-v1"), sha256: digest })
      .optional(),
    runtime: z.strictObject({
      appDatabase: integrationCapabilityResourceSchema,
      neon: z.strictObject({
        branchId: id,
        endpointId: id,
        projectId: id,
        source: z.literal("synthetic-only"),
      }),
      operationRef: z.uuid(),
      planDigest: digest,
    }),
    selection: z.strictObject({ appId: builderAppIdSchema, sessionId: id }),
    serviceMemberships: z.array(integrationCapabilityMembershipSchema).min(1),
    version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    worker: z.strictObject({ reference: id, sha256: digest }),
    workload: z.strictObject({
      audience: z.url(),
      environment: z.literal("production"),
      issuer: z.url(),
      ownerId: id,
      projectId: id,
      subject: id,
    }),
  })
  // oxlint-disable-next-line eslint/complexity -- One refinement compares immutable version, physical resource, captured source and installed ingress authority without rewriting legacy plans.
  .superRefine((plan, context) => {
    const v2 = plan.version >= 2;
    if (
      plan.version === 3
        ? plan.control.existingPlatform === undefined || plan.control.centralHostSetup !== undefined
        : plan.control.centralHostSetup === undefined || plan.control.existingPlatform !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Exact version-specific existing-platform or legacy setup reference required",
      });
    }
    const destination = plan.providerDestination;
    const ingress = plan.machineIngress?.filter((entry) => entry.kind === "quickbooks-ingress");
    if (
      v2
        ? plan.kind !==
            (plan.version === 3
              ? "app-integrations-capability-plan-v3"
              : "app-integrations-capability-plan-v2") ||
          plan.resourceWorker === undefined ||
          destination === undefined ||
          plan.effects.length !== 5 ||
          ingress?.length !== 1 ||
          destination.origin !== plan.publicOrigin ||
          destination.path !== ingress[0]?.path ||
          Object.values(plan.providerConfiguration.readObjects).some(
            (entry) => entry.destination !== destination.name,
          )
        : plan.kind !== "app-integrations-capability-plan-v1" ||
          plan.resourceWorker !== undefined ||
          destination !== undefined ||
          plan.effects.length !== 4
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Exact version-specific resource worker and source-declared provider destination required",
      });
    }
    if (plan.readinessPath !== `/${plan.selection.appId}/api/integrations/readiness`) {
      context.addIssue({ code: "custom", message: "Exact installed readiness endpoint required" });
    }
    if (
      plan.workload.projectId !== plan.project.projectId ||
      plan.workload.ownerId !== plan.project.teamId
    ) {
      context.addIssue({
        code: "custom",
        message: "Exact normal project Production workload required",
      });
    }
    const source = plan.providerConfiguration;
    const sourceMatches = [
      source.artifactRef === plan.release.artifactRef,
      source.provider === "quickbooks",
      source.recipeId === plan.provider.recipeId,
      source.recipeVersion === plan.provider.recipeVersion,
      source.readObjectsSha256 === plan.provider.readObjectsSha256,
    ];
    if (sourceMatches.includes(false)) {
      context.addIssue({
        code: "custom",
        message: "Exact captured provider configuration required",
      });
    }
    for (const entry of plan.machineIngress ?? []) {
      const suffix = entry.kind === "quickbooks-ingress" ? "quickbooks" : entry.kind;
      if (entry.path !== `/${plan.selection.appId}/api/integrations/${suffix}`) {
        context.addIssue({
          code: "custom",
          message: "Exact installer-declared app ingress required",
        });
      }
    }
    const resources = [plan.runtime.appDatabase, plan.control.database];
    if (
      // oxlint-disable-next-line sonarjs/expression-complexity -- Exact resources, credentials and service scopes jointly define one approved capability.
      new Set(resources.map((resource) => resource.resourceId)).size !== resources.length ||
      new Set(resources.map((resource) => resource.database)).size !== resources.length ||
      new Set(resources.flatMap((resource) => [resource.runtimeRole, resource.migratorRole]))
        .size !==
        resources.length * 2 ||
      new Set(plan.serviceMemberships.map((member) => member.organizationId)).size !==
        plan.serviceMemberships.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Capability resources and declared service scopes must be distinct and exact",
      });
    }
  });
export type AppIntegrationCapabilityPlan = z.infer<typeof appIntegrationCapabilityPlanSchema>;
const json = z.json();
type CanonicalJsonValue = z.infer<typeof json>;
const canonical = (value: CanonicalJsonValue): CanonicalJsonValue => {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Canonical serialization branches on an already validated JSON domain.
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
};
export const canonicalAppIntegrationCapabilityPlanBytes = (plan: AppIntegrationCapabilityPlan) =>
  JSON.stringify(canonical(json.parse(appIntegrationCapabilityPlanSchema.parse(plan))));
export const appIntegrationCapabilityPlanDigest = (plan: AppIntegrationCapabilityPlan) =>
  createHash("sha256").update(canonicalAppIntegrationCapabilityPlanBytes(plan)).digest("hex");
export const appIntegrationCapabilityOperationRef = (plan: AppIntegrationCapabilityPlan) => {
  const value = appIntegrationCapabilityPlanDigest(plan);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`;
};
export const integrationProviderDestinationReceiptSchema = z.strictObject({
  destinationId: id,
  effect: z.literal(prepareProviderDestinationEffect),
  name: id,
  secretRef: z.uuid(),
  secretSha256: digest,
  url: z.url(),
});
export const preparedIntegrationProviderDestinationSchema =
  integrationProviderDestinationReceiptSchema.omit({ effect: true, secretRef: true });
export const integrationCapabilityReceiptSchema = z.discriminatedUnion("effect", [
  integrationProviderDestinationReceiptSchema,
  z.strictObject({
    database: sqlName,
    effect: z.literal(prepareControlDatabaseEffect),
    migratorRole: role,
    resourceId: id,
    resourceVersion: id,
    runtimeRole: role,
  }),
  z.strictObject({
    effect: z.literal(installControlSchemaEffect),
    resourceVersion: id,
    schemaSha256: digest,
  }),
  z.strictObject({
    effect: z.literal(bindServiceMembershipsEffect),
    memberships: z
      .array(
        integrationCapabilityMembershipSchema.extend({
          fenceGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        }),
      )
      .min(1),
    resourceVersion: id,
  }),
  z.strictObject({
    appId: builderAppIdSchema,
    effect: z.literal(registerCentralAppEffect),
    principalGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    registrationDigest: digest,
    registrationRef: z.uuid(),
    resourceProfileId: id,
    resourceVersion: id,
  }),
]);
export type IntegrationCapabilityReceipt = z.infer<typeof integrationCapabilityReceiptSchema>;

export const appIntegrationCapabilityApprovalInputSchema = z
  .strictObject({
    operationRef: z.uuid(),
    plan: appIntegrationCapabilityPlanSchema,
    planDigest: digest,
  })
  .superRefine((input, context) => {
    if (
      input.operationRef !== appIntegrationCapabilityOperationRef(input.plan) ||
      input.planDigest !== appIntegrationCapabilityPlanDigest(input.plan)
    ) {
      context.addIssue({
        code: "custom",
        message: "Capability approval must match its complete frozen plan",
      });
    }
  });
export type AppIntegrationCapabilityApprovalInput = z.infer<
  typeof appIntegrationCapabilityApprovalInputSchema
>;
const loadedResource = integrationCapabilityResourceSchema.omit({
  environment: true,
  migratorRole: true,
});
export const preparedAppIntegrationCapabilitySchema = z.strictObject({
  appDatabase: loadedResource,
  appId: builderAppIdSchema,
  control: z.strictObject({
    activationKeyId: id,
    activationPublicKeySha256: digest,
    database: loadedResource,
    origin,
    principalGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    resourceProfileId: id,
  }),
  environment: z.literal("development"),
  kind: z.literal("app-integrations-development-v1"),
  machineIngress: appIntegrationMachineIngressSchema.optional(),
  privateConfiguration: z.strictObject({ reference: z.uuid(), sha256: digest }),
  provider: appIntegrationCapabilityPlanSchema.shape.provider,
  providerDestination: preparedIntegrationProviderDestinationSchema.optional(),
  release: z.strictObject({ artifactSha256: digest, id, manifestSha256: digest }),
  resourceProfile: z.literal("isolated-development"),
  serviceMemberships: z
    .array(
      integrationCapabilityMembershipSchema.extend({
        fenceGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .min(1),
});
export type PreparedAppIntegrationCapability = z.infer<
  typeof preparedAppIntegrationCapabilitySchema
>;
const retiredAttempts = z
  .array(
    z.strictObject({
      attemptGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      proof: z.literal("authoritative-effect-not-applied"),
    }),
  )
  .default([]);
const effectState = z.discriminatedUnion("state", [
  z.strictObject({ retiredAttempts, state: z.literal("idle") }),
  z.strictObject({
    attemptGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    receipt: integrationCapabilityReceiptSchema.optional(),
    retiredAttempts,
    state: z.literal("pending"),
  }),
  z.strictObject({
    attemptGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    receipt: integrationCapabilityReceiptSchema,
    retiredAttempts,
    state: z.literal("applied"),
  }),
]);
export type AppIntegrationCapabilityEffectState = z.infer<typeof effectState>;
export const appIntegrationCapabilityRecordSchema = z
  .strictObject({
    approvalReceipts: z.array(z.strictObject({ approvalId: id, approvedByCallId: id })).default([]),
    effects: z.strictObject({
      [bindServiceMembershipsEffect]: effectState,
      [installControlSchemaEffect]: effectState,
      [prepareControlDatabaseEffect]: effectState,
      [prepareProviderDestinationEffect]: effectState.optional(),
      [registerCentralAppEffect]: effectState,
    }),
    executionLease: z
      .strictObject({
        fenceGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        leaseId: z.uuid(),
      })
      .optional(),
    kind: z.literal("app-integrations-capability-v1"),
    plan: appIntegrationCapabilityPlanSchema,
    planDigest: digest,
    prepared: preparedAppIntegrationCapabilitySchema.optional(),
    providerDiagnostic: integrationProviderDiagnosticSchema.optional(),
  })
  .superRefine((record, context) => {
    const invalid = [
      record.planDigest !== appIntegrationCapabilityPlanDigest(record.plan),
      record.plan.version === 1 && record.effects[prepareProviderDestinationEffect] !== undefined,
      record.plan.effects.some((effect) => {
        const state = record.effects[effect];
        return (
          state === undefined ||
          (state.state !== "idle" && state.receipt !== undefined && state.receipt.effect !== effect)
        );
      }),
      record.prepared !== undefined &&
        record.plan.effects.some((effect) => record.effects[effect]?.state !== "applied"),
    ];
    if (invalid.includes(true)) {
      context.addIssue({
        code: "custom",
        message: "Capability checkpoint must preserve its complete exact intent and effects",
      });
    }
  });
export type AppIntegrationCapabilityRecord = z.infer<typeof appIntegrationCapabilityRecordSchema>;

/** Version-one journals never acquire a new effect; a missing declared state is corrupt. */
export const readIntegrationCapabilityEffect = (
  record: AppIntegrationCapabilityRecord,
  effect: IntegrationCapabilityEffect,
): AppIntegrationCapabilityEffectState => {
  const value = record.effects[effect];
  if (value === undefined || !record.plan.effects.some((declared) => declared === effect)) {
    throw new Error("app_integration_capability_unavailable");
  }
  return value;
};
