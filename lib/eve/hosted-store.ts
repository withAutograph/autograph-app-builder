import type { NativeSendReadObservation } from "./hosted-submission-diagnostic";
import {
  nativeRecoveryDescriptorSchema,
  nativeRecoveryBindingSchema,
  sameNativeRecoveryDescriptor,
  assertNativeRecoveryReceipt,
} from "./native-recovery-contract";
import type { NativeRecoveryDescriptor, NativeRecoveryBinding } from "./native-recovery-contract";
import {
  resourceApprovalResponseMarkerSchema,
  resourceApprovalResponseProofSchema,
  provesResourceApprovalResponse,
} from "./resource-approval-response";
import type { ResourceApprovalResponseProof } from "./resource-approval-response";
import { digest } from "./hosted-operation-identifiers";
import type { NativeDeliveryState, SendDelivery } from "./native-delivery-state";
import {
  nativeDeliveryStateSchema,
  sendDeliverySchema,
  provesNativeDelivery,
} from "./native-delivery-state";
import {
  internalSessionLimitResponseSchema,
  provesSessionLimitResponse,
  privateInputStateSchema,
} from "./session-limit-input";
import {
  approvedBuildDecisionSchema,
  internalBuildContinuationSchema,
} from "../agent/approved-build-continuation";
import type { ApprovedBuildDecision } from "../agent/approved-build-continuation";
import { createHash } from "node:crypto";
import { z } from "zod";

import type { HostedPrincipal } from "./hosted-auth";
import { hostedPrincipalSchema, tenantKeyFor } from "./hosted-auth";
import {
  eveSessionResultSchema,
  publicEveEventSchema,
  publicInputRequestSchema,
  publicPrototypeSchema,
  publicUiPreviewSchema,
  publicWorkingPreviewSchema,
  publicSessionResumabilitySchema,
  publicSessionStageSchema,
  publicSessionSummarySchema,
  sessionStatusSchema,
} from "../mcp/contracts";
import type { PublicSessionSummary } from "../mcp/contracts";
import type { pagedCheckpointMetadataSchema } from "./postgres-hosted-checkpoint-history";
import {
  mergePrivateHostedApprovalReceipts,
  privateHostedApprovalReceiptSchema,
} from "./private-hosted-approval";
import type { PrivateHostedApprovalReceipt } from "./private-hosted-approval";

export const hostedOperationKindSchema = z.enum(["start", "resume", "send", "respond"]);
export type HostedOperationKind = z.infer<typeof hostedOperationKindSchema>;

export const hostedOperationStateSchema = z.enum([
  "reserved",
  "submission_unknown",
  "succeeded",
  "rejected",
]);

export const HOSTED_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const HOSTED_SESSION_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

export const hostedSessionTimeoutPolicySchema = z
  .object({
    idleTimeoutMs: z
      .number()
      .int()
      .min(60_000)
      .max(24 * 60 * 60 * 1000),
    maxLifetimeMs: z
      .number()
      .int()
      .min(60_000)
      .max(7 * 24 * 60 * 60 * 1000),
  })
  .strict()
  .refine(
    ({ idleTimeoutMs, maxLifetimeMs }) => idleTimeoutMs <= maxLifetimeMs,
    "Hosted session idle timeout cannot exceed its maximum lifetime.",
  );

export type HostedSessionTimeoutPolicy = z.infer<typeof hostedSessionTimeoutPolicySchema>;

export const DEFAULT_HOSTED_SESSION_TIMEOUT_POLICY = hostedSessionTimeoutPolicySchema.parse({
  idleTimeoutMs: HOSTED_SESSION_IDLE_TIMEOUT_MS,
  maxLifetimeMs: HOSTED_SESSION_MAX_LIFETIME_MS,
});

const legacyHostedSessionRecordSchema = z
  .object({
    adapterSessionId: z.string().min(1).max(500),
    createdAtEpochMs: z.number().int().nonnegative(),
    principal: hostedPrincipalSchema,
    sessionId: z.string().min(1).max(200),
    status: sessionStatusSchema,
    updatedAtEpochMs: z.number().int().nonnegative(),
    version: z.literal(1),
  })
  .strict()
  .refine(
    ({ createdAtEpochMs, updatedAtEpochMs }) => updatedAtEpochMs >= createdAtEpochMs,
    "Hosted session updates cannot precede creation.",
  );

export const hostedSessionCheckpointSchema = z
  .object({
    capturedAtEpochMs: z.number().int().nonnegative(),
    events: z.array(publicEveEventSchema).max(512),
    // Private legacy checkpoint bytes remain digest-stable for resume/cancel.
    // New checkpoints and every public projection omit this retired field.
    implementationPlan: z.unknown().optional(),
    inputRequests: z.array(publicInputRequestSchema).max(32).optional(),
    nativeDeliveryState: nativeDeliveryStateSchema.optional(),
    privateInputState: privateInputStateSchema.optional(),
    prototype: publicPrototypeSchema.optional(),
    status: sessionStatusSchema,
    truncatedBeforeIndex: z.number().int().nonnegative().optional(),
    uiPreview: publicUiPreviewSchema.optional(),
    version: z.literal(1),
    workingPreview: publicWorkingPreviewSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (checkpoint) => new TextEncoder().encode(JSON.stringify(checkpoint)).byteLength <= 512 * 1024,
    "Hosted session checkpoints must be at most 524288 bytes.",
  );

export type HostedSessionCheckpoint = z.infer<typeof hostedSessionCheckpointSchema>;
export type HostedPagedCheckpointMetadata = z.infer<typeof pagedCheckpointMetadataSchema>;
export interface HostedCheckpointPage {
  checkpointDigest: string;
  cursor: number;
  events: z.infer<typeof publicEveEventSchema>[];
  metadata: HostedPagedCheckpointMetadata;
  totalEvents: number;
}

export const hostedCheckpointRefSchema = z.strictObject({
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  eventCount: z.number().int().nonnegative(),
  id: z.string().uuid(),
});

const canonicalRecordValue = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalRecordValue).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalRecordValue(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

// JSON storage omits undefined object members and writes undefined array items
// as null. Hash the same shape that a checkpoint can retain after persistence.
const canonicalPersistedValue = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => (entry === undefined ? "null" : canonicalPersistedValue(entry))).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalPersistedValue(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export const hostedSessionCheckpointDigest = (checkpoint: HostedSessionCheckpoint): string => {
  const parsed = hostedSessionCheckpointSchema.parse(checkpoint);
  return `sha256:${createHash("sha256").update(canonicalPersistedValue(parsed)).digest("hex")}`;
};

export const hostedSessionCheckpointProgressDigest = (
  checkpoint: HostedSessionCheckpoint,
): string => {
  const { capturedAtEpochMs, ...progress } = hostedSessionCheckpointSchema.parse(checkpoint);
  void capturedAtEpochMs;
  return `sha256:${createHash("sha256").update(canonicalPersistedValue(progress)).digest("hex")}`;
};

// Older inline checkpoints hashed progress events with `turnId: undefined`.
// That key disappeared when the record was stored as JSON. Recognize only this
// known legacy shape, and require both old digests to match before recovery.
const legacyProgressTurnIdDigests = (checkpoint: HostedSessionCheckpoint) => {
  const legacy = hostedSessionCheckpointSchema.parse({
    ...checkpoint,
    events: checkpoint.events.map((event) =>
      event.type === "progress" && !("turnId" in event)
        ? // oxlint-disable-next-line sonarjs/no-undefined-assignment -- reproduce the legacy hashed shape exactly.
          { ...event, turnId: undefined }
        : event,
    ),
  });
  const { capturedAtEpochMs, ...progress } = legacy;
  void capturedAtEpochMs;
  return {
    checkpointDigest: `sha256:${createHash("sha256").update(canonicalRecordValue(legacy)).digest("hex")}`,
    progressDigest: `sha256:${createHash("sha256").update(canonicalRecordValue(progress)).digest("hex")}`,
  };
};

const reportCheckpointDigestMismatch = (
  record: {
    checkpoint?: HostedSessionCheckpoint;
    checkpointDigest?: string;
    checkpointProgressDigest?: string;
  },
  context: z.RefinementCtx,
) => {
  if (record.checkpoint === undefined) {
    return;
  }
  const computedCheckpointDigest = hostedSessionCheckpointDigest(record.checkpoint);
  const computedProgressDigest = hostedSessionCheckpointProgressDigest(record.checkpoint);
  if (
    computedCheckpointDigest !== record.checkpointDigest ||
    computedProgressDigest !== record.checkpointProgressDigest
  ) {
    const legacy = legacyProgressTurnIdDigests(record.checkpoint);
    if (
      legacy.checkpointDigest === record.checkpointDigest &&
      legacy.progressDigest === record.checkpointProgressDigest
    ) {
      return;
    }
  }
  if (computedCheckpointDigest !== record.checkpointDigest) {
    context.addIssue({
      code: "custom",
      message: `Hosted session checkpoint digest mismatch: stored ${record.checkpointDigest ?? "missing"}, computed ${computedCheckpointDigest}. Preserve the session and inspect checkpoint writes or source serialization before retrying.`,
    });
  }
  if (computedProgressDigest !== record.checkpointProgressDigest) {
    context.addIssue({
      code: "custom",
      message: `Hosted session checkpoint progress digest mismatch: stored ${record.checkpointProgressDigest ?? "missing"}, computed ${computedProgressDigest}. Preserve the session and inspect checkpoint writes or source serialization before retrying.`,
    });
  }
};

export const durableHostedSessionRecordSchema = z
  .object({
    cancellationRevision: z.number().int().nonnegative().optional(),
    adapterGeneration: z.number().int().positive(),
    adapterSessionId: z.string().min(1).max(500),
    appId: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u)
      .optional(),
    checkpoint: hostedSessionCheckpointSchema.optional(),
    checkpointDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .optional(),
    checkpointProgressDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .optional(),
    checkpointRef: hostedCheckpointRefSchema.optional(),
    createdAtEpochMs: z.number().int().nonnegative(),
    lastProgressAtEpochMs: z.number().int().nonnegative(),
    originAdapterSessionId: z.string().min(1).max(500),
    parentSessionId: z.string().min(1).max(200).optional(),
    principal: hostedPrincipalSchema,
    // Private Eve authority facts live beside the session record, outside its public checkpoint.
    privateApprovalReceipts: z.array(privateHostedApprovalReceiptSchema).optional(),
    privateBuildDecision: approvedBuildDecisionSchema.optional(),
    nativeRecoveryBinding: nativeRecoveryBindingSchema.optional(),
    resumability: publicSessionResumabilitySchema,
    sessionId: z.string().min(1).max(200),
    sourceHandoffId: z.string().uuid().optional(),
    stage: publicSessionStageSchema,
    status: sessionStatusSchema,
    title: z.string().min(1).max(200),
    updatedAtEpochMs: z.number().int().nonnegative(),
    version: z.literal(2),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.checkpoint !== undefined && record.checkpointRef !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Hosted session has two active checkpoint formats.",
      });
    }
    if (
      record.checkpointRef !== undefined &&
      record.checkpointDigest !== record.checkpointRef.digest
    ) {
      context.addIssue({
        code: "custom",
        message: "Hosted session checkpoint reference digest mismatch.",
      });
    }
    if (record.updatedAtEpochMs < record.createdAtEpochMs) {
      context.addIssue({
        code: "custom",
        message: "Hosted session updates cannot precede creation.",
      });
    }
    if (
      record.lastProgressAtEpochMs < record.createdAtEpochMs ||
      record.lastProgressAtEpochMs > record.updatedAtEpochMs
    ) {
      context.addIssue({
        code: "custom",
        message: "Hosted session progress must be within its durable lifetime.",
      });
    }
    if (
      (record.checkpoint === undefined && record.checkpointRef === undefined) !==
      (record.checkpointDigest === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Hosted session checkpoints require their exact digest.",
      });
    }
    if (
      (record.checkpoint === undefined && record.checkpointRef === undefined) !==
      (record.checkpointProgressDigest === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Hosted session checkpoints require their progress digest.",
      });
    }
    reportCheckpointDigestMismatch(record, context);
    if (record.checkpoint !== undefined && record.checkpoint.status !== record.status) {
      context.addIssue({
        code: "custom",
        message: "Hosted session checkpoint status mismatch.",
      });
    }
    if (
      record.adapterGeneration === 1 &&
      record.adapterSessionId !== record.originAdapterSessionId
    ) {
      context.addIssue({
        code: "custom",
        message: "The first adapter generation must retain its origin binding.",
      });
    }
  });

