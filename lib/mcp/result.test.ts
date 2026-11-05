import { describe, expect, it, vi } from "vitest";

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
import { LocalSessionRecoveryUnavailableError } from "../eve/local-session-recovery";
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
    [new LocalSessionRecoveryUnavailableError(), "session_recovery_unavailable"],
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
        text: "Builder’s session service is not available yet. Try again later or contact support.",
        type: "text",
      },
    ]);
    expect(result.structuredContent.error?.message).toBe(
      "Builder’s session service is not available yet. Try again later or contact support.",
    );
  });

  it("preserves the local session identity and names the operator recovery blocker", () => {
    const result = safeToolError(
      new LocalSessionRecoveryUnavailableError(),
      "original-local-session",
      "autograph_send",
    );
    expect(result.structuredContent).toMatchObject({
      error: { code: "session_recovery_unavailable" },
      sessionId: "original-local-session",
      status: "failed",
    });
    expect(result.structuredContent.error?.message).toContain("original session open");
    expect(result.structuredContent.error?.message).toContain("contact your administrator");
    expect(result.isError).toBe(true);
    expect(result._meta).toBeUndefined();
  });

  it("names the failing MCP operation and redacts provider credentials", () => {
    const result = safeToolError(
      new Error("Stream write failed at https://provider.example/path?token=secret: token=private"),
      "session-one",
      "autograph_get",
    );
    expect(result.structuredContent.error?.code).toBe("internal_error");
    expect(result.structuredContent.error?.message).toContain(
      "Builder could not complete this request",
    );
    expect(result.structuredContent.error?.message).toContain("Stream write failed");
    expect(JSON.stringify(result)).not.toContain("provider.example");
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("redacts credentials in sanitized diagnostics", () => {
    const detail = `provider diagnostic ${"x".repeat(1200)} token=private`;
    const result = safeToolError(new Error(detail), "session-one", "autograph_get");
    const message = result.structuredContent.error?.message ?? "";

    expect(message).toContain("token=[REDACTED]");
    expect(message).not.toContain("token=private");
  });

  it("still identifies a failure when the provider returned no message", () => {
    const result = safeToolError(null, "session-one", "autograph_send");
    expect(result.structuredContent.error?.message).toContain("No further detail was provided");
    expect(result.structuredContent.error?.message).toContain("session ID and error code");
  });

  it.each([
    [new HostedSessionNotFoundError(), "Check the session ID"],
    [new HostedAuthorizationError("insufficient_scope"), "Sign in with the account"],
    [new HostedIdempotencyConflictError(), "new clientRequestId"],
    [new HostedSubmissionUnknownError(), "original clientRequestId"],
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
    expect(result.structuredContent.error?.message).toContain("Don’t send it again yet");
    expect(result.structuredContent.error?.message).toContain("same session with autograph_get");
  });

  it("gives a recoverable lookup when a start has no session ID", () => {
    const result = safeToolError(new HostedSubmissionUnknownError(), "", "autograph_start");
    expect(result.structuredContent.error?.message).toContain(
      "autograph_get with the original clientRequestId",
    );
    expect(result.structuredContent.error?.message).toContain("same ID and request");
  });

  it("makes a provider outage retryable without a new OAuth challenge", () => {
    const result = safeToolError(new McpProviderUnavailableError());
    expect(result.structuredContent.error?.message).toContain("same handoff again shortly");
    expect(result.structuredContent.error?.message).toContain("don’t need to sign in again");
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

describe("verified send preflight public rejection", () => {
  it("names the proven non-dispatch and preserves the session/rejected request retry boundary", () => {
    const result = safeToolError(
      new HostedRejectedOperationError("send_preflight_unavailable"),
      "saved-session",
      "autograph_send",
    );
    expect(result.structuredContent.error?.code).toBe("send_preflight_unavailable");
    expect(result.structuredContent.sessionId).toBe("saved-session");
    expect(result.structuredContent.error?.message).toContain("your message was not sent");
    expect(result.structuredContent.error?.message).toContain("new clientRequestId");
    expect(result.structuredContent.error?.message).toContain("Retry autograph_get");
  });
  it("does not expose arbitrary codes, secret accessors or a code copied onto an uncertain error", () => {
    const secret = "private-source-secret-code";
    const access = vi.fn(() => {
      throw new Error(secret);
    });
    const source = new HostedRejectedOperationError();
    Object.defineProperties(source, {
      cause: { get: access },
      code: { get: access },
      message: { get: access },
    });
    for (const error of [source, new HostedRejectedOperationError(secret)]) {
      const result = safeToolError(error, "saved-session", "autograph_send");
      expect(result.structuredContent.error?.code).toBe("operation_rejected");
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    const uncertain = new HostedSubmissionUnknownError();
    Object.defineProperty(uncertain, "code", { value: "send_preflight_unavailable" });
    expect(
      safeToolError(uncertain, "saved-session", "autograph_send").structuredContent.error?.code,
    ).toBe("submission_unknown");
    expect(access).not.toHaveBeenCalled();
    expect(
      safeToolError(
        new HostedRejectedOperationError("send_preflight_unavailable"),
        "saved-session",
        "autograph_get",
      ).structuredContent.error?.code,
    ).toBe("operation_rejected");
  });
});
