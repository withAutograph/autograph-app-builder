import { operatorWorkerSourceCaptureSchema } from "./operator-worker-source-capture";
import { managedRuntimeWorkerDescriptorSchema } from "./hosted-operator-continuity-contract";
import { tenantExportWorkerDescriptorSchema } from "./hosted-operator-export-contract";
import { z } from "zod";
import { generatedAppRoleSchema } from "../repository/generated-app-role";
import { configurationSchema, scopeSchema } from "./hosted-operator-native-preview-neon";
import { createOperatorWorkloadVerifier } from "./hosted-operator-workload";
import { hostedOperatorAuthAdoptionSourceSchema } from "./hosted-operator-shared-auth-adoption";
import { hostedOperatorAppProjectSettingsSchema } from "./hosted-operator-app-project-settings";
import {
  externallyManagedTrustedSourcesSchema,
  matchesExternalTrustedSources,
} from "./hosted-operator-host-protection";

const neonResourceBootstrapId = "neon-resource-bootstrap-v1";
const singleProjectServicesComposition = "single-project-services";

const id = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const httpsOrigin = z.url().refine((value) => {
  const url = new URL(value);
  return [
    url.protocol === "https:",
    url.pathname === "/",
    url.search === "",
    url.hash === "",
    url.username === "",
    url.password === "",
  ].every(Boolean);
});
export const hostedOperatorWorkerDescriptorSchema = z.strictObject({
  sourceCapture: operatorWorkerSourceCaptureSchema.optional(),
  executablePath: id,
  id,
  operationScope: z.enum([
    "generated-app-release-install-v1",
    "generated-app-access-v1",
    "auth-protected-schema-v1",
    "auth-protected-membership-v1",
    neonResourceBootstrapId,
  ]),
  sha256: digest,
  subcommand: z.enum([
    "protected-generated-app-install",
    "protected-generated-app-access",
    "auth-protected-schema",
    "auth-protected-membership",
    "neon-resource-bootstrap",
  ]),
});
const worker = hostedOperatorWorkerDescriptorSchema;
const resource = z.strictObject({
  database: id,
  migratorRole: id,
  resourceId: id,
  runtimeRole: id,
});
const workload = z.strictObject({
  audience: z.url(),
  environment: z.enum(["development", "preview", "production"]),
  issuer: z.url(),
  ownerId: id,
  projectId: id,
  subject: id,
});
const sandboxConfigurationFields = {
  exportWorker: tenantExportWorkerDescriptorSchema.optional(),
  managedRuntimeWorker: managedRuntimeWorkerDescriptorSchema.optional(),
  genericInstallerWorker: worker
    .extend({
      operationScope: z.literal("generated-app-release-install-v1"),
      subcommand: z.literal("protected-generated-app-install"),
      sourceCapture: operatorWorkerSourceCaptureSchema.extend({
        family: z.literal("genericInstaller"),
      }),
    })
    .optional(),
  accessWorker: worker,
  authProposal: z.strictObject({ executablePath: id, id, sha256: digest }),
  authWorker: worker,
  membershipWorker: worker.optional(),
  projectId: id,
  resourcesWorker: worker,
  integrationResourcesWorker: z
    .strictObject({
      executablePath: id,
      id: z.literal(neonResourceBootstrapId),
      operationScope: z.literal(neonResourceBootstrapId),
      sha256: digest,
      subcommand: z.literal("neon-resource-bootstrap"),
    })
    .optional(),
  integrationWorker: z
    .strictObject({
      executablePath: id,
      id: z.literal("app-integration-bootstrap-v1"),
      operationScope: z.literal("app-integration-bootstrap-v1"),
      sha256: digest,
      subcommand: z.literal("integration-control-schema"),
    })
    .optional(),
  centralIntegrationWorker: z
    .strictObject({
      executablePath: id,
      id: z.literal("central-integration-bootstrap-v1"),
      operationScope: z.literal("central-integration-bootstrap-v1"),
      sha256: digest,
      subcommand: z.literal("central-integration-schema"),
    })
    .optional(),
  teamId: id,
  workers: z.record(id, worker),
};
export const hostedOperatorSandboxConfigurationSchema = z.union([
  z.strictObject({ ...sandboxConfigurationFields, image: id }),
  z.strictObject({
    ...sandboxConfigurationFields,
    source: z.strictObject({ snapshotId: id, type: z.literal("snapshot") }),
  }),
]);