export const hostedSessionRecordSchema = z.discriminatedUnion("version", [
  legacyHostedSessionRecordSchema,
  durableHostedSessionRecordSchema,
]);

export type HostedSessionRecord = z.infer<typeof hostedSessionRecordSchema>;
export type DurableHostedSessionRecord = z.infer<typeof durableHostedSessionRecordSchema>;
export type HostedPagedSessionBase = Omit<
  Extract<DurableHostedSessionRecord, { version: 2 }>,
  "checkpoint" | "checkpointDigest" | "checkpointProgressDigest" | "checkpointRef"
>;

const legacySessionStage = (
  status: z.infer<typeof sessionStatusSchema>,
): z.infer<typeof publicSessionStageSchema> => {
  if (status === "completed") {
    return "complete";
  }
  if (["failed", "cancelled", "input_required"].includes(status)) {
    return "needs_attention";
  }
  return "designing";
};

export const toDurableHostedSessionRecord = (
  input: HostedSessionRecord,
): DurableHostedSessionRecord => {
  const record = hostedSessionRecordSchema.parse(input);
  if (record.version === 2) {
    return record;
  }
  return durableHostedSessionRecordSchema.parse({
    adapterGeneration: 1,
    adapterSessionId: record.adapterSessionId,
    createdAtEpochMs: record.createdAtEpochMs,
    lastProgressAtEpochMs: record.updatedAtEpochMs,
    originAdapterSessionId: record.adapterSessionId,
    principal: record.principal,
    resumability: "live",
    sessionId: record.sessionId,
    stage: legacySessionStage(record.status),
    status: record.status,
    title: "Previous App Builder session",
    updatedAtEpochMs: record.updatedAtEpochMs,
    version: 2,
  });
};

export const hostedSessionSummary = (input: HostedSessionRecord): PublicSessionSummary => {
  const record = toDurableHostedSessionRecord(input);
  const hasCheckpoint = record.checkpoint !== undefined || record.checkpointRef !== undefined;
  return publicSessionSummarySchema.parse({
    ...(record.appId === undefined ? {} : { appId: record.appId }),
    resumability:
      record.version === 2 && !hasCheckpoint && record.resumability !== "terminal"
        ? "restart_required"
        : record.resumability,
    sessionId: record.sessionId,
    stage: record.stage,
    status: record.status,
    title: record.title,
    updatedAt: new Date(record.updatedAtEpochMs).toISOString(),
  });
};

export const isHostedSessionExpired = (input: {
  record: HostedSessionRecord;
  nowEpochMs: number;
  policy?: HostedSessionTimeoutPolicy;
}) => {
  const record = hostedSessionRecordSchema.parse(input.record);
  const policy = hostedSessionTimeoutPolicySchema.parse(
    input.policy ?? DEFAULT_HOSTED_SESSION_TIMEOUT_POLICY,
  );
  return (
    input.nowEpochMs >= record.updatedAtEpochMs + policy.idleTimeoutMs ||
    input.nowEpochMs >= record.createdAtEpochMs + policy.maxLifetimeMs
  );
};

/** Compute recovery only. User-visible session records do not expire. */
export const isHostedSessionComputeLeaseExpired = isHostedSessionExpired;

export const hostedSessionRecordDigest = (record: HostedSessionRecord): string => {
  const parsed = hostedSessionRecordSchema.parse(record);
  return `sha256:${createHash("sha256").update(canonicalRecordValue(parsed)).digest("hex")}`;
};

/** Stable creation identity used by idempotent start receipts as sessions evolve. */
export const hostedSessionCreationDigest = (record: HostedSessionRecord): string => {
  const parsed = hostedSessionRecordSchema.parse(record);
  return `sha256:${createHash("sha256")
    .update(
      canonicalRecordValue({
        createdAtEpochMs: parsed.createdAtEpochMs,
        originAdapterSessionId:
          parsed.version === 1 ? parsed.adapterSessionId : parsed.originAdapterSessionId,
        principal: parsed.principal,
        sessionId: parsed.sessionId,
        version: 1,
        ...(parsed.version === 2 && parsed.sourceHandoffId
          ? { sourceHandoffId: parsed.sourceHandoffId }
          : {}),
      }),
    )
    .digest("hex")}`;
};

const hostedStartAliasSchema = z
  .object({
    canonicalClientRequestId: z.string().min(1).max(200),
    sourceHandoffId: z.string().uuid(),
  })
  .strict();

const reportInvalidStartAlias = (
  record: {
    clientRequestId: string;
    kind: HostedOperationKind;
    startAlias?: z.infer<typeof hostedStartAliasSchema>;
  },
  context: z.RefinementCtx,
): void => {
  if (
    record.startAlias !== undefined &&
    (record.kind !== "start" ||
      record.startAlias.canonicalClientRequestId === record.clientRequestId)
  ) {
    context.addIssue({
      code: "custom",
      message: "Only a start may alias a distinct canonical start request.",
    });
  }
};

const hostedOperationCommonShape = {
  clientRequestId: z.string().min(1).max(200),
  createdAtEpochMs: z.number().int().nonnegative(),
  internalBuildContinuation: internalBuildContinuationSchema.optional(),
  nativeRecovery: nativeRecoveryDescriptorSchema.optional(),
  nativeRecoveryReceipt: nativeRecoveryBindingSchema.optional(),
  internalSessionLimitResponse: internalSessionLimitResponseSchema.optional(),
  kind: hostedOperationKindSchema,
  operationId: z.string().min(1).max(200),
  principal: hostedPrincipalSchema,
  requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  resourceApprovalResponse: resourceApprovalResponseMarkerSchema.optional(),
  resumeSessionId: z.string().min(1).max(200).optional(),
  sendDelivery: sendDeliverySchema.optional(),
  startAlias: hostedStartAliasSchema.optional(),
  updatedAtEpochMs: z.number().int().nonnegative(),
  version: z.literal(1),
};

