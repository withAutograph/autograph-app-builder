import { AdapterNotConfiguredError } from "../eve/service";
import { HostedAuthorizationError } from "../eve/hosted-auth";
import {
  HostedCancellationUnsettledError,
  HostedIdempotencyConflictError,
  HostedRejectedOperationError,
  HostedSessionBusyError,
  HostedSessionNotFoundError,
  HostedSessionRecoveryUnavailableError,
  HostedSubmissionUnknownError,
} from "../eve/hosted-service";
import type { EveSessionListResult, EveSessionResult } from "./contracts";

export const SESSION_RESOURCE_URI = "ui://autograph-app-builder/session.html";

export class McpToolAuthenticationRequiredError extends Error {
  constructor(readonly challenge: string) {
    super("Authentication is required before calling this tool.");
    this.name = "McpToolAuthenticationRequiredError";
  }
}

export function toolResult<
  const Result extends EveSessionListResult | EveSessionResult,
>(result: Result, text: string) {
  const needsInteractiveSessionUi =
    !("kind" in result) &&
    result.status === "input_required" &&
    (result.inputRequests?.length ?? 0) > 0;

  return {
    content: [{ type: "text" as const, text }],
    structuredContent: result,
    ...(needsInteractiveSessionUi
      ? { _meta: { ui: { resourceUri: SESSION_RESOURCE_URI } } }
      : {}),
  };
}

export function safeToolError(error: unknown, sessionId = "") {
  const authenticationRequired =
    error instanceof McpToolAuthenticationRequiredError;
  const notConfigured = error instanceof AdapterNotConfiguredError;
  const notFound = error instanceof HostedSessionNotFoundError;
  const forbidden = error instanceof HostedAuthorizationError;
  const conflict = error instanceof HostedIdempotencyConflictError;
  const unknown = error instanceof HostedSubmissionUnknownError;
  const rejected = error instanceof HostedRejectedOperationError;
  const busy = error instanceof HostedSessionBusyError;
  const recoveryUnavailable =
    error instanceof HostedSessionRecoveryUnavailableError;
  const cancellationUnsettled =
    error instanceof HostedCancellationUnsettledError;
  const code = authenticationRequired
    ? "authentication_required"
    : notConfigured
      ? "adapter_not_configured"
      : notFound
        ? "not_found"
        : forbidden
          ? "forbidden"
          : conflict
            ? "request_conflict"
            : unknown
              ? "submission_unknown"
              : cancellationUnsettled
                ? "cancellation_unsettled"
                : busy
                  ? "already_continuing"
                  : recoveryUnavailable
                    ? "restart_required"
                    : rejected
                      ? "operation_rejected"
                      : "internal_error";
  const message = authenticationRequired
    ? "Sign in to Autograph App Builder to continue."
    : notConfigured
      ? "Autograph App Builder is not connected to its production service yet."
      : notFound
        ? "The requested resource was not found."
        : forbidden
          ? "The operation is not permitted."
          : conflict
            ? "The client request conflicts with an existing operation."
            : unknown
              ? "The submission outcome is unknown and was not replayed."
              : cancellationUnsettled
                ? "Cancellation was accepted but has not settled. Continue with autograph_get."
                : busy
                  ? "This app is already continuing elsewhere. Try again shortly."
                  : recoveryUnavailable
                    ? "This app cannot continue from its last saved point. Start again from the latest result."
                    : rejected
                      ? "The operation was rejected before a durable result."
                      : "The operation failed safely.";
  const result: EveSessionResult = {
    sessionId,
    status: "failed",
    cursor: 0,
    events: [],
    error: {
      code,
      message,
    },
  };
  return {
    ...toolResult(result, message),
    ...(authenticationRequired
      ? { _meta: { "mcp/www_authenticate": [error.challenge] } }
      : {}),
    isError: true,
  };
}
