/* oxlint-disable sonarjs/expression-complexity -- The explicit credential endpoint, role, TLS and isolation tuple is verified together before custody. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import {
  centralHostCanonicalBytes,
  centralHostSetupPlanSchema,
} from "./central-integration-host-contract";
import {
  createCentralIntegrationPrivateCustody,
  centralIntegrationPrivateScopeSchema,
  centralIntegrationPrivateSeedSchema,
} from "./central-integration-private-custody";

const id = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sqlName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u);
const inspectorSchema = z.strictObject({
  issuer: z.string().regex(/^https:\/\/oidc\.vercel\.com(?:\/[A-Za-z0-9_-]+)?$/u),
  audience: z.url().startsWith("https://vercel.com/"),
  subject: id,
  ownerId: id,
  projectId: id,
  environment: z.enum(["preview", "production"]),
});
const sourceSchema = centralHostSetupPlanSchema.shape.source
  .omit({
    operationBranch: true,
    expectedBranchAbsent: true,
    configurationRef: true,
    configurationSha256: true,
  })
  .extend({
    sourceBranch: id,
    deploymentProfile: z.literal("isolated-central-integrations-v1"),
    buildReceiptSha256: digest,
  })
  .refine(
    (source) => JSON.stringify(source.serviceIds) === JSON.stringify(["gateway", "integrations"]),
    { message: "The central source must contain exactly Gateway and Integrations" },
  );
export const centralIntegrationPrivateProfileSchema = z
  .strictObject({
    version: z.literal(1),
    id,
    resourceProfileId: id,
    owners: z.array(hostedTenantAuthoritySchema).min(1),
    isolation: z.literal("dedicated-development"),
    target: centralHostSetupPlanSchema.shape.target,
    control: centralHostSetupPlanSchema.shape.control,
    provider: centralHostSetupPlanSchema.shape.provider,
    source: sourceSchema,
    inspector: inspectorSchema,
    receiver: centralHostSetupPlanSchema.shape.receiver.pick({ publicOrigin: true }),
    globalSetup: z
      .strictObject({
        authority: hostedTenantAuthoritySchema,
        operationRef: z.uuid(),
        planDigest: digest,
      })
      .optional(),
    private: z.strictObject({
      providerApiKey: id,
      providerWebhookSigningSecret: id,
      providerAppId: id.optional(),
      bootstrap: z.strictObject({
        connectionString: id,
        maintenanceDatabase: sqlName,
        bootstrapRole: sqlName,
        productionDatabaseIdentity: z.string().regex(/^[a-z0-9.-]+\.neon\.tech\/[a-zA-Z0-9_.-]+$/u),
      }),
    }),
  })
  .superRefine((profile, context) => {
    try {
      const credential = new URL(profile.private.bootstrap.connectionString);
      const host = credential.hostname.replace(/-pooler(?=\.)/u, "");
      const resource = profile.control.resource;
      const productionHost = profile.private.bootstrap.productionDatabaseIdentity
        .split("/")[0]
        ?.replace(/-pooler(?=\.)/u, "");
      if (
        !["postgres:", "postgresql:"].includes(credential.protocol) ||
        credential.hostname !== resource.hostname ||
        host !== credential.hostname ||
        credential.port !== "5432" ||
        credential.searchParams.getAll("sslmode").length !== 1 ||
        credential.searchParams.get("sslmode") !== "verify-full" ||
        [...credential.searchParams.keys()].some(
          (key) => key !== "sslmode" && key !== "channel_binding",
        ) ||
        credential.searchParams.getAll("channel_binding").length > 1 ||
        (credential.searchParams.has("channel_binding") &&
          credential.searchParams.get("channel_binding") !== "require") ||
        credential.hash !== "" ||
        decodeURIComponent(credential.username) !== profile.private.bootstrap.bootstrapRole ||
        !credential.password ||
        decodeURIComponent(credential.pathname.slice(1)) !==
          profile.private.bootstrap.maintenanceDatabase ||
        productionHost === host ||
        profile.inspector.ownerId !== profile.target.teamId ||
        !profile.source.serviceIds.includes(profile.target.serviceId)
      )
        throw new Error("scope");
    } catch {
      context.addIssue({
        code: "custom",
        message:
          "Central private configuration requires exact isolated resource, inspector and source scope.",
      });
    }
  });
export type CentralIntegrationPrivateProfile = z.infer<
  typeof centralIntegrationPrivateProfileSchema
>;
const unavailable = () => new Error("central_integration_private_profile_required");
/** Trusted deployment-only input. Missing credentials never fall back to a customer or ambient provider key. */
export const readCentralIntegrationPrivateProfile = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CentralIntegrationPrivateProfile => {
  try {
    return centralIntegrationPrivateProfileSchema.parse(
      JSON.parse(environment.HOSTED_CENTRAL_INTEGRATIONS_CONFIGURATION ?? "null"),
    );
  } catch {
    throw unavailable();
  }
};
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const centralIntegrationPrivateProfilePublicFacts = (
  raw: CentralIntegrationPrivateProfile,
) => {
  const profile = centralIntegrationPrivateProfileSchema.parse(raw);
  const { private: _credentials, globalSetup: _setup, ...facts } = profile;
  void _credentials;
  void _setup;
  return facts;
};
export const centralIntegrationPrivateProfileDigest = (profile: CentralIntegrationPrivateProfile) =>
  hash(centralHostCanonicalBytes(centralIntegrationPrivateProfilePublicFacts(profile)));