export const hostedOperationRecordSchema = z
  .discriminatedUnion("state", [
    z
      .object({
        ...hostedOperationCommonShape,
        sessionId: z.string().min(1).max(200).optional(),
        state: z.literal("reserved"),
      })
      .strict(),
    z
      .object({
        ...hostedOperationCommonShape,
        safeErrorCode: z.string().min(1).max(100),
        sessionId: z.string().min(1).max(200).optional(),
        state: z.literal("submission_unknown"),
      })
      .strict(),
    z
      .object({
        ...hostedOperationCommonShape,
        result: eveSessionResultSchema,
        sessionId: z.string().min(1).max(200),
        sessionRecordDigest: z
          .string()
          .regex(/^sha256:[a-f0-9]{64}$/u)
          .optional(),
        state: z.literal("succeeded"),
      })
      .strict(),
    z
      .object({
        ...hostedOperationCommonShape,
        safeErrorCode: z.string().min(1).max(100),
        sessionId: z.string().min(1).max(200).optional(),
        state: z.literal("rejected"),
      })
      .strict(),
  ])
  // oxlint-disable-next-line eslint/complexity, sonarjs/cognitive-complexity -- Operation parsing checks each durable recovery identity alongside the existing state machine.
  .superRefine((record, context) => {
    reportInvalidStartAlias(record, context);
    if (
      record.nativeRecovery !== undefined &&
      (record.kind !== "start" ||
        record.resumeSessionId !== record.nativeRecovery.sourcePublicSessionId ||
        record.operationId !== record.nativeRecovery.operationId)
    ) {
      context.addIssue({
        code: "custom",
        message: "Native recovery must bind its canonical parent start reservation.",
      });
    }
    if (record.nativeRecoveryReceipt !== undefined) {
      try {
        if (record.nativeRecovery === undefined) throw new Error("Recovery reservation absent.");
        assertNativeRecoveryReceipt(record.nativeRecovery, record.nativeRecoveryReceipt);
      } catch {
        context.addIssue({
          code: "custom",
          message: "Native recovery receipt must preserve its source reservation.",
        });
      }
    }
    if (record.state === "succeeded" && record.result.sessionId !== record.sessionId) {
      context.addIssue({
        code: "custom",
        message: "A succeeded operation must bind its result session.",
      });
    }
    if (record.kind === "start") {
      if (record.state === "succeeded" && record.sessionRecordDigest === undefined) {
        context.addIssue({
          code: "custom",
          message: "A succeeded start must bind its exact session record.",
        });
      }
      if (record.state !== "succeeded" && record.sessionId !== undefined) {
        context.addIssue({
          code: "custom",
          message: "An unsuccessful start cannot claim a session.",
        });
      }
      if (
        record.resumeSessionId !== undefined &&
        record.state === "succeeded" &&
        record.resumeSessionId === record.sessionId
      ) {
        context.addIssue({
          code: "custom",
          message: "A resumed child must not replace its parent session ID.",
        });
      }
    } else {
      if (record.resumeSessionId !== undefined) {
        context.addIssue({
          code: "custom",
          message: "Only a child-session start may bind a resume parent.",
        });
      }
      if (record.sessionId === undefined) {
        context.addIssue({
          code: "custom",
          message: "A session mutation must bind its session.",
        });
      }
      if (record.state === "succeeded" && record.sessionRecordDigest !== undefined) {
        context.addIssue({
          code: "custom",
          message: "A session mutation cannot create a session record.",
        });
      }
    }
  })
  .refine(
    (record) =>
      record.resourceApprovalResponse === undefined ||
      (record.kind === "respond" && record.internalSessionLimitResponse === undefined),
    "Only ordinary RESPOND can bind a resource approval batch.",
  )
  .refine(
    (record) => record.internalSessionLimitResponse === undefined || record.kind === "respond",
    "Only RESPOND can bind framework continuation input.",
  )
  .refine(
    (record) =>
      record.sendDelivery === undefined ||
      (record.kind === "send" &&
        record.sessionId === record.sendDelivery.sessionId &&
        record.requestDigest === record.sendDelivery.requestDigest),
    "A delivery acknowledgement must bind its exact canonical SEND.",
  );

export type HostedOperationRecord = z.infer<typeof hostedOperationRecordSchema>;

/** Current canonical source identity, never checkpoint/model prose, authorizes native access. */
// oxlint-disable-next-line eslint/complexity -- Every canonical source identity and cancellation fence is mandatory.
export const assertNativeRecoverySourceBinding = (
  operation: HostedOperationRecord,
  source: HostedSessionRecord | null,
  descriptor: NativeRecoveryDescriptor,
): void => {
  if (
    // oxlint-disable-next-line sonarjs/expression-complexity -- These comparisons form one authorization boundary.
    source === null ||
    source.version !== 2 ||
    source.status !== "failed" ||
    operation.kind !== "start" ||
    operation.resumeSessionId !== descriptor.sourcePublicSessionId ||
    operation.operationId !== descriptor.operationId ||
    operation.nativeRecovery === undefined ||
    !sameNativeRecoveryDescriptor(operation.nativeRecovery, descriptor) ||
    !["reserved", "submission_unknown", "succeeded"].includes(operation.state) ||
    tenantKeyFor(source.principal) !== tenantKeyFor(operation.principal) ||
    source.sessionId !== descriptor.sourcePublicSessionId ||
    source.adapterSessionId !== descriptor.sourceOwnerRunId ||
    source.adapterGeneration !== descriptor.sourceAdapterGeneration ||
    (source.cancellationRevision ?? 0) !== descriptor.parentCancellationRevision ||
    source.sourceHandoffId !== descriptor.sourceHandoffId ||
    (source.nativeRecoveryBinding?.logicalSessionId ?? source.adapterSessionId) !==
      descriptor.logicalSessionId ||
    (source.nativeRecoveryBinding?.originalAuthoritySessionId ?? source.sessionId) !==
      descriptor.originalAuthoritySessionId
  ) {
    throw new Error("Native recovery source ownership changed.");
  }
};

export const assertNativeRecoverySessionReceipt = (
  operation: HostedOperationRecord,
  session: HostedSessionRecord,
): void => {
  if (operation.nativeRecovery === undefined) return;
  const receipt = operation.nativeRecoveryReceipt;
  if (
    // oxlint-disable-next-line sonarjs/expression-complexity -- Child creation requires its exact committed native receipt.
    receipt === undefined ||
    session.version !== 2 ||
    session.nativeRecoveryBinding === undefined ||
    JSON.stringify(receipt) !== JSON.stringify(session.nativeRecoveryBinding) ||
    session.adapterSessionId !== receipt.ownerRunId ||
    session.parentSessionId !== receipt.sourcePublicSessionId
  ) {
    throw new Error("Recovered child lacks its canonical native owner receipt.");
  }
};

/** A recovered public child may receive build state only through its committed native owner receipt. */
export const assertRecoveredBuildContinuationChild = (
  authoritySessionId: string,
  logicalSessionId: string,
  source: HostedSessionRecord | null,
  child: HostedSessionRecord,
  operation: HostedOperationRecord | null,
): void => {
  if (
    // oxlint-disable-next-line sonarjs/expression-complexity -- The exact child, original authority, and committed receipt are one proof.
    child.version !== 2 ||
    source === null ||
    operation === null ||
    child.nativeRecoveryBinding === undefined ||
    child.nativeRecoveryBinding.originalAuthoritySessionId !== authoritySessionId ||
    child.nativeRecoveryBinding.logicalSessionId !== logicalSessionId ||
    child.parentSessionId !== source.sessionId ||
    operation.state !== "succeeded" ||
    operation.sessionId !== child.sessionId ||
    operation.nativeRecovery === undefined
  ) {
    throw new Error("Recovered build continuation owner changed.");
  }
  assertNativeRecoverySourceBinding(operation, source, operation.nativeRecovery);
  assertNativeRecoverySessionReceipt(operation, child);
};

/** Keep the original logical approval scope while binding a private decision to its current physical owner. */
export const recoveredBuildDecision = (
  decision: ApprovedBuildDecision | undefined,
  child: HostedSessionRecord,
): ApprovedBuildDecision | undefined =>
  decision === undefined
    ? undefined
    : approvedBuildDecisionSchema.parse({
        ...decision,
        adapterSessionId: child.adapterSessionId,
      });

export const inheritRecoveryBuildDecision = (
  source: HostedSessionRecord,
  authority: HostedSessionRecord,
  child: HostedSessionRecord,
): HostedSessionRecord => {
  const sourceDecision = toDurableHostedSessionRecord(source).privateBuildDecision;
  const authorityDecision = toDurableHostedSessionRecord(authority).privateBuildDecision;
  const sourceSequence = sourceDecision?.turnSequence ?? -1;
  const authoritySequence = authorityDecision?.turnSequence ?? -1;
  const sourceIsCurrentChild = source.version === 2 && source.nativeRecoveryBinding !== undefined;
  const latestDecision =
    sourceSequence > authoritySequence ||
    (sourceSequence === authoritySequence && sourceIsCurrentChild)
      ? sourceDecision
      : authorityDecision;
  return latestDecision === undefined
    ? child
    : durableHostedSessionRecordSchema.parse({
        ...toDurableHostedSessionRecord(child),
        privateBuildDecision: recoveredBuildDecision(latestDecision, child),
      });
};
export const unsettledSendAcknowledgementSchema = z.strictObject({
  operation: hostedOperationRecordSchema,
  cancellationRevisionAtDispatch: z.number().int().nonnegative().nullable(),
});
export type UnsettledSendAcknowledgement = z.infer<typeof unsettledSendAcknowledgementSchema>;
export const sendAcknowledgementCursorSchema = z.strictObject({
  createdAtEpochMs: z.number().int().nonnegative(),
  operationId: z.string().min(1),
});
export type SendAcknowledgementCursor = z.infer<typeof sendAcknowledgementCursorSchema>;
export const unsettledSendAcknowledgementPageSchema = z.strictObject({
  acknowledgements: z.array(unsettledSendAcknowledgementSchema),
  nextCursor: sendAcknowledgementCursorSchema.optional(),
});

const START_ALIAS_CANNOT_BIND = "The original start request cannot bind this canonical result.";

/** Copy a proven canonical start binding; this does not dispatch or create a second session. */
export const succeededStartAlias = (
  alias: HostedOperationRecord,
  canonical: HostedOperationRecord,
): HostedOperationRecord => {
  if (
    alias.kind !== "start" ||
    alias.startAlias === undefined ||
    !["reserved", "succeeded"].includes(alias.state)
  ) {
    throw new Error(START_ALIAS_CANNOT_BIND);
  }
  if (
    canonical.kind !== "start" ||
    canonical.startAlias !== undefined ||
    canonical.state !== "succeeded"
  ) {
    throw new Error(START_ALIAS_CANNOT_BIND);
  }
  if (
    canonical.clientRequestId !== alias.startAlias.canonicalClientRequestId ||
    tenantKeyFor(alias.principal) !== tenantKeyFor(canonical.principal)
  ) {
    throw new Error(START_ALIAS_CANNOT_BIND);
  }
  return hostedOperationRecordSchema.parse({
    ...alias,
    result: canonical.result,
    sessionId: canonical.sessionId,
    sessionRecordDigest: canonical.sessionRecordDigest,
    state: "succeeded",
    updatedAtEpochMs: Math.max(alias.updatedAtEpochMs, canonical.updatedAtEpochMs),
  });
};

