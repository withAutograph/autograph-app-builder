import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import type { VercelTokenKeyringConfig } from "../integrations/vercel-installation";
import {
  HostedOperatorError,
  operatorPlanDigest,
  operatorAuthSchemaPreparationSchema,
  sharedAuthAdoptionSchema,
  sameOperatorSelection,
} from "./hosted-operator-contract";
import type {
  HostedOperatorPlan,
  OperatorAuthSchemaPreparation,
  SharedAuthAdoption,
} from "./hosted-operator-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";
import { hostedRuntimeIdentity } from "./hosted-runtime-journal";
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
const adoptionBundleSchema = bundleSchema.extend({
  adoption: sharedAuthAdoptionSchema,
  state: z.literal("pending-shared-auth-verification"),
  version: z.literal(2),
});
const createCredentials = () => ({
  migratorPassword: randomBytes(32).toString("base64url"),
  runtimePassword: randomBytes(32).toString("base64url"),
});

export type ProtectedResourceDatabase = "appDatabase" | "authDatabase";

export type ResourceCredentialInput = HostedOperatorContext & {
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
  if (input.plan.authAdoption !== undefined) {
    throw new HostedOperatorError("reconciliation_required");
  }
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
  if (input.plan.authAdoption !== undefined) {
    throw new HostedOperatorError("reconciliation_required");
  }
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

/** Non-secret approval input. Journal state is evidence of prior work, not hosted readback. */
export const describeHostedOperatorSharedAuth = (
  input: ResourceCredentialInput,
): SharedAuthAdoption => {
  const { record, plan } = input;
  const { operator } = record;
  const preparation = operator?.authPreparation;
  if (operator === undefined || preparation === undefined || record.privateState === undefined) {
    throw new HostedOperatorError("reconciliation_required");
  }
  const complete =
    operator !== undefined &&
    plan.effects.every((effect) =>
      operator.receipts.some(
        (receipt) =>
          receipt.effectId === effect.id &&
          (effect.kind !== "access" || receipt.fenceGeneration === operator.fenceGeneration),
      ),
    );
  const ready = [
    record.status === "prepared" && record.step === "bound",
    record.status === "pending" && record.step === "reserved" && plan.stage === "auth-bootstrap",
  ].some(Boolean);
  const invalidSource = [
    !ready,
    !complete,
    operator === undefined,
    preparation === undefined,
    record.privateState === undefined,
    operator.approvalId === undefined,
    operator.fenceGeneration === undefined,
    record.leaseId !== undefined,
    record.leaseExpiresAt !== undefined,
    operator.pendingEffectId !== undefined,
    operator.pendingEffectAttempt !== undefined,
    plan.action !== "prepare",
    !isDeepStrictEqual(record.request, input.target),
    !sameOperatorSelection(plan.selection, input.target),
    !isDeepStrictEqual(operator.plan, plan),
    operator.planDigest !== operatorPlanDigest(plan),
    preparation.database !== plan.authDatabase.database,
    preparation.runtimeRole !== plan.authDatabase.runtimeRole,
    preparation.targetDigest !== plan.authSchema?.targetDigest,
  ].some(Boolean);
  if (invalidSource) {
    throw new HostedOperatorError("reconciliation_required");
  }
  // Validate existing ciphertext and its full original identity without weakening v1 matching.
  const bundle = readMatchingBundle(input);
  const { appDatabase: _app, appId: _appId, ...resource } = bundle.identity;
  void _app;
  void _appId;
  return sharedAuthAdoptionSchema.parse({
    kind: "owned-journal-auth-v1",
    resource,
    source: {
      checkpointSha256: createHash("sha256")
        .update(JSON.stringify(record.privateState))
        .digest("hex"),
      journalDigest: hostedRuntimeIdentity(input.authority, input.target).digest,
      operationRef: operator.operationRef,
      planDigest: operator.planDigest,
      selection: plan.selection,
    },
  });
};

const assertAdoptionTarget = (
  source: ResourceCredentialInput,
  target: ResourceCredentialInput,
  adoption: SharedAuthAdoption,
) => {
  const incompatible = [
    !isDeepStrictEqual(source.authority, target.authority),
    source.target.installationId !== target.target.installationId,
    source.target.scopeId !== target.target.scopeId,
    source.target.scopeType !== target.target.scopeType,
    source.target.appId === target.target.appId,
    !isDeepStrictEqual(target.plan.authAdoption, adoption),
    target.plan.action !== "prepare",
    !isDeepStrictEqual(target.record.request, target.target),
    !sameOperatorSelection(target.plan.selection, target.target),
    target.plan.authSchema?.planDigest !== source.plan.authSchema?.planDigest,
    target.plan.authSchema?.targetDigest !== source.plan.authSchema?.targetDigest,
    !isDeepStrictEqual(target.plan.authSchema?.installer, source.plan.authSchema?.installer),
  ].some(Boolean);
  if (incompatible) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const identity = resourceIdentity(target.plan);
  const { appDatabase: _app, appId: _appId, ...physical } = identity;
  void _app;
  void _appId;
  if (!isDeepStrictEqual(physical, adoption.resource)) {
    throw new HostedOperatorError("resource_mismatch");
  }
  return identity;
};

/**
 * Seal only Auth credentials into the target's existing journal encryption boundary.
 * No plaintext or connection URL is returned. v2 remains unusable by every worker/binding
 * reader until read-only Auth and shared Gateway adoption have been integrated.
 */
export const sealHostedOperatorSharedAuth = (input: {
  source: ResourceCredentialInput;
  target: ResourceCredentialInput;
}) => {
  const { source, target } = input;
  const adoption = describeHostedOperatorSharedAuth(source);
  const identity = assertAdoptionTarget(source, target, adoption);
  const sourceBundle = readMatchingBundle(source);
  const originalApp = sourceBundle.identity.appDatabase;
  if (
    identity.appDatabase.database === originalApp.database ||
    identity.appDatabase.resourceId === originalApp.resourceId ||
    [identity.appDatabase.migratorRole, identity.appDatabase.runtimeRole].some((role) =>
      [originalApp.migratorRole, originalApp.runtimeRole].includes(role),
    )
  ) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const files = decryptHostedRuntimeFiles(target);
  if (files !== undefined) {
    const parsed =
      Object.keys(files).length === 1 && files[fileName] !== undefined
        ? adoptionBundleSchema.safeParse(JSON.parse(files[fileName]))
        : undefined;
    if (parsed?.success !== true || target.record.privateState === undefined) {
      throw new HostedOperatorError("resource_mismatch");
    }
    if (
      !isDeepStrictEqual(parsed.data.identity, identity) ||
      !isDeepStrictEqual(parsed.data.adoption, adoption) ||
      !isDeepStrictEqual(parsed.data.authDatabase, sourceBundle.authDatabase)
    ) {
      throw new HostedOperatorError("resource_mismatch");
    }
    return target.record.privateState;
  }
  const uncertainTarget = [
    target.record.operator === undefined,
    target.record.operator?.receipts.length !== 0,
    target.record.operator?.pendingEffectId !== undefined,
    target.record.operator?.pendingEffectAttempt !== undefined,
    (target.record.operator?.workerCheckpoints?.length ?? 0) !== 0,
  ].some(Boolean);
  if (uncertainTarget) {
    throw new HostedOperatorError("reconciliation_required");
  }
  const bundle = adoptionBundleSchema.parse({
    adoption,
    appDatabase: createCredentials(),
    authDatabase: sourceBundle.authDatabase,
    identity,
    state: "pending-shared-auth-verification",
    version: 2,
  });
  return encryptHostedRuntimeFiles({ ...target, files: { [fileName]: JSON.stringify(bundle) } });
};

/** Trusted control-plane port. Its URL is never a worker, artifact, tool or return value. */
export type SharedAuthReadinessVerifier = (
  input: HostedOperatorContext & {
    assertCurrent: () => Promise<void>;
    plan: HostedOperatorPlan;
    runtimeUrl: string;
  },
) => Promise<OperatorAuthSchemaPreparation>;

/** Read pending Auth runtime metadata without releasing either password pair to general readers. */
export const verifyPendingHostedOperatorSharedAuth = async (input: {
  source: ResourceCredentialInput;
  target: ResourceCredentialInput;
  assertCurrent: () => Promise<void>;
  verifyReadiness: SharedAuthReadinessVerifier;
}): Promise<OperatorAuthSchemaPreparation> => {
  const source = { ...structuredClone(input.source), config: input.source.config };
  const target = { ...structuredClone(input.target), config: input.target.config };
  if (target.record.privateState === undefined) {
    throw new HostedOperatorError("reconciliation_required");
  }
  // Existing checkpoint only: never generate replacements during verification/retry.
  const checkpoint = sealHostedOperatorSharedAuth({ source, target });
  if (!isDeepStrictEqual(checkpoint, target.record.privateState)) {
    throw new HostedOperatorError("reconciliation_required");
  }
  const files = decryptHostedRuntimeFiles(target);
  if (files === undefined || files[fileName] === undefined) {
    throw new HostedOperatorError("reconciliation_required");
  }
  const bundle = adoptionBundleSchema.parse(JSON.parse(files[fileName]));
  const saved = operatorAuthSchemaPreparationSchema.parse(source.record.operator?.authPreparation);
  await input.assertCurrent();
  let proof: OperatorAuthSchemaPreparation;
  try {
    proof = operatorAuthSchemaPreparationSchema.parse(
      await input.verifyReadiness({
        assertCurrent: input.assertCurrent,
        authority: target.authority,
        ownerContext: target.ownerContext,
        plan: target.plan,
        runtimeUrl: directDatabaseUrl({
          database: bundle.identity.authDatabase.database,
          hostname: bundle.identity.endpoint,
          password: bundle.authDatabase.runtimePassword,
          role: bundle.identity.authDatabase.runtimeRole,
        }),
        target: target.target,
      }),
    );
  } catch {
    // A database/port exception can contain the connection URL; never forward it.
    throw new HostedOperatorError("operator_unavailable");
  }
  await input.assertCurrent();
  const mismatched = [
    proof.targetDigest !== saved.targetDigest,
    proof.assetSha256 !== saved.assetSha256,
    proof.catalogFingerprint !== saved.catalogFingerprint,
    proof.database !== saved.database,
    proof.runtimeRole !== saved.runtimeRole,
  ].some(Boolean);
  if (mismatched) {
    throw new HostedOperatorError("resource_mismatch");
  }
  return proof;
};
