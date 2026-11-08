import { createHash } from "node:crypto";
import { z } from "zod";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";

const DEDICATED_DEVELOPMENT_ENVIRONMENT = "dedicated-development";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
/** Existing infrastructure selection is not a central-host setup approval. */
const id = z.string().min(1);
const sqlName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u);
const role = sqlName.refine((value) => !["postgres", "neondb_owner"].includes(value));
const origin = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
});
const neon = z.strictObject({
  projectId: id,
  branchId: id,
  endpointId: id,
  source: z.literal("synthetic-only"),
});
/** Central readiness family v2; this existing-platform reference protocol retains its v1 kind. */
export const existingPlatformIntegrationReadySchema = z.strictObject({
  version: z.literal(2),
  kind: z.literal("existing-platform-integrations-ready-v1"),
  authority: hostedTenantAuthoritySchema,
  referenceId: id,
  composition: z.literal("single-project-services"),
  providerEnvironment: z.literal("development"),
  dataEnvironment: z.literal(DEDICATED_DEVELOPMENT_ENVIRONMENT),
  repositoryId: id,
  profile: z.strictObject({ id, digest }),
  resourceProfileId: id,
  resourceCustody: z.strictObject({ receiptRef: id, receiptDigest: digest }),
  control: z.strictObject({
    resource: z.strictObject({
      resourceId: id,
      // Historical restricted-resource isolation marker; hosting is deployment.environment below.
      environment: z.literal("preview"),
      hostname: z.string().regex(/^[a-z0-9.-]+\.neon\.tech$/u),
      port: z.literal(5432),
      database: sqlName,
      schema: z.literal("public"),
      migratorRole: role,
    }),
    centralRuntimeRole: role,
    neon,
    schemaSha256: digest,
  }),
  activation: z.strictObject({
    keyId: id,
    publicKeyPem: z.string().startsWith("-----BEGIN PUBLIC KEY-----"),
    publicKeySha256: digest,
  }),
  provider: z.strictObject({
    kind: z.literal("quickbooksSandbox"),
    projectId: id,
    integrationId: id,
    authorizationOrigins: z.array(origin).min(1),
    payloadHosts: z.array(id).min(1),
  }),
  deployment: z.strictObject({
    projectId: id,
    teamId: id,
    installationId: id,
    environment: z.enum(["preview", "production"]),
    serviceId: z.literal("integrations"),
    providerDeploymentId: id,
    immutableOrigin: origin,
    configurationRef: id,
    configurationSha256: digest,
  }),
  caller: z.strictObject({
    projectId: id,
    ownerId: id,
    environment: z.literal("production"),
    trustedSourcesGrantSha256: digest,
  }),
});
/** Supplied only by the real owner-scoped custody reader plus independent resource readback. */
export const existingPlatformControlResourceProofSchema = z.strictObject({
  authority: hostedTenantAuthoritySchema,
  custody: z.strictObject({ receiptRef: id, receiptDigest: digest }),
  resourceProfileId: id,
  resourceId: id,
  neon,
  hostname: z.string().regex(/^[a-z0-9.-]+\.neon\.tech$/u),
  database: sqlName,
  migratorRole: role,
  centralRuntimeRole: role,
  schemaSha256: digest,
  dataEnvironment: z.literal(DEDICATED_DEVELOPMENT_ENVIRONMENT),
});
export type ExistingPlatformControlResourceProof = z.infer<
  typeof existingPlatformControlResourceProofSchema
>;
/** Shared platform selection contains no caller/app identity. Those come from current Builder receipts. */
export const existingPlatformIntegrationSelectionSchema =
  existingPlatformIntegrationReadySchema.omit({ authority: true, caller: true });
export const existingPlatformIntegrationSelectionDigest = (
  value: z.infer<typeof existingPlatformIntegrationSelectionSchema>,
) =>
  createHash("sha256")
    .update(JSON.stringify(existingPlatformIntegrationSelectionSchema.parse(value)))
    .digest("hex");
export type ExistingPlatformIntegrationSelection = z.infer<
  typeof existingPlatformIntegrationSelectionSchema
>;
export type ExistingPlatformIntegrationReady = z.infer<
  typeof existingPlatformIntegrationReadySchema
>;
export const existingPlatformIntegrationReferenceDigest = (
  value: ExistingPlatformIntegrationReady,
) =>
  createHash("sha256")
    .update(JSON.stringify(existingPlatformIntegrationReadySchema.parse(value)))
    .digest("hex");
export const existingPlatformIntegrationPlanReferenceSchema = z.strictObject({
  kind: z.literal("existing-platform-integrations-reference-v1"),
  referenceId: z.string().min(1),
  sha256: digest,
  projectId: z.string().min(1),
  teamId: z.string().min(1),
  providerDeploymentId: z.string().min(1),
  hostingEnvironment: z.enum(["preview", "production"]),
  providerEnvironment: z.literal("development"),
  dataEnvironment: z.literal(DEDICATED_DEVELOPMENT_ENVIRONMENT),
  trustedSourcesGrantSha256: digest,
});
export const existingPlatformIntegrationPlanReference = (ready: ExistingPlatformIntegrationReady) =>
  existingPlatformIntegrationPlanReferenceSchema.parse({
    kind: "existing-platform-integrations-reference-v1",
    referenceId: ready.referenceId,
    sha256: existingPlatformIntegrationReferenceDigest(ready),
    projectId: ready.deployment.projectId,
    teamId: ready.deployment.teamId,
    providerDeploymentId: ready.deployment.providerDeploymentId,
    hostingEnvironment: ready.deployment.environment,
    providerEnvironment: ready.providerEnvironment,
    dataEnvironment: ready.dataEnvironment,
    trustedSourcesGrantSha256: ready.caller.trustedSourcesGrantSha256,
  });