export const assertExistingStartSession = (
  operation: HostedOperationRecord,
  session: HostedSessionRecord,
): void => {
  if (
    operation.kind !== "start" ||
    operation.state !== "succeeded" ||
    operation.startAlias !== undefined
  ) {
    throw new Error("The request is not a read-only existing-session start receipt.");
  }
  if (
    operation.sessionId !== session.sessionId ||
    tenantKeyFor(operation.principal) !== tenantKeyFor(session.principal) ||
    operation.sessionRecordDigest !== hostedSessionCreationDigest(session)
  ) {
    throw new Error("The existing-session start receipt does not bind this session.");
  }
};

const SESSION_NOT_FOUND = "Hosted session was not found.";

export const isDeliveredInternalContinuation = (operation: HostedOperationRecord): boolean =>
  operation.kind === "send" &&
  operation.state === "submission_unknown" &&
  operation.internalBuildContinuation?.deliveredTurnId !== undefined &&
  operation.internalBuildContinuation.deliveredMessageSequence !== undefined;

/** Unknown RESPOND is terminal only with exact typed resolution and the current owned adapter binding. */
export const isProvedSessionLimitResponse = (
  operation: HostedOperationRecord,
  current: HostedSessionRecord | null,
  proof: z.infer<typeof privateInputStateSchema> | undefined,
): boolean => {
  if (
    operation.kind !== "respond" ||
    operation.internalSessionLimitResponse === undefined ||
    current === null ||
    proof === undefined
  )
    return false;
  if (
    operation.sessionId !== current.sessionId ||
    tenantKeyFor(operation.principal) !== tenantKeyFor(current.principal)
  )
    return false;
  const durable = toDurableHostedSessionRecord(current);
  const marker = operation.internalSessionLimitResponse;
  return (
    durable.adapterSessionId === marker.adapterSessionId &&
    durable.adapterGeneration === marker.adapterGeneration &&
    provesSessionLimitResponse(marker, privateInputStateSchema.parse(proof))
  );
};

/** The checkpoint is read by the store; caller proof supplies only the original request and binding. */
export const isProvedResourceApprovalResponse = (
  operation: HostedOperationRecord,
  current: HostedSessionRecord | null,
  proofInput: ResourceApprovalResponseProof | undefined,
  metadata: HostedPagedCheckpointMetadata | null,
): boolean => {
  const parsed = resourceApprovalResponseProofSchema.safeParse(proofInput);
  if (!parsed.success || current?.version !== 2 || metadata === null) return false;
  const proof = parsed.data;
  const native = metadata.nativeObservationState;
  if (current.checkpointRef === undefined || native === undefined) return false;
  const invalidBinding = [
    operation.kind !== "respond",
    operation.internalSessionLimitResponse !== undefined,
    operation.sessionId !== current.sessionId,
    tenantKeyFor(operation.principal) !== tenantKeyFor(current.principal),
    current.adapterSessionId !== proof.adapterSessionId,
    current.adapterGeneration !== proof.adapterGeneration,
    current.checkpointDigest !== proof.checkpointDigest,
    metadata.coldReadProgress !== undefined,
    native.adapterSessionId !== current.adapterSessionId,
    native.publicEventCount !== current.checkpointRef.eventCount,
  ].some(Boolean);
  if (invalidBinding) return false;
  const marker = operation.resourceApprovalResponse;
  if (marker === undefined) {
    // Historical reservations did not save a binding. Only a never-replaced original adapter can prove one.
    if (
      current.adapterGeneration !== 1 ||
      current.adapterSessionId !== current.originAdapterSessionId
    )
      return false;
  } else if (
    marker.adapterSessionId !== current.adapterSessionId ||
    marker.adapterGeneration !== current.adapterGeneration
  )
    return false;
  return provesResourceApprovalResponse({
    clientRequestId: operation.clientRequestId,
    requestDigest: operation.requestDigest,
    sessionId: current.sessionId,
    ownerUserId: current.principal.ownerUserId,
    marker,
    proof,
    state: native.privateInputState,
    capture: metadata.privateApprovalCaptureState,
    receipts: current.privateApprovalReceipts ?? [],
  });
};

const SEND_BINDING_UNAVAILABLE = "Canonical SEND acknowledgement binding is unavailable.";
export const bindSendDelivery = (
  operation: HostedOperationRecord,
  current: HostedSessionRecord | null,
  marker: SendDelivery,
): HostedOperationRecord => {
  const delivery = sendDeliverySchema.parse(marker);
  if (
    operation.kind !== "send" ||
    operation.internalBuildContinuation !== undefined ||
    current === null
  )
    throw new Error(SEND_BINDING_UNAVAILABLE);
  if (
    operation.sessionId !== delivery.sessionId ||
    operation.requestDigest !== delivery.requestDigest ||
    current.sessionId !== delivery.sessionId
  )
    throw new Error(SEND_BINDING_UNAVAILABLE);
  if (
    tenantKeyFor(operation.principal) !== tenantKeyFor(current.principal) ||
    (operation.state !== "reserved" && operation.state !== "submission_unknown")
  )
    throw new Error(SEND_BINDING_UNAVAILABLE);
  const durable = toDurableHostedSessionRecord(current);
  if (
    durable.adapterSessionId !== delivery.adapterSessionId ||
    durable.adapterGeneration !== delivery.adapterGeneration
  )
    throw new Error("Canonical SEND acknowledgement binding changed.");
  if (operation.sendDelivery !== undefined && digest(operation.sendDelivery) !== digest(delivery))
    throw new Error("Canonical SEND acknowledgement binding changed.");
  return hostedOperationRecordSchema.parse({ ...operation, sendDelivery: delivery });
};
export const isProvedSendDelivery = (
  operation: HostedOperationRecord,
  current: HostedSessionRecord | null,
  proof: NativeDeliveryState | undefined,
): boolean => {
  const marker = operation.sendDelivery;
  if (operation.kind !== "send" || marker === undefined || current === null) return false;
  if (
    operation.sessionId !== current.sessionId ||
    marker.requestDigest !== operation.requestDigest ||
    marker.sessionId !== operation.sessionId
  )
    return false;
  if (tenantKeyFor(operation.principal) !== tenantKeyFor(current.principal)) return false;
  const durable = toDurableHostedSessionRecord(current);
  return (
    durable.adapterSessionId === marker.adapterSessionId &&
    durable.adapterGeneration === marker.adapterGeneration &&
    provesNativeDelivery(marker, proof)
  );
};

export interface SendObservationBinding {
  adapterSessionId: string;
  adapterGeneration: number;
  cancellationRevision: number;
}
/** Queued acceptance never substitutes for native delivery proof or changes cancellation authority. */
export const canProjectQueuedSendAcknowledgement = (input: {
  acknowledgement: UnsettledSendAcknowledgement;
  current: HostedSessionRecord;
  result: z.infer<typeof eveSessionResultSchema>;
  observation: NativeSendReadObservation;
  observedBinding: SendObservationBinding;
  proof?: NativeDeliveryState;
}): boolean => {
  const { operation, cancellationRevisionAtDispatch } = input.acknowledgement;
  const marker = operation.sendDelivery;
  const current = toDurableHostedSessionRecord(input.current);
  if (
    operation.kind !== "send" ||
    operation.internalBuildContinuation !== undefined ||
    marker === undefined ||
    cancellationRevisionAtDispatch === null
  )
    return false;
  if (operation.state !== "reserved" && operation.state !== "submission_unknown") return false;
  if (input.result.status !== "waiting" && input.result.status !== "working") return false;
  if (input.result.error !== undefined || (input.result.inputRequests?.length ?? 0) > 0)
    return false;
  if (["cancelled", "completed", "failed", "input_required"].includes(current.status)) return false;
  if (
    input.observation.observationComplete !== true ||
    input.observation.nativeNextIndex === undefined ||
    input.observation.nativeTailIndex === undefined ||
    input.observation.nativeNextIndex !== input.observation.nativeTailIndex + 1
  )
    return false;
  if (isProvedSendDelivery(operation, current, input.proof)) return false;
  return [
    operation.sessionId === current.sessionId,
    input.result.sessionId === current.sessionId,
    marker.sessionId === current.sessionId,
    marker.requestDigest === operation.requestDigest,
    tenantKeyFor(operation.principal) === tenantKeyFor(current.principal),
    current.adapterSessionId === marker.adapterSessionId,
    current.adapterGeneration === marker.adapterGeneration,
    (current.cancellationRevision ?? 0) === cancellationRevisionAtDispatch,
    input.observedBinding.adapterSessionId === current.adapterSessionId,
    input.observedBinding.adapterGeneration === current.adapterGeneration,
    input.observedBinding.cancellationRevision === cancellationRevisionAtDispatch,
  ].every(Boolean);
};

/** Only the exact explicit SEND may replace its prior cancellation after native delivery proof. */
export const mayReviveCancelledSession = (
  operation: HostedOperationRecord | null,
  current: HostedSessionRecord,
  proof?: NativeDeliveryState,
): boolean => {
  if (
    current.status !== "cancelled" ||
    operation === null ||
    !["reserved", "submission_unknown"].includes(operation.state)
  ) {
    return false;
  }
  const revision = operation.sendDelivery?.resumeCancellationRevision;
  return (
    revision !== undefined &&
    revision === (toDurableHostedSessionRecord(current).cancellationRevision ?? 0) &&
    isProvedSendDelivery(operation, current, proof)
  );
};

const maySettleHostedOperation = (
  operation: HostedOperationRecord,
  provedResolution = false,
): boolean => {
  if (operation.state === "reserved" || isDeliveredInternalContinuation(operation)) return true;
  if (operation.state !== "submission_unknown") return false;
  return operation.kind === "start" || provedResolution;
};