const nativeNeonConfigurationSchema = z.strictObject({
  configuration: configurationSchema.omit({ connectorInstallationId: true }),
  scope: scopeSchema,
});
/** Generic administrator-selected development custody, never an app or model supplied profile. */
export const standardDevelopmentRuntimePolicySchema = z
  .strictObject({
    version: z.literal(1),
    kind: z.literal("standard-development-runtime-policy-v1"),
    policyId: id,
    nativeNeon: nativeNeonConfigurationSchema,
    productionDatabaseIdentity: z.string().regex(/^[a-z0-9.-]+\.neon\.tech\/[a-z][a-z0-9_]*$/u),
    workloadIdentity: z.literal("vercel-team-oidc-v1"),
  })
  .superRefine((policy, context) => {
    const { configuration, scope } = policy.nativeNeon;
    const enrollment = configuration.syntheticEnrollment;
    const productionHost = policy.productionDatabaseIdentity
      .split("/")[0]
      ?.replace(/-pooler(?=\.)/u, "");
    const valid = [
      enrollment !== undefined,
      enrollment?.project.id === scope.projectId,
      enrollment?.root.branchId !== scope.branchId,
      enrollment?.branches.some((branch) => branch.branchId === scope.branchId) === true,
      scope.hostname.replace(/-pooler(?=\.)/u, "") !== productionHost,
    ].every(Boolean);
    if (!valid) {
      context.addIssue({
        code: "custom",
        message:
          "Standard development custody requires an enrolled nondefault development branch outside Production.",
      });
    }
  });

export const hostedOperatorSourceConfigurationSchema = z.strictObject({
  /** Explicit deployment-owned topology; omitted configurations retain legacy behavior. */
  composition: z.literal(singleProjectServicesComposition).optional(),
  standardDevelopmentRuntime: standardDevelopmentRuntimePolicySchema.optional(),
  standardRuntime: z
    .strictObject({
      profileId: id,
      authOwnership: z.strictObject({ kind: z.literal("dedicated-app-development"), resource }),
      publicRealmWorkload: workload.extend({ environment: z.literal("production") }),
      productionDatabaseIdentity: z.string().regex(/^[a-z0-9.-]+\.neon\.tech\/[a-z][a-z0-9_]*$/u),
      provisioningRequestId: z.uuid(),
      provisioningDigest: digest,
      appSpecDigest: digest,
      capturedReleaseId: id,
    })
    .optional(),
  /** Explicit deployment-owned topology; omitted configurations retain legacy behavior. */

  applications: z.record(
    id,
    z.strictObject({
      accessRoles: z.array(generatedAppRoleSchema),
      /** Registry provenance: new access plans must read roles from the current captured release. */
      nativeTargetRegistration: z.literal(true).optional(),
      appDatabase: resource,
      hostProtection: externallyManagedTrustedSourcesSchema.optional(),
      authAdoptionSource: hostedOperatorAuthAdoptionSourceSchema.optional(),
      branch: id,
      deploymentId: id.optional(),
      projectSettings: hostedOperatorAppProjectSettingsSchema.optional(),
      gitSha: z
        .string()
        .regex(/^[a-f0-9]{40}$/u)
        .optional(),
      organizationProposal: z.strictObject({ name: id, organizationId: id, slug: id }).optional(),
      /** Existing organization selected for the ordinary owner-bound Realm capture. */
      organizationId: id.optional(),
      projectId: id,
      repoId: id.optional(),
    }),
  ),
  authDatabase: resource,
  builderCallbackOrigin: httpsOrigin,
  catalogAppIds: z.array(id).min(1),
  gateway: z.strictObject({
    authBrowserOrigin: httpsOrigin,
    branch: id,
    deploymentId: id.optional(),
    environment: z.literal("preview"),
    gatewayOrigin: httpsOrigin,
    gitSha: z.string().regex(/^[a-f0-9]{40}$/u),
    projectId: id,
    protectedApplicationIds: z.array(id),
    publicOrigin: httpsOrigin,
    repoId: id,
    workload,
  }),
  nativeNeon: nativeNeonConfigurationSchema,
  operator: z.strictObject({
    deploymentId: id,
    environment: z.literal("preview"),
    origin: httpsOrigin,
    projectId: id,
  }),
  sandbox: hostedOperatorSandboxConfigurationSchema,
  teamId: id,
  workloadPolicy: workload,
});
export type HostedOperatorSourceConfiguration = z.infer<
  typeof hostedOperatorSourceConfigurationSchema
