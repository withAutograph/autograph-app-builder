import { AdapterNotConfiguredError } from "../eve/service";
import { HostedAuthorizationError } from "../eve/hosted-auth";
import {
  HostedIdempotencyConflictError,
  HostedRejectedOperationError,
  HostedSessionNotFoundError,
  HostedSubmissionUnknownError,
} from "../eve/hosted-service";
import type { EveSessionResult } from "./contracts";

export const SESSION_RESOURCE_URI = "ui://eve-agent/session.html";

export function toolResult(result: EveSessionResult, text: string) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: result,
    _meta: { ui: { resourceUri: SESSION_RESOURCE_URI } },
  };
}

export function safeToolError(error: unknown, sessionId = "") {
  const notConfigured = error instanceof AdapterNotConfiguredError;
  const notFound = error instanceof HostedSessionNotFoundError;
  const forbidden = error instanceof HostedAuthorizationError;
  const conflict = error instanceof HostedIdempotencyConflictError;
  const unknown = error instanceof HostedSubmissionUnknownError;
  const rejected = error instanceof HostedRejectedOperationError;
  const code = notConfigured
    ? "adapter_not_configured"
    : notFound
      ? "not_found"
      : forbidden
        ? "forbidden"
        : conflict
          ? "request_conflict"
          : unknown
            ? "submission_unknown"
            : rejected
              ? "operation_rejected"
              : "internal_error";
  const message = notConfigured
    ? "This starter is not connected to its production Eve adapter yet."
    : notFound
      ? "The requested resource was not found."
      : forbidden
        ? "The operation is not permitted."
        : conflict
          ? "The client request conflicts with an existing operation."
          : unknown
            ? "The submission outcome is unknown and was not replayed."
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
  return { ...toolResult(result, message), isError: true };
}
