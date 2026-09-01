import { createHash } from "node:crypto";
import { z } from "zod";

import { hostedPrincipalSchema, tenantKeyFor } from "./hosted-auth";
import {
  eveSessionResultSchema,
  publicEveEventSchema,
  publicInputRequestSchema,
  publicImplementationPlanSchema,
  publicPrototypeSchema,
  publicSessionResumabilitySchema,
  publicSessionStageSchema,
  publicSessionSummarySchema,
  sessionStatusSchema,
  type PublicSessionSummary,
} from "../mcp/contracts";
import type { HostedPreviewAdmissionControlBinding } from "../hosted/admission-control";

export const hostedOperationKindSchema = z.enum([
  "start",
  "resume",
  "send",
  "respond",
]);
export type HostedOperationKind = z.infer<typeof hostedOperationKindSchema>;

export const hostedOperationStateSchema = z.enum([
  "reserved",
  "submission_unknown",
  "succeeded",
  "rejected",
]);

export const HOSTED_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;
export const HOSTED_SESSION_MAX_LIFETIME_MS = 24 * 60 * 60 * 1_000;

export const hostedSessionTimeoutPolicySchema = z
  .object({
    idleTimeoutMs: z
      .number()
      .int()
      .min(60_000)
      .max(24 * 60 * 60 * 1_000),
    maxLifetimeMs: z
      .number()
      .int()
      .min(60_000)
      .max(7 * 24 * 60 * 60 * 1_000),
  })
  .strict()
  .refine(
    ({ idleTimeoutMs, maxLifetimeMs }) => idleTimeoutMs <= maxLifetimeMs,
    "Hosted session idle timeout cannot exceed its maximum lifetime.",
  );

export type HostedSessionTimeoutPolicy = z.infer<
  typeof hostedSessionTimeoutPolicySchema
>;

export const DEFAULT_HOSTED_SESSION_TIMEOUT_POLICY =
  hostedSessionTimeoutPolicySchema.parse({
    idleTimeoutMs: HOSTED_SESSION_IDLE_TIMEOUT_MS,
    maxLifetimeMs: HOSTED_SESSION_MAX_LIFETIME_MS,
  });