export const CENTRAL_PRIVATE_RUNTIME_KEYS = [
  "INTEGRATIONS_DATABASE_URL",
  "INTEGRATIONS_ACTIVATION_PRIVATE_KEY_PEM",
  "INTEGRATIONS_AMPERSAND_PROJECT_ID",
  "INTEGRATIONS_AMPERSAND_API_KEY",
  "INTEGRATIONS_AMPERSAND_PROVIDERS",
  "INTEGRATIONS_SETUP_PROOF_SECRET",
  "INTEGRATIONS_AMPERSAND_WEBHOOK_SIGNING_SECRET",
  "INTEGRATIONS_APPLICATION_AUTHORITY_KEYRING",
  "INTEGRATIONS_CONTROL_RESOURCE_PROFILE_ID",
  "INTEGRATIONS_CENTRAL_READINESS_INSPECTOR",
] as const;
export const centralPrivateRuntimeFingerprint = (values: Readonly<Record<string, string>>) =>
  hash(
    JSON.stringify(
      CENTRAL_PRIVATE_RUNTIME_KEYS.toSorted().map((key) => {
        const value = values[key];
        if (!value) throw unavailable();
        return [key, hash(value)];
      }),
    ),
  );
const environmentSchema = z.record(z.string(), z.string());
const configurationCheckpointSchema = z.strictObject({
  environment: environmentSchema,
  configurationSha256: digest,
  profileDigest: digest,
});
type CentralRuntimeInput = Omit<
  Parameters<typeof createCentralIntegrationPrivateCustody>[0],
  "scope"
