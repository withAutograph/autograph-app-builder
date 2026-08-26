import { describe, expect, it } from "vitest";

import { HostedAuthorizationError } from "../eve/hosted-auth";
import {
  HostedIdempotencyConflictError,
  HostedRejectedOperationError,
  HostedSessionNotFoundError,
  HostedSubmissionUnknownError,
} from "../eve/hosted-service";
import { AdapterNotConfiguredError } from "../eve/service";
import { safeToolError } from "./result";

describe("safe MCP tool errors", () => {
  it.each([
    [new AdapterNotConfiguredError(), "adapter_not_configured"],
    [new HostedSessionNotFoundError(), "not_found"],
    [new HostedAuthorizationError("insufficient_scope"), "forbidden"],
    [new HostedIdempotencyConflictError(), "request_conflict"],
    [new HostedSubmissionUnknownError(), "submission_unknown"],
    [new HostedRejectedOperationError(), "operation_rejected"],
    [new Error("secret provider detail"), "internal_error"],
  ])("projects %s without exposing internal details", (error, code) => {
    const result = safeToolError(error, "session-one");
    expect(result.structuredContent.error?.code).toBe(code);
    expect(JSON.stringify(result)).not.toContain("secret provider detail");
    expect(result.isError).toBe(true);
  });
});
