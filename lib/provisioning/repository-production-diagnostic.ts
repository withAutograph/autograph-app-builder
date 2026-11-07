import { z } from "zod";

const failureSchema = z.strictObject({
  event: z.literal("builder.repository_production_failure"),
  phase: z.enum([
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
    "authorization_unavailable",
    "workload_unavailable",
    "binding_unavailable",
    "scope_mismatch",
    "provider_unavailable",
    "credentials_unavailable",
  ]),
  sqlState: z
    .enum(["28P01", "42501", "42P01", "42703", "53300", "55000", "08001", "08006"])
    .optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
});
type Failure = z.infer<typeof failureSchema>;

/** Private exceptions contribute only closed codes and numeric status, never text or causes. */
export const reportRepositoryProductionFailure = (
  phase: Failure["phase"],
  code: Failure["code"],
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Only own data descriptors are projected into the closed diagnostic schema.
  error?: unknown,
): void => {
  try {
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- Descriptor values remain untrusted until parsed below.
    const own = (name: string): unknown =>
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Never invoke exception accessors or inspect raw text.
      error !== null && typeof error === "object"
        ? Object.getOwnPropertyDescriptor(error, name)?.value
        : undefined;
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
