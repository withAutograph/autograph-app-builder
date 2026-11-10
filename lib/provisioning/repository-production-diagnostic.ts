import { z } from "zod";
import { operatorPublicResultSchema } from "./hosted-operator-contract";
import {
  operatorExecutionStage,
  operatorWorkerFailureCode,
} from "./hosted-operator-consent-diagnostic";
import type { OperatorExecutionStage } from "./hosted-operator-consent-diagnostic";

const failureSchema = z.strictObject({
  event: z.literal("builder.repository_production_failure"),
  phase: z.enum([
    "setup_prepare",
    "setup_projection",
    "connection_authority",
    "worker_authority",
    "workload_oidc_acquire",
    "workload_oidc_verify",
    "auth_operator_scope",
    "maintenance_binding",
    "auth_operator_binding",
    "auth_runtime_binding",
    "maintenance_identity",
    "auth_operator_identity",
    "auth_runtime_identity",
    "provider_token",
    "credential_decode",
    "worker_transport_validation",
    "sandbox_oidc_acquire",
    "sandbox_create",
    "runtime_binding_list",
    "runtime_binding_detail",
    "runtime_binding_write",
    "runtime_binding_ownership",
    "runtime_binding_value",
    "access_deployment",
    "access_request",
    "access_owner_resolve",
    "access_operator_read",
    "access_operator_command",
    "access_owner_recheck",
    "access_operator_http",
    "access_operator_transport",
    "access_operator_token",
    "access_operator_projection",
    "access_scope_resolve",
    "access_people",
    "access_projection",
    "access_command_authorize",
    "access_command_lease",
    "access_command_journal",
    "access_command_execute",
    "access_command_reconcile",
  ]),
  code: z.enum([
    "setup_unavailable",
    "authorization_unavailable",
    "workload_unavailable",
    "binding_unavailable",
    "scope_mismatch",
    "provider_unavailable",
    "credentials_unavailable",
  ]),
  operatorCode: operatorPublicResultSchema.shape.code,
  appAccessCode: z
    .enum([
      "authentication_required",
      "app_access_denied",
      "app_access_unavailable",
      "app_access_unknown",
      "request_invalid",
      "request_id_conflict",
    ])
    .optional(),
  errorKind: z
    .enum([
      "Error",
      "TypeError",
      "RangeError",
      "ReferenceError",
      "SyntaxError",
      "URIError",
      "EvalError",
      "AggregateError",
      "DOMException",
    ])
    .optional(),
  requestAborted: z.boolean().optional(),
  launcherStage: operatorExecutionStage.optional(),
  workerFailure: operatorWorkerFailureCode.optional(),
  workerOperation: z
    .enum(["storage", "schema", "access", "membership", "auth-management"])
    .optional(),
  workerReadOnly: z.boolean().optional(),
  reason: z
    .enum([
      "approval_required",
      "authority_changed",
      "journal_scope_mismatch",
      "journal_conflict",
      "lease_unavailable",
      "lease_session_unavailable",
      "lease_lock_lost",
      "lease_fence_stale",
      "destination_changed",
      "reconciliation_required",
      "schema_invalid",
      "runtime_binding_conflict",
      "runtime_value_unavailable",
      "source_unavailable",
      "capture_unavailable",
    ])
    .optional(),
  sqlState: z
    .enum(["28P01", "42501", "42P01", "42703", "53300", "55000", "08001", "08006"])
    .optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
});
type Failure = z.infer<typeof failureSchema>;

