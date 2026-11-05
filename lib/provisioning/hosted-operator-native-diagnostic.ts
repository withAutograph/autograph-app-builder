import { z } from "zod";
import { DrizzleQueryError } from "drizzle-orm";
import { HostedOperatorError, operatorPublicResultSchema } from "./hosted-operator-contract";

export type HostedOperatorNativeFailureStage =
  | "native_request_dependencies"
  | "native_handler_dispatch"
  | "native_fallback_initialize"
  | "resolver_configuration"
  | "resolver_configuration_source"
  | "resolver_configuration_authorization"
  | "resolver_owner_reader_config"
  | "resolver_keyring"
  | "resolver_resources"
  | "resolver_workload"
  | "resolver_owner"
  | "resolver_registry"
  | "resolver_effective_config"
  | "resolver_dispose"
  | "control_plane"
  | "composition"
  | "native_plan_workload"
  | "native_plan_owner"
  | "native_plan_registry_read"
  | "native_plan_captured_release"
  | "native_plan_profile_resolution"
  | "native_plan_supersede"
  | "native_plan_dispatch";

const nativeFailureSqlState = z.enum([
  "28P01",
  "42501",
  "42P01",
  "42703",
  "23505",
  "40001",
  "40P01",
  "53300",
  "55000",
  "08001",
  "08006",
]);

export const reportHostedOperatorNativeFailure = (
  stage: HostedOperatorNativeFailureStage,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Project private failures into fixed diagnostic labels only.
  error: unknown,
): void => {
  try {
    // Never invoke exception accessors or log arbitrary names, text or causes.
    const code: unknown =
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Own data descriptors are the diagnostic boundary.
      error !== null && typeof error === "object"
        ? Object.getOwnPropertyDescriptor(error, "code")?.value
        : undefined;
    let errorClass = "unexpected";
    if (error instanceof HostedOperatorError) {
      errorClass = "operator_error";
    } else if (error instanceof DrizzleQueryError) {
      errorClass = "query_error";
    } else if (error instanceof z.ZodError) {
      errorClass = "validation_error";
    } else if (error instanceof TypeError) {
      errorClass = "type_error";
    } else if (error instanceof SyntaxError) {
      errorClass = "syntax_error";
    }
    const publicCode = operatorPublicResultSchema.shape.code.unwrap().safeParse(code);
    let sqlState = nativeFailureSqlState.safeParse(code);
    if (!sqlState.success && error instanceof DrizzleQueryError) {
      const cause: unknown = Object.getOwnPropertyDescriptor(error, "cause")?.value;
      const causeCode: unknown =
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Inspect one known query wrapper's own data property without invoking accessors.
        cause !== null && typeof cause === "object"
          ? Object.getOwnPropertyDescriptor(cause, "code")?.value
          : undefined;
      sqlState = nativeFailureSqlState.safeParse(causeCode);
    }
    console.warn(
      JSON.stringify({
        event: "builder.hosted_operator_native_failure",
        stage,
        errorClass,
        ...(error instanceof HostedOperatorError && publicCode.success
          ? { code: publicCode.data }
          : {}),
        ...(sqlState.success ? { sqlState: sqlState.data } : {}),
      }),
    );
  } catch {
    // Diagnostic failures must preserve the original response, error and cleanup.
  }
};
