import { createHash } from "node:crypto";
import { z } from "zod";
import { HostedOperatorError, operatorPublicResultSchema } from "./hosted-operator-contract";

const operatorPlanStage = z.enum([
  "journal_read",
  "accepted_spec",
  "release_selection",
  "release_read",
  "neon_planning",
  "provider_inventory",
  "shared_auth_read",
  "auth_adoption_read",
  "auth_schema_proposal",
  "auth_schema_publish",
  "worker_selection",
  "plan_construction",
  "identity_plan_resolution",
  "plan_owner_authorization",
  "plan_composition",
  "plan_validation",
  "plan_authorization",
  "plan_reservation",
  "neon_configuration",
  "neon_owner_guard",
  "neon_oidc",
  "neon_connect_broker",
  "neon_mcp_client",
  "neon_project_metadata",
  "neon_branch_metadata",
  "neon_endpoint_metadata",
  "neon_database_metadata",
  "neon_role_metadata",
  "neon_connection_credential",
  "neon_source_project_access",
  "neon_native_store",
]);
export type OperatorPlanStage = z.infer<typeof operatorPlanStage>;
const operatorPlanningSqlState = z.enum([
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
const operatorPlanningFailure = z.strictObject({
  stage: operatorPlanStage,
  errorClass: z.enum(["operator_error", "validation_error", "type_error", "unexpected"]),
  code: operatorPublicResultSchema.shape.code.unwrap().optional(),
  sqlState: operatorPlanningSqlState.optional(),
  nativeStoreFailure: z
    .enum(["connection_required", "provider_unavailable", "resource_mismatch"])
    .optional(),
});
type OperatorPlanningFailure = z.infer<typeof operatorPlanningFailure>;

const operatorExecutionStage = z.enum([
  "owner_authorization",
  "journal_read",
  "provider_authorization",
  "approval_authorization",
  "approval_read",
  "lease_claim",
]);
export type OperatorExecutionStage = z.infer<typeof operatorExecutionStage>;
const operatorExecutionFailure = operatorPlanningFailure
  .omit({ stage: true, nativeStoreFailure: true })
  .extend({ stage: operatorExecutionStage });
type OperatorExecutionFailure = z.infer<typeof operatorExecutionFailure>;

const boundary = z.enum(["builder", "operator"]);
const phase = z.enum(["inline", "check", "start", "complete"]);
const stage = z.enum([
  "configuration",
  "owner_context",
  "owner_configuration",
  "owner_configuration_parse",
  "owner_store_import",
  "owner_store_construction",
  "owner_authority",
  "owner_membership",
  "owner_session_binding",
  "client_construction",
  "principal",
  "operator_request",
  "operator_ingress",
  "workload_verification",
  "caller_workload",
  "operator_header_probe",
  "inline_token",
  "current_owner",
  "operator_oidc",
  "callback",
  "provider_token",
  "provider_start",
  "provider_start_projection",
]);
const outcome = z.enum([
  "started",
  "verified",
  "ready",
  "consent_required",
  "challenge_started",
  "operator_access_denied",
  "setup_unavailable",
  "control_flow_propagated",
]);
export const operatorWorkloadFailureSchema = z.strictObject({
  failedClaim: z
    .enum(["exp", "iat", "iss", "aud", "sub", "owner_id", "project_id", "environment"])
    .optional(),
  joseCode: z
    .enum([
      "ERR_JWT_CLAIM_VALIDATION_FAILED",
      "ERR_JWT_EXPIRED",
      "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
      "ERR_JWKS_NO_MATCHING_KEY",
      "ERR_JOSE_ALG_NOT_ALLOWED",
      "ERR_JWKS_TIMEOUT",
    ])
    .optional(),
  reason: z.enum([
    "missing_authorization",
    "verification_failed",
    "policy_owner_mismatch",
    "policy_project_mismatch",
    "policy_environment_mismatch",
  ]),
});
export type OperatorWorkloadFailure = z.infer<typeof operatorWorkloadFailureSchema>;

const operatorPlanningMismatchBoundary = z.enum([
  "application_selection",
  "inventory_configuration",
  "inventory_project",
  "inventory_deployment",
  "gateway_origin",
  "plan_result",
]);
export type OperatorPlanningMismatchBoundary = z.infer<typeof operatorPlanningMismatchBoundary>;
const operatorPlanningMismatchField = z.enum([
  "application_missing",
  "app_project",
  "app_branch",
  "team",
  "project_separation",
  "gateway_branch",
  "app_environment",
  "gateway_environment",
  "native_store_binding",
  "project_identity",
  "project_owner",
  "deployment_project",
  "deployment_identity",
  "deployment_owner",
  "deployment_ready",
  "deployment_environment",
  "deployment_branch",
  "deployment_missing",
  "public_origin",
  "gateway_origin",
  "plan_action",
  "plan_selection",
  "gateway_plan",
]);
export type OperatorPlanningMismatchField = z.infer<typeof operatorPlanningMismatchField>;

const callerEnvironment = z.enum(["development", "preview", "production"]);
export const operatorCallerWorkloadSchema = z.strictObject({
  environmentMatches: z.boolean().optional(),
  projectMatches: z.boolean().optional(),
  runtimeEnvironment: callerEnvironment.optional(),
  signatureVerified: z.literal(true).optional(),
  source: z.enum(["request_context", "environment", "unknown"]),
  teamMatches: z.boolean().optional(),
  tokenEnvironment: callerEnvironment.optional(),
  verification: z.enum(["verified", "failed", "unavailable"]),
});
export type OperatorCallerWorkload = z.infer<typeof operatorCallerWorkloadSchema>;

export const operatorOwnerStoreImportErrorCodeSchema = z.enum([
  "ERR_MODULE_NOT_FOUND",
  "MODULE_NOT_FOUND",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "ERR_PACKAGE_IMPORT_NOT_DEFINED",
  "ERR_REQUIRE_ESM",
  "ERR_UNKNOWN_FILE_EXTENSION",
  "ERR_UNSUPPORTED_DIR_IMPORT",
  "ERR_UNSUPPORTED_ESM_URL_SCHEME",
]);

const metadata = z.strictObject({
  accessClass: z
    .enum(["upstream_auth_denied", "application_auth_denied", "other_failed", "ok"])
    .optional(),
  boundary,
  callerWorkload: operatorCallerWorkloadSchema.optional(),
  challengeProjection: z
    .strictObject({
      deviceCodeValid: z.boolean(),
      expiresAtValid: z.boolean(),
      failure: z
        .enum([
          "response_invalid",
          "url_missing",
          "url_invalid",
          "device_code_invalid",
          "expiry_invalid",
        ])
        .optional(),
      urlPresent: z.boolean(),
      urlValid: z.boolean(),
    })
    .optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  nativeNotFound: z.boolean().optional(),
  outcome,
  ownerConfiguration: z
    .strictObject({
      databasePolicyValid: z.boolean(),
      databaseUrlConfigured: z.boolean(),
      issuerCanonical: z.boolean(),
      issuerConfigured: z.boolean(),
      resourceCanonical: z.boolean(),
      resourceConfigured: z.boolean(),
    })
    .optional(),
  ownerStoreImport: z
    .strictObject({
      errorCode: operatorOwnerStoreImportErrorCodeSchema.optional(),
      module: z.enum(["database", "handoff", "session", "membership"]),
    })
    .optional(),
  phase,
  planningFailure: operatorPlanningFailure.optional(),
  executionFailure: operatorExecutionFailure.optional(),
  planningMismatch: z
    .strictObject({
      boundary: operatorPlanningMismatchBoundary,
      fields: z.array(operatorPlanningMismatchField),
    })
    .optional(),
  probeVariant: z.enum(["both_headers", "trusted_oidc_only"]).optional(),
  stage,
  vercelError: z.literal("TRUSTED_SOURCES_ENVIRONMENT_MISMATCH").optional(),
  workloadFailure: operatorWorkloadFailureSchema.optional(),
});
export type HostedOperatorConsentMetadata = z.infer<typeof metadata>;
export type HostedOperatorConsentDiagnostic = HostedOperatorConsentMetadata & {
  event: "builder.hosted_neon_consent";
  sessionIdHash: string;
};
export type HostedOperatorConsentDiagnosticSink = (
  value: HostedOperatorConsentDiagnostic,
) => void | Promise<void>;

/** Closed metadata only. Never receives exceptions, URLs, inputs, outputs or credentials. */
export const createHostedOperatorConsentDiagnostic = (
  sessionId: string,
  sink?: HostedOperatorConsentDiagnosticSink,
) => {
  let sessionIdHash: string;
  try {
    sessionIdHash = `sha256:${createHash("sha256").update(sessionId).digest("hex")}`;
  } catch {
    return (_value: HostedOperatorConsentMetadata) => {
      /* Diagnostics are unavailable; authorization remains unchanged. */
    };
  }
  return (value: HostedOperatorConsentMetadata) => {
    try {
      const parsed = metadata.safeParse(value);
      if (!parsed.success) {
        return;
      }
      const diagnostic: HostedOperatorConsentDiagnostic = {
        ...parsed.data,
        event: "builder.hosted_neon_consent",
        sessionIdHash,
      };
      if (sink === undefined) {
        console.info("[builder:hosted-neon-consent]", diagnostic);
      } else {
        const deliver = async () => {
          try {
            await sink(diagnostic);
          } catch {
            /* Diagnostic only. */
          }
        };
        void deliver();
      }
    } catch {
      /* Diagnostics never change authorization or pause behavior. */
    }
  };
};

/** Report failed comparisons using fixed labels, without receiving their values. */
export const reportOperatorPlanningMismatch = (
  sessionId: string,
  mismatchBoundary: OperatorPlanningMismatchBoundary,
  failed: Partial<Record<OperatorPlanningMismatchField, boolean>>,
  sink?: HostedOperatorConsentDiagnosticSink,
): void => {
  try {
    const fields = operatorPlanningMismatchField.options.filter(
      (field) => Object.hasOwn(failed, field) && failed[field] === true,
    );
    if (fields.length === 0) {
      return;
    }
    createHostedOperatorConsentDiagnostic(
      sessionId,
      sink,
    )({
      boundary: "operator",
      phase: "inline",
      stage: "operator_request",
      outcome: "setup_unavailable",
      planningMismatch: { boundary: mismatchBoundary, fields },
    });
  } catch {
    /* Diagnostics never change planning or authorization behavior. */
  }
};

/** Observe a private planning boundary without changing its result or rejection. */
export const observeOperatorPlanStage = async <T>(
  sessionId: string,
  planStage: OperatorPlanStage,
  run: () => T | Promise<T>,
  sink?: HostedOperatorConsentDiagnosticSink,
): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    const planningFailure: OperatorPlanningFailure = {
      stage: planStage,
      errorClass: "unexpected",
    };
    try {
      if (error instanceof HostedOperatorError) {
        planningFailure.errorClass = "operator_error";
        const code: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value;
        const parsedCode = operatorPublicResultSchema.shape.code.unwrap().safeParse(code);
        if (parsedCode.success) {
          planningFailure.code = parsedCode.data;
        }
      } else if (error instanceof z.ZodError) {
        planningFailure.errorClass = "validation_error";
      } else if (error instanceof TypeError) {
        planningFailure.errorClass = "type_error";
      }
      if (planningFailure.errorClass === "unexpected") {
        const code: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value;
        const parsedSqlState = operatorPlanningSqlState.safeParse(code);
        if (parsedSqlState.success) {
          planningFailure.sqlState = parsedSqlState.data;
        }
      }
    } catch {
      /* Hostile error objects cannot change the original rejection. */
    }
    try {
      createHostedOperatorConsentDiagnostic(
        sessionId,
        sink,
      )({
        boundary: "operator",
        phase: "inline",
        stage: "operator_request",
        outcome: "setup_unavailable",
        planningFailure,
      });
    } catch {
      /* Reporting cannot change the original rejection. */
    }
    throw error;
  }
};

