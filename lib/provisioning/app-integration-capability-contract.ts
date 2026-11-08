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
  resourceId: id,
  environment: z.literal("preview"),
  hostname: z.string().regex(/^[a-z0-9.-]+\.neon\.tech$/u),
  port: z.literal(5432),
  database: sqlName,
  schema: z.literal("public"),
  runtimeRole: role,
  migratorRole: role,
});
export const integrationCapabilityMembershipSchema = z.strictObject({
  organizationId: id,
  actorId: id,
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
    version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    kind: z.enum([
      "app-integrations-capability-plan-v1",
      "app-integrations-capability-plan-v2",
      "app-integrations-capability-plan-v3",
    ]),
    authority: hostedTenantAuthoritySchema,
    selection: z.strictObject({ appId: builderAppIdSchema, sessionId: id }),
    project: z.strictObject({
      projectId: id,
      teamId: id,
      installationId: id,
      provisioningRequestId: z.uuid(),
      provisioningDigest: digest,
    }),
    release: z.strictObject({
      id,
      artifactRef: id,
      manifestSha256: digest,
      artifactSha256: digest,
      appSpecDigest: id,
    }),
    runtime: z.strictObject({
      operationRef: z.uuid(),
      planDigest: digest,
      appDatabase: integrationCapabilityResourceSchema,
      neon: z.strictObject({
        projectId: id,
        branchId: id,
        endpointId: id,
        source: z.literal("synthetic-only"),
      }),
    }),
    profileId: id,
    profileDigest: digest,
    publicOrigin: origin,
    workload: z.strictObject({
      issuer: z.url(),
      audience: z.url(),
      subject: id,
      environment: z.literal("production"),
      projectId: id,
      ownerId: id,
    }),
    readinessPath: z
      .string()
      .startsWith("/")
      .refine((value) => !value.includes("?") && !value.includes("#") && !value.startsWith("//")),
    control: z.strictObject({
      origin,
      resourceProfileId: id,
      registrationIdentitySha256: digest,
      database: integrationCapabilityResourceSchema,
      neon: z.strictObject({
        projectId: id,
        branchId: id,
        endpointId: id,
        source: z.literal("synthetic-only"),
      }),
      centralHostSetup: z
        .strictObject({
          operationRef: z.uuid(),
          planDigest: digest,
          callerOperationRef: z.uuid(),
          callerPlanDigest: digest,
          projectId: id,
          teamId: id,
          providerDeploymentId: id,
          trustedSourcesGrantSha256: digest,
        })
        .optional(),
      existingPlatform: existingPlatformIntegrationPlanReferenceSchema.optional(),
      schema: z.strictObject({ artifactRef: id, sha256: digest }),
      activationKeyId: id,
      activationPublicKeySha256: digest,
    }),
    provider: z.strictObject({
      kind: z.literal("quickbooksSandbox"),
      projectId: id,
      integrationId: id,
      recipeId: id,
      recipeVersion: id,
      readObjectsSha256: digest,
      authorizationOrigins: z.array(origin).min(1),
      payloadHosts: z.array(z.string().regex(/^[a-z0-9.-]+$/u)).min(1),
    }),
    providerConfiguration: appIntegrationProviderConfigurationSchema.safeExtend({
      artifactRef: id,
    }),
    serviceMemberships: z.array(integrationCapabilityMembershipSchema).min(1),
    machineIngress: appIntegrationMachineIngressSchema.optional(),
    worker: z.strictObject({ reference: id, sha256: digest }),
    resourceWorker: z
      .strictObject({ id: z.literal("neon-resource-bootstrap-v1"), sha256: digest })
      .optional(),
    providerDestination: z
      .strictObject({
        name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u),
        origin,
        path: z.string().startsWith("/"),
        existing: z
          .strictObject({ destinationId: id, secretRef: z.uuid(), secretSha256: digest })
          .optional(),
      })
      .optional(),
    privateConfigurationSeed: z.strictObject({ reference: z.uuid(), sha256: digest }),
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
  effect: z.literal(prepareProviderDestinationEffect),
  destinationId: id,
  name: id,
  url: z.url(),
  secretRef: z.uuid(),
  secretSha256: digest,
});
export const preparedIntegrationProviderDestinationSchema =
  integrationProviderDestinationReceiptSchema.omit({ effect: true, secretRef: true });
