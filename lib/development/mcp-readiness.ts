import { TOOL_NAMES } from "../../scripts/portable-release";
import { setTimeout as delay } from "node:timers/promises";

class UnexpectedDevelopmentToolsError extends Error {}

function abortReason(signal: AbortSignal | undefined) {
  return signal?.reason ?? new Error("Development MCP readiness was aborted.");
}

function jsonRpcBody(text: string) {
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .find((line) => line.length > 0);
  return JSON.parse(data ?? text) as {
    error?: { message?: string };
    result?: { tools?: Array<{ name?: string }> };
  };
}

async function mcpRequest(input: {
  endpoint: string;
  body: Record<string, unknown>;
  sessionId?: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}) {
  const requestTimeout = AbortSignal.timeout(5_000);
  const signal = input.signal
    ? AbortSignal.any([input.signal, requestTimeout])
    : requestTimeout;
  const response = await input.fetcher(input.endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(input.sessionId ? { "mcp-session-id": input.sessionId } : {}),
    },
    body: JSON.stringify(input.body),
    signal,
  });
  if (!response.ok)
    throw new Error(`Development MCP returned HTTP ${response.status}.`);
  const text = await response.text();
  const sessionId = response.headers.get("mcp-session-id") ?? input.sessionId;
  return { body: text ? jsonRpcBody(text) : undefined, sessionId };
}

export async function developmentMcpToolNames(input: {
  endpoint: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}) {
  const fetcher = input.fetcher ?? fetch;
  const initialized = await mcpRequest({
    endpoint: input.endpoint,
    fetcher,
    signal: input.signal,
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: {
          name: "autograph-development-readiness",
          version: "1",
        },
      },
    },
  });
  if (initialized.body?.error)
    throw new Error(
      initialized.body.error.message ??
        "Development MCP initialization failed.",
    );
  await mcpRequest({
    endpoint: input.endpoint,
    fetcher,
    signal: input.signal,
    sessionId: initialized.sessionId,
    body: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  const listed = await mcpRequest({
    endpoint: input.endpoint,
    fetcher,
    signal: input.signal,
    sessionId: initialized.sessionId,
    body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  });
  if (listed.body?.error)
    throw new Error(
      listed.body.error.message ?? "Development MCP tools/list failed.",
    );
  return (listed.body?.result?.tools ?? []).map((tool) => tool.name ?? "");
}

export async function waitForDevelopmentMcp(input: {
  endpoint: string;
  timeoutMs?: number;
  intervalMs?: number;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}) {
  const timeoutMs = input.timeoutMs ?? 120_000;
  const intervalMs = input.intervalMs ?? 250;
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    if (input.signal?.aborted) throw abortReason(input.signal);
    try {
      const names = await developmentMcpToolNames(input);
      if (
        names.length !== TOOL_NAMES.length ||
        names.some((name, index) => name !== TOOL_NAMES[index])
      )
        throw new UnexpectedDevelopmentToolsError(
          `Development MCP must expose exactly ${TOOL_NAMES.join(", ")} in order; received ${names.join(", ") || "no tools"}.`,
        );
      return names;
    } catch (error) {
      if (error instanceof UnexpectedDevelopmentToolsError) throw error;
      lastError = error;
    }
    try {
      await delay(intervalMs, undefined, { signal: input.signal });
    } catch {
      if (input.signal?.aborted) throw abortReason(input.signal);
      throw new Error("Development MCP readiness wait failed.");
    }
  }
  throw new Error(
    `Development MCP did not become ready within ${timeoutMs}ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
