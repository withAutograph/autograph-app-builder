import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import type { VercelTokenKeyringConfig } from "../integrations/vercel-installation";
import {
  HostedOperatorError,
  operatorPlanDigest,
  canonicalGatewayEnvironmentRowsSchema,
  operatorAuthSchemaPreparationSchema,
  sharedAuthAdoptionSchema,
  sameOperatorSelection,
} from "./hosted-operator-contract";
import type {
  HostedOperatorPlan,
  ManagedOperatorEnvironmentRow,
  OperatorAuthSchemaPreparation,
  SharedAuthAdoption,
} from "./hosted-operator-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";
import { hostedRuntimeIdentity } from "./hosted-runtime-journal";
import { decryptHostedRuntimeFiles, encryptHostedRuntimeFiles } from "./hosted-runtime-service";
import {
  assertHostedOperatorSharedGateway,
  describeHostedOperatorSharedGateway,
} from "./hosted-operator-shared-gateway";

const fileName = "protected-resource-credentials.json";
const pendingAdoptionState = "pending-shared-auth-verification";
const activeAdoptionState = "active-shared-auth";
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
  state: z.literal(pendingAdoptionState),
  version: z.literal(2),
});
const activeAdoptionBundleSchema = adoptionBundleSchema.extend({
  state: z.literal(activeAdoptionState),
  verification: z.strictObject({
    authPreparation: operatorAuthSchemaPreparationSchema,
    gatewayEnvironment: canonicalGatewayEnvironmentRowsSchema,
  }),
});
const storedBundleSchema = z.union([
  bundleSchema,
  adoptionBundleSchema,
  activeAdoptionBundleSchema,
]);
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

const readStoredBundle = (input: ResourceCredentialInput) => {
  const files = decryptHostedRuntimeFiles(input);
  if (files === undefined) {
    throw new Error("Protected resource credential checkpoint is unavailable.");
  }
  if (Object.keys(files).length !== 1 || files[fileName] === undefined) {
    throw new Error("Protected resource credential checkpoint is incompatible.");
  }
  try {
    return storedBundleSchema.parse(JSON.parse(files[fileName]));
  } catch {
    // Malformed ciphertext content can contain passwords; do not forward parser errors.
    throw new HostedOperatorError("reconciliation_required");
  }
};
const sameReadiness = (
  left: OperatorAuthSchemaPreparation,
  right: OperatorAuthSchemaPreparation,
) => {
  const { observedAt: _left, ...leftIdentity } = left;
  const { observedAt: _right, ...rightIdentity } = right;
  void _left;
  void _right;
  return isDeepStrictEqual(leftIdentity, rightIdentity);
};
const assertActiveBundle = (
  input: ResourceCredentialInput,
  bundle: z.infer<typeof activeAdoptionBundleSchema>,
) => {
  const { plan } = input;
  const preparation = bundle.verification.authPreparation;
  const incompatible = [
    !isDeepStrictEqual(bundle.identity, resourceIdentity(plan)),
    !isDeepStrictEqual(bundle.adoption, plan.authAdoption),
    !isDeepStrictEqual(input.record.request, input.target),
    !sameOperatorSelection(plan.selection, input.target),
    preparation.database !== plan.authDatabase.database,
    preparation.runtimeRole !== plan.authDatabase.runtimeRole,
    preparation.targetDigest !== plan.authSchema?.targetDigest,
  ].some(Boolean);
  if (incompatible) {
    throw new HostedOperatorError("resource_mismatch");
  }
  // The sealed proof names the exact approved canonical ownership snapshot.
  assertHostedOperatorSharedGateway(plan, plan, bundle.verification.gatewayEnvironment);
  return bundle;
};
const readMatchingBundle = (input: ResourceCredentialInput) => {
  const bundle = readStoredBundle(input);
  if (input.plan.authAdoption !== undefined) {
    if (bundle.version !== 2 || bundle.state !== activeAdoptionState) {
      throw new HostedOperatorError("reconciliation_required");
    }
    return assertActiveBundle(input, bundle);
  }
  if (bundle.version !== 1) {
    throw new HostedOperatorError("reconciliation_required");
  }
  if (!isDeepStrictEqual(bundle.identity, resourceIdentity(input.plan))) {
    throw new Error("Protected resource credential checkpoint belongs to different resources.");
  }
  return bundle;
};

