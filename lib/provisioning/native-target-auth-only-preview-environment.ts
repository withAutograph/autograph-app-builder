import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";

import type { NativeTargetAuthOnlyPlan } from "./native-target-auth-only-plan-schema";
import { nativeTargetAuthOnlyPlanDigest } from "./native-target-auth-only-plan-schema";
import type { NativeTargetAuthOnlyDeliveryPlan } from "./native-target-auth-only-delivery-plan";
import { nativeTargetAuthOnlyDeliveryPlanDigest } from "./native-target-auth-only-delivery-plan";
import type { NativeTargetAuthOnlyApproval } from "./native-target-auth-only-dispatch";
import { resolveNativePreviewEnvironmentGitBranch } from "./native-preview-environment-scope";
import { nativeTargetAuthOnlyResourceApprovalPlanSchema } from "./native-target-auth-only-resource-plan-schema";
import { nativeTargetAuthOnlyResourcePlanDigest } from "./native-target-auth-only-resource-plan-store";
import type { HostedRuntimeTarget } from "./hosted-runtime-journal";

const id = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const origin = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.origin === value;
});
const gatewayEnvironmentKeys = [
  "AUTH_DATABASE_RESOURCE",
  "PLATFORM_AUTH_DATABASE_URL",
  "PLATFORM_GATEWAY_PROJECT_BINDINGS",
  "PLATFORM_GATEWAY_PROTECTED_APPLICATIONS",
  "PLATFORM_REALM_OPERATOR_LINK_CONFIG",
] as const;
const appEnvironmentKeys = [
  "PLATFORM_JWKS_URL",
  "PLATFORM_ORIGIN",
  "PLATFORM_PUBLIC_ORIGIN",
] as const;
const variableName = z.string().regex(/^[A-Z][A-Z0-9_]*$/u);
const valueMap = z.record(z.string(), z.string().min(1));
export const recoverySenderApiKey = "AUTH_RECOVERY_RESEND_API_KEY";
export const recoverySenderFrom = "AUTH_RECOVERY_EMAIL_FROM";
export const nativeTargetAuthOnlyRecoverySecretSchema = z
  .strictObject({
    id,
    key: z.literal(recoverySenderApiKey),
    projectId: id,
    target: z.literal("preview"),
    physicalBranch: id.nullable(),
    type: id,
    visibility: z.literal("secret").optional(),
    createdAt: z.number().int().nonnegative().optional(),
    updatedAt: z.number().int().nonnegative().optional(),
  })
  .refine((row) => row.visibility === "secret" || ["secret", "sensitive"].includes(row.type));
const recoverySenderSchema = z.strictObject({
  provider: z.literal("resend"),
  environment: z.literal("preview"),
  ownerProjectId: id,
  from: z.email(),
  apiKey: nativeTargetAuthOnlyRecoverySecretSchema,
});
type RecoverySender = z.infer<typeof recoverySenderSchema>;

export type NativeTargetAuthOnlyDeliveryEnvironmentInput = {
  authority: z.infer<typeof hostedTenantAuthoritySchema>;
  target: HostedRuntimeTarget;
  plan: NativeTargetAuthOnlyPlan;
  deliveryPlan: NativeTargetAuthOnlyDeliveryPlan;
  operationRef: string;
  approval: NativeTargetAuthOnlyApproval;
  fenceGeneration: number;
  effect: "gateway" | "app";
  assertCurrent: () => Promise<void>;
  signal: AbortSignal;
};

type NativeTargetAuthOnlyPreviewEnvironmentMaterials = {
  deliveryPlanBytes: Buffer;
  resourcePlanDigest: string;
  resourcePlan: z.infer<typeof nativeTargetAuthOnlyResourceApprovalPlanSchema>;
  resourcePlanBytes: Buffer;
  authRuntimeUrl: string;
  /** Nonauth profile values, retained from deployment configuration or provider readback. */
  gatewayProfileValues: Readonly<Record<string, string>>;
  /** Existing journal-owned values; absent rows are valid on first delivery. */
  observedGatewayValues?: Readonly<Record<string, string>>;
  emailVerification: {
    required: "true";
    sender: RecoverySender;
  };
  gatewayProjectMetadata: unknown;
  appProjectMetadata: unknown;
};

