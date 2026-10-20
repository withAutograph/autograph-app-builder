import { createHash } from "node:crypto";
import { managedRuntimePublicProfileSchema } from "../sandbox/managed-runtime-capabilities";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { hostedRuntimeTargetSchema } from "./hosted-runtime-journal";
import {
  hostedOperatorPlanSchema,
  HostedOperatorError,
  managedOperatorEnvironmentRowSchema,
  operatorDeploymentCandidateSchema,
} from "./hosted-operator-contract";

const id = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const origin = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
});
export const managedRuntimeWorkerDescriptorSchema = z.strictObject({
  id,
  executablePath: id,
  sha256: digest,
  operationScope: z.literal("managed-app-runtime-v1"),
  subcommand: z.literal("protected-managed-app-runtime"),
});
export const continuityRuntimeSelectionSchema = z.strictObject({ sandboxId: id, root: id });
export type ContinuityRuntimeSelection = z.infer<typeof continuityRuntimeSelectionSchema>;
export const hostedContinuityPlanSchema = z
  .strictObject({
    version: z.literal(1),
    kind: z.literal("app-continuity-plan"),
    intentId: z.uuid(),
    planRef: id,
    authority: hostedTenantAuthoritySchema,
    target: hostedRuntimeTargetSchema,
    originalSetup: z.strictObject({
      operationRef: z.uuid(),
      planDigest: digest,
      approvalId: id,
      approvedByCallId: id,
    }),
    preparedPlan: hostedOperatorPlanSchema,
    runtime: continuityRuntimeSelectionSchema.extend({
      projectId: id,
      ownerId: id,
      appPort: z.number().int().min(1).max(65_535),
      bridgePort: z.number().int().min(1).max(65_535),
    }),
    gateway: z.strictObject({
      projectId: id,
      ownerId: id,
      environment: z.literal("preview"),
      publicOrigin: origin,
    }),
    actors: z.array(z.strictObject({ actorId: id, organizationId: id })).min(1),
  })
  .superRefine((value, ctx) => {
    if (
      value.planRef !== `_protected-operator/continuity-plans/${value.intentId}` ||
      value.target.appId !== value.preparedPlan.selection.appId ||
      value.target.sessionId !== value.preparedPlan.selection.sessionId ||
      value.target.environment !== "preview"
    ) {
      ctx.addIssue({ code: "custom", message: "Continuity scope differs." });
    }
  });
export type HostedContinuityPlan = z.infer<typeof hostedContinuityPlanSchema>;
export const continuityPlanDigest = (plan: HostedContinuityPlan) =>
  createHash("sha256")
    .update(JSON.stringify(hostedContinuityPlanSchema.parse(plan)))
    .digest("hex");
