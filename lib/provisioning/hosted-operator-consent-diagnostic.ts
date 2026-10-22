import { createHash } from "node:crypto";
import { APIError } from "@vercel/sandbox";
import { z } from "zod";
import { HostedOperatorError, operatorPublicResultSchema } from "./hosted-operator-contract";
import {
  normalAuthClientFailureDiagnosticSchema,
  projectNormalAuthClientFailure,
} from "./hosted-operator-normal-auth-client";

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
  "saved_plan_read",
  "saved_plan_classification",
  "saved_plan_reexposure",
  "successor_prior_read",
  "successor_classification",
  "prior_successor_approval",
  "retained_state_read",
  "retained_approval",
  "plan_journal_update",
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
const operatorPlanningValidationInvariant = z.enum([
  "identity_link_scope",
  "gateway_candidate_scope",
  "gateway_environment_scope",
  "app_delivery_scope",
  "other_custom",
  "schema_shape",
  "unknown",
]);
type OperatorPlanningValidationInvariant = z.infer<typeof operatorPlanningValidationInvariant>;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Exact string matching discards untrusted issue messages without coercion.
const planningCustomInvariant = (message: unknown): OperatorPlanningValidationInvariant => {
  switch (message) {
    case "Realm identity link must match the owned Auth resource, exact issuer and canonical owner session.": {
      return "identity_link_scope";
    }
    case "Gateway candidates must belong to the exact approved native project and branch.":
    case "Only an independently READY Gateway candidate may be pinned.": {
      return "gateway_candidate_scope";
    }
    case "Gateway rows must remain in the owned trusted project.": {
      return "gateway_environment_scope";
    }
    case "Deployment candidates must remain within their approved project and Preview branch.":
    case "Only an observed READY deployment of this approved delivery may be selected.":
    case "Managed environment rows must belong to this approved app operation.":
    case "Historical app delivery must retain its actual owned project, branch and row lineage.": {
      return "app_delivery_scope";
    }
    default: {
      return "other_custom";
    }
  }
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- The private descriptor reader leaves parsing to the closed-label projector and never invokes getters.
const ownDiagnosticValue = (value: unknown, key: string): unknown => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Never read untrusted accessors, inherited properties or arbitrary exception values.
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(value, key)?.value;
};

/** Project existing issues only; never parse the record again or retain issue text, paths or values. */
export const projectOperatorPlanningValidationInvariants = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This pure diagnostic projector must tolerate arbitrary thrown objects.
  error: unknown,
): OperatorPlanningValidationInvariant[] => {
  try {
    const issues = ownDiagnosticValue(error, "issues");
    const length = ownDiagnosticValue(issues, "length");
    if (
      !Array.isArray(issues) ||
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Array length is accepted only from an own data descriptor.
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 1
    ) {
      return ["unknown"];
    }
    const labels = new Set<OperatorPlanningValidationInvariant>();
    // Bound inspection of untrusted exception metadata, never the planned workload.
    const inspected = Math.min(length, 64);
    for (let index = 0; index < inspected; index += 1) {
      const issue = ownDiagnosticValue(issues, String(index));
      const code = ownDiagnosticValue(issue, "code");
      if (code === "custom") {
        labels.add(planningCustomInvariant(ownDiagnosticValue(issue, "message")));
      } else {
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Only the presence of a data issue code is projected, never its contents.
        labels.add(typeof code === "string" ? "schema_shape" : "unknown");
      }
    }
    if (length > inspected) {
      labels.add("unknown");
    }
    return operatorPlanningValidationInvariant.options.filter((label) => labels.has(label));
  } catch {
    return ["unknown"];
  }
};

const operatorPlanningFailure = z.strictObject({
  stage: operatorPlanStage,
  errorClass: z.enum(["operator_error", "validation_error", "type_error", "unexpected"]),
  code: operatorPublicResultSchema.shape.code.unwrap().optional(),
  sqlState: operatorPlanningSqlState.optional(),
  validationInvariants: z.array(operatorPlanningValidationInvariant).optional(),
  nativeStoreFailure: z
    .enum(["connection_required", "provider_unavailable", "resource_mismatch"])
    .optional(),
});
type OperatorPlanningFailure = z.infer<typeof operatorPlanningFailure>;

const continuityPlanningStage = z.enum([
  "tool_client_resolution",
  "tool_preview_target",
  "tool_local_sandbox",
  "tool_selected_app",
  "tool_sandbox_identity",
  "tool_plan_request",
  "client_request_validation",
  "client_token_resolution",
  "client_transport",
  "client_response_status",
  "client_response_decode",
  "client_response_validation",
  "dispatcher_workload_verification",
  "dispatcher_owner_authorization",
  "dispatcher_planning",
  "prepared_runtime",
  "sandbox_authorization",
  "sandbox_resume",
  "port_observation",
]);
export type ContinuityPlanningStage = z.infer<typeof continuityPlanningStage>;
const continuityPlanningFailure = z.strictObject({
  stage: continuityPlanningStage,
  errorClass: z.enum([
    "operator_error",
    "validation_error",
    "type_error",
    "unexpected",
    "sandbox_api_error",
    "abort_error",
  ]),
  httpStatus: z.number().int().min(100).max(599).optional(),
  signalAborted: z.boolean().optional(),
});