> & {
  profile: CentralIntegrationPrivateProfile;
  authority: z.infer<typeof hostedTenantAuthoritySchema>;
};
const authorizeCentralCustody = async (input: CentralRuntimeInput) => {
  const profile = centralIntegrationPrivateProfileSchema.parse(input.profile);
  const authority = hostedTenantAuthoritySchema.parse(input.authority);
  if (!profile.owners.some((owner) => isDeepStrictEqual(owner, authority))) throw unavailable();
  await input.assertCurrent();
  const scope = centralIntegrationPrivateScopeSchema.parse({
    authority,
    profileId: profile.id,
    resourceProfileId: profile.resourceProfileId,
    target: profile.target,
    control: {
      resource: profile.control.resource,
      centralRuntimeRole: profile.control.centralRuntimeRole,
      neon: profile.control.neon,
    },
    provider: {
      kind: profile.provider.kind,
      projectId: profile.provider.projectId,
      integrationId: profile.provider.integrationId,
    },
  });
  const custody = createCentralIntegrationPrivateCustody({ ...input, scope });
  return { profile, scope, custody };
};
const centralConnections = (
  profile: CentralIntegrationPrivateProfile,
  seed: z.infer<typeof centralIntegrationPrivateSeedSchema>,
) => {
  const connection = (role: string, password: string) => {
    const url = new URL(
      `postgresql://${profile.control.resource.hostname}:5432/${profile.control.resource.database}`,
    );
    url.username = role;
    url.password = password;
    url.searchParams.set("sslmode", "verify-full");
    return url.toString();
  };
  return {
    migrator: connection(profile.control.resource.migratorRole, seed.migratorPassword),
    runtime: connection(profile.control.centralRuntimeRole, seed.runtimePassword),
  };
};
/** All output is server-private. Only the separate environment hashes/ref belong in a public plan. */
export const resolveCentralRuntimeConfiguration = async (input: CentralRuntimeInput) => {
  const { profile, scope, custody } = await authorizeCentralCustody(input);
  const seed = await custody.seed();
  const connections = centralConnections(profile, seed.value);
  const profileDigest = centralIntegrationPrivateProfileDigest(profile);
  const baseValues = {
    INTEGRATIONS_DATABASE_URL: connections.runtime,
    INTEGRATIONS_ACTIVATION_PRIVATE_KEY_PEM: seed.value.activation.privateKeyPem,
    INTEGRATIONS_AMPERSAND_PROJECT_ID: profile.provider.projectId,
    INTEGRATIONS_AMPERSAND_API_KEY: profile.private.providerApiKey,
    INTEGRATIONS_AMPERSAND_PROVIDERS: JSON.stringify({
      quickbooks: {
        provider: profile.provider.kind,
        authorizationOrigins: profile.provider.authorizationOrigins,
        ...(profile.private.providerAppId === undefined
          ? {}
          : { providerAppId: profile.private.providerAppId }),
      },
    }),
    INTEGRATIONS_SETUP_PROOF_SECRET: seed.value.setupProofSecret,
    INTEGRATIONS_AMPERSAND_WEBHOOK_SIGNING_SECRET: profile.private.providerWebhookSigningSecret,
    INTEGRATIONS_APPLICATION_AUTHORITY_KEYRING: JSON.stringify(seed.value.authorityKeyring),
    INTEGRATIONS_CONTROL_RESOURCE_PROFILE_ID: profile.resourceProfileId,
    INTEGRATIONS_CENTRAL_READINESS_INSPECTOR: JSON.stringify(profile.inspector),
  };
  const configurationSha256 = centralPrivateRuntimeFingerprint(baseValues);
  const checkpointIdentity = hash(
    centralHostCanonicalBytes({ configurationSha256, profileDigest }),
  );
  const configurationRef = custody.reference("runtime-configuration", checkpointIdentity);
  const values = {
    ...baseValues,
    AUTOGRAPH_DEPLOYMENT_PROFILE: profile.source.deploymentProfile,
    INTEGRATIONS_CENTRAL_CONFIGURATION: JSON.stringify({
      applicationIngress: "signed-app-development-v1",
      deploymentProfile: profile.source.deploymentProfile,
      profileId: profile.id,
      profileDigest,
      resourceProfileId: profile.resourceProfileId,
      configurationRef,
      configurationSha256,
      control: {
        hostname: profile.control.resource.hostname,
        port: 5432,
        database: profile.control.resource.database,
        schema: profile.control.resource.schema,
        runtimeRole: profile.control.centralRuntimeRole,
        neon: profile.control.neon,
        schemaSha256: profile.control.schemaSha256,
      },
      activation: {
        keyId: seed.value.activation.keyId,
        publicKeySha256: seed.value.activation.publicKeySha256,
      },
      deployment: {
        projectId: profile.target.projectId,
        teamId: profile.target.teamId,
        environment: "preview",
        serviceId: "integrations",
      },
    }),
  };
  const checkpoint = await custody.reserve("runtime-configuration", checkpointIdentity, () => ({
    environment: values,
    configurationSha256,
    profileDigest,
  }));
  const frozen = configurationCheckpointSchema.parse(checkpoint.value);
  if (
    frozen.configurationSha256 !== configurationSha256 ||
    frozen.profileDigest !== profileDigest ||
    !isDeepStrictEqual(frozen.environment, values)
  )
    throw new Error("central_integration_runtime_custody_conflict");
  await input.assertCurrent();
  return {
    scope,
    custody,
    configurationRef,
    configurationSha256,
    privateConfigurationSha256: checkpoint.sha256,
    environment: Object.entries(frozen.environment)
      .map(([key, value]) => ({ key, sha256: hash(value) }))
      .toSorted((a, b) => {
        if (a.key < b.key) {
          return -1;
        }
        if (a.key > b.key) {
          return 1;
        }
        return 0;
      }),
    values: frozen.environment,
    connections,
    activation: {
      keyId: seed.value.activation.keyId,
      publicKeyPem: seed.value.activation.publicKeyPem,
      publicKeySha256: seed.value.activation.publicKeySha256,
    },
    resourceCredentials: {
      migratorPassword: seed.value.migratorPassword,
      runtimePassword: seed.value.runtimePassword,
    },
  };
};

