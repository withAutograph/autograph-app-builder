import { Agent, MockAgent } from "undici";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import {
  createHostedOperatorClient,
  createHostedOperatorDispatcher,
  isHostedOperatorTransportUnknown,
} from "./hosted-operator-client";
import { HostedOperatorError } from "./hosted-operator-contract";

const selection = {
  appId: "test-app",
  branch: "main",
  environment: "preview" as const,
  projectId: "project",
  sessionId: "private-session",
};
const operationRef = "83cf8be5-3e1f-4e73-8e2f-e270fd2e6833";

const clientFor = (response: Record<string, string | undefined>) =>
  createHostedOperatorClient({
    endpoint: "https://operator.example",
    fetch: async () => await Promise.resolve(Response.json(response)),
    token: async () => await Promise.resolve("private-bearer"),
  });

describe("operator Auth identity input results", () => {
  const request = { action: "auth-identity-input" as const, selection, operationRef };
  const success = {
    browserUrl: "https://auth.example/api/auth/platform/operator-link?nonce=private-nonce",
    expiresAt: "2026-10-15T20:00:00.000Z",
    operationRef,
    sessionId: selection.sessionId,
  };

  it.each([
    "auth_identity_required",
    "operation_in_progress",
    "authorization_required",
    undefined,
  ] as const)("preserves a blocked operator result code (%s)", async (code) => {
    const result = clientFor({
      appId: selection.appId,
      authenticatedBehavior: "unassessed",
      status: "blocked",
      operationRef,
      ...(code === undefined ? {} : { code }),
    }).authIdentityInput(request);
    await expect(result).rejects.toBeInstanceOf(HostedOperatorError);
    await expect(result).rejects.toMatchObject({ code: code ?? "operator_unavailable" });
  });

  it("returns the validated identity invitation", async () => {
    await expect(clientFor(success).authIdentityInput(request)).resolves.toEqual(success);
  });

  it.each([
    { operationRef: "0f598245-fd56-48ca-a11e-dfa2e50c0884" },
    { sessionId: "another-private-session" },
  ])("rejects a successful result bound to another request (%j)", async (mismatch) => {
    await expect(
      clientFor({ ...success, ...mismatch }).authIdentityInput(request),
    ).rejects.toMatchObject({ code: "resource_mismatch" });
  });

  it.each([
    { ...success, expiresAt: "invalid-time" },
    { ...success, browserUrl: "http://insecure.example" },
    {
      appId: selection.appId,
      authenticatedBehavior: "unassessed",
      status: "blocked",
      code: "unrecognized-code",
    },
  ])("preserves schema validation for malformed responses (%j)", async (malformed) => {
    await expect(clientFor(malformed).authIdentityInput(request)).rejects.toBeInstanceOf(
      z.ZodError,
    );
  });
});