const exportPlanningStage = z.enum([
  "tool_client_resolution",
  "tool_preview_target",
  "tool_project_mismatch",
  "tool_branch_mismatch",
  "tool_missing_customer",
  "tool_plan_request",
  "dispatcher_workload_verification",
  "dispatcher_owner_authorization",
  "plan_owner_authorization",
  "plan_prior_read",
  "plan_prior_validation",
  "plan_input_validation",
  "worker_configuration",
  "prepared_owner_authorization",
  "prepared_journal_read",
  "prepared_phase_validation",
  "prepared_approval_authorization",
  "customer_authorization",
  "release_selection",
  "release_match",
  "release_read",
  "plan_construction",
  "plan_validation",
  "setup_owner_authorization",
  "setup_journal_read",
  "setup_phase_validation",
  "setup_approval_authorization",
  "setup_customer_authorization",
  "setup_match",
  "setup_match_original_setup",
  "setup_match_resource",
  "setup_match_release_id",
  "setup_match_release_manifest",
  "setup_match_release_ref",
  "setup_match_app",
  "plan_reservation",
  "plan_reservation_match",
  "plan_response",
]);
export type ExportPlanningStage = z.infer<typeof exportPlanningStage>;
export type ExportPlanningStageObserver = (stage: ExportPlanningStage) => void;
const exportPlanningFailure = z.strictObject({
  stage: exportPlanningStage,
  errorClass: z.enum(["operator_error", "validation_error", "type_error", "unexpected"]),
});

/** Optional diagnostics cannot alter planning or authorization, including a throwing observer. */
export const advanceExportPlanningStage = (
  observer: ExportPlanningStageObserver | undefined,
  planStage: ExportPlanningStage,
): void => {
  try {
    observer?.(planStage);
  } catch {
    /* Planning retains its original behavior when diagnostics are unavailable. */
  }
};

const normalActorProofFailure = z.strictObject({
  stage: z.enum([
    "authorization",
    "journal_read",
    "owner_session",
    "realm_binding",
    "proof_preparation",
    "artifact_context",
    "proof_request",
    "proof_response",
    "proof_decode",
    "proof_artifact_read",
    "proof_verify",
    "proof_readback_request",
    "proof_readback_response",
    "proof_persistence",
    "result",
  ]),
  cookiePresent: z.boolean().optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  contentTypeValid: z.boolean().optional(),
  redirected: z.boolean().optional(),
  errorClass: operatorPlanningFailure.shape.errorClass.optional(),
  code: operatorPublicResultSchema.shape.code.unwrap().optional(),
});
export type OperatorNormalActorProofFailure = z.infer<typeof normalActorProofFailure>;

const operatorExecutionStage = z.enum([
  "owner_authorization",
  "journal_read",
  "provider_authorization",
  "approval_authorization",
  "approval_read",
  "lease_claim",
  "effect_reconciliation",
  "worker_preparation",
  "sandbox_create",
  "worker_pin",
  "spool_setup",
  "command_start",
  "command_stream",
  "worker_protocol",
  "command_wait",
  "readback",
  "final_inventory_readback",
  "final_runtime_readiness",
  "final_authority",
  "final_verifier_entry",
  "final_owner_authorization",
  "final_journal_read",
  "final_proof_parse",
  "final_proof_publication",
  "resource_lease",
  "final_lease_release",
  "execution_settlement",
  "sandbox_cleanup",
]);
export type OperatorExecutionStage = z.infer<typeof operatorExecutionStage>;
const operatorRuntimeReadinessStage = z.enum([
  "selection",
  "authority",
  "approved_access",
  "release_manifest",
  "runtime_credential",
  "runtime_connection",
  "runtime_identity",
  "actor_binding",
  "runtime_context",
  "runtime_release",
]);
export type OperatorRuntimeReadinessStage = z.infer<typeof operatorRuntimeReadinessStage>;
const authStartupStage = z.enum([
  "spool_open",
  "startup_plan_parse",
  "context_binding",
  "approved_plan_binding",
  "schema_options",
  "schema_replan",
  "migrator_preflight",
]);
const authStartupDomainCode = z.enum([
  "invalid_new_empty_auth_proposal",
  "invalid_auth_worker_startup",
  "auth_resource_mismatch",
  "auth_worker_context_mismatch",
  "auth_operator_plan_mismatch",
  "invalid_auth_schema_plan",
  "auth_schema_plan_mismatch",
  "migration_contention",
  "new_empty_public_namespace_occupied",
  "verified_schema_drift",
  "incomplete_schema_reconciliation_required",
  "incomplete_effect_plan_changed",
  "unowned_schema_history",
  "invalid_schema_history_tables",
  "exposed_schema_history",
  "configured_schema_mismatch",
  "schema_reconciliation_incomplete",
  "auth_configuration_error",
]);
interface AuthStartupDiagnostic {
  stage: z.infer<typeof authStartupStage>;
  domain_code?: z.infer<typeof authStartupDomainCode>;
}