/** Frozen pending/reconciliation reader. Absence never generates a new seed or writes a checkpoint. */
export const readCentralRuntimeConfiguration = async (
  input: CentralRuntimeInput & {
    configurationRef: string;
    configurationSha256: string;
    profileDigest: string;
  },
) => {
  const { profile, scope, custody } = await authorizeCentralCustody(input);
  const expected = z
    .strictObject({
      configurationRef: z.uuid(),
      configurationSha256: digest,
      profileDigest: digest,
    })
    .parse({
      configurationRef: input.configurationRef,
      configurationSha256: input.configurationSha256,
      profileDigest: input.profileDigest,
    });
  const checkpointIdentity = hash(
    centralHostCanonicalBytes({
      configurationSha256: expected.configurationSha256,
      profileDigest: expected.profileDigest,
    }),
  );
  if (
    custody.reference("runtime-configuration", checkpointIdentity) !== expected.configurationRef
  ) {
    throw unavailable();
  }
  const checkpoint = await custody.read("runtime-configuration", checkpointIdentity);
  if (checkpoint === undefined) {
    return undefined;
  }
  const stored = configurationCheckpointSchema.parse(checkpoint.value);
  if (
    stored.configurationSha256 !== expected.configurationSha256 ||
    stored.profileDigest !== expected.profileDigest ||
    centralPrivateRuntimeFingerprint(stored.environment) !== expected.configurationSha256
  ) {
    throw unavailable();
  }
  const seedCheckpoint = await custody.read("central-seed", "stable-v1");
  if (seedCheckpoint === undefined) {
    throw unavailable();
  }
  const seed = centralIntegrationPrivateSeedSchema.parse(seedCheckpoint.value);
  const connections = centralConnections(profile, seed);
  const manifest = z
    .object({ configurationRef: z.string(), configurationSha256: digest, profileDigest: digest })
    .parse(JSON.parse(stored.environment.INTEGRATIONS_CENTRAL_CONFIGURATION ?? "null"));
  if (
    !isDeepStrictEqual(manifest, expected) ||
    stored.environment.INTEGRATIONS_DATABASE_URL !== connections.runtime ||
    stored.environment.INTEGRATIONS_ACTIVATION_PRIVATE_KEY_PEM !== seed.activation.privateKeyPem
  ) {
    throw unavailable();
  }
  await input.assertCurrent();
  return {
    scope,
    custody,
    configurationRef: expected.configurationRef,
    configurationSha256: expected.configurationSha256,
    privateConfigurationSha256: checkpoint.sha256,
    values: stored.environment,
    connections,
    activation: {
      keyId: seed.activation.keyId,
      publicKeyPem: seed.activation.publicKeyPem,
      publicKeySha256: seed.activation.publicKeySha256,
    },
    resourceCredentials: {
      migratorPassword: seed.migratorPassword,
      runtimePassword: seed.runtimePassword,
    },
  };
};