export const nativeTargetAuthOnlyPreviewEnvironmentManifestSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("native-target-auth-only-preview-environment"),
  authOnlyPlanDigest: digest,
  deliveryPlanDigest: digest,
  resourcePlanDigest: digest,
  source: z.strictObject({
    branch: id,
    gitSha: z.string().regex(/^[a-f0-9]{40}$/u),
    repositoryId: id,
  }),
  gateway: z.strictObject({
    projectId: id,
    branch: id,
    physicalBranch: z.string().min(1).nullable(),
    values: z.array(z.strictObject({ key: variableName, sha256: digest })).length(7),
    recoverySecret: nativeTargetAuthOnlyRecoverySecretSchema,
  }),
  app: z.strictObject({
    projectId: id,
    branch: id,
    physicalBranch: z.string().min(1).nullable(),
    values: z.array(z.strictObject({ key: z.enum(appEnvironmentKeys), sha256: digest })).length(3),
  }),
});
export type NativeTargetAuthOnlyPreviewEnvironmentManifest = z.infer<
  typeof nativeTargetAuthOnlyPreviewEnvironmentManifestSchema
>;

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const exactKeys = (values: Readonly<Record<string, string>>, expected: readonly string[]) => {
  const actual = Object.keys(values).toSorted();
  if (!isDeepStrictEqual(actual, [...expected].toSorted())) {
    throw new Error("native_target_auth_only_preview_environment_keys_mismatch");
  }
};

/**
 * Compose private Gateway values and public static-app bindings from the same
 * retained delivery approval. The sender key is represented only by provider
 * metadata. Other private values go to the adapter, and the manifest hashes them.
 */