/** Project advisory worker metadata without invoking getters or retaining arbitrary values. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This projection is the untrusted advisory metadata parser and must discard malformed input.
export const projectAuthStartupDiagnostic = (value: unknown): AuthStartupDiagnostic | undefined => {
  try {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Inspect only own data descriptors before validating closed fields; never invoke untrusted getters.
    if (value === null || typeof value !== "object") {
      return undefined;
    }
    const stage: unknown = Object.getOwnPropertyDescriptor(value, "stage")?.value;
    const parsedStage = authStartupStage.safeParse(stage);
    if (!parsedStage.success) {
      return undefined;
    }
    const code: unknown = Object.getOwnPropertyDescriptor(value, "domain_code")?.value;
    const parsedCode = authStartupDomainCode.safeParse(code);
    return {
      stage: parsedStage.data,
      ...(parsedCode.success ? { domain_code: parsedCode.data } : {}),
    };
  } catch {
    return undefined;
  }
};

const resourceReadbackStage = z.enum([
  "fence",
  "admin_identity",
  "database_read",
  "role_read",
  "role_assertion",
  "database_assertion",
  "migrator_login",
  "runtime_login",
  "final_fence",
]);
const resourceReadbackReason = z.enum([
  "authority_denied",
  "database_identity_mismatch",
  "provider_identity_mismatch",
  "resource_identity_conflict",
  "role_login_readback_failed",
  "runtime_privilege_readback_failed",
  "startup_rejected",
  "effect_failed",
]);
const resourceReadbackSqlStateClass = z.enum([
  "08",
  "22",
  "23",
  "28",
  "3D",
  "3F",
  "40",
  "42",
  "53",
  "54",
  "55",
  "57",
  "58",
  "XX",
]);
interface ResourceReadbackDiagnostic {
  stage: z.infer<typeof resourceReadbackStage>;
  reason?: z.infer<typeof resourceReadbackReason>;
  sqlStateClass?: z.infer<typeof resourceReadbackSqlStateClass>;
}

/** Keep only closed worker failure labels; advisory metadata never changes the result. */
export const projectResourceReadbackDiagnostic = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This projection accepts untrusted advisory metadata and discards arbitrary values.
  value: unknown,
): ResourceReadbackDiagnostic | undefined => {
  try {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Own data descriptors avoid invoking untrusted getters.
    if (value === null || typeof value !== "object") {
      return undefined;
    }
    const stage: unknown = Object.getOwnPropertyDescriptor(value, "stage")?.value;
    const parsedStage = resourceReadbackStage.safeParse(stage);
    if (!parsedStage.success) {
      return undefined;
    }
    const reason: unknown = Object.getOwnPropertyDescriptor(value, "reason")?.value;
    const parsedReason = resourceReadbackReason.safeParse(reason);
    const sqlStateClass: unknown = Object.getOwnPropertyDescriptor(value, "sqlStateClass")?.value;
    const parsedClass = resourceReadbackSqlStateClass.safeParse(sqlStateClass);
    return {
      stage: parsedStage.data,
      ...(parsedReason.success ? { reason: parsedReason.data } : {}),
      ...(parsedClass.success ? { sqlStateClass: parsedClass.data } : {}),
    };
  } catch {
    return undefined;
  }
};

const operatorExecutionFailure = operatorPlanningFailure
  .omit({ stage: true, nativeStoreFailure: true })
  .extend({
    stage: operatorExecutionStage,
    runtimeReadinessStage: operatorRuntimeReadinessStage.optional(),
    authStartup: z.unknown().optional(),
    resourceReadback: z.unknown().optional(),
    normalAuth: normalAuthClientFailureDiagnosticSchema.optional(),
    journalFailure: z.literal("normal_actor_journal_changed").optional(),
    mode: z.enum(["inspect", "execute"]).optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    commandExit: z.enum(["zero", "nonzero"]).optional(),
    protocol: z.enum(["incomplete", "unknown"]).optional(),
    workerFailure: z
      .enum([
        "startup_rejected",
        "authority_denied",
        "effect_failed",
        "readback_unknown",
        "protocol_failure",
        "cancelled",
        "timeout",
      ])
      .optional(),
  })
  .transform(({ authStartup, resourceReadback, ...failure }) => {
    const projected =
      failure.workerFailure === "startup_rejected"
        ? projectAuthStartupDiagnostic(authStartup)
        : undefined;
    const readback =
      failure.workerFailure === "readback_unknown" && failure.mode === "inspect"
        ? projectResourceReadbackDiagnostic(resourceReadback)
        : undefined;
    return {
      ...failure,
      ...(projected === undefined ? {} : { authStartup: projected }),
      ...(readback === undefined ? {} : { resourceReadback: readback }),
    };
  });
export type OperatorExecutionFailure = z.infer<typeof operatorExecutionFailure>;

const hostedEnvironmentBindingStage = z.enum([
  "input_validation",
  "credential_read",
  "project_read",
  "environment_list",
  "environment_value_read",
  "checkpoint",
  "create_post",
  "update_patch",
  "delete_request",
  "readback",
]);
const hostedEnvironmentBindingFailure = z.strictObject({
  stage: hostedEnvironmentBindingStage,
  requestTarget: z.enum(["environment_row", "project_settings"]).optional(),
  trustedSourcesVisibility: z.enum(["absent", "null", "present"]).optional(),
  approvedSourcePresent: z.boolean().optional(),
  approvedPairCovered: z.boolean().optional(),
  providerCode: z
    .enum([
      "not_found",
      "project_not_found",
      "forbidden",
      "unauthorized",
      "integration_configuration_disabled",
      "invalid_token",
      "other",
    ])
    .optional(),
  reason: z.enum([
    "input_rejected",
    "authorization_rejected",
    "credential_unavailable",
    "credential_read_failed",
    "provider_request_failed",
    "provider_rejected",
    "git_reference_rejection",
    "provider_response_invalid",
    "checkpoint_failed",
    "state_conflict",
  ]),
  httpStatus: z.number().int().min(100).max(599).optional(),
});
export type HostedEnvironmentBindingFailure = z.infer<typeof hostedEnvironmentBindingFailure>;