export const withoutHostedOperationError = (operation: HostedOperationRecord) => {
  if (operation.state !== "submission_unknown") {
    return operation;
  }
  const { safeErrorCode, ...record } = operation;
  void safeErrorCode;
  return record;
};

export const reserveOperationResultSchema = z.discriminatedUnion("disposition", [
  z
    .object({
      disposition: z.literal("reserved"),
      operation: hostedOperationRecordSchema,
    })
    .strict(),
  z
    .object({
      disposition: z.literal("existing"),
      operation: hostedOperationRecordSchema,
    })
    .strict(),
  z.object({ disposition: z.literal("conflict") }).strict(),
  z
    .object({
      disposition: z.literal("rejected"),
      reason: z.literal("session_busy"),
    })
    .strict(),
]);

export type ReserveOperationResult = z.infer<typeof reserveOperationResultSchema>;

/**
 * Durable implementations must make every method atomic. All lookup methods
 * require a principal and must include its issuer, audience, workspace, and
 * owner in the storage predicate. `settleSucceeded` must atomically persist an
 * optional new session and the terminal operation result.
 */
export interface HostedEveStore {
  getPrivateOperation?: (
    principal: HostedPrincipal,
    operationId: string,
  ) => Promise<HostedOperationRecord | null>;
  recordPrivateBuildDecision?: (input: {
    principal: HostedPrincipal;
    sessionId: string;
    decision: ApprovedBuildDecision;
  }) => Promise<void>;
  claimInternalBuildMessage?: (input: {
    principal: HostedPrincipal;
    sessionId: string;
    logicalSessionId?: string;
    operationId: string;
    nonce: string;
    turnId: string;
    turnSequence: number;
    messageSequence: number;
  }) => Promise<boolean>;

  /** Append raw Eve approval settlements to the owner-scoped session record. */
  recordPrivateApprovalReceipts?: (input: {
    principal: z.infer<typeof hostedPrincipalSchema>;
    sessionId: string;
    receipts: readonly PrivateHostedApprovalReceipt[];
  }) => Promise<void>;
  bindExistingStart?: (
    principal: z.infer<typeof hostedPrincipalSchema>,
    candidate: HostedOperationRecord,
  ) => Promise<HostedOperationRecord>;
  /** Exact caller-owned start lookup; never searches another tenant or user. */
  getStartOperation?: (
    principal: z.infer<typeof hostedPrincipalSchema>,
    clientRequestId: string,
  ) => Promise<HostedOperationRecord | null>;
  /** Exact tenant-scoped lookup through the unique adapter binding. */
  getSessionByAdapterSessionId?: (
    principal: z.infer<typeof hostedPrincipalSchema>,
    adapterSessionId: string,
  ) => Promise<HostedSessionRecord | null>;
  settleStartAlias?: (input: {
    principal: z.infer<typeof hostedPrincipalSchema>;
    clientRequestId: string;
    canonicalClientRequestId: string;
  }) => Promise<void>;
  reserveOperation: (
    principal: z.infer<typeof hostedPrincipalSchema>,
    candidate: HostedOperationRecord,
  ) => Promise<ReserveOperationResult>;
  commitNativeRecoveryReceipt?: (input: {
    principal: HostedPrincipal;
    descriptor: NativeRecoveryDescriptor;
    recoveryBinding: NativeRecoveryBinding;
    nowEpochMs: number;
  }) => Promise<NativeRecoveryBinding>;
  recordCancellationIntent?: (input: {
    principal: HostedPrincipal;
    sessionId: string;
    nowEpochMs: number;
  }) => Promise<HostedSessionRecord>;
  recordSendDelivery?: (input: {
    principal: HostedPrincipal;
    operationId: string;
    delivery: SendDelivery;
    cancellationRevisionAtDispatch?: number;
    nowEpochMs: number;
  }) => Promise<HostedOperationRecord>;
  /** Owner/session-scoped durable ACK lookup; no provider observation or mutation. */
  readUnsettledSendAcknowledgements?: (input: {
    principal: HostedPrincipal;
    sessionId: string;
    operationId?: string;
    cursor?: SendAcknowledgementCursor;
    limit: number;
  }) => Promise<z.infer<typeof unsettledSendAcknowledgementPageSchema>>;
  settleSucceeded: (input: {
    principal: z.infer<typeof hostedPrincipalSchema>;
    operationId: string;
    requestDigest: string;
    result: z.infer<typeof eveSessionResultSchema>;
    session?: HostedSessionRecord;
    sessionLimitResolution?: z.infer<typeof privateInputStateSchema>;
    sendDeliveryResolution?: NativeDeliveryState;
    resourceApprovalResolution?: ResourceApprovalResponseProof;
    nowEpochMs: number;
  }) => Promise<HostedOperationRecord>;
  settleSucceededPaged?: (input: {
    principal: z.infer<typeof hostedPrincipalSchema>;
    operationId: string;
    requestDigest: string;
    result: z.infer<typeof eveSessionResultSchema>;
    session: HostedPagedSessionBase;
    metadata: HostedPagedCheckpointMetadata;
    events: AsyncIterable<z.infer<typeof publicEveEventSchema>>;
    nowEpochMs: number;
  }) => Promise<HostedOperationRecord>;
  settleUnsuccessful: (input: {
    principal: z.infer<typeof hostedPrincipalSchema>;
    operationId: string;
    requestDigest: string;
    state: "submission_unknown" | "rejected";
    safeErrorCode: string;
    nowEpochMs: number;
  }) => Promise<HostedOperationRecord>;
  /** After a complete idle Eve observation, release only old unanswered mutations. */
  settleIdleReservations?: (input: {
    principal: z.infer<typeof hostedPrincipalSchema>;
    sessionId: string;
    beforeEpochMs: number;
    nowEpochMs: number;
  }) => Promise<number>;
  getSession: (
    principal: z.infer<typeof hostedPrincipalSchema>,
    sessionId: string,
  ) => Promise<HostedSessionRecord | null>;
  listSessions: (input: {
    principal: z.infer<typeof hostedPrincipalSchema>;
    cursor: number;
    limit: number;
  }) => Promise<{
    sessions: HostedSessionRecord[];
    cursor: number;
  }>;
  observeSession?: (input: {
    explicitSendOperationId?: string;
    principal: z.infer<typeof hostedPrincipalSchema>;
    sessionId: string;
    checkpoint: HostedSessionCheckpoint;
    stage: z.infer<typeof publicSessionStageSchema>;
    resumability: z.infer<typeof publicSessionResumabilitySchema>;
    appId?: string;
    nowEpochMs: number;
  }) => Promise<HostedSessionRecord>;
  observeSessionPaged?: (input: {
    explicitSendOperationId?: string;
    principal: z.infer<typeof hostedPrincipalSchema>;
    sessionId: string;
    expectedCheckpointDigest: string | undefined;
    metadata: HostedPagedCheckpointMetadata;
    events: AsyncIterable<z.infer<typeof publicEveEventSchema>>;
    stage: z.infer<typeof publicSessionStageSchema>;
    resumability: z.infer<typeof publicSessionResumabilitySchema>;
    appId?: string;
    nowEpochMs: number;
  }) => Promise<HostedSessionRecord>;
  readCheckpointPage?: (input: {
    principal: z.infer<typeof hostedPrincipalSchema>;
    sessionId: string;
    checkpointRef: z.infer<typeof hostedCheckpointRefSchema>;
    cursor: number;
    limit: number;
  }) => Promise<HostedCheckpointPage>;
  replaceSessionAdapter?: (input: {
    principal: z.infer<typeof hostedPrincipalSchema>;
    sessionId: string;
    expectedAdapterGeneration: number;
    expectedCheckpointDigest?: string;
    adapterSessionId: string;
    checkpoint: HostedSessionCheckpoint;
    stage: z.infer<typeof publicSessionStageSchema>;
    resumability: z.infer<typeof publicSessionResumabilitySchema>;
    appId?: string;
    nowEpochMs: number;
  }) => Promise<HostedSessionRecord>;
  replaceSessionAdapterPaged?: (input: {
    principal: z.infer<typeof hostedPrincipalSchema>;
    sessionId: string;
    expectedAdapterGeneration: number;
    expectedCheckpointDigest?: string;
    adapterSessionId: string;
    metadata: HostedPagedCheckpointMetadata;
    events: AsyncIterable<z.infer<typeof publicEveEventSchema>>;
    stage: z.infer<typeof publicSessionStageSchema>;
    resumability: z.infer<typeof publicSessionResumabilitySchema>;
    appId?: string;
    nowEpochMs: number;
  }) => Promise<HostedSessionRecord>;
}

/** Test/local conformance store. Hosted deployment must supply durable storage. */
export class InMemoryHostedEveStore implements HostedEveStore {
  private readonly operations = new Map<string, HostedOperationRecord>();
  private readonly sendCancellationRevisions = new Map<string, number>();
  private readonly sessions = new Map<string, HostedSessionRecord>();

  private currentBuildSession(
    principal: HostedPrincipal,
    authoritySessionId: string,
    logicalSessionId: string,
  ): DurableHostedSessionRecord {
    const authority = this.sessions.get(
      InMemoryHostedEveStore.sessionKey(principal, authoritySessionId),
    );
    if (authority === undefined) throw new Error(SESSION_NOT_FOUND);
    const tenant = tenantKeyFor(principal);
    const children = [...this.sessions.values()].filter(
      (candidate) =>
        tenantKeyFor(candidate.principal) === tenant &&
        candidate.version === 2 &&
        candidate.nativeRecoveryBinding?.originalAuthoritySessionId === authoritySessionId &&
        candidate.nativeRecoveryBinding.logicalSessionId === logicalSessionId,
    );
    for (const child of children) {
      if (child.version !== 2 || child.nativeRecoveryBinding === undefined)
        throw new Error(SESSION_NOT_FOUND);
      assertRecoveredBuildContinuationChild(
        authoritySessionId,
        logicalSessionId,
        this.sessions.get(
          InMemoryHostedEveStore.sessionKey(principal, child.parentSessionId ?? ""),
        ) ?? null,
        child,
        this.operations.get(
          InMemoryHostedEveStore.operationKey(principal, child.nativeRecoveryBinding.operationId),
        ) ?? null,
      );
    }
    const leaves = children.filter(
      (candidate) =>
        !children.some(
          (child) => child.version === 2 && child.parentSessionId === candidate.sessionId,
        ),
    );
    if (leaves.length > 1) throw new Error("Recovered build continuation owner is ambiguous.");
    const current = leaves[0] ?? authority;
    if (leaves.length === 0 && current.adapterSessionId !== logicalSessionId) {
      throw new Error(SESSION_NOT_FOUND);
    }
    return toDurableHostedSessionRecord(current);
  }

