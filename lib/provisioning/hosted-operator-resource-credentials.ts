import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

import type { VercelTokenKeyringConfig } from "../integrations/vercel-installation";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";
import { decryptHostedRuntimeFiles, encryptHostedRuntimeFiles } from "./hosted-runtime-service";

const fileName = "protected-resource-credentials.json";
const password = z
  .string()
  .min(32)
  .max(512)
  .refine((value) => !/[\0\r\n]/u.test(value));
const credentialsSchema = z.strictObject({ migratorPassword: password, runtimePassword: password });
const resourceSchema = z.strictObject({
  database: z.string(),
  migratorRole: z.string(),
  resourceId: z.string(),
  runtimeRole: z.string(),
});
const identitySchema = z.strictObject({
  appDatabase: resourceSchema,
  appId: z.string(),
  authDatabase: resourceSchema,
  branchId: z.string(),
  endpoint: z.string(),
  endpointId: z.string(),
  projectId: z.string(),
});
const bundleSchema = z.strictObject({
  appDatabase: credentialsSchema,
  authDatabase: credentialsSchema,
  identity: identitySchema,
  version: z.literal(1),
});
const createCredentials = () => ({
  migratorPassword: randomBytes(32).toString("base64url"),
  runtimePassword: randomBytes(32).toString("base64url"),
});

export type ProtectedResourceDatabase = "appDatabase" | "authDatabase";

type ResourceCredentialInput = HostedOperatorContext & {
  config: VercelTokenKeyringConfig;
  plan: HostedOperatorPlan;
  record: HostedRuntimeJournalRecord;
};

const resourceIdentity = (plan: HostedOperatorPlan) => {
  const identity = identitySchema.parse({
    appDatabase: plan.appDatabase,
    appId: plan.selection.appId,
    authDatabase: plan.authDatabase,
    branchId: plan.neon.branchId,
    endpoint: plan.neon.endpoint,
    endpointId: plan.bootstrap?.endpointId,
    projectId: plan.neon.projectId,
  });
  if (
    identity.appDatabase.resourceId === identity.authDatabase.resourceId ||
    identity.appDatabase.database === identity.authDatabase.database ||
    new Set([
      identity.appDatabase.migratorRole,
      identity.appDatabase.runtimeRole,
      identity.authDatabase.migratorRole,
      identity.authDatabase.runtimeRole,
    ]).size !== 4
  ) {
    throw new Error("Protected resources must have separate database and role identities.");
  }
  return identity;
};

const readMatchingBundle = (input: ResourceCredentialInput) => {
  const identity = resourceIdentity(input.plan);
  const files = decryptHostedRuntimeFiles(input);
  if (files === undefined) {
    throw new Error("Protected resource credential checkpoint is unavailable.");
  }
  if (Object.keys(files).length !== 1 || files[fileName] === undefined) {
    throw new Error("Protected resource credential checkpoint is incompatible.");
  }
  const bundle = bundleSchema.parse(JSON.parse(files[fileName]));
  if (JSON.stringify(bundle.identity) !== JSON.stringify(identity)) {
    throw new Error("Protected resource credential checkpoint belongs to different resources.");
  }
  return bundle;
};

const directDatabaseUrl = (input: {
  database: string;
  hostname: string;
  password: string;
  role: string;
}) => {
  const url = new URL(`postgresql://${input.hostname}:5432/`);
  url.username = encodeURIComponent(input.role);
  url.password = encodeURIComponent(input.password);
  url.pathname = `/${encodeURIComponent(input.database)}`;
  url.searchParams.set("sslmode", "verify-full");
  return url.toString();
};

/** Read only: absent or incompatible owned credentials never generate replacements. */
export const readHostedOperatorResourceBindings = (input: ResourceCredentialInput) => {
  const bundle = readMatchingBundle(input);
  const bindings = (database: ProtectedResourceDatabase) => {
    const resource = input.plan[database];
    const credentials = bundle[database];
    return {
      migrationUrl: directDatabaseUrl({
        database: resource.database,
        hostname: input.plan.neon.endpoint,
        password: credentials.migratorPassword,
        role: resource.migratorRole,
      }),
      runtimeUrl: directDatabaseUrl({
        database: resource.database,
        hostname: input.plan.neon.endpoint,
        password: credentials.runtimePassword,
        role: resource.runtimeRole,
      }),
    };
  };
  return { appDatabase: bindings("appDatabase"), authDatabase: bindings("authDatabase") };
};

/** Private control-plane helper; this is never a public tool or model input. */
export const prepareHostedOperatorResourceCredentials = (
  input: HostedOperatorContext & {
    config: VercelTokenKeyringConfig;
    database: ProtectedResourceDatabase;
    plan: HostedOperatorPlan;
    record: HostedRuntimeJournalRecord;
  },
) => {
  const identity = resourceIdentity(input.plan);
  const files = decryptHostedRuntimeFiles(input);
  let bundle: z.infer<typeof bundleSchema>;
  let { privateState } = input.record;
  if (files === undefined) {
    bundle = bundleSchema.parse({
      appDatabase: createCredentials(),
      authDatabase: createCredentials(),
      identity,
      version: 1,
    });
    privateState = encryptHostedRuntimeFiles({
      ...input,
      files: { [fileName]: JSON.stringify(bundle) },
    });
  } else {
    bundle = readMatchingBundle(input);
  }
  if (privateState === undefined) {
    throw new Error("Protected resource credential checkpoint is unavailable.");
  }
  // Keep wire ordering aligned with the fixed bootstrap worker's canonical schema.
  const selected = bundle[input.database];
  const credentialsBytes = JSON.stringify({
    migratorPassword: selected.migratorPassword,
    runtimePassword: selected.runtimePassword,
  });
  return {
    credentialsBytes,
    credentialsSha256: createHash("sha256").update(credentialsBytes).digest("hex"),
    privateState,
  };
};