export const integrationCapabilityReceiptSchema = z.discriminatedUnion("effect", [
  integrationProviderDestinationReceiptSchema,
  z.strictObject({
    effect: z.literal(prepareControlDatabaseEffect),
    resourceVersion: id,
    resourceId: id,
    database: sqlName,
    runtimeRole: role,
    migratorRole: role,
  }),
  z.strictObject({
    effect: z.literal(installControlSchemaEffect),
    resourceVersion: id,
    schemaSha256: digest,
  }),
  z.strictObject({
    effect: z.literal(bindServiceMembershipsEffect),
    resourceVersion: id,
    memberships: z
      .array(
        integrationCapabilityMembershipSchema.extend({
          fenceGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        }),
      )
      .min(1),
  }),
  z.strictObject({
    effect: z.literal(registerCentralAppEffect),
    resourceVersion: id,
    appId: builderAppIdSchema,
    resourceProfileId: id,
    registrationRef: z.uuid(),
    registrationDigest: digest,
    principalGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
]);
export type IntegrationCapabilityReceipt = z.infer<typeof integrationCapabilityReceiptSchema>;

export const appIntegrationCapabilityApprovalInputSchema = z
  .strictObject({
    plan: appIntegrationCapabilityPlanSchema,
    operationRef: z.uuid(),
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
  kind: z.literal("app-integrations-development-v1"),
  appId: builderAppIdSchema,
  environment: z.literal("development"),
  resourceProfile: z.literal("isolated-development"),
  release: z.strictObject({ id, manifestSha256: digest, artifactSha256: digest }),
  appDatabase: loadedResource,
  control: z.strictObject({
    origin,
    resourceProfileId: id,
    principalGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    database: loadedResource,
    activationKeyId: id,
    activationPublicKeySha256: digest,
  }),
  provider: appIntegrationCapabilityPlanSchema.shape.provider,
  providerDestination: preparedIntegrationProviderDestinationSchema.optional(),
  serviceMemberships: z
    .array(
      integrationCapabilityMembershipSchema.extend({
        fenceGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .min(1),
  machineIngress: appIntegrationMachineIngressSchema.optional(),
  privateConfiguration: z.strictObject({ reference: z.uuid(), sha256: digest }),
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
  z.strictObject({ state: z.literal("idle"), retiredAttempts }),
  z.strictObject({
    state: z.literal("pending"),
    retiredAttempts,
    attemptGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    receipt: integrationCapabilityReceiptSchema.optional(),
  }),
  z.strictObject({
    state: z.literal("applied"),
    retiredAttempts,
    attemptGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    receipt: integrationCapabilityReceiptSchema,
  }),
]);
export type AppIntegrationCapabilityEffectState = z.infer<typeof effectState>;
export const appIntegrationCapabilityRecordSchema = z
  .strictObject({
    kind: z.literal("app-integrations-capability-v1"),
    plan: appIntegrationCapabilityPlanSchema,
    planDigest: digest,
    effects: z.strictObject({
      "prepare-control-database": effectState,
      "install-control-schema": effectState,
      "bind-service-memberships": effectState,
      "register-central-app": effectState,
      "prepare-provider-destination": effectState.optional(),
    }),
    approvalReceipts: z.array(z.strictObject({ approvalId: id, approvedByCallId: id })).default([]),
    executionLease: z
      .strictObject({
        leaseId: z.uuid(),
        fenceGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .optional(),
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