  async bindExistingStart(
    principal: z.infer<typeof hostedPrincipalSchema>,
    candidateInput: HostedOperationRecord,
  ): Promise<HostedOperationRecord> {
    const candidate = hostedOperationRecordSchema.parse(candidateInput);
    if (
      tenantKeyFor(principal) !== tenantKeyFor(candidate.principal) ||
      candidate.sessionId === undefined
    ) {
      throw new Error("Hosted store principal mismatch.");
    }
    const session = await this.getSession(principal, candidate.sessionId);
    if (session === null) throw new Error(SESSION_NOT_FOUND);
    assertExistingStartSession(candidate, session);
    const key = InMemoryHostedEveStore.operationKey(principal, candidate.operationId);
    const existing = this.operations.get(key);
    if (existing !== undefined) {
      if (
        existing.requestDigest !== candidate.requestDigest ||
        existing.resumeSessionId !== candidate.resumeSessionId ||
        existing.sessionId !== candidate.sessionId
      ) {
        throw new Error("The existing-session start request conflicts with its saved receipt.");
      }
      return structuredClone(existing);
    }
    this.operations.set(key, structuredClone(candidate));
    return structuredClone(candidate);
  }

  // oxlint-disable-next-line eslint/require-await -- Keep the durable store interface.
  async getStartOperation(
    principal: z.infer<typeof hostedPrincipalSchema>,
    clientRequestId: string,
  ): Promise<HostedOperationRecord | null> {
    const operation = [...this.operations.values()].find(
      (candidate) =>
        (candidate.kind === "start" || candidate.kind === "resume") &&
        candidate.clientRequestId === clientRequestId &&
        tenantKeyFor(candidate.principal) === tenantKeyFor(principal),
    );
    return operation === undefined ? null : structuredClone(operation);
  }

  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
  async reserveOperation(
    principal: z.infer<typeof hostedPrincipalSchema>,
    candidate: HostedOperationRecord,
  ): Promise<ReserveOperationResult> {
    const parsed = hostedOperationRecordSchema.parse(candidate);
    if (tenantKeyFor(parsed.principal) !== tenantKeyFor(principal)) {
      return { disposition: "conflict" };
    }
    const key = InMemoryHostedEveStore.operationKey(principal, parsed.operationId);
    const existing = this.operations.get(key);
    if (existing !== undefined) {
      const sameRequest =
        existing.requestDigest === parsed.requestDigest &&
        existing.kind === parsed.kind &&
        existing.clientRequestId === parsed.clientRequestId &&
        JSON.stringify(existing.nativeRecovery) === JSON.stringify(parsed.nativeRecovery);
      return sameRequest &&
        existing.startAlias?.canonicalClientRequestId ===
          parsed.startAlias?.canonicalClientRequestId &&
        existing.startAlias?.sourceHandoffId === parsed.startAlias?.sourceHandoffId
        ? { disposition: "existing", operation: structuredClone(existing) }
        : { disposition: "conflict" };
    }
    if (
      parsed.kind !== "start" &&
      [...this.operations.values()].some(
        (record) =>
          record.state === "reserved" &&
          record.sessionId === parsed.sessionId &&
          tenantKeyFor(record.principal) === tenantKeyFor(principal),
      )
    ) {
      return { disposition: "rejected", reason: "session_busy" };
    }
    if (
      parsed.kind === "start" &&
      parsed.resumeSessionId !== undefined &&
      [...this.operations.values()].some(
        (record) =>
          // oxlint-disable-next-line sonarjs/expression-complexity -- Unknown and receipt-bearing recovery reserve the same failed source.
          (record.state === "reserved" ||
            record.state === "submission_unknown" ||
            (parsed.nativeRecovery !== undefined && record.nativeRecoveryReceipt !== undefined)) &&
          record.kind === "start" &&
          record.resumeSessionId === parsed.resumeSessionId &&
          tenantKeyFor(record.principal) === tenantKeyFor(principal),
      )
    ) {
      return { disposition: "rejected", reason: "session_busy" };
    }
    if (parsed.nativeRecovery !== undefined) {
      assertNativeRecoverySourceBinding(
        parsed,
        this.sessions.get(
          InMemoryHostedEveStore.sessionKey(principal, parsed.nativeRecovery.sourcePublicSessionId),
        ) ?? null,
        parsed.nativeRecovery,
      );
    }
    this.operations.set(key, structuredClone(parsed));
    return { disposition: "reserved", operation: structuredClone(parsed) };
  }

  // oxlint-disable-next-line eslint/require-await -- In-memory storage preserves the async durable-store contract.
  async commitNativeRecoveryReceipt(
    input: Parameters<NonNullable<HostedEveStore["commitNativeRecoveryReceipt"]>>[0],
  ): Promise<NativeRecoveryBinding> {
    const descriptor = nativeRecoveryDescriptorSchema.parse(input.descriptor);
    const receipt = nativeRecoveryBindingSchema.parse(input.recoveryBinding);
    assertNativeRecoveryReceipt(descriptor, receipt);
    const key = InMemoryHostedEveStore.operationKey(input.principal, descriptor.operationId);
    const operation = this.operations.get(key);
    if (operation === undefined) throw new Error("Native recovery reservation is unavailable.");
    const source =
      this.sessions.get(
        InMemoryHostedEveStore.sessionKey(input.principal, descriptor.sourcePublicSessionId),
      ) ?? null;
    assertNativeRecoverySourceBinding(operation, source, descriptor);
    if (operation.nativeRecoveryReceipt !== undefined) {
      if (JSON.stringify(operation.nativeRecoveryReceipt) !== JSON.stringify(receipt))
        throw new Error("Native recovery owner receipt conflicts.");
      return structuredClone(operation.nativeRecoveryReceipt);
    }
    if (operation.state === "succeeded")
      throw new Error("Native recovery receipt was not committed before activation.");
    this.operations.set(
      key,
      hostedOperationRecordSchema.parse({
        ...operation,
        nativeRecoveryReceipt: receipt,
        updatedAtEpochMs: Math.max(operation.updatedAtEpochMs, input.nowEpochMs),
      }),
    );
    return structuredClone(receipt);
  }

  async settleStartAlias(
    input: Parameters<NonNullable<HostedEveStore["settleStartAlias"]>>[0],
  ): Promise<void> {
    const [alias, canonical] = await Promise.all([
      this.getStartOperation(input.principal, input.clientRequestId),
      this.getStartOperation(input.principal, input.canonicalClientRequestId),
    ]);
    if (alias === null || canonical === null) {
      throw new Error("The original start request binding is unavailable.");
    }
    const settled = succeededStartAlias(alias, canonical);
    this.operations.set(
      InMemoryHostedEveStore.operationKey(input.principal, alias.operationId),
      structuredClone(settled),
    );
  }

  // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous canonical store contract.
  async recordCancellationIntent(
    input: Parameters<NonNullable<HostedEveStore["recordCancellationIntent"]>>[0],
  ): Promise<HostedSessionRecord> {
    const key = InMemoryHostedEveStore.sessionKey(input.principal, input.sessionId);
    const current = this.sessions.get(key);
    if (current === undefined) throw new Error(SESSION_NOT_FOUND);
    const durable = toDurableHostedSessionRecord(current);
    const updated = durableHostedSessionRecordSchema.parse({
      ...durable,
      cancellationRevision: (durable.cancellationRevision ?? 0) + 1,
      updatedAtEpochMs: Math.max(durable.updatedAtEpochMs, input.nowEpochMs),
    });
    this.sessions.set(key, structuredClone(updated));
    return structuredClone(updated);
  }

  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
  async recordSendDelivery(
    input: Parameters<NonNullable<HostedEveStore["recordSendDelivery"]>>[0],
  ): Promise<HostedOperationRecord> {
    const key = InMemoryHostedEveStore.operationKey(input.principal, input.operationId);
    const operation = this.operations.get(key);
    if (operation === undefined) throw new Error("Canonical SEND is unavailable.");
    const current = await this.getSession(input.principal, input.delivery.sessionId);
    const updated = hostedOperationRecordSchema.parse({
      ...bindSendDelivery(operation, current, input.delivery),
      updatedAtEpochMs: input.nowEpochMs,
    });
    const atCommit = this.sessions.get(
      InMemoryHostedEveStore.sessionKey(input.principal, input.delivery.sessionId),
    );
    if (this.operations.get(key) !== operation || atCommit === undefined) {
      throw new Error("Canonical SEND changed before ACK persistence.");
    }
    bindSendDelivery(operation, atCommit, input.delivery);
    const baseline = input.cancellationRevisionAtDispatch;
    const savedBaseline = this.sendCancellationRevisions.get(key);
    if (baseline !== undefined) {
      z.number().int().nonnegative().parse(baseline);
      if (
        (toDurableHostedSessionRecord(atCommit).cancellationRevision ?? 0) !== baseline ||
        (savedBaseline !== undefined && savedBaseline !== baseline)
      ) {
        throw new Error("Canonical SEND cancellation changed before ACK persistence.");
      }
      if (operation.sendDelivery === undefined) {
        this.sendCancellationRevisions.set(key, baseline);
      }
    }
    this.operations.set(key, structuredClone(updated));
    return structuredClone(updated);
  }

