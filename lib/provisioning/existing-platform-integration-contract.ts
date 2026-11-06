import { createHash } from "node:crypto";
import { z } from "zod";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";

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
  branchId: id,
  endpointId: id,
  projectId: id,
  source: z.literal("synthetic-only"),
});
/** Central readiness family v2; this existing-platform reference protocol retains its v1 kind. */
export const existingPlatformIntegrationReadySchema = z.strictObject({
  activation: z.strictObject({
    keyId: id,
    publicKeyPem: z.string().startsWith("-----BEGIN PUBLIC KEY-----"),
    publicKeySha256: digest,
  }),
  authority: hostedTenantAuthoritySchema,
  caller: z.strictObject({
    environment: z.literal("production"),
    ownerId: id,
    projectId: id,
    trustedSourcesGrantSha256: digest,
  }),
  composition: z.literal("single-project-services"),
  control: z.strictObject({
    centralRuntimeRole: role,
    neon,
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
    schemaSha256: digest,
  }),
  dataEnvironment: z.literal("dedicated-development"),
  deployment: z.strictObject({
    configurationRef: id,
    configurationSha256: digest,
    environment: z.enum(["preview", "production"]),
    immutableOrigin: origin,
    installationId: id,
    projectId: id,
    providerDeploymentId: id,
    serviceId: z.literal("integrations"),
    teamId: id,
  }),
  kind: z.literal("existing-platform-integrations-ready-v1"),
  profile: z.strictObject({ digest, id }),
  provider: z.strictObject({
    authorizationOrigins: z.array(origin).min(1),
    integrationId: id,
    kind: z.literal("quickbooksSandbox"),
    payloadHosts: z.array(id).min(1),
    projectId: id,
  }),
  providerEnvironment: z.literal("development"),
  referenceId: id,
  repositoryId: id,
  resourceCustody: z.strictObject({ receiptDigest: digest, receiptRef: id }),
  resourceProfileId: id,
  version: z.literal(2),
});
/** Supplied only by the real owner-scoped custody reader plus independent resource readback. */
export const existingPlatformControlResourceProofSchema = z.strictObject({
  authority: hostedTenantAuthoritySchema,
  centralRuntimeRole: role,
  custody: z.strictObject({ receiptDigest: digest, receiptRef: id }),
  dataEnvironment: z.literal("dedicated-development"),
  database: sqlName,
  hostname: z.string().regex(/^[a-z0-9.-]+\.neon\.tech$/u),
  migratorRole: role,
  neon,
  resourceId: id,
  resourceProfileId: id,
  schemaSha256: digest,
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
  dataEnvironment: z.literal("dedicated-development"),
  hostingEnvironment: z.enum(["preview", "production"]),
  kind: z.literal("existing-platform-integrations-reference-v1"),
  projectId: z.string().min(1),
  providerDeploymentId: z.string().min(1),
  providerEnvironment: z.literal("development"),
  referenceId: z.string().min(1),
  sha256: digest,
  teamId: z.string().min(1),
  trustedSourcesGrantSha256: digest,
});
export const existingPlatformIntegrationPlanReference = (ready: ExistingPlatformIntegrationReady) =>
  existingPlatformIntegrationPlanReferenceSchema.parse({
    dataEnvironment: ready.dataEnvironment,
    hostingEnvironment: ready.deployment.environment,
    kind: "existing-platform-integrations-reference-v1",
    projectId: ready.deployment.projectId,
    providerDeploymentId: ready.deployment.providerDeploymentId,
    providerEnvironment: ready.providerEnvironment,
    referenceId: ready.referenceId,
    sha256: existingPlatformIntegrationReferenceDigest(ready),
    teamId: ready.deployment.teamId,
    trustedSourcesGrantSha256: ready.caller.trustedSourcesGrantSha256,
  });