const runtimePreparationStage = z.enum([
  "approval_evaluation",
  "approval_module_loading",
  "module_loading",
  "input_validation",
  "client_resolution",
  "prior_approval",
  "operator_execute",
  "identity_read",
  "result_mapping",
]);
export type RuntimePreparationStage = z.infer<typeof runtimePreparationStage>;
const runtimePreparationFailure = z.strictObject({
  stage: runtimePreparationStage,
  errorClass: z.enum([
    "operator_error",
    "validation_error",
    "type_error",
    "abort_error",
    "timeout_error",
    "unexpected",
  ]),
  code: operatorPublicResultSchema.shape.code.unwrap().optional(),
  moduleCode: z
    .enum([
      "ERR_MODULE_NOT_FOUND",
      "MODULE_NOT_FOUND",
      "ERR_PACKAGE_PATH_NOT_EXPORTED",
      "ERR_UNKNOWN_FILE_EXTENSION",
    ])
    .optional(),
});

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
  "canonical_owner_app",
  "direct_owner_project",
  "prepared_preview_journal",
  "prepared_preview_selection",
  "inventory_configuration",
  "inventory_project",
  "inventory_deployment",
  "gateway_origin",
  "plan_result",
]);
export type OperatorPlanningMismatchBoundary = z.infer<typeof operatorPlanningMismatchBoundary>;
const operatorPlanningMismatchField = z.enum([
  "application_missing",
  "owner_app_missing",
  "owner_app_mismatch",
  "active_installations_missing",
  "ready_project_missing",
  "ready_project_ambiguous",
  "journal_missing",
  "operator_missing",
  "delivery_missing",
  "delivery_sha_missing",
  "artifact_missing",
  "journal_status",
  "plan_stage",
  "plan_digest",
  "selection_app",
  "selection_branch",
  "selection_environment",
  "selection_project",
  "selection_session",
  "delivery_project",
  "selection_missing",
  "release_source_binding",
  "release_app",
  "release_id",
  "release_manifest",
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

export const maintenanceUriMismatchSchema = z.enum([
  "url",
  "protocol",
  "hostname",
  "pooled_hostname",
  "port",
  "role",
  "password",
  "database",
  "fragment",
  "tls_mode",
  "tls_count",
  "query_keys",
  "channel_binding_count",
  "channel_binding_value",
  "encoding",
]);
export type OperatorMaintenanceUriMismatch = z.infer<typeof maintenanceUriMismatchSchema>;

const neonMcpFailureSchema = z.strictObject({
  phase: z.enum([
    "tool_request",
    "tool_error",
    "response_shape",
    "response_decode",
    "credential_shape",
    "credential_identity",
    "credential_uri",
  ]),
  sdkCode: z
    .union([
      z.literal(-32_700),
      z.literal(-32_600),
      z.literal(-32_601),
      z.literal(-32_602),
      z.literal(-32_603),
      z.literal(-32_000),
      z.literal(-32_001),
      z.literal(-32_002),
    ])
    .optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  uriMismatch: z.array(maintenanceUriMismatchSchema).optional(),
});
export type OperatorNeonMcpFailure = z.infer<typeof neonMcpFailureSchema>;

// Official CLI env error codes; BAD_REQUEST remains generic, never a guessed branch cause.
// https://github.com/vercel/vercel/blob/main/packages/cli/src/util/env/known-error.ts
const gatewayProviderCode = z.enum([
  "BAD_REQUEST",
  "ENV_ALREADY_EXISTS",
  "ENV_CONFLICT",
  "EXISTING_KEY_AND_TARGET",
  "FORBIDDEN",
  "ID_NOT_FOUND",
  "INVALID_KEY",
  "INVALID_VALUE",
  "KEY_INVALID_CHARACTERS",
  "KEY_INVALID_LENGTH",
  "KEY_RESERVED",
  "RESERVED_ENV_VARIABLE",
  "MAX_ENVS_EXCEEDED",
  "MISSING_ID",
  "MISSING_KEY",
  "MISSING_TARGET",
  "MISSING_VALUE",
  "NOT_AUTHORIZED",
  "NOT_DECRYPTABLE",
  "SYSTEM_ENV_WITH_VALUE",
  "TEAM_NOT_FOUND",
  "TOO_MANY_IDS",
  "TOO_MANY_KEYS",
  "UNKNOWN_ERROR",
  "VALUE_INVALID_LENGTH",
  "VALUE_INVALID_TYPE",
]);

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Read untrusted own data descriptors before the closed advisory projection; never invoke getters.
const ownProviderDetail = (value: unknown, key: string): unknown =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Object descriptors require an object; this does not authorize any provider data.
  typeof value === "object" && value !== null
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Parse ephemeral provider text here; only literal closed labels leave the caller.
const providerMessages = (value: unknown): string[] => {
  const message = z.string().safeParse(value);
  return message.success ? [message.data] : [];
};

const gatewayProviderTerm = z.enum([
  "branch",
  "production",
  "preview",
  "target",
  "integration",
  "token",
  "configuration",
  "permission",
  "duplicate",
  "size",
  "update",
  "length",
  "repository",
  "commit",
  "framework",
  "author",
  "build",
  "source",
  "sha",
  "ref",
  "repoId",
  "gitSource",
  "projectSettings",
]);
const gatewayValidationField = z.enum([
  "gitBranch",
  "target",
  "type",
  "key",
  "value",
  "comment",
  "gitSource",
  "ref",
  "sha",
  "repoId",
  "name",
  "project",
  "projectSettings",
]);

/** Literal observations only: labels are neither provider causes nor permission to retry. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the parser for untrusted advisory provider metadata; only closed fields are returned.
export const projectOperatorGatewayProviderFailure = (payload: unknown) => {
  const result: Pick<
    OperatorGatewayBindingsDiagnostic,
    "providerCode" | "providerTerms" | "validationFields"
  > = {};
  try {
    const error = ownProviderDetail(payload, "error");
    const rawCode = z.string().safeParse(ownProviderDetail(error, "code"));
    const code = gatewayProviderCode.safeParse(
      rawCode.success ? rawCode.data.toUpperCase() : undefined,
    );
    if (code.success) {
      result.providerCode = code.data;
    }
    const messages = providerMessages(ownProviderDetail(error, "message"));
    const details = ownProviderDetail(error, "details");
    const entries: unknown[] = [];
    if (Array.isArray(details)) {
      for (let index = 0; index < details.length; index += 1) {
        entries.push(ownProviderDetail(details, String(index)));
      }
    } else {
      entries.push(details);
    }
    const fields = new Set<z.infer<typeof gatewayValidationField>>();
    for (const detail of entries) {
      const nestedError = ownProviderDetail(detail, "error");
      messages.push(
        ...providerMessages(detail),
        ...providerMessages(ownProviderDetail(detail, "message")),
        ...providerMessages(nestedError),
        ...providerMessages(ownProviderDetail(nestedError, "message")),
      );
      const path = ownProviderDetail(detail, "path");
      const stringPath = z.string().safeParse(path);
      const field = gatewayValidationField.safeParse(
        stringPath.success ? stringPath.data.replace(/^\//u, "") : ownProviderDetail(path, "0"),
      );
      if (field.success) {
        fields.add(field.data);
      }
    }
    const terms = gatewayProviderTerm.options.filter((term) =>
      messages.some((text) => new RegExp(`\\b${term}\\b`, "iu").test(text)),
    );
    if (terms.length !== 0) {
      result.providerTerms = terms;
    }
    if (fields.size !== 0) {
      result.validationFields = gatewayValidationField.options.filter((field) => fields.has(field));
    }
  } catch {
    /* Hostile advisory properties cannot change the original provider failure. */
  }
  return result;
};