  readUnsettledSendAcknowledgements: HostedEveStore["readUnsettledSendAcknowledgements"] = (
    input,
  ) => {
    const principal = hostedPrincipalSchema.parse(input.principal);
    z.number().int().positive().parse(input.limit);
    const cursor =
      input.cursor === undefined ? undefined : sendAcknowledgementCursorSchema.parse(input.cursor);
    const operations = [...this.operations.values()]
      .filter((operation) => {
        if (
          tenantKeyFor(operation.principal) !== tenantKeyFor(principal) ||
          operation.sessionId !== input.sessionId ||
          operation.kind !== "send"
        ) {
          return false;
        }
        if (
          operation.internalBuildContinuation !== undefined ||
          operation.sendDelivery === undefined
        ) {
          return false;
        }
        if (operation.state !== "reserved" && operation.state !== "submission_unknown") {
          return false;
        }
        if (input.operationId !== undefined && operation.operationId !== input.operationId) {
          return false;
        }
        if (cursor === undefined) {
          return true;
        }
        return (
          operation.createdAtEpochMs > cursor.createdAtEpochMs ||
          (operation.createdAtEpochMs === cursor.createdAtEpochMs &&
            operation.operationId > cursor.operationId)
        );
      })
      .toSorted(
        (left, right) =>
          left.createdAtEpochMs - right.createdAtEpochMs ||
          (left.operationId < right.operationId
            ? -1
            : Number(left.operationId > right.operationId)),
      );
    const page = operations.slice(0, input.limit);
    const last = page.at(-1);
    return Promise.resolve(
      unsettledSendAcknowledgementPageSchema.parse({
        acknowledgements: page.map((operation) => ({
          operation: structuredClone(operation),
          cancellationRevisionAtDispatch:
            this.sendCancellationRevisions.get(
              InMemoryHostedEveStore.operationKey(principal, operation.operationId),
            ) ?? null,
        })),
        ...(operations.length > page.length && last !== undefined
          ? {
              nextCursor: {
                createdAtEpochMs: last.createdAtEpochMs,
                operationId: last.operationId,
              },
            }
          : {}),
      }),
    );
  };

  // oxlint-disable-next-line eslint/complexity -- Settlement now checks the native recovery receipt alongside existing operation guards.
  async settleSucceeded(
    input: Parameters<HostedEveStore["settleSucceeded"]>[0],
  ): Promise<HostedOperationRecord> {
    const operation = this.operations.get(
      InMemoryHostedEveStore.operationKey(input.principal, input.operationId),
    );
    if (operation === undefined || operation.requestDigest !== input.requestDigest) {
      throw new Error("Hosted operation cannot settle at this digest.");
    }
    const [provedResponse, provedSend, provedApproval] = await Promise.all([
      this.provedSessionLimitResponse(operation, input.sessionLimitResolution),
      this.provedSendDelivery(operation, input.sendDeliveryResolution),
      this.provedResourceApprovalResponse(operation, input.resourceApprovalResolution),
    ]);
    if (
      !maySettleHostedOperation(
        operation,
        [provedResponse, provedSend, provedApproval].some(Boolean),
      )
    ) {
      throw new Error("Hosted operation cannot settle at this digest.");
    }
    const result = eveSessionResultSchema.parse(input.result);
    let session =
      input.session === undefined ? undefined : hostedSessionRecordSchema.parse(input.session);
    if (
      session !== undefined &&
      tenantKeyFor(session.principal) !== tenantKeyFor(input.principal)
    ) {
      throw new Error("Hosted store principal mismatch.");
    }
    if (operation.kind === "start" && session === undefined) {
      throw new Error("A successful start must atomically persist its session.");
    }
    if (session !== undefined && operation.nativeRecovery !== undefined) {
      const source =
        this.sessions.get(
          InMemoryHostedEveStore.sessionKey(
            input.principal,
            operation.nativeRecovery.sourcePublicSessionId,
          ),
        ) ?? null;
      assertNativeRecoverySourceBinding(operation, source, operation.nativeRecovery);
      assertNativeRecoverySessionReceipt(operation, session);
      const authority = this.sessions.get(
        InMemoryHostedEveStore.sessionKey(
          input.principal,
          operation.nativeRecovery.originalAuthoritySessionId,
        ),
      );
      if (source === null || authority === undefined) {
        throw new Error(SESSION_NOT_FOUND);
      }
      session = inheritRecoveryBuildDecision(source, authority, session);
    }
    if (operation.kind !== "start" && session !== undefined) {
      throw new Error("Only start may create a hosted session.");
    }
    const expectedSessionId = session?.sessionId ?? operation.sessionId;
    if (expectedSessionId === undefined || result.sessionId !== expectedSessionId) {
      throw new Error("Hosted operation result session mismatch.");
    }
    const settled = hostedOperationRecordSchema.parse({
      ...withoutHostedOperationError(operation),
      result,
      sessionId: result.sessionId,
      state: "succeeded",
      ...(session === undefined
        ? {}
        : { sessionRecordDigest: hostedSessionCreationDigest(session) }),
      updatedAtEpochMs: input.nowEpochMs,
    });
    if (session !== undefined) {
      const key = InMemoryHostedEveStore.sessionKey(input.principal, session.sessionId);
      if (this.sessions.has(key)) {
        throw new Error("Hosted session already exists.");
      }
      this.sessions.set(key, structuredClone(session));
    }
    this.operations.set(
      InMemoryHostedEveStore.operationKey(input.principal, input.operationId),
      structuredClone(settled),
    );
    return structuredClone(settled);
  }

  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
  async settleUnsuccessful(
    input: Parameters<HostedEveStore["settleUnsuccessful"]>[0],
  ): Promise<HostedOperationRecord> {
    const operation = this.requireReserved(input);
    const settled = hostedOperationRecordSchema.parse({
      ...operation,
      safeErrorCode: input.safeErrorCode,
      state: input.state,
      updatedAtEpochMs: input.nowEpochMs,
    });
    this.operations.set(
      InMemoryHostedEveStore.operationKey(input.principal, input.operationId),
      structuredClone(settled),
    );
    return structuredClone(settled);
  }

  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
  async settleIdleReservations(
    input: Parameters<NonNullable<HostedEveStore["settleIdleReservations"]>>[0],
  ) {
    if (!this.sessions.has(InMemoryHostedEveStore.sessionKey(input.principal, input.sessionId))) {
      throw new Error(SESSION_NOT_FOUND);
    }
    let settledCount = 0;
    for (const [key, operation] of this.operations) {
      const reservedMutation = operation.kind !== "start" && operation.state === "reserved";
      const oldSessionOperation =
        operation.sessionId === input.sessionId &&
        operation.updatedAtEpochMs <= input.beforeEpochMs;
      const sameTenant = tenantKeyFor(operation.principal) === tenantKeyFor(input.principal);
      if (!reservedMutation || !oldSessionOperation || !sameTenant) {
        continue;
      }
      this.operations.set(
        key,
        hostedOperationRecordSchema.parse({
          ...operation,
          safeErrorCode: "submission_unknown",
          state: "submission_unknown",
          updatedAtEpochMs: input.nowEpochMs,
        }),
      );
      settledCount += 1;
    }
    return settledCount;
  }

  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
  async getSession(
    principal: z.infer<typeof hostedPrincipalSchema>,
    sessionId: string,
  ): Promise<HostedSessionRecord | null> {
    const session = this.sessions.get(InMemoryHostedEveStore.sessionKey(principal, sessionId));
    return session === undefined ? null : structuredClone(session);
  }

  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning store contract
  async getSessionByAdapterSessionId(
    principal: z.infer<typeof hostedPrincipalSchema>,
    adapterSessionId: string,
  ): Promise<HostedSessionRecord | null> {
    const tenant = tenantKeyFor(principal);
    const matching = [...this.sessions.values()].filter(
      (candidate) =>
        tenantKeyFor(candidate.principal) === tenant &&
        candidate.adapterSessionId === adapterSessionId,
    );
    if (matching.length > 1) {
      throw new Error("Hosted adapter session binding is ambiguous.");
    }
    return matching[0] === undefined ? null : structuredClone(matching[0]);
  }

  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
  // oxlint-disable-next-line eslint/require-await -- The in-memory implementation preserves the asynchronous canonical store contract.
  async getPrivateOperation(
    principal: HostedPrincipal,
    operationId: string,
  ): Promise<HostedOperationRecord | null> {
    return structuredClone(
      this.operations.get(InMemoryHostedEveStore.operationKey(principal, operationId)) ?? null,
    );
  }
  // oxlint-disable-next-line eslint/require-await -- The in-memory implementation preserves the asynchronous canonical store contract.
  async recordPrivateBuildDecision(input: {
    principal: HostedPrincipal;
    sessionId: string;
    decision: ApprovedBuildDecision;
  }): Promise<void> {
    const decision = approvedBuildDecisionSchema.parse(input.decision);
    const current = this.currentBuildSession(
      input.principal,
      input.sessionId,
      decision.adapterSessionId,
    );
    const key = InMemoryHostedEveStore.sessionKey(input.principal, current.sessionId);
    const boundDecision = recoveredBuildDecision(decision, current);
    if (boundDecision === undefined) throw new Error(SESSION_NOT_FOUND);
    if ((current.privateBuildDecision?.turnSequence ?? -1) > decision.turnSequence) {
      return;
    }
    this.sessions.set(
      key,
      durableHostedSessionRecordSchema.parse({ ...current, privateBuildDecision: boundDecision }),
    );
  }
  // oxlint-disable-next-line eslint/require-await -- The in-memory implementation preserves the asynchronous canonical store contract.
  async claimInternalBuildMessage(input: {
    principal: HostedPrincipal;
    sessionId: string;
    logicalSessionId?: string;
    operationId: string;
    nonce: string;
    turnId: string;
    turnSequence: number;
    messageSequence: number;
  }): Promise<boolean> {
    const key = InMemoryHostedEveStore.operationKey(input.principal, input.operationId);
    const operation = this.operations.get(key);
    const marker = operation?.internalBuildContinuation;
    if (operation === undefined || marker === undefined || operation.state === "rejected") {
      return false;
    }
    const current = this.currentBuildSession(
      input.principal,
      input.sessionId,
      input.logicalSessionId ?? marker.decision.adapterSessionId,
    );
    const wrongIdentity =
      operation.sessionId !== current.sessionId ||
      marker.decision.adapterSessionId !== current.adapterSessionId ||
      marker.nonce !== input.nonce;
    if (wrongIdentity || input.turnSequence <= marker.decision.turnSequence) {
      return false;
    }
    if (marker.deliveredTurnId !== undefined) {
      return (
        marker.deliveredTurnId === input.turnId &&
        marker.deliveredMessageSequence === input.messageSequence
      );
    }
    this.operations.set(
      key,
      hostedOperationRecordSchema.parse({
        ...operation,
        internalBuildContinuation: {
          ...marker,
          deliveredMessageSequence: input.messageSequence,
          deliveredTurnId: input.turnId,
        },
      }),
    );
    return true;
  }

