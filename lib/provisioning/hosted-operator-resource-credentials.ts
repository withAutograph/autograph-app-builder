import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

import type { VercelTokenKeyringConfig } from "../integrations/vercel-installation";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";
import { decryptHostedRuntimeFiles, encryptHostedRuntimeFiles } from "./hosted-runtime-service";

const fileName = "protected-resource-credentials.json";
const password = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
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

/** Private control-plane helper; this is never a public tool or model input. */
export const prepareHostedOperatorResourceCredentials = (
  input: HostedOperatorContext & {
    config: VercelTokenKeyringConfig;
    database: ProtectedResourceDatabase;
    plan: HostedOperatorPlan;
    record: HostedRuntimeJournalRecord;
  },
) => {
  const identity = identitySchema.parse({
    appDatabase: input.plan.appDatabase,
    appId: input.plan.selection.appId,
    authDatabase: input.plan.authDatabase,
    branchId: input.plan.neon.branchId,
    endpoint: input.plan.neon.endpoint,
    endpointId: input.plan.bootstrap?.endpointId,
    projectId: input.plan.neon.projectId,
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
    if (Object.keys(files).length !== 1 || files[fileName] === undefined) {
      throw new Error("Protected resource credential checkpoint is incompatible.");
    }
    bundle = bundleSchema.parse(JSON.parse(files[fileName]));
    if (JSON.stringify(bundle.identity) !== JSON.stringify(identity)) {
      throw new Error("Protected resource credential checkpoint belongs to different resources.");
    }
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