describe("closed outbound operator action diagnostics", () => {
  const diagnosticRequest = { action: "status" as const, selection, operationRef };

  it("negotiates optional status observations and accepts the legacy status response", async () => {
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-autograph-execution-observation")).toBe("requested");
      return await Promise.resolve(
        Response.json({
          appId: selection.appId,
          authenticatedBehavior: "unassessed",
          status: "pending",
          operationRef,
        }),
      );
    });
    const client = createHostedOperatorClient({
      endpoint: "https://operator.example",
      fetch: transport,
      token: async () => await Promise.resolve("private-bearer"),
    });
    await expect(client.request(diagnosticRequest)).resolves.toMatchObject({ status: "pending" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "bindings",
      (client: ReturnType<typeof createHostedOperatorClient>) =>
        client.bindings({ action: "bindings", selection, operationRef }),
    ],
    [
      "auth-identity-input",
      (client: ReturnType<typeof createHostedOperatorClient>) =>
        client.authIdentityInput({ action: "auth-identity-input", selection, operationRef }),
    ],
    [
      "neon-authorization",
      (client: ReturnType<typeof createHostedOperatorClient>) =>
        client.neonAuthorization({
          action: "neon-authorization",
          phase: "check",
          sessionId: selection.sessionId,
        }),
    ],
    [
      "resolve-preview-target",
      (client: ReturnType<typeof createHostedOperatorClient>) =>
        client.resolvePreviewTarget({
          action: "resolve-preview-target",
          appId: selection.appId,
          sessionId: selection.sessionId,
        }),
    ],
  ] as const)("reports malformed %s payloads as schema-invalid", async (_action, invoke) => {
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    const client = createHostedOperatorClient({
      endpoint: "https://operator.example",
      fetch: vi.fn<typeof fetch>(async (_url, init) => {
        expect(new Headers(init?.headers).has("x-autograph-execution-observation")).toBe(false);
        return await Promise.resolve(Response.json({ private: "payload" }));
      }),
      token: async () => await Promise.resolve("private-bearer"),
    });
    try {
      await expect(invoke(client)).rejects.toBeDefined();
      expect(logs).toHaveBeenCalledWith(
        "[builder:hosted-neon-consent]",
        expect.objectContaining({
          operatorResponse: "schema_invalid",
          accessClass: "other_failed",
        }),
      );
      expect(JSON.stringify(logs.mock.calls)).not.toContain("private");
    } finally {
      logs.mockRestore();
    }
  });

  it("labels a JSON decode failure without logging its response body or changing the error", async () => {
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    const failure = new SyntaxError("RAW_PRIVATE_RESPONSE_BODY could not be decoded");
    const response = new Response("RAW_PRIVATE_RESPONSE_BODY");
    vi.spyOn(response, "json").mockRejectedValue(failure);
    const transport = vi.fn<typeof fetch>(async () => await Promise.resolve(response));
    const client = createHostedOperatorClient({
      endpoint: "https://operator.example",
      fetch: transport,
      token: async () => await Promise.resolve("private-bearer"),
    });
    try {
      await expect(client.request(diagnosticRequest)).rejects.toBe(failure);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(logs).toHaveBeenCalledWith(
        "[builder:hosted-neon-consent]",
        expect.objectContaining({
          httpStatus: 200,
          accessClass: "other_failed",
          operatorResponse: "decode_failed",
        }),
      );
      expect(JSON.stringify(logs.mock.calls)).not.toContain("RAW_PRIVATE_RESPONSE_BODY");
    } finally {
      logs.mockRestore();
    }
  });

  it("labels a parsed blocked result with its public code and returns it unchanged", async () => {
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    const result = {
      appId: selection.appId,
      authenticatedBehavior: "unassessed",
      status: "blocked",
      operationRef,
      code: "operation_in_progress",
    };
    const transport = vi.fn<typeof fetch>(async () => await Promise.resolve(Response.json(result)));
    const client = createHostedOperatorClient({
      endpoint: "https://operator.example",
      fetch: transport,
      token: async () => await Promise.resolve("private-bearer"),
    });
    try {
      await expect(client.request(diagnosticRequest)).resolves.toEqual(result);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(logs).toHaveBeenCalledWith(
        "[builder:hosted-neon-consent]",
        expect.objectContaining({
          httpStatus: 200,
          operatorResponse: "blocked",
          operatorCode: "operation_in_progress",
        }),
      );
    } finally {
      logs.mockRestore();
    }
  });

  it.each(["status", "execute"] as const)(
    "distinguishes %s without changing requests or results",
    async (action) => {
      const logs = vi.spyOn(console, "info").mockImplementation(() => {});
      const result = {
        appId: selection.appId,
        authenticatedBehavior: "unassessed",
        status: "pending",
        operationRef,
      };
      const requestPayload = {
        action,
        selection,
        operationRef,
        ...(action === "execute" ? { callId: "private-call", planDigest: "a".repeat(64) } : {}),
      };
      const transport = vi.fn<typeof fetch>(async (_url, init) => {
        const body = z.string().parse(init?.body);
        expect(JSON.parse(body)).toEqual(requestPayload);
        const observationPreference = new Headers(init?.headers).get(
          "x-autograph-execution-observation",
        );
        expect(observationPreference).toBe(
          action === "status" || action === "execute" ? "requested" : null,
        );
        return await Promise.resolve(Response.json(result));
      });
      const client = createHostedOperatorClient({
        endpoint: "https://operator.example",
        fetch: transport,
        token: async () => await Promise.resolve("private-bearer"),
      });
      try {
        const value =
          action === "execute"
            ? await client.request({
                action,
                selection,
                operationRef,
                callId: "private-call",
                planDigest: "a".repeat(64),
              })
            : await client.request({ action, selection, operationRef });
        expect(value).toEqual(result);
        expect(transport).toHaveBeenCalledTimes(1);
        expect(logs).toHaveBeenCalledWith(
          "[builder:hosted-neon-consent]",
          expect.objectContaining({ operatorAction: action, outcome: "started" }),
        );
        expect(logs).toHaveBeenCalledWith(
          "[builder:hosted-neon-consent]",
          expect.objectContaining({ operatorAction: action, httpStatus: 200, outcome: "verified" }),
        );
        const serialized = JSON.stringify(logs.mock.calls);
        for (const secret of ["private-session", "private-call", "private-bearer", operationRef]) {
          expect(serialized).not.toContain(secret);
        }
      } finally {
        logs.mockRestore();
      }
    },
  );
});