/** Observe a private execution boundary without changing its result or rejection. */
export const observeOperatorExecutionStage = async <T>(
  sessionId: string,
  executionStage: OperatorExecutionStage,
  run: () => T | Promise<T>,
  sink?: HostedOperatorConsentDiagnosticSink,
): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    const executionFailure: OperatorExecutionFailure = {
      stage: executionStage,
      errorClass: "unexpected",
    };
    try {
      if (error instanceof HostedOperatorError) {
        executionFailure.errorClass = "operator_error";
        const code: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value;
        const parsedCode = operatorPublicResultSchema.shape.code.unwrap().safeParse(code);
        if (parsedCode.success) {
          executionFailure.code = parsedCode.data;
        }
      } else if (error instanceof z.ZodError) {
        executionFailure.errorClass = "validation_error";
      } else if (error instanceof TypeError) {
        executionFailure.errorClass = "type_error";
      }
      if (executionFailure.errorClass === "unexpected") {
        const code: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value;
        const parsedSqlState = operatorPlanningSqlState.safeParse(code);
        if (parsedSqlState.success) {
          executionFailure.sqlState = parsedSqlState.data;
        }
      }
    } catch {
      /* Hostile error objects cannot change the original rejection. */
    }
    try {
      createHostedOperatorConsentDiagnostic(
        sessionId,
        sink,
      )({
        boundary: "operator",
        phase: "inline",
        stage: "operator_request",
        outcome: "setup_unavailable",
        executionFailure,
      });
    } catch {
      /* Reporting cannot change the original rejection. */
    }
    throw error;
  }
};
