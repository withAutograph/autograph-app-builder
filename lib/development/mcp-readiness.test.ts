import { setTimeout as delay } from "node:timers/promises";
import type { setTimeout as timerPromiseSetTimeout } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";

import { TOOL_NAMES } from "../../scripts/portable-release";
import { developmentMcpToolNames, waitForDevelopmentMcp } from "./mcp-readiness";

// oxlint-disable-next-line anti-slop/no-module-mocking -- deterministic coverage of the retry delay without wall-clock waits
vi.mock("node:timers/promises", async (importOriginal) => {
  const timers = await importOriginal<{ setTimeout: typeof timerPromiseSetTimeout }>();
  return { ...timers, setTimeout: vi.fn(timers.setTimeout) };
});

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function response(body: unknown, status = 200, sessionId?: string) {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    headers: sessionId ? { "mcp-session-id": sessionId } : undefined,
    status,
  });
}

describe("development MCP readiness", () => {
  it("initializes one session and returns the advertised tool names", async () => {
    const methods: string[] = [];
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const fetcher = vi.fn(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        id?: number;
        method: string;
      };
      methods.push(request.method);
      if (request.method === "initialize") {
        return response({ id: request.id, jsonrpc: "2.0", result: {} }, 200, "dev-1");
      }
      if (request.method === "notifications/initialized") {
        return response(undefined, 202);
      }
      return response({
        id: request.id,
        jsonrpc: "2.0",
        result: { tools: TOOL_NAMES.map((name) => ({ name })) },
      });
    }) as typeof fetch;
    await expect(
      developmentMcpToolNames({
        endpoint: "http://127.0.0.1:3210/mcp",
        fetcher,
      }),
    ).resolves.toEqual([...TOOL_NAMES]);
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
  });

  it("retries an endpoint that is still starting, then returns discovery", async () => {
    let attempt = 0;
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const fetcher = vi.fn(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        id?: number;
        method: string;
      };
      const firstAttempt = attempt === 0;
      attempt += 1;
      if (request.method === "initialize" && firstAttempt) {
        return response({ error: "starting" }, 503);
      }
      if (request.method === "initialize") {
        return response({ id: request.id, jsonrpc: "2.0", result: {} }, 200, "dev-2");
      }
      if (request.method === "notifications/initialized") {
        return response(undefined, 202);
      }
      return response({
        id: request.id,
        jsonrpc: "2.0",
        result: { tools: TOOL_NAMES.map((name) => ({ name })) },
      });
    }) as typeof fetch;
    await expect(
      waitForDevelopmentMcp({
        endpoint: "http://127.0.0.1:3210/mcp",
        fetcher,
        intervalMs: 1,
        timeoutMs: 100,
      }),
    ).resolves.toEqual([...TOOL_NAMES]);
  });

  it("backs off after failed probes while probing immediately and honoring abort", async () => {
    const controller = new AbortController();
    const initializeTimes: number[] = [];
    const requestedWaits: number[] = [];
    let elapsedMs = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => elapsedMs);
    const deterministicDelay = (ms: number, value?: unknown) => {
      requestedWaits.push(ms);
      elapsedMs += ms;
      if (requestedWaits.length === 7) {
        const aborted = new Error("test aborted");
        controller.abort(aborted);
        return Promise.reject(aborted);
      }
      return Promise.resolve(value);
    };
    for (let wait = 0; wait < 7; wait += 1) {
      vi.mocked(delay).mockImplementationOnce(deterministicDelay as typeof delay);
    }
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const fetcher = vi.fn(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      if (request.method === "initialize") {
        initializeTimes.push(Date.now());
      }
      return response({ error: "starting" }, 503);
    }) as typeof fetch;
    const waiting = waitForDevelopmentMcp({
      endpoint: "http://127.0.0.1:3210/mcp",
      fetcher,
      signal: controller.signal,
      timeoutMs: 120_000,
    });

    try {
      expect(initializeTimes).toHaveLength(1);
      expect(requestedWaits).toEqual([]);
      await expect(waiting).rejects.toThrow("test aborted");
      expect(initializeTimes).toHaveLength(7);
      expect(requestedWaits).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000]);
    } finally {
      now.mockRestore();
    }
  });

  it("clamps the last retry delay to the remaining timeout", async () => {
    let elapsedMs = 0;
    const requestedWaits: number[] = [];
    const now = vi.spyOn(Date, "now").mockImplementation(() => elapsedMs);
    const deterministicDelay = (ms: number, value?: unknown) => {
      requestedWaits.push(ms);
      elapsedMs += ms;
      return Promise.resolve(value);
    };
    for (let wait = 0; wait < 3; wait += 1) {
      vi.mocked(delay).mockImplementationOnce(deterministicDelay as typeof delay);
    }
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const fetcher = vi.fn(async () => response({ error: "starting" }, 503)) as typeof fetch;
    try {
      await expect(
        waitForDevelopmentMcp({
          endpoint: "http://127.0.0.1:3210/mcp",
          fetcher,
          timeoutMs: 1000,
        }),
      ).rejects.toThrow("did not become ready within 1000ms");
      expect(requestedWaits).toEqual([250, 500, 250]);
    } finally {
      now.mockRestore();
    }
  });

  it("accepts reordered discovery with additional tools", async () => {
    const names = [...TOOL_NAMES.toReversed(), "development_inspect"];
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const fetcher = vi.fn(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        id?: number;
        method: string;
      };
      if (request.method === "initialize") {
        return response({ id: request.id, jsonrpc: "2.0", result: {} }, 200, "dev-3");
      }
      if (request.method === "notifications/initialized") {
        return response(undefined, 202);
      }
      return response({
        id: request.id,
        jsonrpc: "2.0",
        result: { tools: names.map((name) => ({ name })) },
      });
    }) as typeof fetch;
    await expect(
      waitForDevelopmentMcp({
        endpoint: "http://127.0.0.1:3210/mcp",
        fetcher,
        intervalMs: 1,
        timeoutMs: 100,
      }),
    ).resolves.toEqual(names);
  });
});
