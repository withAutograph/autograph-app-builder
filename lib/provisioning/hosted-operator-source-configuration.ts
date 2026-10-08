import { z } from "zod";
import { configurationSchema, scopeSchema } from "./hosted-operator-native-preview-neon";
import { createHostedOperatorControlPlane } from "./hosted-operator-deployment";
import { createOperatorWorkloadVerifier } from "./hosted-operator-workload";
import type { OperatorWorkloadPolicy } from "./hosted-operator-workload";

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
const worker = z.strictObject({
  executablePath: id,
  id,
  operationScope: z.enum([
    "generated-app-release-install-v1",
    "generated-app-access-v1",
    "auth-protected-schema-v1",
    "auth-protected-membership-v1",
    "neon-resource-bootstrap-v1",
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
export const hostedOperatorSourceConfigurationSchema = z.strictObject({
  applications: z.record(
    id,
    z.strictObject({
      accessRoles: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u)).min(1),
      appDatabase: resource,
      branch: id,
      deploymentId: id,
      gitSha: z.string().regex(/^[a-f0-9]{40}$/u),
      organizationProposal: z.strictObject({ name: id, organizationId: id, slug: id }).optional(),
      projectId: id,
      repoId: id,
    }),
  ),
  authDatabase: resource,
  builderCallbackOrigin: httpsOrigin,
  catalogAppIds: z.array(id).min(1),
  gateway: z.strictObject({
    authBrowserOrigin: httpsOrigin,
    branch: id,
    deploymentId: id,
    environment: z.literal("preview"),
    gatewayOrigin: httpsOrigin,
    gitSha: z.string().regex(/^[a-f0-9]{40}$/u),
    projectId: id,
    protectedApplicationIds: z.array(id),
    publicOrigin: httpsOrigin,
    repoId: id,
  }),
  nativeNeon: z.strictObject({
    configuration: configurationSchema.omit({ connectorInstallationId: true }),
    scope: scopeSchema,
  }),
  operator: z.strictObject({
    deploymentId: id,
    environment: z.literal("preview"),
    origin: httpsOrigin,
    projectId: id,
  }),
  sandbox: z.strictObject({
    accessWorker: worker,
    authProposal: z.strictObject({ executablePath: id, id, sha256: digest }),
    authWorker: worker,
    image: id,
    membershipWorker: worker.optional(),
    projectId: id,
    resourcesWorker: worker,
    teamId: id,
    workers: z.record(id, worker),
  }),
  teamId: id,
  workloadPolicy: workload,
});
export type HostedOperatorSourceConfiguration = z.infer<
  typeof hostedOperatorSourceConfigurationSchema
>;

/** Deployment-owned exact configuration. Missing setup is unavailable; no default project, role, source or grant is invented. */
export const readHostedOperatorSourceConfiguration = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => {
  const text = environment.PROTECTED_HOSTED_OPERATOR_CONFIGURATION;
  if (text === undefined || text === "") {
    throw new Error("Protected operator deployment configuration is unavailable.");
  }
  const config = hostedOperatorSourceConfigurationSchema.parse(JSON.parse(text));
  createOperatorWorkloadVerifier(config.workloadPolicy);
  const ownedConfiguration = [
    config.operator.projectId === config.nativeNeon.configuration.operator.projectId,
    config.teamId === config.nativeNeon.configuration.operator.ownerId,
    config.operator.environment === config.nativeNeon.configuration.operator.environment,
    Object.values(config.applications).every(
      (app) =>
        app.projectId !== config.operator.projectId && app.projectId !== config.gateway.projectId,
    ),
    config.sandbox.projectId === config.operator.projectId,
    config.sandbox.teamId === config.teamId,
    new Set([config.operator.projectId, config.gateway.projectId]).size === 2,
  ].every(Boolean);
  if (!ownedConfiguration) {
    throw new Error("Protected operator deployment configuration is unavailable.");
  }
  return config;
};

/** Real reusable control plane for native operator composition and the owner-authenticated callback. */
export const openHostedOperatorCompositionResources = async (
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => {
  const configuration = readHostedOperatorSourceConfiguration(environment);
  const controlPlane = await createHostedOperatorControlPlane({
    environment,
    workloadPolicy: configuration.workloadPolicy satisfies OperatorWorkloadPolicy,
  });
  return { configuration, controlPlane };
};