const legacyHostedSessionRecordSchema = z
  .object({
    version: z.literal(1),
    sessionId: z.string().min(1).max(200),
    principal: hostedPrincipalSchema,
    adapterSessionId: z.string().min(1).max(500),
    status: sessionStatusSchema,
    createdAtEpochMs: z.number().int().nonnegative(),
    updatedAtEpochMs: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    ({ createdAtEpochMs, updatedAtEpochMs }) =>
      updatedAtEpochMs >= createdAtEpochMs,
    "Hosted session updates cannot precede creation.",
  );

export const hostedSessionCheckpointSchema = z
  .object({
    version: z.literal(1),
    status: sessionStatusSchema,
    events: z.array(publicEveEventSchema).max(512),
    truncatedBeforeIndex: z.number().int().nonnegative().optional(),
    inputRequests: z.array(publicInputRequestSchema).max(32).optional(),
    prototype: publicPrototypeSchema.optional(),
    implementationPlan: publicImplementationPlanSchema.optional(),
    capturedAtEpochMs: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (checkpoint) =>
      new TextEncoder().encode(JSON.stringify(checkpoint)).byteLength <=
      512 * 1_024,
    "Hosted session checkpoints must be at most 524288 bytes.",
  );

export type HostedSessionCheckpoint = z.infer<
  typeof hostedSessionCheckpointSchema
>;

export function hostedSessionCheckpointDigest(
  checkpoint: HostedSessionCheckpoint,
): string {
  const parsed = hostedSessionCheckpointSchema.parse(checkpoint);
  return `sha256:${createHash("sha256")
    .update(canonicalRecordValue(parsed))
    .digest("hex")}`;
}

export function hostedSessionCheckpointProgressDigest(
  checkpoint: HostedSessionCheckpoint,
): string {
  const { capturedAtEpochMs: _capturedAtEpochMs, ...progress } =
    hostedSessionCheckpointSchema.parse(checkpoint);
  return `sha256:${createHash("sha256")
    .update(canonicalRecordValue(progress))
    .digest("hex")}`;
}

export const durableHostedSessionRecordSchema = z
  .object({
    version: z.literal(2),
    sessionId: z.string().min(1).max(200),
    principal: hostedPrincipalSchema,
    adapterSessionId: z.string().min(1).max(500),
    originAdapterSessionId: z.string().min(1).max(500),
    adapterGeneration: z.number().int().positive(),
    title: z.string().min(1).max(200),
    appId: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u)
      .optional(),
    stage: publicSessionStageSchema,
    status: sessionStatusSchema,
    resumability: publicSessionResumabilitySchema,
    checkpoint: hostedSessionCheckpointSchema.optional(),
    checkpointDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .optional(),
    checkpointProgressDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .optional(),
    parentSessionId: z.string().min(1).max(200).optional(),
    lastProgressAtEpochMs: z.number().int().nonnegative(),
    createdAtEpochMs: z.number().int().nonnegative(),
    updatedAtEpochMs: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.updatedAtEpochMs < record.createdAtEpochMs)
      context.addIssue({
        code: "custom",
        message: "Hosted session updates cannot precede creation.",
      });
    if (
      record.lastProgressAtEpochMs < record.createdAtEpochMs ||
      record.lastProgressAtEpochMs > record.updatedAtEpochMs
    )
      context.addIssue({
        code: "custom",
        message: "Hosted session progress must be within its durable lifetime.",
      });
    if (
      (record.checkpoint === undefined) !==
      (record.checkpointDigest === undefined)
    )
      context.addIssue({
        code: "custom",
        message: "Hosted session checkpoints require their exact digest.",
      });
    if (
      (record.checkpoint === undefined) !==
      (record.checkpointProgressDigest === undefined)
    )
      context.addIssue({
        code: "custom",
        message: "Hosted session checkpoints require their progress digest.",
      });
    if (
      record.checkpoint !== undefined &&
      hostedSessionCheckpointDigest(record.checkpoint) !==
        record.checkpointDigest
    )
      context.addIssue({
        code: "custom",
        message: "Hosted session checkpoint digest mismatch.",
      });
    if (
      record.checkpoint !== undefined &&
      hostedSessionCheckpointProgressDigest(record.checkpoint) !==
        record.checkpointProgressDigest
    )
      context.addIssue({
        code: "custom",
        message: "Hosted session checkpoint progress digest mismatch.",
      });
    if (
      record.checkpoint !== undefined &&
      record.checkpoint.status !== record.status
    )
      context.addIssue({
        code: "custom",
        message: "Hosted session checkpoint status mismatch.",
      });
    if (
      record.adapterGeneration === 1 &&
      record.adapterSessionId !== record.originAdapterSessionId
    )
      context.addIssue({
        code: "custom",
        message: "The first adapter generation must retain its origin binding.",
      });
  });

export const hostedSessionRecordSchema = z.discriminatedUnion("version", [
  legacyHostedSessionRecordSchema,
  durableHostedSessionRecordSchema,
]);

export type HostedSessionRecord = z.infer<typeof hostedSessionRecordSchema>;
export type DurableHostedSessionRecord = z.infer<
  typeof durableHostedSessionRecordSchema
>;

function legacySessionStage(
  status: z.infer<typeof sessionStatusSchema>,
): z.infer<typeof publicSessionStageSchema> {
  if (status === "completed") return "complete";
  if (["failed", "cancelled", "input_required"].includes(status))
    return "needs_attention";
  return "designing";
}

export function toDurableHostedSessionRecord(
  input: HostedSessionRecord,
): DurableHostedSessionRecord {
  const record = hostedSessionRecordSchema.parse(input);
  if (record.version === 2) return record;
  return durableHostedSessionRecordSchema.parse({
    version: 2,
    sessionId: record.sessionId,
    principal: record.principal,
    adapterSessionId: record.adapterSessionId,
    originAdapterSessionId: record.adapterSessionId,
    adapterGeneration: 1,
    title: "Previous App Builder session",
    stage: legacySessionStage(record.status),
    status: record.status,
    resumability: "live",
    lastProgressAtEpochMs: record.updatedAtEpochMs,
    createdAtEpochMs: record.createdAtEpochMs,
    updatedAtEpochMs: record.updatedAtEpochMs,
  });
}

export function hostedSessionSummary(
  input: HostedSessionRecord,
): PublicSessionSummary {
  const record = toDurableHostedSessionRecord(input);
  return publicSessionSummarySchema.parse({
    sessionId: record.sessionId,
    title: record.title,
    ...(record.appId === undefined ? {} : { appId: record.appId }),
    stage: record.stage,
    status: record.status,
    resumability:
      record.version === 2 &&
      record.checkpoint === undefined &&
      record.resumability !== "terminal"
        ? "restart_required"
        : record.resumability,
    updatedAt: new Date(record.updatedAtEpochMs).toISOString(),
  });
}

