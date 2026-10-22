import { AdapterNotConfiguredError } from "../eve/service";
import {
  localSessionRecoveryError,
  LocalSessionRecoveryUnavailableError,
} from "../eve/local-session-recovery";
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

const unknownSubmissionMessage = (operation: McpOperation, sessionId: string): string => {
  if (operation === "autograph_respond") {
    return "Your response may have been accepted, but Builder could not confirm it. Don’t send it again yet. Read the same session with autograph_get to see whether the request was resolved; if that read is delayed, retry it with the same session ID and cursor.";
  }
  if (operation === "autograph_start" || sessionId.length === 0) {
    return "Builder could not confirm whether your new app request was saved. Use autograph_get with the original clientRequestId to recover the session. If you retry, use the same ID and request so Builder does not start a duplicate.";
  }
  return "Builder could not confirm whether your last message was saved, so it was not sent again. Read the same session with autograph_get before sending another message.";
};

const isVerifiedSendPreflightRejection = (error: HostedRejectedOperationError): boolean => {
  try {
    return Object.getOwnPropertyDescriptor(error, "code")?.value === "send_preflight_unavailable";
  } catch {
    return false;
  }
};

const rejectedToolError = (error: HostedRejectedOperationError, operation: McpOperation) => {
  if (operation === "autograph_send" && isVerifiedSendPreflightRejection(error)) {
    return {
      code: "send_preflight_unavailable",
      message:
        "Builder could not read this session, so your message was not sent. Retry autograph_get with the same session ID and cursor. After it succeeds, send your message with a new clientRequestId because the original ID is tied to this rejection.",
    };
  }
  return {
    code: "operation_rejected",
    message:
      "Builder could not complete this request. Read the session with autograph_get to check its current state, then retry only if the action was not applied.",
  };
};

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

const genericUnexpectedMessage = (safeCause: string): string => {
  const noDetail = safeCause.length === 0 ? "No further detail was provided. " : "";
  const recovery =
    "Retry this saved session; if the problem continues, contact support with the session ID and error code.";
  let message = `Builder could not complete this request. ${noDetail}${recovery}`;
  if (safeCause.length > 0) {
    message += `\n\nDetails: ${safeCause}`;
  }
  return message;
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
      "A connected provider is temporarily unavailable. Your prepared app and connections are saved. Try this same handoff again shortly; you don’t need to sign in again.";
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
  const localRecoveryUnavailable = error instanceof LocalSessionRecoveryUnavailableError;
  const cancellationUnsettled = error instanceof HostedCancellationUnsettledError;
  let code = "internal_error";
  const safeCause = safeUnexpectedCause(error);
  let message = rejected
    ? "The service rejected this operation before saving a result."
    : genericUnexpectedMessage(safeCause);
  if (authenticationRequired) {
    code = "authentication_required";
    message = "Sign in to Autograph App Builder to continue.";
  } else if (notConfigured) {
    code = "adapter_not_configured";
    message = "Builder’s session service is not available yet. Try again later or contact support.";
  } else if (notFound) {
    code = "not_found";
    message = handoffUnavailable
      ? "This handoff is unavailable. Connect Autograph with the same account used on the web, or reopen your prepared app to renew an expired handoff."
      : "Builder couldn’t find this session. Check the session ID or list your recent builds with autograph_get, then reopen the right session.";
  } else if (forbidden) {
    code = "forbidden";
    message =
      "This account can’t open the session. Sign in with the account that owns the app, then retry the same session.";
  } else if (conflict) {
    code = "request_conflict";
    message =
      "This request ID was already used for a different action. Read the current session state, then use a new clientRequestId for your next request.";
  } else if (unknown) {
    code = "submission_unknown";
    message = unknownSubmissionMessage(operation, sessionId);
  } else if (cancellationUnsettled) {
    code = "cancellation_unsettled";
    message =
      "Cancellation was accepted but is still in progress. Check the session with autograph_get.";
  } else if (busy) {
    code = "already_continuing";
    message = "This app is already continuing in another place. Try again shortly.";
  } else if (localRecoveryUnavailable) {
    code = localSessionRecoveryError.code;
    message =
      "Builder couldn’t recover this local session. Keep the original session open and contact your administrator before trying again.";
  } else if (recoveryUnavailable) {
    code = "restart_required";
    message =
      "Builder can’t continue from the last saved point. Start again from the latest result.";
  } else if (rejected) {
    ({ code, message } = rejectedToolError(error, operation));
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
