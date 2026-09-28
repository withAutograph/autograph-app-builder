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
import { z } from "zod";

export { McpProviderUnavailableError, McpToolAuthenticationRequiredError } from "./errors";

export const SESSION_RESOURCE_URI = "ui://autograph-app-builder/session.html";

type McpOperation =
  | "autograph_start"
  | "autograph_get"
  | "autograph_send"
  | "autograph_respond"
  | "autograph_cancel";

const safeUnexpectedCause = (error: unknown): string => {
  const messages: string[] = [];
  let current = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (current instanceof Error) {
      if (current.message.trim().length > 0) {
        messages.push(current.message);
      }
      current = current.cause;
    } else {
      const parsed = z.string().safeParse(current);
      if (parsed.success && parsed.data.trim().length > 0) {
        messages.push(parsed.data);
      }
      break;
    }
  }
  return messages
    .join("; caused by: ")
    .replaceAll(/\p{Cc}/gu, " ")
    .replaceAll(/https?:\/\/[^\s]+/giu, "[URL REDACTED]")
    .replaceAll(/Bearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replaceAll(
      /\b(?:gh[oprsu]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/gu,
      "[REDACTED]",
    )
    .replaceAll(
      /\b(?<key>authorization|cookie|password|passwd|secret|token|api[-_]?key)\s*[:=]\s*[^\s,;]+/giu,
      "$<key>=[REDACTED]",
    )
    .replaceAll(/\s+/gu, " ")
    .trim();
};

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
export function safeToolError(
  error: unknown,
  sessionId = "",
  operation: McpOperation = "autograph_get",
) {
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
  let message = `Autograph App Builder could not complete ${operation}. Cause: ${safeUnexpectedCause(error) || "The service returned no error detail."} Retry this saved session after fixing the cause; if it repeats, report the operation and session ID.`;
  if (authenticationRequired) {
    code = "authentication_required";
    message = "Sign in to Autograph App Builder to continue.";
  } else if (notConfigured) {
    code = "adapter_not_configured";
    message =
      "Autograph App Builder's session service is not configured. An operator must connect the hosted session adapter before this action can run.";
  } else if (notFound) {
    code = "not_found";
    message = handoffUnavailable
      ? "This handoff is unavailable. Connect Autograph with the same account used on the web, or reopen your prepared app to renew an expired handoff."
      : "The requested Builder session was not found. Check the session ID or list your recent builds with autograph_get, then reopen the intended session.";
  } else if (forbidden) {
    code = "forbidden";
    message =
      "The signed-in account cannot access this Builder session or workspace. Sign in with the account that owns the app, then retry the same session.";
  } else if (conflict) {
    code = "request_conflict";
    message =
      "This client request ID was already used for a different operation. Read the current session state, then send the new request with a new clientRequestId.";
  } else if (unknown) {
    code = "submission_unknown";
    message =
      operation === "autograph_respond"
        ? "The response may have been accepted, but Builder could not confirm its settlement before the session read deadline. Do not submit the response again. Read the same session with autograph_get to see whether the input resolved; if its read is delayed, retry that read with the same session ID and cursor."
        : "The service could not confirm whether the last submission was saved, so it was not replayed. Read the same session with autograph_get before sending another request.";
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
    message =
      "The service rejected this operation before saving a result. Read the session with autograph_get to see its current state, then retry only if the action was not applied.";
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