export function isHostedSessionExpired(input: {
  record: HostedSessionRecord;
  nowEpochMs: number;
  policy?: HostedSessionTimeoutPolicy;
}) {
  const record = hostedSessionRecordSchema.parse(input.record);
  const policy = hostedSessionTimeoutPolicySchema.parse(
    input.policy ?? DEFAULT_HOSTED_SESSION_TIMEOUT_POLICY,
  );
  return (
    input.nowEpochMs >= record.updatedAtEpochMs + policy.idleTimeoutMs ||
    input.nowEpochMs >= record.createdAtEpochMs + policy.maxLifetimeMs
  );
}

/** Admission/compute accounting only. User-visible session records do not expire. */
export const isHostedSessionComputeLeaseExpired = isHostedSessionExpired;

function canonicalRecordValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalRecordValue).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${canonicalRecordValue(entry)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hostedSessionRecordDigest(record: HostedSessionRecord): string {
  const parsed = hostedSessionRecordSchema.parse(record);
  return `sha256:${createHash("sha256")
    .update(canonicalRecordValue(parsed))
    .digest("hex")}`;
}

/** Stable creation identity used by idempotent start receipts as sessions evolve. */
export function hostedSessionCreationDigest(
  record: HostedSessionRecord,
): string {
  const parsed = hostedSessionRecordSchema.parse(record);
  return `sha256:${createHash("sha256")
    .update(
      canonicalRecordValue({
        version: 1,
        sessionId: parsed.sessionId,
        principal: parsed.principal,
        originAdapterSessionId:
          parsed.version === 1
            ? parsed.adapterSessionId
            : parsed.originAdapterSessionId,
        createdAtEpochMs: parsed.createdAtEpochMs,
      }),
    )
    .digest("hex")}`;
}

const hostedOperationCommonShape = {
  version: z.literal(1),
  operationId: z.string().min(1).max(200),
  principal: hostedPrincipalSchema,
  kind: hostedOperationKindSchema,
  clientRequestId: z.string().min(1).max(200),
  requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  resumeSessionId: z.string().min(1).max(200).optional(),
  createdAtEpochMs: z.number().int().nonnegative(),
  updatedAtEpochMs: z.number().int().nonnegative(),
};

export const hostedOperationRecordSchema = z
  .discriminatedUnion("state", [
    z
      .object({
        ...hostedOperationCommonShape,
        state: z.literal("reserved"),
        sessionId: z.string().min(1).max(200).optional(),
      })
      .strict(),
    z
      .object({
        ...hostedOperationCommonShape,
        state: z.literal("submission_unknown"),
        sessionId: z.string().min(1).max(200).optional(),
        safeErrorCode: z.string().min(1).max(100),
      })
      .strict(),
    z
      .object({
        ...hostedOperationCommonShape,
        state: z.literal("succeeded"),
        sessionId: z.string().min(1).max(200),
        result: eveSessionResultSchema,
        sessionRecordDigest: z
          .string()
          .regex(/^sha256:[a-f0-9]{64}$/)
          .optional(),
      })
      .strict(),
    z
      .object({
        ...hostedOperationCommonShape,
        state: z.literal("rejected"),
        sessionId: z.string().min(1).max(200).optional(),
        safeErrorCode: z.string().min(1).max(100),
      })
      .strict(),
  ])
  .superRefine((record, context) => {
    if (
      record.state === "succeeded" &&
      record.result.sessionId !== record.sessionId
    ) {
      context.addIssue({
        code: "custom",
        message: "A succeeded operation must bind its result session.",
      });
    }
    if (record.kind === "start") {
      if (
        record.state === "succeeded" &&
        record.sessionRecordDigest === undefined
      ) {
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
      )
        context.addIssue({
          code: "custom",
          message: "A resumed child must not replace its parent session ID.",
        });
    } else {
      if (record.resumeSessionId !== undefined)
        context.addIssue({
          code: "custom",
          message: "Only a child-session start may bind a resume parent.",
        });
      if (record.sessionId === undefined) {
        context.addIssue({
          code: "custom",
          message: "A session mutation must bind its session.",
        });
      }
      if (
        record.state === "succeeded" &&
        record.sessionRecordDigest !== undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "A session mutation cannot create a session record.",
        });
      }
    }
  });

