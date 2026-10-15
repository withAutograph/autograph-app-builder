import { Agent, MockAgent } from "undici";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import {
  createHostedOperatorClient,
  createHostedOperatorDispatcher,
} from "./hosted-operator-client";

const selection = {
  appId: "test-app",
  branch: "main",
  environment: "preview" as const,
  projectId: "project",
  sessionId: "private-session",
};
const operationRef = "83cf8be5-3e1f-4e73-8e2f-e270fd2e6833";

describe("closed outbound operator action diagnostics", () => {
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
      const request = {
        action,
        selection,
        operationRef,
        ...(action === "execute" ? { callId: "private-call", planDigest: "a".repeat(64) } : {}),
      };
      const transport = vi.fn<typeof fetch>(async (_url, init) => {
        const body = z.string().parse(init?.body);
        expect(JSON.parse(body)).toEqual(request);
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

  it("preserves a transport failure without another operator attempt", async () => {
    const failure = new TypeError("Transport unavailable");
    const transport = vi.fn<typeof fetch>(async () => await Promise.reject(failure));
    const client = createHostedOperatorClient({
      endpoint: "https://operator.example",
      fetch: transport,
      token: async () => await Promise.resolve("bearer"),
    });
    await expect(client.request(request)).rejects.toBe(failure);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