const gatewayBindingsDiagnostic = z.strictObject({
  mode: z.enum(["bind", "reconcile", "verify"]),
  stage: z.enum([
    "context",
    "authority",
    "credential",
    "known_rows",
    "environment_inventory",
    "managed_values",
    "required_environment",
    "public_environment",
    "trusted_origins",
    "runtime_binding",
    "prior_policy",
    "prior_projection",
    "app_candidate",
    "desired_values",
    "ownership_readback",
    "checkpoint",
    "prewrite",
    "write",
    "write_readback",
    "final_readback",
  ]),
  method: z.enum(["GET", "POST", "PATCH"]).optional(),
  requestTarget: z.enum(["project_environment", "project_settings"]).optional(),
  trustedSourcesVisibility: z.enum(["absent", "null", "present"]).optional(),
  missingApprovedPairCount: z.number().int().nonnegative().optional(),
  statusCategory: z
    .enum([
      "success",
      "auth_denied",
      "rate_limited",
      "client_error",
      "server_error",
      "redirect",
      "other",
      "no_response",
    ])
    .optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  providerCode: gatewayProviderCode.optional(),
  providerTerms: z.array(gatewayProviderTerm).optional(),
  validationFields: z.array(gatewayValidationField).optional(),
  result: z.enum(["bound", "applied", "absent", "unknown", "failed"]),
});
export type OperatorGatewayBindingsDiagnostic = z.infer<typeof gatewayBindingsDiagnostic>;

const gatewayDeliveryDiagnostic = z.strictObject({
  stage: z.enum([
    "context",
    "reconciliation",
    "alias_assignment",
    "environment",
    "authority",
    "prior_attempt",
    "project_read",
    "project_assertion",
    "before_create",
    "correction_intent",
    "deployment_create",
    "deployment_readback",
    "checkpoint",
  ]),
  phase: z
    .enum(["authority", "credential", "fetch", "http_response", "json_decode", "response_schema"])
    .optional(),
  method: z.enum(["GET", "POST"]).optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  result: z.enum(["applied", "retryable", "unknown"]),
  providerCode: gatewayProviderCode.optional(),
  providerTerms: z.array(gatewayProviderTerm).optional(),
  validationFields: z.array(gatewayValidationField).optional(),
});
export type OperatorGatewayDeliveryDiagnostic = z.infer<typeof gatewayDeliveryDiagnostic>;