export const composeNativeTargetAuthOnlyPreviewEnvironment = (input: {
  plan: NativeTargetAuthOnlyPlan;
  deliveryPlan: NativeTargetAuthOnlyDeliveryPlan;
  deliveryPlanBytes: Buffer;
  resourcePlanDigest: string;
  resourcePlan: z.infer<typeof nativeTargetAuthOnlyResourceApprovalPlanSchema>;
  resourcePlanBytes: Buffer;
  approval: NativeTargetAuthOnlyApproval;
  authRuntimeUrl: string;
  emailVerification: {
    required: "true";
    sender: RecoverySender;
  };
  gatewayProfileValues: Readonly<Record<string, string>>;
  observedGatewayValues?: Readonly<Record<string, string>>;
  gatewayProjectMetadata: unknown;
  appProjectMetadata: unknown;
}) => {
  const plan = input.plan;
  const delivery = input.deliveryPlan;
  const planDigest = nativeTargetAuthOnlyPlanDigest(plan);
  const deliveryDigest = nativeTargetAuthOnlyDeliveryPlanDigest(input.deliveryPlanBytes);
  const resourcePlan = nativeTargetAuthOnlyResourceApprovalPlanSchema.parse(input.resourcePlan);
  const gateway = delivery.delivery.publicGateway;
  const gatewayOrigin = origin.parse(gateway?.gatewayOrigin);
  const publicOrigin = origin.parse(gateway?.origin);
  const app = delivery.delivery.delivery;
  if (
    delivery.kind !== "native-target-auth-only-delivery" ||
    delivery.authOnlyPlanDigest !== planDigest ||
    delivery.resourcePlanDigest !== digest.parse(input.resourcePlanDigest) ||
    nativeTargetAuthOnlyResourcePlanDigest(input.resourcePlanBytes) !== input.resourcePlanDigest ||
    !isDeepStrictEqual(JSON.parse(input.resourcePlanBytes.toString("utf8")), resourcePlan) ||
    deliveryDigest !== deliveryPlanDigestSchema.parse(input.approval.planDigest) ||
    input.approval.sourceDigest !== deliveryDigest ||
    input.approval.outcome !== "approved" ||
    input.approval.publicSessionId !== plan.origin.publicSessionId ||
    input.approval.responderPrincipalId !== plan.origin.authority.ownerUserId ||
    delivery.source.branch !== plan.publishedSource.branch ||
    delivery.source.gitSha !== plan.publishedSource.gitSha ||
    delivery.source.repositoryId !== plan.publishedSource.repositoryId ||
    gateway === undefined ||
    app === undefined ||
    gateway.projectId === app.projectId ||
    app?.projectId !== delivery.target.projectId ||
    app?.branch !== delivery.target.branch ||
    resourcePlan.authOnlyPlanDigest !== planDigest ||
    resourcePlan.target.projectId !== delivery.target.projectId ||
    resourcePlan.authDatabase.resourceId !== plan.authResource.resourceId ||
    resourcePlan.authDatabase.database !== plan.authResource.database ||
    resourcePlan.bootstrap.endpointId !== plan.authResource.endpointId ||
    resourcePlan.neon.endpoint !== plan.authResource.hostname ||
    delivery.delivery.delivery?.gitSha !== delivery.source.gitSha ||
    delivery.delivery.delivery?.repoId !== delivery.source.repositoryId ||
    delivery.delivery.gatewayDelivery?.branch !== gateway.branch ||
    !isDeepStrictEqual(input.deliveryPlanBytes, Buffer.from(JSON.stringify(delivery)))
  ) {
    throw new Error("native_target_auth_only_preview_environment_binding_mismatch");
  }

  const sender = recoverySenderSchema.safeParse(input.emailVerification.sender);
  if (
    !sender.success ||
    input.emailVerification.required !== "true" ||
    sender.data.ownerProjectId !== gateway.projectId ||
    sender.data.apiKey.projectId !== gateway.projectId
  ) {
    throw new Error("native_target_auth_only_preview_email_verification_unavailable");
  }
  const profileValues = valueMap.parse(input.gatewayProfileValues);
  exactKeys(profileValues, [
    "PLATFORM_GATEWAY_PROJECT_BINDINGS",
    "PLATFORM_REALM_OPERATOR_LINK_CONFIG",
  ]);
  let runtime: URL;
  try {
    runtime = new URL(input.authRuntimeUrl);
  } catch {
    throw new Error("native_target_auth_only_preview_environment_resource_mismatch");
  }
  const resource = {
    database: resourcePlan.authDatabase.database,
    migratorRole: resourcePlan.authDatabase.migratorRole,
    runtimeRole: resourcePlan.authDatabase.runtimeRole,
    hostname: resourcePlan.neon.endpoint,
    branchId: resourcePlan.neon.branchId,
    projectId: resourcePlan.neon.projectId,
  };
  if (
    (runtime.protocol !== "postgres:" && runtime.protocol !== "postgresql:") ||
    runtime.hostname !== resource.hostname ||
    (runtime.port !== "" && runtime.port !== "5432") ||
    decodeURIComponent(runtime.username) !== resource.runtimeRole ||
    decodeURIComponent(runtime.pathname.slice(1)) !== resource.database ||
    runtime.password.length === 0 ||
    runtime.searchParams.get("sslmode") !== "verify-full" ||
    runtime.hash !== ""
  )
    throw new Error("native_target_auth_only_preview_environment_resource_mismatch");
  const resourceValue = JSON.stringify({
    database: resource.database,
    environment: "preview",
    hostname: resource.hostname,
    migratorRole: resource.migratorRole,
    neon: { branchId: resource.branchId, projectId: resource.projectId },
    port: 5432,
    runtimeRole: resource.runtimeRole,
    schema: "public",
    version: 1,
  });
  // Validate the two retained Gateway documents without rewriting their bytes or dropping sibling bindings.
  z.json().parse(JSON.parse(profileValues.PLATFORM_REALM_OPERATOR_LINK_CONFIG));
  z.json().parse(JSON.parse(profileValues.PLATFORM_GATEWAY_PROJECT_BINDINGS));
  const protectedApps = z.array(id).parse(gateway.protectedApplicationIds);
  if (new Set(protectedApps).size !== protectedApps.length) {
    throw new Error("native_target_auth_only_preview_environment_policy_mismatch");
  }
  const gatewayExpected: Record<string, string> = {
    AUTH_DATABASE_RESOURCE: resourceValue,
    PLATFORM_AUTH_DATABASE_URL: input.authRuntimeUrl,
    PLATFORM_GATEWAY_PROJECT_BINDINGS: profileValues.PLATFORM_GATEWAY_PROJECT_BINDINGS,
    PLATFORM_GATEWAY_PROTECTED_APPLICATIONS: JSON.stringify(
      [...new Set([...protectedApps, plan.appId])].toSorted((left, right) =>
        left.localeCompare(right),
      ),
    ),
    PLATFORM_REALM_OPERATOR_LINK_CONFIG: profileValues.PLATFORM_REALM_OPERATOR_LINK_CONFIG,
    AUTH_REQUIRE_EMAIL_VERIFICATION: input.emailVerification.required,
    [recoverySenderFrom]: sender.data.from,
  };
  exactKeys(gatewayExpected, [
    ...gatewayEnvironmentKeys,
    "AUTH_REQUIRE_EMAIL_VERIFICATION",
    recoverySenderFrom,
  ]);
  if (input.observedGatewayValues !== undefined) {
    for (const [key, value] of Object.entries(input.observedGatewayValues)) {
      if (!(key in gatewayExpected) || gatewayExpected[key] !== value) {
        throw new Error("native_target_auth_only_preview_environment_conflict");
      }
    }
  }
  const appValues = {
    PLATFORM_JWKS_URL: `${gatewayOrigin}/_platform/jwks.json`,
    PLATFORM_ORIGIN: gatewayOrigin,
    PLATFORM_PUBLIC_ORIGIN: publicOrigin,
  };
  exactKeys(appValues, appEnvironmentKeys);

  const gatewayPhysicalBranch = resolveNativePreviewEnvironmentGitBranch(
    delivery.delivery.gatewayDelivery?.branch ?? delivery.target.branch,
    input.gatewayProjectMetadata,
  );
  if (sender.data.apiKey.physicalBranch !== gatewayPhysicalBranch) {
    throw new Error("native_target_auth_only_preview_email_verification_unavailable");
  }
  const appPhysicalBranch = resolveNativePreviewEnvironmentGitBranch(
    delivery.target.branch,
    input.appProjectMetadata,
    { allowUnlinkedProject: true },
  );
  const manifest = nativeTargetAuthOnlyPreviewEnvironmentManifestSchema.parse({
    version: 1,
    kind: "native-target-auth-only-preview-environment",
    authOnlyPlanDigest: planDigest,
    deliveryPlanDigest: deliveryDigest,
    resourcePlanDigest: input.resourcePlanDigest,
    source: delivery.source,
    gateway: {
      projectId: gateway.projectId,
      branch: delivery.delivery.gatewayDelivery?.branch ?? delivery.target.branch,
      physicalBranch: gatewayPhysicalBranch,
      recoverySecret: sender.data.apiKey,
      values: Object.keys(gatewayExpected)
        .toSorted()
        .map((key) => ({ key, sha256: hash(gatewayExpected[key]!) })),
    },
    app: {
      projectId: app.projectId,
      branch: app.branch,
      physicalBranch: appPhysicalBranch,
      values: appEnvironmentKeys.map((key) => ({ key, sha256: hash(appValues[key]!) })),
    },
  });
  return { manifest, gatewayValues: gatewayExpected, appValues };
};