export const hostedContinuityRequestSchema = z.strictObject({
  action: z.literal("continuity"),
  planRef: id,
  planDigest: digest,
  idempotencyKey: id,
});
export type HostedContinuityRequest = z.infer<typeof hostedContinuityRequestSchema>;
export const parseContinuityRequestForPlan = (
  request: HostedContinuityRequest,
  plan: HostedContinuityPlan,
) => {
  const parsed = hostedContinuityRequestSchema.parse(request);
  if (parsed.planRef !== plan.planRef || parsed.planDigest !== continuityPlanDigest(plan)) {
    throw new HostedOperatorError("resource_mismatch");
  }
  return parsed;
};
export const parseContinuityPlanForOwner = (
  plan: HostedContinuityPlan,
  context: { authority: HostedContinuityPlan["authority"]; target: HostedContinuityPlan["target"] },
) => {
  const parsed = hostedContinuityPlanSchema.parse(plan);
  if (
    !isDeepStrictEqual(parsed.authority, context.authority) ||
    !isDeepStrictEqual(parsed.target, context.target)
  ) {
    throw new HostedOperatorError("authorization_required");
  }
  return parsed;
};
export const continuityApprovalSchema = hostedContinuityRequestSchema.extend({
  approvalId: id,
  approvedByCallId: id,
});
export type ContinuityApproval = z.infer<typeof continuityApprovalSchema>;
export const continuityIdentitySchema = z.strictObject({
  intentId: z.uuid(),
  approvalRef: id,
  owner: hostedTenantAuthoritySchema.extend({ sessionId: id }),
  appId: id,
  runtimeAttemptId: z.uuid(),
  fence: z.number().int().positive(),
  sandboxId: id,
  providerSessionId: id,
});
export const continuityCurrentSchema = continuityIdentitySchema.extend({
  state: z.enum([
    "starting",
    "ready",
    "restarting",
    "revoked",
    "expired",
    "reconciliation-required",
  ]),
  leaseExpiresAt: z.iso.datetime(),
});
export type ContinuityCurrent = z.infer<typeof continuityCurrentSchema>;
const providerTarget = z.strictObject({
  projectId: id,
  ownerId: id,
  sandboxId: id,
  providerSessionId: id,
  origin,
  bridgePort: z.number().int().min(1).max(65_535),
});
/** Same public wire accepted by Arrusted's trusted managed-target receiver. Not live provider evidence. */
export const continuityProjectionSchema = z.strictObject({
  version: z.literal(1),
  provenance: z.literal("trusted-operator-published-managed-target"),
  intentId: z.uuid(),
  approvalRef: id,
  owner: hostedTenantAuthoritySchema.extend({ sessionId: id }),
  appId: id,
  preparedOperationRef: id,
  gateway: hostedContinuityPlanSchema.shape.gateway,
  approvedTarget: providerTarget,
  observation: providerTarget.extend({ expiresAt: z.iso.datetime() }),
  runtimeAttemptId: z.uuid(),
  fence: z.number().int().positive(),
  leaseExpiresAt: z.iso.datetime(),
  state: continuityCurrentSchema.shape.state,
  actors: hostedContinuityPlanSchema.shape.actors,
  suiteSelectorSha256: digest,
  transportSha256: digest,
});
export type ContinuityProjection = z.infer<typeof continuityProjectionSchema>;
export const continuityCapabilitiesSchema = z.strictObject({
  suiteSelector: id,
  transport: id,
  lifecycle: id,
});
export type ContinuityCapabilities = z.infer<typeof continuityCapabilitiesSchema>;
export const continuityPrivateStateSchema = z.strictObject({
  encryptedToken: id,
  tokenIv: id,
  tokenTag: id,
  keyVersion: id,
});
export const continuityRuntimeLocatorSchema = z.strictObject({
  ...continuityRuntimeSelectionSchema.shape,
  providerSessionId: id,
  commandId: id.optional(),
  dispatchAttempted: z.boolean().optional(),
  worker: managedRuntimeWorkerDescriptorSchema,
  attemptId: z.uuid(),
  rootDirectory: id,
});
export type ContinuityRuntimeLocator = z.infer<typeof continuityRuntimeLocatorSchema>;
export const managedRuntimeWorkerAssetSchema = z.strictObject({
  sourceCreationAttempted: z.boolean().optional(),
  sourceSandboxId: z.string().min(1).optional(),
  installed: z.boolean().optional(),
  disposed: z.boolean().optional(),
});
export type ManagedRuntimeWorkerAssetState = z.infer<typeof managedRuntimeWorkerAssetSchema>;
export const continuityRecordSchema = z
  .strictObject({
    kind: z.literal("app-continuity"),
    requestId: z.uuid(),
    revision: z.number().int().nonnegative(),
    idempotencyKey: id,
    plan: hostedContinuityPlanSchema,
    planDigest: digest,
    approval: continuityApprovalSchema.optional(),
    state: z.enum([
      "planned",
      "approved",
      "starting",
      "publishing",
      "ready",
      "revoking",
      "revoked",
      "settled",
      "reconciliation-required",
    ]),
    fence: z.number().int().nonnegative(),
    attemptId: z.uuid().optional(),
    privateState: continuityPrivateStateSchema.optional(),
    workerAsset: managedRuntimeWorkerAssetSchema.optional(),
    publicProfile: managedRuntimePublicProfileSchema.optional(),
    current: continuityCurrentSchema.optional(),
    projection: continuityProjectionSchema.optional(),
    locator: continuityRuntimeLocatorSchema.optional(),
    environmentRows: z.array(managedOperatorEnvironmentRowSchema),
    environmentWrites: z.array(z.strictObject({ key: id, sha256: digest })),
    deliveryAttempted: z.boolean().optional(),
    deliveryCandidates: z.array(operatorDeploymentCandidateSchema),
    suiteCommandId: id.optional(),
    suiteDispatched: z.boolean().optional(),
    cancelled: z.boolean().optional(),
    failure: z
      .strictObject({
        stage: z.literal("publication"),
        reason: z.literal("runtime-closed-before-publication-completed"),
      })
      .optional(),
    outcome: z
      .strictObject({ exitCode: z.number().int(), completedAt: z.iso.datetime() })
      .optional(),
    pendingStage: z.enum(["runtime", "publication", "suite", "revocation"]).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.requestId !== value.plan.intentId ||
      value.planDigest !== continuityPlanDigest(value.plan)
    ) {
      ctx.addIssue({ code: "custom", message: "Continuity journal identity differs." });
    }
  });
export type ContinuityRecord = z.infer<typeof continuityRecordSchema>;
export const continuityStatus = (record: ContinuityRecord) => ({
  intentId: record.requestId,
  planRef: record.plan.planRef,
  state: record.state,
  ...(record.outcome === undefined ? {} : { outcome: record.outcome }),
  ...(record.failure === undefined ? {} : { failure: record.failure }),
  ...(record.current === undefined
    ? {}
    : {
        runtime: {
          runtimeAttemptId: record.current.runtimeAttemptId,
          state: record.current.state,
          leaseExpiresAt: record.current.leaseExpiresAt,
        },
      }),
});

export const continuityStatusSchema = z.strictObject({
  intentId: z.uuid(),
  planRef: id,
  state: continuityRecordSchema.shape.state,
  outcome: continuityRecordSchema.shape.outcome,
  failure: continuityRecordSchema.shape.failure,
  runtime: z
    .strictObject({
      runtimeAttemptId: z.uuid(),
      state: continuityCurrentSchema.shape.state,
      leaseExpiresAt: z.iso.datetime(),
    })
    .optional(),
});
export const continuityPlannedSchema = z.strictObject({
  plan: hostedContinuityPlanSchema,
  request: hostedContinuityRequestSchema,
  status: continuityStatusSchema,
});