/** Local continuation evidence only: no source lookup or password leaves this helper. */
export const readActiveHostedOperatorSharedAuth = (input: ResourceCredentialInput) => {
  if (input.record.privateState === undefined) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Optional local evidence has no value before activation.
    return undefined;
  }
  const bundle = readStoredBundle(input);
  if (bundle.version !== 2 || bundle.state !== activeAdoptionState) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Optional local evidence has no value before activation.
    return undefined;
  }
  assertActiveBundle(input, bundle);
  // Mutable Gateway checkpoints can contain an interrupted PATCH. Local continuation
  // uses the sealed ownership seed; source planning separately requires current verified rows.
  const { gatewayEnvironment } = bundle.verification;
  return {
    adoption: bundle.adoption,
    authPreparation: bundle.verification.authPreparation,
    gatewayEnvironment,
  };
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
  if (input.plan.authAdoption !== undefined && input.database === "authDatabase") {
    throw new HostedOperatorError("reconciliation_required");
  }
  const identity = resourceIdentity(input.plan);
  const files = decryptHostedRuntimeFiles(input);
  let bundle: ReturnType<typeof readMatchingBundle>;
  let { privateState } = input.record;
  if (files === undefined) {
    if (input.plan.authAdoption !== undefined) {
      throw new HostedOperatorError("reconciliation_required");
    }
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
  if (bundle.version === 2 && !sameReadiness(preparation, bundle.verification.authPreparation)) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const { appDatabase: _app, appId: _appId, ...resource } = bundle.identity;
  void _app;
  void _appId;
  const adoption = sharedAuthAdoptionSchema.parse({
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
  const sourceGateway =
    operator.gatewayEnvironment ??
    (bundle.version === 2 ? bundle.verification.gatewayEnvironment : undefined);
  if (sourceGateway !== undefined) {
    adoption.gatewayEnvironment = describeHostedOperatorSharedGateway(plan, sourceGateway);
  }
  return adoption;
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
 * No plaintext or connection URL is returned. Pending v2 is unusable by worker/binding
 * readers until trusted activation seals verified Auth and shared Gateway provenance.
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
    const parsed = readStoredBundle(target);
    if (
      parsed.version !== 2 ||
      parsed.state !== pendingAdoptionState ||
      target.record.privateState === undefined
    ) {
      throw new HostedOperatorError("resource_mismatch");
    }
    if (
      !isDeepStrictEqual(parsed.identity, identity) ||
      !isDeepStrictEqual(parsed.adoption, adoption) ||
      !isDeepStrictEqual(parsed.authDatabase, sourceBundle.authDatabase)
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
    state: pendingAdoptionState,
    version: 2,
  });
  return encryptHostedRuntimeFiles({ ...target, files: { [fileName]: JSON.stringify(bundle) } });
};

/** Seal verified adoption; the coordinator owns authorization, source stability and target CAS. */
export const activateHostedOperatorSharedAuth = (input: {
  source: ResourceCredentialInput;
  target: ResourceCredentialInput;
  authPreparation: OperatorAuthSchemaPreparation;
  gatewayEnvironment: ManagedOperatorEnvironmentRow[];
}) => {
  const { source, target } = input;
  if (target.record.privateState === undefined) {
    throw new HostedOperatorError("reconciliation_required");
  }
  const adoption = describeHostedOperatorSharedAuth(source);
  assertAdoptionTarget(source, target, adoption);
  const bundle = readStoredBundle(target);
  if (
    bundle.version !== 2 ||
    !isDeepStrictEqual(bundle.adoption, adoption) ||
    !isDeepStrictEqual(bundle.identity, resourceIdentity(target.plan)) ||
    !isDeepStrictEqual(bundle.authDatabase, readMatchingBundle(source).authDatabase)
  ) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const parsed = operatorAuthSchemaPreparationSchema.safeParse(input.authPreparation);
  const saved = source.record.operator?.authPreparation;
  if (!parsed.success || saved === undefined || !sameReadiness(parsed.data, saved)) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const gatewayEnvironment = assertHostedOperatorSharedGateway(
    target.plan,
    source.plan,
    input.gatewayEnvironment,
  );
  if (bundle.state === activeAdoptionState) {
    assertActiveBundle(target, bundle);
    if (
      !sameReadiness(parsed.data, bundle.verification.authPreparation) ||
      !isDeepStrictEqual(gatewayEnvironment, bundle.verification.gatewayEnvironment)
    ) {
      throw new HostedOperatorError("resource_mismatch");
    }
    return target.record.privateState;
  }
  const active = activeAdoptionBundleSchema.parse({
    ...bundle,
    state: activeAdoptionState,
    verification: { authPreparation: parsed.data, gatewayEnvironment },
  });
  assertActiveBundle(target, active);
  return encryptHostedRuntimeFiles({ ...target, files: { [fileName]: JSON.stringify(active) } });
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
  const bundle = readStoredBundle(target);
  if (bundle.version !== 2 || bundle.state !== pendingAdoptionState) {
    throw new HostedOperatorError("reconciliation_required");
  }
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
  if (!sameReadiness(proof, saved)) {
    throw new HostedOperatorError("resource_mismatch");
  }
  return proof;
};