/** Adapter factory matching the runtime's per-effect environment authority port. */
export const createNativeTargetAuthOnlyPreviewEnvironmentPort =
  (deps: {
    readMaterials: (
      input: NativeTargetAuthOnlyDeliveryEnvironmentInput,
    ) => Promise<NativeTargetAuthOnlyPreviewEnvironmentMaterials>;
    applyAndVerify: (input: {
      authority: z.infer<typeof hostedTenantAuthoritySchema>;
      target: HostedRuntimeTarget;
      operationRef: string;
      fenceGeneration: number;
      approvedDeliveryDigest: string;
      effect: "gateway" | "app";
      projectId: string;
      branch: string;
      physicalBranch: string | null;
      values: Readonly<Record<string, string>>;
      manifest: NativeTargetAuthOnlyPreviewEnvironmentManifest;
      assertCurrent: () => Promise<void>;
      signal: AbortSignal;
    }) => Promise<void>;
  }) =>
  async (input: NativeTargetAuthOnlyDeliveryEnvironmentInput): Promise<void> => {
    const plan = input.plan;
    const delivery = input.deliveryPlan;
    if (
      input.target.environment !== "preview" ||
      input.target.appId !== plan.appId ||
      input.target.projectId !== delivery.target.projectId ||
      input.target.branch !== delivery.target.branch ||
      !isDeepStrictEqual(input.authority, plan.origin.authority) ||
      input.approval.planDigest !==
        nativeTargetAuthOnlyDeliveryPlanDigest(Buffer.from(JSON.stringify(delivery))) ||
      input.approval.sourceDigest !== input.approval.planDigest ||
      input.approval.outcome !== "approved" ||
      !Number.isSafeInteger(input.fenceGeneration) ||
      input.fenceGeneration <= 0
    )
      throw new Error("native_target_auth_only_preview_environment_binding_mismatch");
    input.signal.throwIfAborted();
    await input.assertCurrent();
    const materials = await deps.readMaterials(input);
    await input.assertCurrent();
    input.signal.throwIfAborted();
    const composed = composeNativeTargetAuthOnlyPreviewEnvironment({
      plan,
      deliveryPlan: delivery,
      deliveryPlanBytes: materials.deliveryPlanBytes,
      resourcePlanDigest: materials.resourcePlanDigest,
      resourcePlan: materials.resourcePlan,
      resourcePlanBytes: materials.resourcePlanBytes,
      approval: input.approval,
      authRuntimeUrl: materials.authRuntimeUrl,
      emailVerification: materials.emailVerification,
      gatewayProfileValues: materials.gatewayProfileValues,
      ...(materials.observedGatewayValues === undefined
        ? {}
        : { observedGatewayValues: materials.observedGatewayValues }),
      gatewayProjectMetadata: materials.gatewayProjectMetadata,
      appProjectMetadata: materials.appProjectMetadata,
    });
    const targetPlan =
      input.effect === "gateway" ? composed.manifest.gateway : composed.manifest.app;
    await deps.applyAndVerify({
      authority: structuredClone(input.authority),
      target: structuredClone(input.target),
      operationRef: input.operationRef,
      fenceGeneration: input.fenceGeneration,
      approvedDeliveryDigest: composed.manifest.deliveryPlanDigest,
      effect: input.effect,
      projectId: targetPlan.projectId,
      branch: targetPlan.branch,
      physicalBranch: targetPlan.physicalBranch,
      values: input.effect === "gateway" ? composed.gatewayValues : composed.appValues,
      manifest: composed.manifest,
      assertCurrent: input.assertCurrent,
      signal: input.signal,
    });
    await input.assertCurrent();
    input.signal.throwIfAborted();
  };

const deliveryPlanDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
