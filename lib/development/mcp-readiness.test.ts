import { describe, expect, it, vi } from "vitest";

import { TOOL_NAMES } from "../../scripts/portable-release";
import {
  developmentMcpToolNames,
  waitForDevelopmentMcp,
} from "./mcp-readiness";

function response(body: unknown, status = 200, sessionId?: string) {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: sessionId ? { "mcp-session-id": sessionId } : undefined,
  });
}

describe("development MCP readiness", () => {
  it("initializes one session and returns the advertised tool names", async () => {
    const methods: string[] = [];
    const fetcher = vi.fn(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        id?: number;
        method: string;
      };
      methods.push(request.method);
      if (request.method === "initialize")
        return response(
          { jsonrpc: "2.0", id: request.id, result: {} },
          200,
          "dev-1",
        );
      if (request.method === "notifications/initialized")
        return response(undefined, 202);
      return response({
        jsonrpc: "2.0",
        id: request.id,
        result: { tools: TOOL_NAMES.map((name) => ({ name })) },
      });
    }) as typeof fetch;
    await expect(
      developmentMcpToolNames({
        endpoint: "http://127.0.0.1:3210/mcp",
        fetcher,
      }),
    ).resolves.toEqual([...TOOL_NAMES]);
    expect(methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
  });

  it("retries an endpoint that is still starting, then proves exactly five tools", async () => {
    let attempt = 0;
    const fetcher = vi.fn(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        id?: number;
        method: string;
      };
      if (request.method === "initialize" && attempt++ === 0)
        return response({ error: "starting" }, 503);
      if (request.method === "initialize")
        return response(
          { jsonrpc: "2.0", id: request.id, result: {} },
          200,
          "dev-2",
        );
      if (request.method === "notifications/initialized")
        return response(undefined, 202);
      return response({
        jsonrpc: "2.0",
        id: request.id,
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

  it("fails closed as soon as a live endpoint advertises another contract", async () => {
    const fetcher = vi.fn(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        id?: number;
        method: string;
      };
      if (request.method === "initialize")
        return response(
          { jsonrpc: "2.0", id: request.id, result: {} },
          200,
          "dev-3",
        );
      if (request.method === "notifications/initialized")
        return response(undefined, 202);
      return response({
        jsonrpc: "2.0",
        id: request.id,
        result: { tools: [{ name: "eve_start" }] },
      });
    }) as typeof fetch;
    await expect(
      waitForDevelopmentMcp({
        endpoint: "http://127.0.0.1:3210/mcp",
        fetcher,
        intervalMs: 1,
        timeoutMs: 100,
      }),
    ).rejects.toThrow("must expose exactly autograph_start");
  });
});