const inventoryReadFailure = z.strictObject({
  target: z.enum(["inventory", "app", "gateway", "operator"]),
  operation: z.enum([
    "owner",
    "credential",
    "project",
    "deployment",
    "public_alias",
    "environment",
    "aliases",
    "store_list",
    "store_detail",
  ]),
  phase: z.enum(["owner", "credential", "fetch", "http_response", "json_decode", "schema"]),
  httpStatus: z.number().int().min(100).max(599).optional(),
  errorClass: operatorPlanningFailure.shape.errorClass.optional(),
  publicCode: operatorPublicResultSchema.shape.code.unwrap().optional(),
});
export type OperatorInventoryReadFailure = z.infer<typeof inventoryReadFailure>;
type InventoryReadDescriptor = Omit<OperatorInventoryReadFailure, "errorClass" | "publicCode">;

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
  neonMcpFailure: neonMcpFailureSchema.optional(),
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
  operatorAction: z
    .enum([
      "plan",
      "execute",
      "status",
      "bindings",
      "auth-identity-input",
      "resolve-preview-target",
      "neon-authorization",
    ])
    .optional(),
  operatorResponse: z.enum(["decode_failed", "schema_invalid", "blocked"]).optional(),
  operatorCode: operatorPublicResultSchema.shape.code.unwrap().optional(),
  preparationStage: runtimePreparationStage.optional(),
  preparationFailure: runtimePreparationFailure.optional(),
  phase,
  planningFailure: operatorPlanningFailure.optional(),
  continuityPlanningFailure: continuityPlanningFailure.optional(),
  exportPlanningFailure: exportPlanningFailure.optional(),
  normalActorProofFailure: normalActorProofFailure.optional(),
  executionFailure: operatorExecutionFailure.optional(),
  hostedEnvironmentBindingFailure: hostedEnvironmentBindingFailure.optional(),
  gatewayBindings: gatewayBindingsDiagnostic.optional(),
  gatewayDelivery: gatewayDeliveryDiagnostic.optional(),
  inventoryReadFailure: inventoryReadFailure.optional(),
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

const routineOwnerProgressStages = new Set<HostedOperatorConsentMetadata["stage"]>([
  "owner_configuration",
  "owner_authority",
  "owner_membership",
  "owner_session_binding",
]);

const isRoutineOwnerProgress = (value: HostedOperatorConsentMetadata): boolean => {
  if (value.boundary !== "builder" || value.phase !== "inline") {
    return false;
  }
  return (
    (value.outcome === "started" || value.outcome === "verified") &&
    routineOwnerProgressStages.has(value.stage)
  );
};

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
        // Reauthorization still runs for every effect; routine progress must not crowd out failures.
        if (isRoutineOwnerProgress(parsed.data)) {
          return;
        }
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

/** Descriptor-only projection: exception text and arbitrary caller metadata never reach the sink. */
export const reportOperatorNormalActorProofFailure = (
  sessionId: string,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Advisory metadata is projected from own data descriptors without invoking accessors.
  failure: unknown,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Only closed error classes and an existing public code may leave this boundary.
  error: unknown,
  sink?: HostedOperatorConsentDiagnosticSink,
): void => {
  try {
    const proofStage = normalActorProofFailure.shape.stage.safeParse(
      ownDiagnosticValue(failure, "stage"),
    );
    if (!proofStage.success) {
      return;
    }
    const projected: OperatorNormalActorProofFailure = { stage: proofStage.data };
    for (const key of ["cookiePresent", "contentTypeValid", "redirected"] as const) {
      const parsed = z.boolean().safeParse(ownDiagnosticValue(failure, key));
      if (parsed.success) {
        projected[key] = parsed.data;
      }
    }
    const httpStatus = normalActorProofFailure.shape.httpStatus.safeParse(
      ownDiagnosticValue(failure, "httpStatus"),
    );
    if (httpStatus.success) {
      projected.httpStatus = httpStatus.data;
    }
    projected.errorClass = "unexpected";
    try {
      if (error instanceof HostedOperatorError) {
        projected.errorClass = "operator_error";
        const code = operatorPublicResultSchema.shape.code
          .unwrap()
          .safeParse(ownDiagnosticValue(error, "code"));
        if (code.success) {
          projected.code = code.data;
        }
      } else if (error instanceof z.ZodError) {
        projected.errorClass = "validation_error";
      } else if (error instanceof TypeError) {
        projected.errorClass = "type_error";
      }
    } catch {
      /* Hostile exceptions cannot change the existing rejection. */
    }
    createHostedOperatorConsentDiagnostic(
      sessionId,
      sink,
    )({
      boundary: "operator",
      phase: "inline",
      stage: "operator_request",
      outcome: "setup_unavailable",
      normalActorProofFailure: projected,
    });
  } catch {
    /* Reporting cannot change collection, authority or error behavior. */
  }
};

/** Report a hosted environment-binding failure using only closed stage/reason/status values. */
export const reportHostedEnvironmentBindingFailure = (
  sessionId: string,
  failure: HostedEnvironmentBindingFailure,
  sink?: HostedOperatorConsentDiagnosticSink,
): void => {
  try {
    const parsed = hostedEnvironmentBindingFailure.safeParse(failure);
    if (!parsed.success) {
      return;
    }
    createHostedOperatorConsentDiagnostic(
      sessionId,
      sink,
    )({
      boundary: "operator",
      phase: "complete",
      stage: "operator_request",
      outcome: "setup_unavailable",
      hostedEnvironmentBindingFailure: parsed.data,
    });
  } catch {
    /* Reporting cannot change binding behavior. */
  }
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

type SandboxResumeFailure = Partial<
  Pick<z.infer<typeof continuityPlanningFailure>, "errorClass" | "httpStatus" | "signalAborted">
>;

/** Only the SDK's exported error class and closed HTTP/cancellation metadata may leave resume. */
const sandboxResumeFailure = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SDK and cancellation rejections are projected without reading exception details.
  error: unknown,
  requestSignal?: AbortSignal,
): SandboxResumeFailure => {
  const failure: SandboxResumeFailure = {};
  try {
    if (requestSignal !== undefined) {
      failure.signalAborted = requestSignal.aborted;
    }
    if (error instanceof APIError) {
      failure.errorClass = "sandbox_api_error";
      const response = ownDiagnosticValue(error, "response");
      if (response instanceof Response) {
        const status = continuityPlanningFailure.shape.httpStatus.safeParse(response.status);
        if (status.success && status.data !== undefined) {
          failure.httpStatus = status.data;
        }
      }
    } else if (error instanceof DOMException && error.name === "AbortError") {
      failure.errorClass = "abort_error";
    }
  } catch {
    /* Closed SDK classification never changes the original rejection. */
  }
  return failure;
};