  // oxlint-disable-next-line eslint/require-await -- The in-memory implementation retains the async canonical store contract.
  async recordPrivateApprovalReceipts(input: {
    principal: z.infer<typeof hostedPrincipalSchema>;
    sessionId: string;
    receipts: readonly PrivateHostedApprovalReceipt[];
  }): Promise<void> {
    const key = InMemoryHostedEveStore.sessionKey(input.principal, input.sessionId);
    const current = this.sessions.get(key);
    if (current === undefined) {
      throw new Error(SESSION_NOT_FOUND);
    }
    const durable = toDurableHostedSessionRecord(current);
    const updated = durableHostedSessionRecordSchema.parse({
      ...durable,
      privateApprovalReceipts: mergePrivateHostedApprovalReceipts(
        input.sessionId,
        durable.privateApprovalReceipts,
        input.receipts,
      ),
    });
    this.sessions.set(key, structuredClone(updated));
  }

  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
  async listSessions(input: {
    principal: z.infer<typeof hostedPrincipalSchema>;
    cursor: number;
    limit: number;
  }): Promise<{ sessions: HostedSessionRecord[]; cursor: number }> {
    const sessions = [...this.sessions.values()]
      .filter((record) => tenantKeyFor(record.principal) === tenantKeyFor(input.principal))
      .toSorted(
        (left, right) =>
          right.updatedAtEpochMs - left.updatedAtEpochMs ||
          right.sessionId.localeCompare(left.sessionId),
      )
      .slice(input.cursor, input.cursor + input.limit)
      .map((record) => structuredClone(record));
    return { cursor: input.cursor + sessions.length, sessions };
  }

  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
  async observeSession(input: {
    explicitSendOperationId?: string;
    principal: z.infer<typeof hostedPrincipalSchema>;
    sessionId: string;
    checkpoint: HostedSessionCheckpoint;
    stage: z.infer<typeof publicSessionStageSchema>;
    resumability: z.infer<typeof publicSessionResumabilitySchema>;
    appId?: string;
    nowEpochMs: number;
  }): Promise<HostedSessionRecord> {
    const key = InMemoryHostedEveStore.sessionKey(input.principal, input.sessionId);
    const current = this.sessions.get(key);
    if (current === undefined) {
      throw new Error(SESSION_NOT_FOUND);
    }
    const durable = toDurableHostedSessionRecord(current);
    const explicitSend =
      input.explicitSendOperationId === undefined
        ? undefined
        : this.operations.get(
            InMemoryHostedEveStore.operationKey(input.principal, input.explicitSendOperationId),
          );
    // Passive observations never undo Stop; only its later explicit, proved SEND may advance.
    if (
      durable.status === "cancelled" &&
      !mayReviveCancelledSession(
        explicitSend ?? null,
        durable,
        input.checkpoint.nativeDeliveryState,
      )
    ) {
      return structuredClone(durable);
    }
    const observed = durableHostedSessionRecordSchema.parse({
      ...durable,
      ...(input.appId === undefined ? {} : { appId: input.appId }),
      checkpoint: input.checkpoint,
      checkpointDigest: hostedSessionCheckpointDigest(input.checkpoint),
      checkpointProgressDigest: hostedSessionCheckpointProgressDigest(input.checkpoint),
      lastProgressAtEpochMs:
        durable.checkpointProgressDigest === hostedSessionCheckpointProgressDigest(input.checkpoint)
          ? durable.lastProgressAtEpochMs
          : input.nowEpochMs,
      resumability: input.resumability,
      stage: input.stage,
      status: input.checkpoint.status,
      updatedAtEpochMs: input.nowEpochMs,
    });
    this.sessions.set(key, structuredClone(observed));
    return structuredClone(observed);
  }

  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
  async replaceSessionAdapter(input: {
    principal: z.infer<typeof hostedPrincipalSchema>;
    sessionId: string;
    expectedAdapterGeneration: number;
    expectedCheckpointDigest?: string;
    adapterSessionId: string;
    checkpoint: HostedSessionCheckpoint;
    stage: z.infer<typeof publicSessionStageSchema>;
    resumability: z.infer<typeof publicSessionResumabilitySchema>;
    appId?: string;
    nowEpochMs: number;
  }): Promise<HostedSessionRecord> {
    const key = InMemoryHostedEveStore.sessionKey(input.principal, input.sessionId);
    const current = this.sessions.get(key);
    if (current === undefined) {
      throw new Error(SESSION_NOT_FOUND);
    }
    const durable = toDurableHostedSessionRecord(current);
    if (
      durable.adapterGeneration !== input.expectedAdapterGeneration ||
      durable.checkpointDigest !== input.expectedCheckpointDigest
    ) {
      throw new Error("Hosted session recovery raced another continuation.");
    }
    const replaced = durableHostedSessionRecordSchema.parse({
      ...durable,
      adapterGeneration: durable.adapterGeneration + 1,
      adapterSessionId: input.adapterSessionId,
      ...(input.appId === undefined ? {} : { appId: input.appId }),
      checkpoint: input.checkpoint,
      checkpointDigest: hostedSessionCheckpointDigest(input.checkpoint),
      checkpointProgressDigest: hostedSessionCheckpointProgressDigest(input.checkpoint),
      lastProgressAtEpochMs: input.nowEpochMs,
      resumability: input.resumability,
      stage: input.stage,
      status: input.checkpoint.status,
      updatedAtEpochMs: input.nowEpochMs,
    });
    this.sessions.set(key, structuredClone(replaced));
    return structuredClone(replaced);
  }

  readCheckpointPage?: HostedEveStore["readCheckpointPage"];

  private async provedResourceApprovalResponse(
    operation: HostedOperationRecord,
    proof: ResourceApprovalResponseProof | undefined,
  ): Promise<boolean> {
    if (proof === undefined) return false;
    const current =
      operation.sessionId === undefined
        ? null
        : await this.getSession(operation.principal, operation.sessionId);
    if (
      current?.version !== 2 ||
      current.checkpointRef === undefined ||
      this.readCheckpointPage === undefined
    )
      throw new Error("Resource approval settlement is not proved.");
    const page = await this.readCheckpointPage({
      principal: operation.principal,
      sessionId: current.sessionId,
      checkpointRef: current.checkpointRef,
      cursor: 0,
      limit: 1,
    });
    // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Re-read authoritative state after checkpoint I/O to reject concurrent replacement.
    const latest = await this.getSession(operation.principal, current.sessionId);
    const unchangedOperation = this.operations.get(
      InMemoryHostedEveStore.operationKey(operation.principal, operation.operationId),
    );
    const valid =
      page.checkpointDigest === current.checkpointRef.digest &&
      page.totalEvents === current.checkpointRef.eventCount &&
      isProvedResourceApprovalResponse(operation, latest, proof, page.metadata) &&
      digest(unchangedOperation) === digest(operation);
    if (!valid) throw new Error("Resource approval settlement is not proved.");
    return true;
  }

  private async provedSendDelivery(
    operation: HostedOperationRecord,
    proof: NativeDeliveryState | undefined,
  ): Promise<boolean> {
    if (operation.kind !== "send" || operation.internalBuildContinuation !== undefined)
      return false;
    const current =
      operation.sessionId === undefined
        ? null
        : await this.getSession(operation.principal, operation.sessionId);
    const proved = isProvedSendDelivery(operation, current, proof);
    if (!proved) throw new Error("Canonical SEND delivery is not proved.");
    return proved;
  }

  private async provedSessionLimitResponse(
    operation: HostedOperationRecord,
    proof: z.infer<typeof privateInputStateSchema> | undefined,
  ): Promise<boolean> {
    if (operation.internalSessionLimitResponse === undefined || operation.sessionId === undefined)
      return false;
    const current = await this.getSession(operation.principal, operation.sessionId);
    return isProvedSessionLimitResponse(operation, current, proof);
  }

  private requireReserved(input: {
    principal: z.infer<typeof hostedPrincipalSchema>;
    operationId: string;
    requestDigest: string;
  }): HostedOperationRecord {
    const operation = this.operations.get(
      InMemoryHostedEveStore.operationKey(input.principal, input.operationId),
    );
    if (
      operation === undefined ||
      operation.state !== "reserved" ||
      operation.requestDigest !== input.requestDigest
    ) {
      throw new Error("Hosted operation is not reserved at this digest.");
    }
    return operation;
  }

  private static operationKey(
    principal: z.infer<typeof hostedPrincipalSchema>,
    operationId: string,
  ): string {
    return `${tenantKeyFor(principal)}\u0000${operationId}`;
  }

  private static sessionKey(
    principal: z.infer<typeof hostedPrincipalSchema>,
    sessionId: string,
  ): string {
    return `${tenantKeyFor(principal)}\u0000${sessionId}`;
  }
}