describe("operator request transport", () => {
  const pending = {
    appId: selection.appId,
    authenticatedBehavior: "unassessed",
    status: "pending",
    operationRef,
  };
  const request = { action: "status" as const, selection, operationRef };

  it("configures real Agent pools for the operator duration without a global override", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock
      .get("https://operator.example")
      .intercept({ path: "/v1/runtime", method: "POST" })
      .reply(200, pending);
    const dispatcher = createHostedOperatorDispatcher((origin, options) => {
      expect(options).toMatchObject({ headersTimeout: 1_800_000, bodyTimeout: 1_800_000 });
      return mock.get(origin.toString());
    });
    try {
      const response = await dispatcher.request({
        origin: "https://operator.example",
        path: "/v1/runtime",
        method: "POST",
      });
      expect(await response.body.json()).toEqual(pending);
    } finally {
      await dispatcher.close();
      await mock.close();
    }
  });

  it("reuses the operator dispatcher and preserves caller cancellation and redirect policy", async () => {
    const controller = new AbortController();
    const dispatchers: Agent[] = [];
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      const options = z
        .object({ dispatcher: z.instanceof(Agent), redirect: z.literal("error") })
        .parse(init);
      dispatchers.push(options.dispatcher);
      expect(init?.signal).toBe(controller.signal);
      return await Promise.resolve(Response.json(pending));
    });
    const input = {
      endpoint: "https://operator.example",
      fetch: transport,
      token: async () => await Promise.resolve("bearer"),
    };
    await createHostedOperatorClient(input).request(request, controller.signal);
    await createHostedOperatorClient(input).request(request, controller.signal);
    expect(dispatchers[0]).toBeInstanceOf(Agent);
    expect(dispatchers.every((dispatcher) => dispatcher === dispatchers[0])).toBe(true);
  });

  it.each(["before", "during"] as const)(
    "propagates cancellation %s the request without retrying",
    async (timing) => {
      const controller = new AbortController();
      const cancellation = new DOMException("Cancelled", "AbortError");
      const admitted = Promise.withResolvers<string>();
      const transport = vi.fn<typeof fetch>(async (_url, init) => {
        expect(init?.signal).toBe(controller.signal);
        admitted.resolve("started");
        controller.signal.throwIfAborted();
        const response = Promise.withResolvers<Response>();
        controller.signal.addEventListener(
          "abort",
          () => {
            response.reject(cancellation);
          },
          { once: true },
        );
        return await response.promise;
      });
      const client = createHostedOperatorClient({
        endpoint: "https://operator.example",
        fetch: transport,
        token: async () => await Promise.resolve("bearer"),
      });
      if (timing === "before") {
        controller.abort(cancellation);
      }
      const result = client.request(request, controller.signal);
      const rejected = expect(result).rejects.toBe(cancellation);
      await admitted.promise;
      if (timing === "during") {
        controller.abort(cancellation);
      }
      await rejected;
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );

  it("marks status transport failure as unknown without another operator attempt", async () => {
    const failure = new TypeError("Transport unavailable");
    const transport = vi.fn<typeof fetch>(async () => await Promise.reject(failure));
    const client = createHostedOperatorClient({
      endpoint: "https://operator.example",
      fetch: transport,
      token: async () => await Promise.resolve("bearer"),
    });
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The predicate narrows the transport error with the exported guard.
    await expect(client.request(request)).rejects.toSatisfy((error: unknown) => {
      expect(isHostedOperatorTransportUnknown(error)).toBe(true);
      expect(error).toMatchObject({ cause: failure });
      return true;
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("marks execute fetch rejection as an unknown transport outcome and preserves its cause", async () => {
    const failure = new TypeError("private transport detail");
    const transport = vi.fn<typeof fetch>(async () => await Promise.reject(failure));
    const client = createHostedOperatorClient({
      endpoint: "https://operator.example",
      fetch: transport,
      token: async () => await Promise.resolve("bearer"),
    });
    const result = client.request({
      action: "execute",
      selection,
      operationRef,
      callId: "private-call",
      planDigest: "a".repeat(64),
    });
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The predicate narrows the transport error with the exported guard.
    await expect(result).rejects.toSatisfy((error: unknown) => {
      expect(isHostedOperatorTransportUnknown(error)).toBe(true);
      expect(error).toMatchObject({ cause: failure });
      return true;
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("marks execute body read failure as unknown but preserves JSON syntax failures", async () => {
    const bodyReadFailure = new TypeError("stream terminated");
    const response = Response.json({});
    vi.spyOn(response, "json").mockRejectedValue(bodyReadFailure);
    const client = createHostedOperatorClient({
      endpoint: "https://operator.example",
      fetch: vi.fn<typeof fetch>(async () => await Promise.resolve(response)),
      token: async () => await Promise.resolve("bearer"),
    });
    const executeRequest = {
      action: "execute" as const,
      selection,
      operationRef,
      callId: "private-call",
      planDigest: "a".repeat(64),
    };
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The predicate narrows the unknown transport failure with the exported guard.
    await expect(client.request(executeRequest)).rejects.toSatisfy((error: unknown) => {
      expect(isHostedOperatorTransportUnknown(error)).toBe(true);
      expect(error).toMatchObject({ cause: bodyReadFailure });
      return true;
    });

    const syntaxFailure = new SyntaxError("invalid JSON");
    const syntaxResponse = Response.json({});
    vi.spyOn(syntaxResponse, "json").mockRejectedValue(syntaxFailure);
    const syntaxClient = createHostedOperatorClient({
      endpoint: "https://operator.example",
      fetch: vi.fn<typeof fetch>(async () => await Promise.resolve(syntaxResponse)),
      token: async () => await Promise.resolve("bearer"),
    });
    await expect(syntaxClient.request(executeRequest)).rejects.toBe(syntaxFailure);
  });

  it("reports schema-invalid public execute results without exposing response data", async () => {
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    const client = createHostedOperatorClient({
      endpoint: "https://operator.example",
      fetch: vi.fn<typeof fetch>(
        async () => await Promise.resolve(Response.json({ secret: "private" })),
      ),
      token: async () => await Promise.resolve("bearer"),
    });
    try {
      await expect(
        client.request({
          action: "execute",
          selection,
          operationRef,
          callId: "private-call",
          planDigest: "a".repeat(64),
        }),
      ).rejects.toBeInstanceOf(z.ZodError);
      expect(logs).toHaveBeenCalledWith(
        "[builder:hosted-neon-consent]",
        expect.objectContaining({
          operatorAction: "execute",
          operatorResponse: "schema_invalid",
          accessClass: "other_failed",
        }),
      );
      expect(JSON.stringify(logs.mock.calls)).not.toContain("private");
    } finally {
      logs.mockRestore();
    }
  });
});
