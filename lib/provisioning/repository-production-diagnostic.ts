import { z } from "zod";

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
]);

/** Private exceptions contribute only closed labels and numeric status, never raw text or causes. */
export const reportRepositoryProductionFailure = (
  phase: Failure["phase"],
  code: Failure["code"],
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Only own data descriptors are projected into the closed diagnostic schema.
  error?: unknown,
): void => {
  try {
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- Descriptor values remain untrusted until parsed below.
    const own = (name: string): unknown =>
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Read data descriptors only; never invoke exception accessors.
      error !== null && typeof error === "object"
        ? Object.getOwnPropertyDescriptor(error, name)?.value
        : undefined;
    const message = z.string().safeParse(own("message"));
    // ZodError need not extend Error, and its custom instanceof reads instance properties.
    const fixedReason = message.success ? reasonByMessage.get(message.data) : undefined;
    const reason = own("name") === "ZodError" ? "schema_invalid" : fixedReason;
    const sqlState = failureSchema.shape.sqlState.unwrap().safeParse(own("code"));
    const statuses = [own("statusCode"), own("status")];
    const httpStatus = statuses
      .map((value) => failureSchema.shape.httpStatus.unwrap().safeParse(value))
      .find((value) => value.success);
    console.warn(
      JSON.stringify(
        failureSchema.parse({
          event: "builder.repository_production_failure",
          phase,
          code,
          ...(reason === undefined ? {} : { reason }),
          ...(sqlState.success ? { sqlState: sqlState.data } : {}),
          ...(httpStatus?.success ? { httpStatus: httpStatus.data } : {}),
        }),
      ),
    );
  } catch {
    // Diagnostics cannot replace the original failure or change effect/cleanup behavior.
  }
};

export const observeRepositoryProductionPhase = async <T>(
  phase: Failure["phase"],
  code: Failure["code"],
  run: () => Promise<T>,
): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    reportRepositoryProductionFailure(phase, code, error);
    throw error;
  }
};