/** Only fixed labels and the hashed session are emitted; exception properties are never read. */
export const reportExportPlanningFailure = (
  sessionId: string,
  planStage: ExportPlanningStage,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A rejection boundary must tolerate arbitrary thrown values without inspecting their properties.
  error: unknown,
  sink?: HostedOperatorConsentDiagnosticSink,
): void => {
  try {
    let errorClass: z.infer<typeof exportPlanningFailure>["errorClass"] = "unexpected";
    try {
      if (error instanceof HostedOperatorError) {
        errorClass = "operator_error";
      } else if (error instanceof z.ZodError) {
        errorClass = "validation_error";
      } else if (error instanceof TypeError) {
        errorClass = "type_error";
      }
    } catch {
      /* Hostile prototypes are unclassified, never traversed. */
    }
    createHostedOperatorConsentDiagnostic(
      sessionId,
      sink,
    )({
      boundary: planStage.startsWith("tool_") ? "builder" : "operator",
      phase: "inline",
      stage: "operator_request",
      outcome: "setup_unavailable",
      exportPlanningFailure: { stage: planStage, errorClass },
    });
  } catch {
    /* Diagnostics cannot replace the original rejection. */
  }
};

/** Continuity diagnostics retain only fixed stage/class labels, never exception details. */
export const reportContinuityPlanningFailure = (
  sessionId: string,
  planStage: ContinuityPlanningStage,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This rejection boundary classifies arbitrary thrown values without reading their properties.
  error: unknown,
  sink?: HostedOperatorConsentDiagnosticSink,
  requestSignal?: AbortSignal,
): void => {
  const failure: z.infer<typeof continuityPlanningFailure> = {
    stage: planStage,
    errorClass: "unexpected",
  };
  try {
    if (error instanceof HostedOperatorError) {
      failure.errorClass = "operator_error";
    } else if (error instanceof z.ZodError) {
      failure.errorClass = "validation_error";
    } else if (error instanceof TypeError) {
      failure.errorClass = "type_error";
    }
  } catch {
    /* Hostile prototypes cannot change the original rejection. */
  }
  if (planStage === "sandbox_resume") {
    Object.assign(failure, sandboxResumeFailure(error, requestSignal));
  }
  try {
    createHostedOperatorConsentDiagnostic(
      sessionId,
      sink,
    )({
      boundary:
        planStage.startsWith("tool_") || planStage.startsWith("client_") ? "builder" : "operator",
      phase: "inline",
      stage: "operator_request",
      outcome: "setup_unavailable",
      continuityPlanningFailure: failure,
    });
  } catch {
    /* Diagnostics never change continuity planning. */
  }
};

/** Observe an existing planning call exactly once, preserving its value or rejection. */
export const observeContinuityPlanningStage = async <T>(
  sessionId: string,
  planStage: ContinuityPlanningStage,
  run: () => T | Promise<T>,
  sink?: HostedOperatorConsentDiagnosticSink,
  requestSignal?: AbortSignal,
): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    reportContinuityPlanningFailure(sessionId, planStage, error, sink, requestSignal);
    throw error;
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
        if (planStage === "plan_journal_update") {
          planningFailure.validationInvariants = projectOperatorPlanningValidationInvariants(error);
        }
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

/** Report only closed failure metadata; never change the original private rejection. */
export const reportOperatorExecutionFailure = (
  sessionId: string,
  executionStage: OperatorExecutionStage,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This exception boundary accepts arbitrary thrown values and projects only schema-checked closed diagnostic fields.
  error: unknown,
  sink?: HostedOperatorConsentDiagnosticSink,
  execution?: Pick<
    OperatorExecutionFailure,
    | "stage"
    | "runtimeReadinessStage"
    | "mode"
    | "commandExit"
    | "protocol"
    | "workerFailure"
    | "httpStatus"
    | "authStartup"
    | "resourceReadback"
  >,
): void => {
  const executionFailure: OperatorExecutionFailure = {
    stage: executionStage,
    ...execution,
    errorClass: "unexpected",
  };
  const normalAuth = projectNormalAuthClientFailure(error);
  if (normalAuth !== undefined) {
    executionFailure.normalAuth = normalAuth;
  }
  try {
    if (
      error instanceof Error &&
      ownDiagnosticValue(error, "message") === "normal_actor_journal_changed"
    ) {
      executionFailure.journalFailure = "normal_actor_journal_changed";
    }
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
};

/** Report one private provider inventory read using only closed operation and error labels. */
export const reportOperatorInventoryReadFailure = (
  sessionId: string,
  descriptor: InventoryReadDescriptor,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Exception boundaries accept arbitrary thrown values and project only closed labels.
  error: unknown,
  sink?: HostedOperatorConsentDiagnosticSink,
): void => {
  try {
    const failure: OperatorInventoryReadFailure = { ...descriptor };
    try {
      if (error instanceof HostedOperatorError) {
        failure.errorClass = "operator_error";
        const code = operatorPublicResultSchema.shape.code
          .unwrap()
          .safeParse(ownDiagnosticValue(error, "code"));
        if (code.success) {
          failure.publicCode = code.data;
        }
      } else if (error instanceof z.ZodError) {
        failure.errorClass = "validation_error";
      } else if (error instanceof TypeError) {
        failure.errorClass = "type_error";
      } else {
        failure.errorClass = "unexpected";
      }
    } catch {
      /* Hostile error objects cannot change provider read behavior. */
    }
    createHostedOperatorConsentDiagnostic(
      sessionId,
      sink,
    )({
      boundary: "operator",
      phase: "inline",
      stage: "operator_request",
      outcome: "setup_unavailable",
      inventoryReadFailure: failure,
    });
  } catch {
    /* Hostile descriptors and diagnostics never change provider read behavior. */
  }
};

/** Observe a private execution boundary without changing its result or rejection. */
export const observeOperatorExecutionStage = async <T>(
  sessionId: string,
  executionStage: OperatorExecutionStage,
  run: () => T | Promise<T>,
  sink?: HostedOperatorConsentDiagnosticSink,
  execution?: Pick<
    OperatorExecutionFailure,
    | "stage"
    | "runtimeReadinessStage"
    | "mode"
    | "commandExit"
    | "protocol"
    | "workerFailure"
    | "httpStatus"
    | "authStartup"
    | "resourceReadback"
  >,
): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    reportOperatorExecutionFailure(sessionId, executionStage, error, sink, execution);
    throw error;
  }
};

