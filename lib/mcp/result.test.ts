import { describe, expect, it } from "vitest";

import { HostedAuthorizationError } from "../eve/hosted-auth";
import {
  HostedIdempotencyConflictError,
  HostedRejectedOperationError,
  HostedSessionBusyError,
  HostedSessionNotFoundError,
  HostedSessionRecoveryUnavailableError,
  HostedSubmissionUnknownError,
} from "../eve/hosted-service";
import { AdapterNotConfiguredError } from "../eve/service";
import {
  McpToolAuthenticationRequiredError,
  safeToolError,
  toolResult,
} from "./result";

describe("safe MCP tool errors", () => {
  it.each([
    [new AdapterNotConfiguredError(), "adapter_not_configured"],
    [new HostedSessionNotFoundError(), "not_found"],
    [new HostedAuthorizationError("insufficient_scope"), "forbidden"],
    [new HostedIdempotencyConflictError(), "request_conflict"],
    [new HostedSubmissionUnknownError(), "submission_unknown"],
    [new HostedRejectedOperationError(), "operation_rejected"],
    [new HostedSessionBusyError(), "already_continuing"],
    [new HostedSessionRecoveryUnavailableError(), "restart_required"],
    [new Error("secret provider detail"), "internal_error"],
  ])("projects %s without exposing internal details", (error, code) => {
    const result = safeToolError(error, "session-one");
    expect(result.structuredContent.error?.code).toBe(code);
    expect(JSON.stringify(result)).not.toContain("secret provider detail");
    expect(result.isError).toBe(true);
  });

  it("brands the public disconnected-state message", () => {
    const result = safeToolError(new AdapterNotConfiguredError());
    expect(result.content).toEqual([
      {
        type: "text",
        text: "Autograph App Builder is not connected to its production service yet.",
      },
    ]);
    expect(result.structuredContent.error?.message).toBe(
      "Autograph App Builder is not connected to its production service yet.",
    );
  });

  it("returns the MCP OAuth challenge as protected tool metadata", () => {
    const challenge =
      'Bearer resource_metadata="https://new.autograph.so/.well-known/oauth-protected-resource", error="invalid_token", error_description="Sign in to continue"';
    const result = safeToolError(
      new McpToolAuthenticationRequiredError(challenge),
    );

    expect(result.structuredContent.error?.code).toBe(
      "authentication_required",
    );
    expect(result._meta).toEqual({ "mcp/www_authenticate": [challenge] });
    expect(result.isError).toBe(true);
  });
});

describe("MCP App UI presentation", () => {
  it("keeps ordinary session results text-first", () => {
    const result = toolResult(
      {
        sessionId: "session-one",
        status: "working",
        cursor: 0,
        events: [],
      },
      "Autograph App Builder started the app build.",
    );

    expect(result._meta).toBeUndefined();
  });

  it("offers Autograph App Builder progress for an outstanding input request", () => {
    const result = toolResult(
      {
        sessionId: "session-one",
        status: "input_required",
        cursor: 1,
        events: [],
        inputRequests: [
          {
            requestId: "request-one",
            kind: "approval",
            title: "Continue?",
            allowFreeform: false,
          },
        ],
      },
      "Autograph App Builder needs input.",
    );

    expect(result._meta).toEqual({
      ui: { resourceUri: "ui://autograph-app-builder/session.html" },
    });
  });

  it("keeps prototype results out of the MCP App UI", () => {
    const result = toolResult(
      {
        sessionId: "session-one",
        status: "completed",
        cursor: 42,
        events: [],
        prototype: {
          path: "prototype/vendor-onboarding/index.html",
          mediaType: "text/html",
          content: "<!doctype html><html><body>Vendor queue</body></html>",
          digest: "a".repeat(64),
          revision: "b".repeat(64),
        },
      },
      "Autograph App Builder returned the latest progress.",
    );

    expect(result._meta).toBeUndefined();
  });
});
