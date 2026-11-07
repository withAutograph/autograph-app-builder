import { privateOperatorApprovalObservationSchema } from "../eve/private-operator-approval-observation";
import { browserTestSelectionSchema } from "../agent/browser-test-selection";
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
const reconciliationRequired = "reconciliation-required";
const origin = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
});
export const managedRuntimeWorkerDescriptorSchema = z.strictObject({
  executablePath: id,
  id,
  operationScope: z.literal("managed-app-runtime-v1"),
  sha256: digest,
  subcommand: z.literal("protected-managed-app-runtime"),
});
export const continuityRuntimeSelectionSchema = z.strictObject({
  browserSelection: browserTestSelectionSchema.optional(),
  root: id,
  sandboxId: id,
});
export type ContinuityRuntimeSelection = z.infer<typeof continuityRuntimeSelectionSchema>;
export const hostedContinuityPlanSchema = z
  .strictObject({
    actors: z.array(z.strictObject({ actorId: id, organizationId: id })).min(1),
    authority: hostedTenantAuthoritySchema,
    gateway: z.strictObject({
      environment: z.literal("preview"),
      ownerId: id,
      projectId: id,
      publicOrigin: origin,
    }),
    intentId: z.uuid(),
    kind: z.literal("app-continuity-plan"),
    originalSetup: z.strictObject({
      approvalId: id,
      approvedByCallId: id,
      operationRef: z.uuid(),
      planDigest: digest,
    }),
    planRef: id,
    predecessorIntentId: z.uuid().optional(),
    preparedPlan: hostedOperatorPlanSchema,
    runtime: continuityRuntimeSelectionSchema.extend({
      appPort: z.number().int().min(1).max(65_535),
      bridgePort: z.number().int().min(1).max(65_535),
      ownerId: id,
      projectId: id,
    }),
    target: hostedRuntimeTargetSchema,
    version: z.literal(1),
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
  idempotencyKey: id,
  planDigest: digest,
  planRef: id,
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
  appId: id,
  approvalRef: id,
  fence: z.number().int().positive(),
  intentId: z.uuid(),
  owner: hostedTenantAuthoritySchema.extend({ sessionId: id }),
  providerSessionId: id,
  runtimeAttemptId: z.uuid(),
  sandboxId: id,
});
export const continuityCurrentSchema = continuityIdentitySchema.extend({
  leaseExpiresAt: z.iso.datetime(),
  state: z.enum(["starting", "ready", "restarting", "revoked", "expired", reconciliationRequired]),
});
export type ContinuityCurrent = z.infer<typeof continuityCurrentSchema>;
const providerTarget = z.strictObject({
  bridgePort: z.number().int().min(1).max(65_535),
  origin,
  ownerId: id,
  projectId: id,
  providerSessionId: id,
  sandboxId: id,
});
/** Same public wire accepted by Arrusted's trusted managed-target receiver. Not live provider evidence. */
export const continuityProjectionSchema = z.strictObject({
  actors: hostedContinuityPlanSchema.shape.actors,
  appId: id,
  approvalRef: id,
  approvedTarget: providerTarget,
  fence: z.number().int().positive(),
  gateway: hostedContinuityPlanSchema.shape.gateway,
  intentId: z.uuid(),
  leaseExpiresAt: z.iso.datetime(),
  observation: providerTarget.extend({ expiresAt: z.iso.datetime() }),
  owner: hostedTenantAuthoritySchema.extend({ sessionId: id }),
  preparedOperationRef: id,
  provenance: z.literal("trusted-operator-published-managed-target"),
  runtimeAttemptId: z.uuid(),
  state: continuityCurrentSchema.shape.state,
  suiteSelectorSha256: digest,
  transportSha256: digest,
  version: z.literal(1),
});
export type ContinuityProjection = z.infer<typeof continuityProjectionSchema>;
export const continuityCapabilitiesSchema = z.strictObject({
  lifecycle: id,
  suiteSelector: id,
  transport: id,
});
export type ContinuityCapabilities = z.infer<typeof continuityCapabilitiesSchema>;
export const continuityPrivateStateSchema = z.strictObject({
  encryptedToken: id,
  keyVersion: id,
  tokenIv: id,
  tokenTag: id,
});
export const continuityRuntimeLocatorSchema = z.strictObject({
  ...continuityRuntimeSelectionSchema.shape,
  attemptId: z.uuid(),
  commandId: id.optional(),
  dispatchAttempted: z.boolean().optional(),
  providerSessionId: id,
  rootDirectory: id,
  worker: managedRuntimeWorkerDescriptorSchema,
});
export type ContinuityRuntimeLocator = z.infer<typeof continuityRuntimeLocatorSchema>;
export const managedRuntimeWorkerAssetSchema = z.strictObject({
  disposed: z.boolean().optional(),
  installed: z.boolean().optional(),
  sourceCreationAttempted: z.boolean().optional(),
  sourceSandboxId: z.string().min(1).optional(),
});
export type ManagedRuntimeWorkerAssetState = z.infer<typeof managedRuntimeWorkerAssetSchema>;
export const continuityRecordSchema = z
  .strictObject({
    approval: continuityApprovalSchema.optional(),
    approvalObservation: privateOperatorApprovalObservationSchema.optional(),
    attemptId: z.uuid().optional(),
    cancelled: z.boolean().optional(),
    current: continuityCurrentSchema.optional(),
    deliveryAttempted: z.boolean().optional(),
    deliveryCandidates: z.array(operatorDeploymentCandidateSchema),
    environmentRows: z.array(managedOperatorEnvironmentRowSchema),
    environmentWrites: z.array(z.strictObject({ key: id, sha256: digest })),
    failure: z
      .strictObject({
        reason: z.literal("runtime-closed-before-publication-completed"),
        stage: z.literal("publication"),
      })
      .optional(),
    fence: z.number().int().nonnegative(),
    idempotencyKey: id,
    kind: z.literal("app-continuity"),
    locator: continuityRuntimeLocatorSchema.optional(),
    outcome: z
      .strictObject({ completedAt: z.iso.datetime(), exitCode: z.number().int() })
      .optional(),
    pendingStage: z.enum(["runtime", "publication", "suite", "revocation"]).optional(),
    plan: hostedContinuityPlanSchema,
    planDigest: digest,
    privateState: continuityPrivateStateSchema.optional(),
    projection: continuityProjectionSchema.optional(),
    publicProfile: managedRuntimePublicProfileSchema.optional(),
    requestId: z.uuid(),
    revision: z.number().int().nonnegative(),
    state: z.enum([
      "planned",
      "approved",
      "starting",
      "publishing",
      "ready",
      "revoking",
      "revoked",
      "settled",
      reconciliationRequired,
    ]),
    suiteCommandId: id.optional(),
    suiteDispatched: z.boolean().optional(),
    supersededBy: z.uuid().optional(),
    workerAsset: managedRuntimeWorkerAssetSchema.optional(),
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

/** Only an approved attempt with no possible process or publication dispatch may follow a resumed VM session. */
export const canRebindUndispatchedContinuityRuntime = (record: ContinuityRecord): boolean => {
  const { locator, current, approval, attemptId, plan } = record;
  if (
    locator === undefined ||
    current === undefined ||
    approval === undefined ||
    attemptId === undefined
  ) {
    return false;
  }
  return [
    ["starting", "reconciliation-required"].includes(record.state),
    record.pendingStage === "runtime",
    record.supersededBy === undefined,
    record.cancelled !== true,
    record.failure === undefined,
    record.outcome === undefined,
    record.fence > 0,
    locator.commandId === undefined,
    locator.dispatchAttempted !== true,
    locator.attemptId === attemptId,
    locator.sandboxId === plan.runtime.sandboxId,
    locator.root === plan.runtime.root,
    record.projection === undefined,
    record.environmentRows.length === 0,
    record.environmentWrites.length === 0,
    record.deliveryCandidates.length === 0,
    record.deliveryAttempted !== true,
    record.suiteDispatched !== true,
    record.suiteCommandId === undefined,
    current.state === "starting",
    isDeepStrictEqual(continuityIdentitySchema.strip().parse(current), {
      appId: plan.target.appId,
      approvalRef: approval.approvalId,
      fence: record.fence,
      intentId: record.requestId,
      owner: { ...plan.authority, sessionId: plan.target.sessionId },
      providerSessionId: locator.providerSessionId,
      runtimeAttemptId: attemptId,
      sandboxId: locator.sandboxId,
    }),
  ].every(Boolean);
};

/** Journal markers are observations only. An unrecorded marker is never proof of no effect. */
const checkpointMarker = (recorded: boolean) =>
  recorded ? ("recorded" as const) : ("unrecorded" as const);
export const continuityStatus = (record: ContinuityRecord) => {
  const status: ContinuityStatus = {
    intentId: record.requestId,
    planRef: record.plan.planRef,
    state: record.state,
  };
  if (record.supersededBy !== undefined) {
    status.supersededBy = record.supersededBy;
  }
  if (record.outcome !== undefined) {
    status.outcome = record.outcome;
  }
  if (record.failure !== undefined) {
    status.failure = record.failure;
  }
  if (record.current !== undefined) {
    status.runtime = {
      leaseExpiresAt: record.current.leaseExpiresAt,
      runtimeAttemptId: record.current.runtimeAttemptId,
      state: record.current.state,
    };
  }
  return status;
};

export const continuityStatusSchema = z.strictObject({
  failure: continuityRecordSchema.shape.failure,
  intentId: z.uuid(),
  outcome: continuityRecordSchema.shape.outcome,
  planRef: id,
  runtime: z
    .strictObject({
      leaseExpiresAt: z.iso.datetime(),
      runtimeAttemptId: z.uuid(),
      state: continuityCurrentSchema.shape.state,
    })
    .optional(),
  state: continuityRecordSchema.shape.state,
  supersededBy: z.uuid().optional(),
});
type ContinuityStatus = z.infer<typeof continuityStatusSchema>;
/** A separate opt-in read keeps legacy strict status consumers compatible. */
export const continuityCheckpointSchema = continuityStatusSchema.extend({
  checkpoints: z.strictObject({
    pendingStage: continuityRecordSchema.shape.pendingStage,
    runtimeLocator: z.enum(["recorded", "unrecorded"]),
    runtimeDispatch: z.enum(["recorded", "unrecorded"]),
    runtimeCommand: z.enum(["recorded", "unrecorded"]),
    publicationAttempt: z.enum(["recorded", "unrecorded"]),
    publicationCandidate: z.enum(["recorded", "unrecorded"]),
    environmentWrite: z.enum(["recorded", "unrecorded"]),
    suiteDispatch: z.enum(["recorded", "unrecorded"]),
    suiteCommand: z.enum(["recorded", "unrecorded"]),
    outcome: z.enum(["recorded", "unrecorded"]),
  }),
});
export const continuityCheckpoints = (record: ContinuityRecord) => ({
  ...continuityStatus(record),
  checkpoints: {
    ...(record.pendingStage === undefined ? {} : { pendingStage: record.pendingStage }),
    runtimeLocator: checkpointMarker(record.locator !== undefined),
    runtimeDispatch: checkpointMarker(record.locator?.dispatchAttempted === true),
    runtimeCommand: checkpointMarker(record.locator?.commandId !== undefined),
    publicationAttempt: checkpointMarker(record.deliveryAttempted === true),
    publicationCandidate: checkpointMarker(record.deliveryCandidates.length > 0),
    environmentWrite: checkpointMarker(record.environmentWrites.length > 0),
    suiteDispatch: checkpointMarker(record.suiteDispatched === true),
    suiteCommand: checkpointMarker(record.suiteCommandId !== undefined),
    outcome: checkpointMarker(record.outcome !== undefined),
  },
});

export const continuityPlannedSchema = z.strictObject({
  plan: hostedContinuityPlanSchema,
  request: hostedContinuityRequestSchema,
  status: continuityStatusSchema,
});