/** Fixed credential-read failure phases and numeric SDK status only; never inspect messages or bodies. */
export const reportOperatorNeonMcpFailure = (
  sessionId: string,
  failurePhase: OperatorNeonMcpFailure["phase"],
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SDK exceptions are untrusted; only own numeric fields enter closed diagnostic schemas.
  error?: unknown,
  sink?: HostedOperatorConsentDiagnosticSink,
  uriMismatch?: OperatorMaintenanceUriMismatch[],
): void => {
  try {
    const failure: OperatorNeonMcpFailure = { phase: failurePhase };
    if (uriMismatch !== undefined) {
      failure.uriMismatch = maintenanceUriMismatchSchema.array().parse(uriMismatch);
    }
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- Keep descriptor values untrusted until the closed numeric schemas below parse them.
    const ownValue = (name: string): unknown => {
      try {
        return Object.getOwnPropertyDescriptor(error, name)?.value;
      } catch {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- Missing or hostile descriptors supply no diagnostic value.
        return undefined;
      }
    };
    const sdkCode = neonMcpFailureSchema.shape.sdkCode.safeParse(ownValue("code"));
    const httpStatus = neonMcpFailureSchema.shape.httpStatus.safeParse(ownValue("statusCode"));
    if (sdkCode.success && sdkCode.data !== undefined) {
      failure.sdkCode = sdkCode.data;
    }
    if (httpStatus.success && httpStatus.data !== undefined) {
      failure.httpStatus = httpStatus.data;
    }
    createHostedOperatorConsentDiagnostic(
      sessionId,
      sink,
    )({
      boundary: "operator",
      phase: "inline",
      stage: "operator_request",
      outcome: "setup_unavailable",
      neonMcpFailure: failure,
    });
  } catch {
    /* Diagnostics cannot change credential authorization or expose hostile exception properties. */
  }
};

/** Closed preparation failure only; hostile exception fields and failing sinks never affect behavior. */
export const reportRuntimePreparationFailure = (
  sessionId: string,
  preparationStage: RuntimePreparationStage,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Untrusted caught exceptions enter only closed classification schemas.
  error: unknown,
  sink?: HostedOperatorConsentDiagnosticSink,
): void => {
  const failure: z.infer<typeof runtimePreparationFailure> = {
    stage: preparationStage,
    errorClass: "unexpected",
  };
  try {
    if (error instanceof HostedOperatorError) {
      failure.errorClass = "operator_error";
    } else if (error instanceof z.ZodError) {
      failure.errorClass = "validation_error";
    } else if (error instanceof TypeError) {
      failure.errorClass = "type_error";
    }
    if (
      failure.errorClass === "unexpected" &&
      (error instanceof Error || error instanceof DOMException)
    ) {
      const name = z.enum(["AbortError", "TimeoutError"]).safeParse(error.name);
      if (name.success) {
        failure.errorClass = name.data === "AbortError" ? "abort_error" : "timeout_error";
      }
    }
    const code: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value;
    const operatorCode = runtimePreparationFailure.shape.code.safeParse(code);
    if (failure.errorClass === "operator_error" && operatorCode.success) {
      failure.code = operatorCode.data;
    }
    const moduleCode = runtimePreparationFailure.shape.moduleCode.safeParse(code);
    if (moduleCode.success) {
      failure.moduleCode = moduleCode.data;
    }
  } catch {
    /* Exception introspection must never replace the original result. */
  }
  try {
    createHostedOperatorConsentDiagnostic(
      sessionId,
      sink,
    )({
      boundary: "builder",
      outcome: "setup_unavailable",
      phase: "inline",
      stage: "operator_request",
      preparationFailure: failure,
    });
  } catch {
    /* Failure reporting is advisory. */
  }
};

/** Step entry evidence with no invocation payload. */
export const reportRuntimePreparationStarted = (
  sessionId: string,
  preparationStage: RuntimePreparationStage,
): void => {
  try {
    createHostedOperatorConsentDiagnostic(sessionId)({
      boundary: "builder",
      outcome: "started",
      phase: "inline",
      stage: "operator_request",
      preparationStage,
    });
  } catch {
    /* Diagnostics never prevent entry into the original step. */
  }
};
