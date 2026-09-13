import { AdapterNotConfiguredError } from "../eve/service";
import { BuilderHandoffUnavailableError } from "../handoff/service";
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
import { McpProviderUnavailableError, McpToolAuthenticationRequiredError } from "./errors";

export { McpProviderUnavailableError, McpToolAuthenticationRequiredError } from "./errors";

export const SESSION_RESOURCE_URI = "ui://autograph-app-builder/session.html";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function toolResult<const Result extends EveSessionListResult | EveSessionResult>(
  result: Result,
  text: string,
) {
  const needsInteractiveSessionUi =
    !("kind" in result) &&
    result.status === "input_required" &&
    (result.inputRequests?.length ?? 0) > 0;

  return {
    content: [{ text, type: "text" as const }],
    structuredContent: result,
    ...(needsInteractiveSessionUi ? { _meta: { ui: { resourceUri: SESSION_RESOURCE_URI } } } : {}),
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function safeToolError(error: unknown, sessionId = "") {
  if (error instanceof McpProviderUnavailableError) {
    const message =
      "Provider access is temporarily unavailable. Retry this same handoff shortly; your prepared app and connections are saved. No provider login is needed for this outage.";
    return {
      ...toolResult(
        {
          cursor: 0,
          error: { code: "provider_unavailable", message },
          events: [],
          sessionId,
          status: "failed",
        },
        message,
      ),
      isError: true,
    };
  }
  const authenticationRequired = error instanceof McpToolAuthenticationRequiredError;
  const notConfigured = error instanceof AdapterNotConfiguredError;
  const handoffUnavailable = error instanceof BuilderHandoffUnavailableError;
  const notFound = error instanceof HostedSessionNotFoundError || handoffUnavailable;
  const forbidden = error instanceof HostedAuthorizationError;
  const conflict = error instanceof HostedIdempotencyConflictError;
  const unknown = error instanceof HostedSubmissionUnknownError;
  const rejected = error instanceof HostedRejectedOperationError;
  const busy = error instanceof HostedSessionBusyError;
  const recoveryUnavailable = error instanceof HostedSessionRecoveryUnavailableError;
  const cancellationUnsettled = error instanceof HostedCancellationUnsettledError;
  let code = "internal_error";
  let message = "The operation failed safely.";
  if (authenticationRequired) {
    code = "authentication_required";
    message = "Sign in to Autograph App Builder to continue.";
  } else if (notConfigured) {
    code = "adapter_not_configured";
    message = "Autograph App Builder is not connected to its production service yet.";
  } else if (notFound) {
    code = "not_found";
    message = handoffUnavailable
      ? "This handoff is unavailable. Connect Autograph with the same account used on the web, or reopen your prepared app to renew an expired handoff."
      : "The requested resource was not found.";
  } else if (forbidden) {
    code = "forbidden";
    message = "The operation is not permitted.";
  } else if (conflict) {
    code = "request_conflict";
    message = "The client request conflicts with an existing operation.";
  } else if (unknown) {
    code = "submission_unknown";
    message = "The submission outcome is unknown and was not replayed.";
  } else if (cancellationUnsettled) {
    code = "cancellation_unsettled";
    message = "Cancellation was accepted but has not settled. Continue with autograph_get.";
  } else if (busy) {
    code = "already_continuing";
    message = "This app is already continuing elsewhere. Try again shortly.";
  } else if (recoveryUnavailable) {
    code = "restart_required";
    message =
      "This app cannot continue from its last saved point. Start again from the latest result.";
  } else if (rejected) {
    code = "operation_rejected";
    message = "The operation was rejected before a durable result.";
  }
  const result: EveSessionResult = {
    cursor: 0,
    error: {
      code,
      message,
    },
    events: [],
    sessionId,
    status: "failed",
  };
  return {
    ...toolResult(result, message),
    ...(authenticationRequired ? { _meta: { "mcp/www_authenticate": [error.challenge] } } : {}),
    isError: true,
  };
}