const reasonByMessage = new Map<string, NonNullable<Failure["reason"]>>([
  ["repository_production_approval_required", "approval_required"],
  ["repository_production_scope_denied", "authority_changed"],
  ["repository_production_owner_unavailable", "authority_changed"],
  ["repository_production_owner_changed", "authority_changed"],
  ["repository_production_journal_scope_mismatch", "journal_scope_mismatch"],
  ["repository_production_journal_conflict", "journal_conflict"],
  ["repository_production_conflict", "journal_conflict"],
  ["repository_production_lease_unavailable", "lease_unavailable"],
  ["Protected resource lease session is unavailable.", "lease_session_unavailable"],
  ["Protected resource lease session was lost.", "lease_session_unavailable"],
  ["Protected resource lease session was lost or replaced.", "lease_session_unavailable"],
  ["Protected resource lease lock was lost.", "lease_lock_lost"],
  ["Protected resource lease fence is stale.", "lease_fence_stale"],
  ["repository_production_destination_changed", "destination_changed"],
  ["repository_production_reconciliation_required", "reconciliation_required"],
  ["repository_production_access_reconciliation_required", "reconciliation_required"],
  ["repository_production_runtime_binding_conflict", "runtime_binding_conflict"],
  ["repository_production_runtime_value_unavailable", "runtime_value_unavailable"],
  ["repository_production_source_unavailable", "source_unavailable"],
  ["repository_production_capture_unavailable", "capture_unavailable"],
]);

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Exception fields remain untrusted until projected through closed schemas.
const ownData = (value: unknown, name: string): unknown => {
  try {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Never invoke exception accessors.
    if (value === null || typeof value !== "object") {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
};
const builtinErrorKinds = [
  [Error.prototype, "Error"],
  [TypeError.prototype, "TypeError"],
  [RangeError.prototype, "RangeError"],
  [ReferenceError.prototype, "ReferenceError"],
  [SyntaxError.prototype, "SyntaxError"],
  [URIError.prototype, "URIError"],
  [EvalError.prototype, "EvalError"],
  [AggregateError.prototype, "AggregateError"],
  [DOMException.prototype, "DOMException"],
] as const;
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Only fixed native prototype identities or own closed names are recognized.
const errorKind = (error: unknown): Failure["errorKind"] => {
  const named = failureSchema.shape.errorKind.unwrap().safeParse(ownData(error, "name"));
  if (named.success) {
    return named.data;
  }
  try {
    let prototype: unknown = Object.getPrototypeOf(error);
    for (let depth = 0; depth < 3 && prototype !== null; depth += 1) {
      const currentPrototype = prototype;
      const known = builtinErrorKinds.find(([candidate]) => candidate === currentPrototype);
      if (known) {
        return known[1];
      }
      prototype = Object.getPrototypeOf(prototype);
    }
  } catch {
    // Hostile prototype traps cannot suppress the remaining closed fields.
  }
  return undefined;
};
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Wrapped drivers contribute only allowlisted SQLSTATEs through own data properties.
const sqlState = (error: unknown): Failure["sqlState"] => {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    const parsed = failureSchema.shape.sqlState.unwrap().safeParse(ownData(current, "code"));
    if (parsed.success) {
      return parsed.data;
    }
    current = ownData(current, "cause");
  }
  return undefined;
};

/** Private exceptions contribute only closed labels and numeric status, never raw text or causes. */
export const reportRepositoryProductionFailure = (
  phase: Failure["phase"],
  code: Failure["code"],
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Only own data descriptors are projected into the closed diagnostic schema.
  error?: unknown,
  signal?: AbortSignal,
  launcherStage?: OperatorExecutionStage,
  worker?: Pick<Failure, "workerFailure" | "workerOperation" | "workerReadOnly">,
): void => {
  try {
    const message = z.string().safeParse(ownData(error, "message"));
    // ZodError need not extend Error, and its custom instanceof reads instance properties.
    const fixedReason = message.success ? reasonByMessage.get(message.data) : undefined;
    const reason = ownData(error, "name") === "ZodError" ? "schema_invalid" : fixedReason;
    const operatorCode = failureSchema.shape.operatorCode.safeParse(ownData(error, "code"));
    const appAccessCode = failureSchema.shape.appAccessCode
      .unwrap()
      .safeParse(ownData(error, "code"));
    const statuses = [ownData(error, "statusCode"), ownData(error, "status")];
    const httpStatus = statuses
      .map((value) => failureSchema.shape.httpStatus.unwrap().safeParse(value))
      .find((value) => value.success);
    const workerFailure = operatorWorkerFailureCode.safeParse(ownData(worker, "workerFailure"));
    const workerOperation = failureSchema.shape.workerOperation
      .unwrap()
      .safeParse(ownData(worker, "workerOperation"));
    const workerReadOnly = failureSchema.shape.workerReadOnly
      .unwrap()
      .safeParse(ownData(worker, "workerReadOnly"));
    console.warn(
      JSON.stringify(
        failureSchema.parse({
          event: "builder.repository_production_failure",
          phase,
          code,
          errorKind: errorKind(error),
          sqlState: sqlState(error),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Preserve conditional fields and evaluation order.
          ...(reason === undefined ? {} : { reason }),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Preserve conditional fields and evaluation order.
          ...(operatorCode.success ? { operatorCode: operatorCode.data } : {}),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Omit an absent closed app-access code like the existing diagnostic fields.
          ...(appAccessCode.success ? { appAccessCode: appAccessCode.data } : {}),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Preserve conditional fields and evaluation order.
          ...(httpStatus?.success ? { httpStatus: httpStatus.data } : {}),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Preserve conditional fields and evaluation order.
          ...(signal === undefined ? {} : { requestAborted: signal.aborted }),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Preserve conditional fields and evaluation order.
          ...(launcherStage === undefined ? {} : { launcherStage }),
          workerFailure: workerFailure.success ? workerFailure.data : undefined,
          workerOperation: workerOperation.success ? workerOperation.data : undefined,
          workerReadOnly: workerReadOnly.success ? workerReadOnly.data : undefined,
        }),
      ),
    );
  } catch {
    // Diagnostics cannot replace the original failure or change effect/cleanup behavior.
  }
};

const progressSchema = z.strictObject({
  event: z.literal("builder.repository_production_progress"),
  phase: z.enum(["connections", "worker_input"]),
  state: z.enum(["started", "completed"]),
});
export const reportRepositoryProductionProgress = (
  phase: z.infer<typeof progressSchema>["phase"],
  state: z.infer<typeof progressSchema>["state"],
): void => {
  try {
    console.info(
      JSON.stringify(
        progressSchema.parse({ event: "builder.repository_production_progress", phase, state }),
      ),
    );
  } catch {
    // Progress visibility never changes the protected operation.
  }
};

const connectionTimingSchema = z.strictObject({
  event: z.literal("builder.repository_production_connection_timing"),
  phase: z.enum([
    "connection_authority",
    "workload_oidc_acquire",
    "workload_oidc_verify",
    "maintenance_identity",
    "auth_operator_identity",
    "auth_runtime_identity",
  ]),
  state: z.enum(["started", "completed", "failed"]),
  elapsedMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

/** Connection-only timings contain no result, exception or private connection payload. */
export const observeRepositoryProductionConnectionTiming = async <T>(
  phase: z.infer<typeof connectionTimingSchema>["phase"],
  run: () => Promise<T>,
): Promise<T> => {
  let startedAt: number | undefined;
  try {
    startedAt = performance.now();
  } catch {
    // A clock failure cannot change the protected operation.
  }
  const report = (state: z.infer<typeof connectionTimingSchema>["state"]) => {
    try {
      if (startedAt === undefined) {
        return;
      }
      const elapsedMs =
        state === "started" ? 0 : Math.max(0, Math.floor(performance.now() - startedAt));
      console.info(
        JSON.stringify(
          connectionTimingSchema.parse({
            event: "builder.repository_production_connection_timing",
            phase,
            state,
            elapsedMs,
          }),
        ),
      );
    } catch {
      // Timing and logging never replace the original result or exception.
    }
  };
  report("started");
  try {
    const result = await run();
    report("completed");
    return result;
  } catch (error) {
    report("failed");
    throw error;
  }
};

export const observeRepositoryProductionPhase = async <T>(
  phase: Failure["phase"],
  code: Failure["code"],
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    reportRepositoryProductionFailure(phase, code, error, signal);
    throw error;
  }
};