export type HostedOperationRecord = z.infer<typeof hostedOperationRecordSchema>;

export const reserveOperationResultSchema = z.discriminatedUnion(
  "disposition",
  [
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
        reason: z.enum(["admission_limit", "session_busy"]),
      })
      .strict(),
  ],
);

export type ReserveOperationResult = z.infer<
  typeof reserveOperationResultSchema
>;

/**
 * Durable implementations must make every method atomic. All lookup methods
 * require a principal and must include its issuer, audience, workspace, and
 * owner in the storage predicate. `settleSucceeded` must atomically persist an
 * optional new session and the terminal operation result.
 */
export interface HostedEveStore {
  reserveOperation(
    principal: z.infer<typeof hostedPrincipalSchema>,
    candidate: HostedOperationRecord,
    admission?: {
      binding: HostedPreviewAdmissionControlBinding;
      nowEpochMs: number;
      sessionTimeoutPolicy: HostedSessionTimeoutPolicy;
    },
  ): Promise<ReserveOperationResult>;
  settleSucceeded(input: {
    principal: z.infer<typeof hostedPrincipalSchema>;
    operationId: string;
    requestDigest: string;
    result: z.infer<typeof eveSessionResultSchema>;
    session?: HostedSessionRecord;
    nowEpochMs: number;
  }): Promise<HostedOperationRecord>;
  settleUnsuccessful(input: {
    principal: z.infer<typeof hostedPrincipalSchema>;
    operationId: string;
    requestDigest: string;
    state: "submission_unknown" | "rejected";
    safeErrorCode: string;
    nowEpochMs: number;
  }): Promise<HostedOperationRecord>;
  getSession(
    principal: z.infer<typeof hostedPrincipalSchema>,
    sessionId: string,
  ): Promise<HostedSessionRecord | null>;
  listSessions(input: {
    principal: z.infer<typeof hostedPrincipalSchema>;
    cursor: number;
    limit: number;
  }): Promise<{ sessions: HostedSessionRecord[]; cursor: number }>;
  observeSession?(input: {
    principal: z.infer<typeof hostedPrincipalSchema>;
    sessionId: string;
    checkpoint: HostedSessionCheckpoint;
    stage: z.infer<typeof publicSessionStageSchema>;
    resumability: z.infer<typeof publicSessionResumabilitySchema>;
    appId?: string;
    nowEpochMs: number;
  }): Promise<HostedSessionRecord>;
  replaceSessionAdapter?(input: {
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
  }): Promise<HostedSessionRecord>;
}

/** Test/local conformance store. Hosted deployment must supply durable storage. */
export class InMemoryHostedEveStore implements HostedEveStore {
  private readonly operations = new Map<string, HostedOperationRecord>();
  private readonly sessions = new Map<string, HostedSessionRecord>();