>;

/** A standard destination is supplied coherently, never assembled from an old Gateway. */
export const hasSingleProjectServicesTopology = (config: HostedOperatorSourceConfiguration) =>
  config.gateway.projectId !== config.operator.projectId &&
  config.gateway.gatewayOrigin === config.gateway.publicOrigin &&
  config.gateway.authBrowserOrigin === config.gateway.publicOrigin &&
  Object.values(config.applications).every((app) =>
    [
      app.projectId === config.gateway.projectId,
      app.branch === config.gateway.branch,
      app.projectSettings?.framework === "services",
      app.projectSettings?.rootDirectory === ".",
      app.nativeTargetRegistration === undefined,
      app.hostProtection === undefined,
      app.repoId === undefined || app.repoId === config.gateway.repoId,
    ].every(Boolean),
  );

/** A standard destination is supplied coherently, never assembled from an old Gateway. */

/** Validate the same deployment ownership invariants for every configuration snapshot. */
export const validateHostedOperatorSourceConfiguration = (
  value: HostedOperatorSourceConfiguration,
) => {
  const config = hostedOperatorSourceConfigurationSchema.parse(value);
  createOperatorWorkloadVerifier(config.workloadPolicy);
  const ownedConfiguration = [
    config.operator.projectId === config.nativeNeon.configuration.operator.projectId,
    config.teamId === config.nativeNeon.configuration.operator.ownerId,
    config.operator.environment === config.nativeNeon.configuration.operator.environment,
    config.gateway.workload.projectId === config.gateway.projectId,
    config.gateway.workload.ownerId === config.teamId,
    config.gateway.workload.environment === config.gateway.environment,
    Object.values(config.applications).every(
      (app) =>
        app.projectId !== config.operator.projectId &&
        (config.composition === singleProjectServicesComposition ||
          app.projectId !== config.gateway.projectId),
    ),
    config.sandbox.projectId === config.operator.projectId,
    config.sandbox.teamId === config.teamId,
    Object.values(config.applications).every(
      (app) =>
        app.hostProtection === undefined ||
        matchesExternalTrustedSources(
          app.hostProtection,
          config.teamId,
          app.projectId,
          config.gateway.projectId,
        ),
    ),
    new Set([config.operator.projectId, config.gateway.projectId]).size === 2,
    config.standardRuntime === undefined ||
      [
        config.composition === singleProjectServicesComposition,
        config.standardRuntime.publicRealmWorkload.projectId === config.gateway.projectId,
        config.standardRuntime.publicRealmWorkload.ownerId === config.teamId,
      ].every(Boolean),
    config.composition !== singleProjectServicesComposition ||
      hasSingleProjectServicesTopology(config),
    config.standardRuntime === undefined ||
      [
        config.composition === singleProjectServicesComposition,
        config.standardRuntime.publicRealmWorkload.projectId === config.gateway.projectId,
        config.standardRuntime.publicRealmWorkload.ownerId === config.teamId,
      ].every(Boolean),
    config.standardRuntime === undefined ||
      [
        config.composition === singleProjectServicesComposition,
        config.standardRuntime.publicRealmWorkload.projectId === config.gateway.projectId,
        config.standardRuntime.publicRealmWorkload.ownerId === config.teamId,
      ].every(Boolean),
    config.composition !== singleProjectServicesComposition ||
      hasSingleProjectServicesTopology(config),
  ].every(Boolean);
  if (!ownedConfiguration) {
    throw new Error("Protected operator deployment configuration is unavailable.");
  }
  return config;
};
