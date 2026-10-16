import { setTimeout as delay } from "node:timers/promises";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function abortReason(signal: AbortSignal | undefined) {
  return signal?.reason ?? new Error("Development MCP readiness was aborted.");
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function jsonRpcBody(text: string) {
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .find((line) => line.length > 0);
  return JSON.parse(data ?? text) as {
    error?: { message?: string };
    result?: { tools?: { name?: string }[] };
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function mcpRequest(input: {
  endpoint: string;
  body: Record<string, unknown>;
  sessionId?: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}) {
  const requestTimeout = AbortSignal.timeout(5000);
  const signal = input.signal ? AbortSignal.any([input.signal, requestTimeout]) : requestTimeout;
  const response = await input.fetcher(input.endpoint, {
    body: JSON.stringify(input.body),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(input.sessionId ? { "mcp-session-id": input.sessionId } : {}),
    },
    method: "POST",
    signal,
  });
  if (!response.ok) {
    throw new Error(`Development MCP returned HTTP ${response.status}.`);
  }
  const text = await response.text();
  const sessionId = response.headers.get("mcp-session-id") ?? input.sessionId;
  return { body: text ? jsonRpcBody(text) : undefined, sessionId };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function developmentMcpToolNames(input: {
  endpoint: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}) {
  const fetcher = input.fetcher ?? fetch;
  const initialized = await mcpRequest({
    body: {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: {
          name: "autograph-development-readiness",
          version: "1",
        },
        protocolVersion: "2025-03-26",
      },
    },
    endpoint: input.endpoint,
    fetcher,
    signal: input.signal,
  });
  if (initialized.body?.error) {
    throw new Error(initialized.body.error.message ?? "Development MCP initialization failed.");
  }
  await mcpRequest({
    body: { jsonrpc: "2.0", method: "notifications/initialized" },
    endpoint: input.endpoint,
    fetcher,
    sessionId: initialized.sessionId,
    signal: input.signal,
  });
  const listed = await mcpRequest({
    body: { id: 2, jsonrpc: "2.0", method: "tools/list", params: {} },
    endpoint: input.endpoint,
    fetcher,
    sessionId: initialized.sessionId,
    signal: input.signal,
  });
  if (listed.body?.error) {
    throw new Error(listed.body.error.message ?? "Development MCP tools/list failed.");
  }
  return (listed.body?.result?.tools ?? []).map((tool) => tool.name ?? "");
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function waitForDevelopmentMcp(input: {
  endpoint: string;
  timeoutMs?: number;
  intervalMs?: number;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}) {
  const timeoutMs = input.timeoutMs ?? 120_000;
  const initialIntervalMs = input.intervalMs ?? 250;
  const maximumIntervalMs = Math.max(initialIntervalMs, 5000);
  let retryIntervalMs = initialIntervalMs;
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    if (input.signal?.aborted) {
      throw abortReason(input.signal);
    }
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      const names = await developmentMcpToolNames(input);
      return names;
    } catch (error) {
      lastError = error;
    }
    try {
      const remainingMs = Math.max(0, timeoutMs - (Date.now() - started));
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      await delay(Math.min(retryIntervalMs, remainingMs), undefined, { signal: input.signal });
      retryIntervalMs = Math.min(retryIntervalMs * 2, maximumIntervalMs);
    } catch {
      if (input.signal?.aborted) {
        throw abortReason(input.signal);
      }
      throw new Error("Development MCP readiness wait failed.");
    }
  }
  throw new Error(
    `Development MCP did not become ready within ${timeoutMs}ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