  async reserveOperation(
    principal: z.infer<typeof hostedPrincipalSchema>,
    candidate: HostedOperationRecord,
    admission?: {
      binding: HostedPreviewAdmissionControlBinding;
      nowEpochMs: number;
      sessionTimeoutPolicy: HostedSessionTimeoutPolicy;
    },
  ): Promise<ReserveOperationResult> {
    const parsed = hostedOperationRecordSchema.parse(candidate);
    if (tenantKeyFor(parsed.principal) !== tenantKeyFor(principal)) {
      return { disposition: "conflict" };
    }
    const key = this.operationKey(principal, parsed.operationId);
    const existing = this.operations.get(key);
    if (existing !== undefined) {
      return existing.requestDigest === parsed.requestDigest &&
        existing.kind === parsed.kind &&
        existing.clientRequestId === parsed.clientRequestId
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
          record.state === "reserved" &&
          record.kind === "start" &&
          record.resumeSessionId === parsed.resumeSessionId &&
          tenantKeyFor(record.principal) === tenantKeyFor(principal),
      )
    ) {
      return { disposition: "rejected", reason: "session_busy" };
    }
    if (parsed.kind === "start" && admission !== undefined) {
      const minuteStart = admission.nowEpochMs - 60_000;
      const subjectStarts = [...this.operations.values()].filter(
        (record) =>
          record.kind === "start" &&
          record.createdAtEpochMs >= minuteStart &&
          record.principal.issuer === principal.issuer &&
          record.principal.audience === principal.audience &&
          record.principal.workspaceId === principal.workspaceId &&
          record.principal.ownerUserId === principal.ownerUserId,
      ).length;
      const workspaceStarts = [...this.operations.values()].filter(
        (record) =>
          record.kind === "start" &&
          record.createdAtEpochMs >= minuteStart &&
          record.principal.issuer === principal.issuer &&
          record.principal.audience === principal.audience &&
          record.principal.workspaceId === principal.workspaceId,
      ).length;
      const subjectConcurrent = [...this.sessions.values()].filter(
        (record) =>
          !isHostedSessionExpired({
            record,
            nowEpochMs: admission.nowEpochMs,
            policy: admission.sessionTimeoutPolicy,
          }) &&
          record.principal.issuer === principal.issuer &&
          record.principal.audience === principal.audience &&
          record.principal.workspaceId === principal.workspaceId &&
          record.principal.ownerUserId === principal.ownerUserId &&
          record.status === "working",
      ).length;
      const workspaceActive = [...this.sessions.values()].filter(
        (record) =>
          !isHostedSessionExpired({
            record,
            nowEpochMs: admission.nowEpochMs,
            policy: admission.sessionTimeoutPolicy,
          }) &&
          record.principal.issuer === principal.issuer &&
          record.principal.audience === principal.audience &&
          record.principal.workspaceId === principal.workspaceId &&
          ["working", "input_required", "waiting"].includes(record.status),
      ).length;
      const limits = admission.binding;
      if (
        limits.monthlySpendUsedUsdCents >= limits.monthlySpendLimitUsdCents ||
        subjectStarts >= limits.startsPerSubjectPerMinute ||
        workspaceStarts >= limits.startsPerWorkspacePerMinute ||
        subjectConcurrent >= limits.maxConcurrentSessionsPerSubject ||
        workspaceActive >= limits.maxActiveSessionsPerWorkspace
      ) {
        return { disposition: "rejected", reason: "admission_limit" };
      }
    }
    this.operations.set(key, structuredClone(parsed));
    return { disposition: "reserved", operation: structuredClone(parsed) };
  }

  async settleSucceeded(
    input: Parameters<HostedEveStore["settleSucceeded"]>[0],
  ): Promise<HostedOperationRecord> {
    const operation = this.requireReserved(input);
    const result = eveSessionResultSchema.parse(input.result);
    const session =
      input.session === undefined
        ? undefined
        : hostedSessionRecordSchema.parse(input.session);
    if (
      session !== undefined &&
      tenantKeyFor(session.principal) !== tenantKeyFor(input.principal)
    ) {
      throw new Error("Hosted store principal mismatch.");
    }
    if (operation.kind === "start" && session === undefined) {
      throw new Error(
        "A successful start must atomically persist its session.",
      );
    }
    if (operation.kind !== "start" && session !== undefined) {
      throw new Error("Only start may create a hosted session.");
    }
    const expectedSessionId = session?.sessionId ?? operation.sessionId;
    if (
      expectedSessionId === undefined ||
      result.sessionId !== expectedSessionId
    ) {
      throw new Error("Hosted operation result session mismatch.");
    }
    const settled = hostedOperationRecordSchema.parse({
      ...operation,
      state: "succeeded",
      sessionId: result.sessionId,
      result,
      ...(session === undefined
        ? {}
        : { sessionRecordDigest: hostedSessionCreationDigest(session) }),
      updatedAtEpochMs: input.nowEpochMs,
    });
    if (session !== undefined) {
      const key = this.sessionKey(input.principal, session.sessionId);
      if (this.sessions.has(key)) {
        throw new Error("Hosted session already exists.");
      }
      this.sessions.set(key, structuredClone(session));
    }
    this.operations.set(
      this.operationKey(input.principal, input.operationId),
      structuredClone(settled),
    );
    return structuredClone(settled);
  }

  async settleUnsuccessful(
    input: Parameters<HostedEveStore["settleUnsuccessful"]>[0],
  ): Promise<HostedOperationRecord> {
    const operation = this.requireReserved(input);
    const settled = hostedOperationRecordSchema.parse({
      ...operation,
      state: input.state,
      safeErrorCode: input.safeErrorCode,
      updatedAtEpochMs: input.nowEpochMs,
    });
    this.operations.set(
      this.operationKey(input.principal, input.operationId),
      structuredClone(settled),
    );
    return structuredClone(settled);
  }

  async getSession(
    principal: z.infer<typeof hostedPrincipalSchema>,
    sessionId: string,
  ): Promise<HostedSessionRecord | null> {
    const session = this.sessions.get(this.sessionKey(principal, sessionId));
    return session === undefined ? null : structuredClone(session);
  }

  async listSessions(input: {
    principal: z.infer<typeof hostedPrincipalSchema>;
    cursor: number;
    limit: number;
  }): Promise<{ sessions: HostedSessionRecord[]; cursor: number }> {
    const sessions = [...this.sessions.values()]
      .filter(
        (record) =>
          tenantKeyFor(record.principal) === tenantKeyFor(input.principal),
      )
      .toSorted(
        (left, right) =>
          right.updatedAtEpochMs - left.updatedAtEpochMs ||
          right.sessionId.localeCompare(left.sessionId),
      )
      .slice(input.cursor, input.cursor + input.limit)
      .map((record) => structuredClone(record));
    return { sessions, cursor: input.cursor + sessions.length };
  }

  async observeSession(input: {
    principal: z.infer<typeof hostedPrincipalSchema>;
    sessionId: string;
    checkpoint: HostedSessionCheckpoint;
    stage: z.infer<typeof publicSessionStageSchema>;
    resumability: z.infer<typeof publicSessionResumabilitySchema>;
    appId?: string;
    nowEpochMs: number;
  }): Promise<HostedSessionRecord> {
    const key = this.sessionKey(input.principal, input.sessionId);
    const current = this.sessions.get(key);
    if (current === undefined) throw new Error("Hosted session was not found.");
    const durable = toDurableHostedSessionRecord(current);
    const observed = durableHostedSessionRecordSchema.parse({
      ...durable,
      status: input.checkpoint.status,
      checkpoint: input.checkpoint,
      checkpointDigest: hostedSessionCheckpointDigest(input.checkpoint),
      checkpointProgressDigest: hostedSessionCheckpointProgressDigest(
        input.checkpoint,
      ),
      stage: input.stage,
      resumability: input.resumability,
      ...(input.appId === undefined ? {} : { appId: input.appId }),
      lastProgressAtEpochMs:
        durable.checkpointProgressDigest ===
        hostedSessionCheckpointProgressDigest(input.checkpoint)
          ? durable.lastProgressAtEpochMs
          : input.nowEpochMs,
      updatedAtEpochMs: input.nowEpochMs,
    });
    this.sessions.set(key, structuredClone(observed));
    return structuredClone(observed);
  }

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
    const key = this.sessionKey(input.principal, input.sessionId);
    const current = this.sessions.get(key);
    if (current === undefined) throw new Error("Hosted session was not found.");
    const durable = toDurableHostedSessionRecord(current);
    if (
      durable.adapterGeneration !== input.expectedAdapterGeneration ||
      durable.checkpointDigest !== input.expectedCheckpointDigest
    )
      throw new Error("Hosted session recovery raced another continuation.");
    const replaced = durableHostedSessionRecordSchema.parse({
      ...durable,
      adapterSessionId: input.adapterSessionId,
      adapterGeneration: durable.adapterGeneration + 1,
      status: input.checkpoint.status,
      checkpoint: input.checkpoint,
      checkpointDigest: hostedSessionCheckpointDigest(input.checkpoint),
      checkpointProgressDigest: hostedSessionCheckpointProgressDigest(
        input.checkpoint,
      ),
      stage: input.stage,
      resumability: input.resumability,
      ...(input.appId === undefined ? {} : { appId: input.appId }),
      lastProgressAtEpochMs: input.nowEpochMs,
      updatedAtEpochMs: input.nowEpochMs,
    });
    this.sessions.set(key, structuredClone(replaced));
    return structuredClone(replaced);
  }

  private requireReserved(input: {
    principal: z.infer<typeof hostedPrincipalSchema>;
    operationId: string;
    requestDigest: string;
  }): HostedOperationRecord {
    const operation = this.operations.get(
      this.operationKey(input.principal, input.operationId),
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

  private operationKey(
    principal: z.infer<typeof hostedPrincipalSchema>,
    operationId: string,
  ): string {
    return `${tenantKeyFor(principal)}\u0000${operationId}`;
  }

  private sessionKey(
    principal: z.infer<typeof hostedPrincipalSchema>,
    sessionId: string,
  ): string {
    return `${tenantKeyFor(principal)}\u0000${sessionId}`;
  }
}
