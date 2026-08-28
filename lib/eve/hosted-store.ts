import { createHash } from "node:crypto";
import { z } from "zod";

import { hostedPrincipalSchema, tenantKeyFor } from "./hosted-auth";
import { eveSessionResultSchema, sessionStatusSchema } from "../mcp/contracts";
import type { HostedPreviewAdmissionControlBinding } from "../hosted/admission-control";

export const hostedOperationKindSchema = z.enum(["start", "send", "respond"]);
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

export const hostedSessionRecordSchema = z
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

export type HostedSessionRecord = z.infer<typeof hostedSessionRecordSchema>;

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

const hostedOperationCommonShape = {
  version: z.literal(1),
  operationId: z.string().min(1).max(200),
  principal: hostedPrincipalSchema,
  kind: hostedOperationKindSchema,
  clientRequestId: z.string().min(1).max(200),
  requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
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
    } else {
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
        reason: z.literal("admission_limit"),
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
  observeSession?(input: {
    principal: z.infer<typeof hostedPrincipalSchema>;
    sessionId: string;
    status: z.infer<typeof sessionStatusSchema>;
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
        : { sessionRecordDigest: hostedSessionRecordDigest(session) }),
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

  async observeSession(input: {
    principal: z.infer<typeof hostedPrincipalSchema>;
    sessionId: string;
    status: z.infer<typeof sessionStatusSchema>;
    nowEpochMs: number;
  }): Promise<HostedSessionRecord> {
    const key = this.sessionKey(input.principal, input.sessionId);
    const current = this.sessions.get(key);
    if (current === undefined) throw new Error("Hosted session was not found.");
    const observed = hostedSessionRecordSchema.parse({
      ...current,
      status: input.status,
      updatedAtEpochMs: input.nowEpochMs,
    });
    this.sessions.set(key, structuredClone(observed));
    return structuredClone(observed);
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
