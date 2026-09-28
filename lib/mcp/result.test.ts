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
import { BuilderHandoffUnavailableError } from "../handoff/service";
import {
  McpToolAuthenticationRequiredError,
  McpProviderUnavailableError,
  safeToolError,
  toolResult,
} from "./result";

describe("safe MCP tool errors", () => {
  it.each([
    [new AdapterNotConfiguredError(), "adapter_not_configured"],
    [new HostedSessionNotFoundError(), "not_found"],
    [new McpProviderUnavailableError(), "provider_unavailable"],
    [new BuilderHandoffUnavailableError(), "not_found"],
    [new HostedAuthorizationError("insufficient_scope"), "forbidden"],
    [new HostedIdempotencyConflictError(), "request_conflict"],
    [new HostedSubmissionUnknownError(), "submission_unknown"],
    [new HostedRejectedOperationError(), "operation_rejected"],
    [new HostedSessionBusyError(), "already_continuing"],
    [new HostedSessionRecoveryUnavailableError(), "restart_required"],
    [new Error("workflow result exceeded stream size"), "internal_error"],
    // Vitest's table test API is callback-based.
    // oxlint-disable-next-line promise/prefer-await-to-callbacks
  ])("projects %s without exposing internal details", (error, code) => {
    const result = safeToolError(error, "session-one");
    expect(result.structuredContent.error?.code).toBe(code);
    expect(result.structuredContent.error?.message).toBeTruthy();
    expect(result.isError).toBe(true);
  });

  it("explains missing hosted session configuration", () => {
    const result = safeToolError(new AdapterNotConfiguredError());
    expect(result.content).toEqual([
      {
        text: "Autograph App Builder's session service is not configured. An operator must connect the hosted session adapter before this action can run.",
        type: "text",
      },
    ]);
    expect(result.structuredContent.error?.message).toBe(
      "Autograph App Builder's session service is not configured. An operator must connect the hosted session adapter before this action can run.",
    );
  });

  it("names the failing MCP operation and redacts provider credentials", () => {
    const result = safeToolError(
      new Error("Stream write failed at https://provider.example/path?token=secret: token=private"),
      "session-one",
      "autograph_get",
    );
    expect(result.structuredContent.error?.code).toBe("internal_error");
    expect(result.structuredContent.error?.message).toContain("autograph_get");
    expect(result.structuredContent.error?.message).toContain("Stream write failed");
    expect(JSON.stringify(result)).not.toContain("provider.example");
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("preserves full sanitized diagnostics longer than 700 characters", () => {
    const detail = `provider diagnostic ${"x".repeat(1200)} token=private`;
    const result = safeToolError(new Error(detail), "session-one", "autograph_get");
    const message = result.structuredContent.error?.message ?? "";

    expect(message).toContain("x".repeat(1200));
    expect(message).toContain("token=[REDACTED]");
    expect(message).not.toContain("token=private");
  });

  it("still identifies a failure when the provider returned no message", () => {
    const result = safeToolError(null, "session-one", "autograph_send");
    expect(result.structuredContent.error?.message).toContain("autograph_send");
    expect(result.structuredContent.error?.message).toContain("no error detail");
  });

  it.each([
    [new HostedSessionNotFoundError(), "Check the session ID"],
    [new HostedAuthorizationError("insufficient_scope"), "Sign in with the account"],
    [new HostedIdempotencyConflictError(), "new clientRequestId"],
    [new HostedSubmissionUnknownError(), "autograph_get before sending"],
    [new HostedRejectedOperationError(), "retry only if the action was not applied"],
    // Vitest's table test API is callback-based.
    // oxlint-disable-next-line promise/prefer-await-to-callbacks
  ])("gives a recovery action for %s", (error, nextStep) => {
    expect(safeToolError(error).structuredContent.error?.message).toContain(nextStep);
  });

  it("tells callers not to replay an approval whose settlement is unknown", () => {
    const result = safeToolError(
      new HostedSubmissionUnknownError(),
      "session-one",
      "autograph_respond",
    );
    expect(result.structuredContent.error?.code).toBe("submission_unknown");
    expect(result.structuredContent.error?.message).toContain("Do not submit the response again");
    expect(result.structuredContent.error?.message).toContain("same session with autograph_get");
  });

  it("makes a provider outage retryable without a new OAuth challenge", () => {
    const result = safeToolError(new McpProviderUnavailableError());
    expect(result.structuredContent.error?.message).toContain("Retry this same handoff");
    expect(result.structuredContent.error?.message).toContain("No provider login");
    expect(result._meta).toBeUndefined();
  });

  it("gives same-account guidance without disclosing handoff ownership", () => {
    const result = safeToolError(new BuilderHandoffUnavailableError());
    expect(result.structuredContent.error?.message).toContain("same account used on the web");
    expect(result.structuredContent.error?.code).toBe("not_found");
  });

  it("returns the MCP OAuth challenge as protected tool metadata", () => {
    const challenge =
      'Bearer resource_metadata="https://new.autograph.so/.well-known/oauth-protected-resource", error="invalid_token", error_description="Sign in to continue"';
    const result = safeToolError(new McpToolAuthenticationRequiredError(challenge));

    expect(result.structuredContent.error?.code).toBe("authentication_required");
    expect(result._meta).toEqual({ "mcp/www_authenticate": [challenge] });
    expect(result.isError).toBe(true);
  });
});

describe("MCP App UI presentation", () => {
  it("keeps ordinary session results text-first", () => {
    const result = toolResult(
      {
        cursor: 0,
        events: [],
        sessionId: "session-one",
        status: "working",
      },
      "Autograph App Builder started the app build.",
    );

    expect(result._meta).toBeUndefined();
  });

  it("offers Autograph App Builder progress for an outstanding input request", () => {
    const result = toolResult(
      {
        cursor: 1,
        events: [],
        inputRequests: [
          {
            allowFreeform: false,
            kind: "approval",
            requestId: "request-one",
            title: "Continue?",
          },
        ],
        sessionId: "session-one",
        status: "input_required",
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
        cursor: 42,
        events: [],
        prototype: {
          content: "<!doctype html><html><body>Vendor queue</body></html>",
          digest: "a".repeat(64),
          mediaType: "text/html",
          path: "prototype/vendor-onboarding/index.html",
          revision: "b".repeat(64),
        },
        sessionId: "session-one",
        status: "completed",
      },
      "Autograph App Builder returned the latest progress.",
    );

    expect(result._meta).toBeUndefined();
  });
});
