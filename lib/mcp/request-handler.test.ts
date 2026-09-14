import { McpUiResourceMetaSchema } from "@modelcontextprotocol/ext-apps";
import { describe, expect, it, vi } from "vitest";

import type { HostedEveTransport } from "../eve/hosted-service";
import { InMemoryHostedEveStore } from "../eve/hosted-store";
import type { VerifiedHostedClaims } from "../eve/hosted-auth";
import type { EveSessionService } from "../eve/service";
import {
  createAutographMcpHandler,
  createMcpRequestHandler,
  withHostedBuilderHandoffs,
} from "./request-handler";
import type { HostedMcpRuntime } from "./request-handler";

const auth = {
  algorithm: "ES256" as const,
  audience: "https://builder.example.test/mcp",
  issuer: "https://builder.example.test/api/auth",
  jwksUrl: "https://builder.example.test/api/auth/jwks",
  resourceUrl: "https://builder.example.test/mcp",
};
const exactTools = [
  "autograph_cancel",
  "autograph_get",
  "autograph_respond",
  "autograph_send",
  "autograph_start",
];

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function claims(input: Partial<VerifiedHostedClaims> = {}): VerifiedHostedClaims {
  return {
    audience: auth.audience,
    issuer: auth.issuer,
    scopes: [
      "autograph:session",
      "autograph:start",
      "autograph:get",
      "autograph:send",
      "autograph:respond",
      "autograph:cancel",
    ],
    subject: "user-one",
    workspaceId: "workspace-one",
    ...input,
  };
}

const transport: HostedEveTransport = {
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  async cancel() {
    throw new Error("Transport must not run while listing tools.");
  },
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  async get() {
    throw new Error("Transport must not run while listing tools.");
  },
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  async respond() {
    throw new Error("Transport must not run while listing tools.");
  },
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  async send() {
    throw new Error("Transport must not run while listing tools.");
  },
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  async start() {
    throw new Error("Transport must not run while listing tools.");
  },
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function runtime(
  input: {
    verifiedClaims?: VerifiedHostedClaims;
    verifierError?: Error;
    membership?: (workspaceId: string) => Promise<boolean>;
  } = {},
): HostedMcpRuntime {
  return {
    auth,
    membership: {
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      async isMember({ workspaceId }) {
        return input.membership?.(workspaceId) ?? true;
      },
    },
    now: () => 2_000_000_000_000,
    store: new InMemoryHostedEveStore(),
    transport,
    verifier: {
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      async verify() {
        if (input.verifierError !== undefined) {throw input.verifierError;}
        return input.verifiedClaims ?? claims();
      },
    },
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function mcpRequest(
  headers: Record<string, string> = {},
  method = "tools/list",
  params: Record<string, unknown> = {},
): Request {
  return new Request(auth.resourceUrl, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method,
      params,
    }),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    method: "POST",
  });
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function mcpToolRequest(name: string, args: Record<string, unknown>): Request {
  return new Request(auth.resourceUrl, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: args, name },
    }),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    method: "POST",
  });
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function mcpResult<T>(response: Response): Promise<T> {
  const body = await response.text();
  const data = body
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  const payload = JSON.parse(data ?? body) as { result?: T };
  if (payload.result === undefined) {throw new Error(`MCP result was missing: ${body}`);}
  return payload.result;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function toolNames(response: Response): Promise<string[]> {
  const result = await mcpResult<{
    tools?: { name?: string }[];
  }>(response);
  return (result.tools ?? []).map((tool) => tool.name ?? "").toSorted();
}

describe("branded public tool mapping", () => {
  it("redeems an opaque handoff once and returns the same session after a lost response", async () => {
    const calls: { operation: string; input: unknown }[] = [];
    const result = {
      cursor: 1,
      events: [],
      sessionId: "session-one",
      status: "waiting" as const,
    };
    const service = {
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      async cancel() {
        return result;
      },
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      async get(input: Parameters<EveSessionService["get"]>[0]) {
        calls.push({ input, operation: "get" });
        return result;
      },
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      async list() {
        return { cursor: 0, kind: "session_list" as const, sessions: [] };
      },
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      async recoverStart(input: Parameters<NonNullable<EveSessionService["recoverStart"]>>[0]) {
        calls.push({ input, operation: "recoverStart" });
        return result;
      },
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      async respond() {
        return result;
      },
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      async send() {
        return result;
      },
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      async start(input: Parameters<EveSessionService["start"]>[0]) {
        calls.push({ input, operation: "start" });
        return result;
      },
    } satisfies EveSessionService;
    let redeemed = false;
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const bindSession = vi.fn(async () => {
      redeemed = true;
    });
    const wrapped = withHostedBuilderHandoffs({
      handoffs: {
        bindSession,
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        async recheckRepositoryAccess({ principal, repository }) {
          calls.push({
            input: { principal, repository },
            operation: "recheckRepositoryAccess",
          });
          return { action: "update", status: "authorization-required" };
        },
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        async resolve({ authority, handoffId }) {
          expect(authority).toEqual({
            audience: auth.audience,
            issuer: auth.issuer,
            ownerUserId: "user-one",
            workspaceId: "workspace-one",
          });
          expect(handoffId).toBe("123e4567-e89b-42d3-a456-426614174000");
          return redeemed
            ? { sessionId: "session-one", status: "redeemed" as const }
            : {
                deterministicClientRequestId: `handoff:${"a".repeat(64)}`,
                prompt:
                  "Build the server-owned handoff. Call resolve-repository-access before repository work.",
                record: {
                  intent: {
                    repository: {
                      requestedName: "app-builder-dogfood",
                      resolvedFullName: "withAutograph/app-builder-dogfood",
                    },
                  },
                  requestDigest: "a".repeat(64),
                },
                status: "unredeemed" as const,
              };
        },
      },
      principal: {
        audience: auth.audience,
        issuer: auth.issuer,
        ownerUserId: "user-one",
        scopes: claims().scopes,
        workspaceId: "workspace-one",
      },
      service,
    });
    const request = {
      clientRequestId: "caller-one",
      handoffId: "123e4567-e89b-42d3-a456-426614174000",
    };

    await expect(wrapped.start(request)).resolves.toEqual(result);
    await expect(wrapped.start(request)).resolves.toEqual(result);
    expect(bindSession).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      {
        input: {
          principal: {
            audience: auth.audience,
            issuer: auth.issuer,
            ownerUserId: "user-one",
            scopes: claims().scopes,
            workspaceId: "workspace-one",
          },
          repository: "withAutograph/app-builder-dogfood",
        },
        operation: "recheckRepositoryAccess",
      },
      {
        input: {
          clientRequestId: `handoff:${"a".repeat(64)}`,
          prompt:
            "Build the server-owned handoff. Call resolve-repository-access before repository work.",
          sourceHandoffId: "123e4567-e89b-42d3-a456-426614174000",
        },
        operation: "start",
      },
      {
        input: { cursor: 0, limit: 100, sessionId: "session-one" },
        operation: "recoverStart",
      },
    ]);
  });

  it("leaves an opaque handoff unbound when the provider re-read is unavailable", async () => {
    const start = vi.fn();
    const bindSession = vi.fn();
    const result = {
      cursor: 1,
      events: [],
      sessionId: "session-one",
      status: "waiting" as const,
    };
    const service = {
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      async cancel() {
        return result;
      },
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      async get() {
        return result;
      },
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      async list() {
        return { cursor: 0, kind: "session_list" as const, sessions: [] };
      },
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      async respond() {
        return result;
      },
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      async send() {
        return result;
      },
      start,
    } satisfies EveSessionService;
    const wrapped = withHostedBuilderHandoffs({
      handoffs: {
        bindSession,
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        async recheckRepositoryAccess() {
          return { status: "provider-unavailable" };
        },
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        async resolve() {
          return {
            deterministicClientRequestId: `handoff:${"a".repeat(64)}`,
            prompt: "Build the server-owned handoff.",
            record: {
              intent: {
                repository: {
                  requestedName: "app-builder-dogfood",
                  resolvedFullName: "withAutograph/app-builder-dogfood",
                },
              },
              requestDigest: "a".repeat(64),
            },
            status: "unredeemed" as const,
          };
        },
      },
      principal: {
        audience: auth.audience,
        issuer: auth.issuer,
        ownerUserId: "user-one",
        scopes: claims().scopes,
        workspaceId: "workspace-one",
      },
      service,
    });

    await expect(
      wrapped.start({
        clientRequestId: "caller-one",
        handoffId: "123e4567-e89b-42d3-a456-426614174000",
      }),
    ).rejects.toThrow("Provider access is temporarily unavailable.");
    expect(start).not.toHaveBeenCalled();
    expect(bindSession).not.toHaveBeenCalled();
  });

  it("silently starts an opaque handoff after a current ready provider read", async () => {
    const result = {
      cursor: 1,
      events: [],
      sessionId: "session-one",
      status: "waiting" as const,
    };
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const start = vi.fn(async () => result);
    const bindSession = vi.fn();
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const recheckRepositoryAccess = vi.fn(async () => ({
      status: "ready" as const,
    }));
    const service = {
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      async cancel() {
        return result;
      },
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      async get() {
        return result;
      },
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      async list() {
        return { cursor: 0, kind: "session_list" as const, sessions: [] };
      },
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      async respond() {
        return result;
      },
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      async send() {
        return result;
      },
      start,
    } satisfies EveSessionService;
    const wrapped = withHostedBuilderHandoffs({
      handoffs: {
        bindSession,
        recheckRepositoryAccess,
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        async resolve() {
          return {
            deterministicClientRequestId: `handoff:${"a".repeat(64)}`,
            prompt: "Build the server-owned handoff.",
            record: {
              intent: {
                repository: {
                  requestedName: "app-builder-dogfood",
                  resolvedFullName: "withAutograph/app-builder-dogfood",
                },
              },
              requestDigest: "a".repeat(64),
            },
            status: "unredeemed" as const,
          };
        },
      },
      principal: {
        audience: auth.audience,
        issuer: auth.issuer,
        ownerUserId: "user-one",
        scopes: claims().scopes,
        workspaceId: "workspace-one",
      },
      service,
    });

    await expect(
      wrapped.start({
        clientRequestId: "caller-one",
        handoffId: "123e4567-e89b-42d3-a456-426614174000",
      }),
    ).resolves.toEqual(result);
    expect(recheckRepositoryAccess).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(bindSession).toHaveBeenCalledOnce();
  });

  it("keeps ordinary tools free of unconditional MCP App resources", async () => {
    const handler = createAutographMcpHandler({} as EveSessionService);
    const response = await handler(mcpRequest());
    const result = await mcpResult<{
      tools?: {
        name?: string;
        _meta?: { ui?: { resourceUri?: string; visibility?: string[] } };
      }[];
    }>(response);

    expect((result.tools ?? []).map(({ name }) => name).toSorted()).toEqual(exactTools);
    expect((result.tools ?? []).every(({ _meta }) => _meta?.ui?.resourceUri === undefined)).toBe(
      true,
    );
    expect(
      result.tools?.find(({ name }) => name === "autograph_respond")?._meta?.ui?.visibility,
    ).toEqual(["model", "app"]);
  });

  it("maps each public operation to the unchanged Eve session service", async () => {
    const calls: { operation: string; input: unknown }[] = [];
    const result = {
      cursor: 1,
      events: [],
      sessionId: "session-one",
      status: "waiting" as const,
    };
    const service: EveSessionService = {
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      async cancel(input) {
        calls.push({ input, operation: "cancel" });
        return result;
      },
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      async get(input) {
        calls.push({ input, operation: "get" });
        return result;
      },
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      async list(input) {
        calls.push({ input, operation: "list" });
        return { cursor: 0, kind: "session_list", sessions: [] };
      },
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      async respond(input) {
        calls.push({ input, operation: "respond" });
        return result;
      },
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      async send(input) {
        calls.push({ input, operation: "send" });
        return result;
      },
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      async start(input) {
        calls.push({ input, operation: "start" });
        return result;
      },
    };
    const handler = createAutographMcpHandler(service);
    const invocations = [
      ["autograph_start", { clientRequestId: "start-one", prompt: "Build an app" }],
      ["autograph_get", { cursor: 0, limit: 25, sessionId: "session-one" }],
      [
        "autograph_send",
        {
          clientRequestId: "send-one",
          message: "Use the compact layout",
          sessionId: "session-one",
        },
      ],
      [
        "autograph_respond",
        {
          clientRequestId: "respond-one",
          responses: [
            { requestId: "approval-one", response: { kind: "approve" } },
            {
              requestId: "question-one",
              response: { kind: "answer", value: "Compact" },
            },
          ],
          sessionId: "session-one",
        },
      ],
      ["autograph_cancel", { sessionId: "session-one", turnId: "turn-one" }],
    ] as const;

    for (const [name, args] of invocations) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      const response = await handler(mcpToolRequest(name, args));
      expect(response.status).toBe(200);
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      const callResult = await mcpResult<{ structuredContent?: unknown }>(response);
      expect(callResult.structuredContent).toEqual(result);
    }

    expect(calls).toEqual([
      { input: invocations[0][1], operation: "start" },
      { input: invocations[1][1], operation: "get" },
      { input: invocations[2][1], operation: "send" },
      { input: invocations[3][1], operation: "respond" },
      { input: invocations[4][1], operation: "cancel" },
    ]);
  });

  it("lists recent sessions when autograph_get omits sessionId", async () => {
    const sessionResult = {
      cursor: 0,
      events: [],
      sessionId: "session-one",
      status: "waiting" as const,
    };
    const listed = {
      cursor: 1,
      kind: "session_list" as const,
      sessions: [
        {
          resumability: "live" as const,
          sessionId: "session-one",
          stage: "prototype" as const,
          status: "waiting" as const,
          title: "Vendor workspace",
          updatedAt: "2026-09-01T12:00:00.000Z",
        },
      ],
    };
    const service = {
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      cancel: vi.fn(async () => sessionResult),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      get: vi.fn(async () => sessionResult),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      list: vi.fn(async () => listed),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      respond: vi.fn(async () => sessionResult),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      send: vi.fn(async () => sessionResult),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      start: vi.fn(async () => sessionResult),
    } satisfies EveSessionService;
    const handler = createAutographMcpHandler(service);
    const response = await handler(mcpToolRequest("autograph_get", { cursor: 0, limit: 25 }));
    const result = await mcpResult<{ structuredContent: unknown }>(response);

    expect(result.structuredContent).toEqual(listed);
    expect(service.list).toHaveBeenCalledWith({ cursor: 0, limit: 25 });
    expect(service.get).not.toHaveBeenCalled();
  });

  it("returns a Browser-openable URL without attaching prototype UI", async () => {
    const content = "<!doctype html><html><body>Vendor queue</body></html>";
    const result = {
      cursor: 1,
      events: [],
      prototype: {
        content,
        digest: "e8385bab4b1d1c12641b37bdeec4e359c40a6f30016f724ec61b5b8b20ca8c0f",
        mediaType: "text/html" as const,
        path: "prototype/vendor-onboarding/index.html",
        revision: "b".repeat(64),
      },
      sessionId: "session-one",
      status: "completed" as const,
    };
    const service = {
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      cancel: vi.fn(async () => result),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      get: vi.fn(async () => result),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      list: vi.fn(async () => ({
        cursor: 0,
        kind: "session_list" as const,
        sessions: [],
      })),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      respond: vi.fn(async () => result),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      send: vi.fn(async () => result),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      start: vi.fn(async () => result),
    } satisfies EveSessionService;
    const handler = createAutographMcpHandler(service, {
      requestUrl: auth.resourceUrl,
    });
    const response = await handler(
      mcpToolRequest("autograph_get", {
        cursor: 0,
        limit: 100,
        sessionId: "session-one",
      }),
    );
    const callResult = await mcpResult<{
      structuredContent: Omit<typeof result, "prototype"> & {
        prototype: typeof result.prototype & { previewUrl: string };
      };
      _meta?: unknown;
    }>(response);

    expect(callResult.structuredContent.prototype.previewUrl).toBe(
      `https://builder.example.test/preview/session-one/${result.prototype.digest}`,
    );
    expect(callResult._meta).toBeUndefined();
  });
});

describe("request-scoped MCP service selection", () => {
  it("allows public tool discovery before OAuth but protects tool calls", async () => {
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const verifier = vi.fn(async () => claims());
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const membership = vi.fn(async () => true);
    const hostedRuntime = runtime();
    hostedRuntime.verifier = { verify: verifier };
    hostedRuntime.membership = { isMember: membership };
    const handler = createMcpRequestHandler({
      environment: { EVE_HOSTED_ADAPTER: "1" },
      hostedRuntime,
    });

    const discovery = await mcpResult<{
      tools: {
        name: string;
        _meta?: {
          securitySchemes?: { type: string; scopes?: string[] }[];
        };
      }[];
    }>(await handler(mcpRequest({}, "tools/list")));
    expect(discovery.tools.map(({ name }) => name).toSorted()).toEqual(exactTools);
    for (const tool of discovery.tools) {
      expect(tool._meta?.securitySchemes).toEqual([
        {
          scopes: [
            "autograph:session",
            "autograph:start",
            "autograph:get",
            "autograph:send",
            "autograph:respond",
            "autograph:cancel",
          ],
          type: "oauth2",
        },
      ]);
    }
    expect(verifier).not.toHaveBeenCalled();
    expect(membership).not.toHaveBeenCalled();

    const protectedCall = await handler(
      mcpRequest({}, "tools/call", {
        arguments: { cursor: 0, limit: 20 },
        name: "autograph_get",
      }),
    );
    expect(protectedCall.status).toBe(200);
    const authResult = await mcpResult<{
      isError: boolean;
      _meta: { "mcp/www_authenticate": string[] };
      structuredContent: { error: { code: string } };
    }>(protectedCall);
    expect(authResult.isError).toBe(true);
    expect(authResult.structuredContent.error.code).toBe("authentication_required");
    expect(authResult._meta["mcp/www_authenticate"][0]).toContain('error="invalid_token"');
    expect(authResult._meta["mcp/www_authenticate"][0]).toContain(
      'error_description="Sign in to Autograph App Builder to continue"',
    );
    expect(authResult._meta["mcp/www_authenticate"][0]).toContain(
      'scope="autograph:session autograph:start autograph:get autograph:send autograph:respond autograph:cancel"',
    );
  });

  it("does not fall back to local or unconfigured service in hosted mode", async () => {
    const handler = createMcpRequestHandler({
      environment: {
        APP_BUILDER_LOCAL_ADAPTER: "0",
        EVE_AGENT_HOST: "http://127.0.0.1:9999",
        EVE_HOSTED_ADAPTER: "1",
      },
    });
    const response = await handler(mcpRequest());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "service_unavailable",
    });
  });

  it("fails closed when hosted runtime authentication metadata is incomplete", async () => {
    const hostedRuntime = runtime();
    hostedRuntime.auth = { ...auth, audience: "" };
    const handler = createMcpRequestHandler({
      environment: { EVE_HOSTED_ADAPTER: "1" },
      hostedRuntime,
    });
    const response = await handler(mcpRequest({ authorization: "Bearer token" }, "tools/call"));
    expect(response.status).toBe(503);
  });

  it("returns the same tool-level auth challenge for missing and malformed credentials", async () => {
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const verifier = vi.fn(async () => claims());
    const hostedRuntime = runtime();
    hostedRuntime.verifier = { verify: verifier };
    const handler = createMcpRequestHandler({
      environment: { EVE_HOSTED_ADAPTER: "1" },
      hostedRuntime,
    });
    const responses = await Promise.all([
      handler(
        mcpRequest({}, "tools/call", {
          arguments: { cursor: 0, limit: 20 },
          name: "autograph_get",
        }),
      ),
      handler(
        mcpRequest({ authorization: "Bearer two tokens" }, "tools/call", {
          arguments: { cursor: 0, limit: 20 },
          name: "autograph_get",
        }),
      ),
      handler(
        mcpRequest({ authorization: "Basic token" }, "tools/call", {
          arguments: { cursor: 0, limit: 20 },
          name: "autograph_get",
        }),
      ),
    ]);
    expect(verifier).not.toHaveBeenCalled();
    for (const response of responses) {
      expect(response.status).toBe(200);
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      const result = await mcpResult<{
        _meta: { "mcp/www_authenticate": string[] };
      }>(response);
      expect(result._meta["mcp/www_authenticate"][0]).toContain('error="invalid_token"');
      expect(result._meta["mcp/www_authenticate"][0]).toContain(
        'scope="autograph:session autograph:start autograph:get autograph:send autograph:respond autograph:cancel"',
      );
    }
  });

  it("maps invalid tokens to 401 and missing session scope to 403", async () => {
    const invalid = createMcpRequestHandler({
      environment: { EVE_HOSTED_ADAPTER: "1" },
      hostedRuntime: runtime({ verifierError: new Error("bad token") }),
    });
    const invalidResponse = await invalid(
      mcpRequest({ authorization: "Bearer token" }, "tools/call", {
        arguments: { cursor: 0, limit: 20 },
        name: "autograph_get",
      }),
    );
    expect(invalidResponse.status).toBe(200);
    const invalidResult = await mcpResult<{
      _meta: { "mcp/www_authenticate": string[] };
    }>(invalidResponse);
    expect(invalidResult._meta["mcp/www_authenticate"][0]).toContain('error="invalid_token"');

    const insufficient = createMcpRequestHandler({
      environment: { EVE_HOSTED_ADAPTER: "1" },
      hostedRuntime: runtime({
        verifiedClaims: claims({ scopes: ["autograph:session"] }),
      }),
    });
    const insufficientResponse = await insufficient(
      mcpRequest({ authorization: "Bearer token" }, "tools/call", {
        arguments: { cursor: 0, limit: 20 },
        name: "autograph_get",
      }),
    );
    expect(insufficientResponse.status).toBe(200);
    const insufficientResult = await mcpResult<{
      _meta: { "mcp/www_authenticate": string[] };
    }>(insufficientResponse);
    expect(insufficientResult._meta["mcp/www_authenticate"][0]).toContain(
      'error="insufficient_scope"',
    );
    expect(insufficientResult._meta["mcp/www_authenticate"][0]).toContain(
      'scope="autograph:session autograph:start autograph:get autograph:send autograph:respond autograph:cancel"',
    );
  });

  it("makes denied and membership-error workspaces indistinguishable", async () => {
    const requestHeaders = { authorization: "Bearer token" };
    const handlers = [
      createMcpRequestHandler({
        environment: { EVE_HOSTED_ADAPTER: "1" },
        hostedRuntime: runtime({
          // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
          membership: async () => false,
          verifiedClaims: claims({ workspaceId: "workspace-two" }),
        }),
      }),
      createMcpRequestHandler({
        environment: { EVE_HOSTED_ADAPTER: "1" },
        hostedRuntime: runtime({
          // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
          membership: async () => {
            throw new Error("store unavailable");
          },
          verifiedClaims: claims({ workspaceId: "workspace-two" }),
        }),
      }),
    ] as const;
    const responses = [
      await handlers[0](mcpRequest(requestHeaders, "tools/call")),
      await handlers[1](mcpRequest(requestHeaders, "tools/call")),
    ];
    const projections = await Promise.all(
      responses.map(async (response) => ({
        body: await response.json(),
        cache: response.headers.get("cache-control"),
        status: response.status,
      })),
    );
    expect(new Set(projections.map((projection) => JSON.stringify(projection))).size).toBe(1);
    expect(projections[0]).toEqual({
      body: { error: "not_found" },
      cache: "no-store",
      status: 404,
    });
  });

  it("binds each protected hosted request to its own principal and membership check", async () => {
    const seen: string[] = [];
    const hostedRuntime = runtime({
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      membership: async (workspaceId) => {
        seen.push(workspaceId);
        return true;
      },
    });
    hostedRuntime.verifier = {
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      async verify({ token }) {
        return claims({
          subject: `user-${token}`,
          workspaceId: `workspace-${token}`,
        });
      },
    };
    const handler = createMcpRequestHandler({
      environment: { EVE_HOSTED_ADAPTER: "1" },
      hostedRuntime,
    });
    const [one, two] = await Promise.all([
      handler(
        mcpRequest({ authorization: "Bearer one" }, "tools/call", {
          arguments: { cursor: 0, limit: 20 },
          name: "autograph_get",
        }),
      ),
      handler(
        mcpRequest({ authorization: "Bearer two" }, "tools/call", {
          arguments: { cursor: 0, limit: 20 },
          name: "autograph_get",
        }),
      ),
    ]);
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(seen.toSorted()).toEqual(["workspace-one", "workspace-two"]);
  });

  it("preserves the exact five tools in loopback local and unconfigured modes", async () => {
    const local = createMcpRequestHandler({
      environment: {
        APP_BUILDER_LOCAL_ADAPTER: "1",
        EVE_AGENT_HOST: "http://127.0.0.1:9999",
      },
    });
    const unconfigured = createMcpRequestHandler({ environment: {} });
    const [localResponse, unconfiguredResponse] = await Promise.all([
      local(mcpRequest()),
      unconfigured(mcpRequest()),
    ]);
    expect(localResponse.status).toBe(200);
    expect(unconfiguredResponse.status).toBe(200);
    expect(await toolNames(localResponse)).toEqual(exactTools);
    expect(await toolNames(unconfiguredResponse)).toEqual(exactTools);
  });

  it("exposes only the branded public MCP contract", async () => {
    const handler = createMcpRequestHandler({ environment: {} });
    const toolResponse = await handler(mcpRequest());
    const resourceResponse = await handler(mcpRequest({}, "resources/list"));
    const resourceReadResponse = await handler(
      mcpRequest({}, "resources/read", {
        uri: "ui://autograph-app-builder/session.html",
      }),
    );
    expect(toolResponse.status).toBe(200);
    expect(resourceResponse.status).toBe(200);
    expect(resourceReadResponse.status).toBe(200);

    const toolResult = await mcpResult<{
      tools: {
        name: string;
        title?: string;
        description?: string;
        annotations?: {
          readOnlyHint?: boolean;
          destructiveHint?: boolean;
          idempotentHint?: boolean;
          openWorldHint?: boolean;
        };
      }[];
    }>(toolResponse);
    expect(toolResult.tools.map(({ name }) => name).toSorted()).toEqual(exactTools);
    expect(toolResult.tools.every(({ name }) => !name.startsWith("eve_"))).toBe(true);
    expect(Object.fromEntries(toolResult.tools.map(({ name, title }) => [name, title]))).toEqual({
      autograph_cancel: "Stop App Builder work",
      autograph_get: "Check App Builder progress",
      autograph_respond: "Answer App Builder questions",
      autograph_send: "Send App Builder feedback",
      autograph_start: "Start with Autograph App Builder",
    });
    expect(
      Object.fromEntries(toolResult.tools.map(({ name, description }) => [name, description])),
    ).toEqual({
      autograph_cancel:
        "Request cancellation of the active App Builder session. This cannot publish, deploy, provision, or modify the user's repository.",
      autograph_get:
        "List recent app builds, or read the next page of one app build's progress and requests.",
      autograph_respond:
        "Answer the complete outstanding set of App Builder questions in one response. This cannot publish, deploy, provision, or modify the user's repository without a later in-product approval.",
      autograph_send:
        "Send additional direction to an App Builder session. This cannot publish, deploy, provision, or modify the user's repository without a later in-product approval.",
      autograph_start:
        "Start reversible App Builder work and return immediately. This only manages an App Builder session; it cannot publish, deploy, provision, or modify the user's repository without a later in-product approval.",
    });
    expect(
      Object.fromEntries(toolResult.tools.map(({ name, annotations }) => [name, annotations])),
    ).toEqual({
      autograph_cancel: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      autograph_get: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      autograph_respond: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      autograph_send: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      autograph_start: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
    });

    const resourceResult = await mcpResult<{
      resources: {
        name: string;
        title?: string;
        description?: string;
        _meta?: { ui?: unknown };
      }[];
    }>(resourceResponse);
    expect(resourceResult.resources).toContainEqual(
      expect.objectContaining({
        _meta: {
          ui: {
            csp: {
              baseUriDomains: [],
              connectDomains: [],
              frameDomains: ["about:"],
              resourceDomains: [],
            },
            prefersBorder: false,
          },
        },
        description: "Live progress and requests from Autograph App Builder.",
        name: "autograph-session",
        title: "Autograph App Builder progress",
      }),
    );
    const resourceMeta = resourceResult.resources[0]?._meta?.ui;
    expect(McpUiResourceMetaSchema.parse(resourceMeta)).toEqual(resourceMeta);

    const resourceRead = await mcpResult<{
      contents: { _meta?: { ui?: unknown } }[];
    }>(resourceReadResponse);
    expect(resourceRead.contents).toHaveLength(1);
    expect(resourceRead.contents[0]?._meta?.ui).toEqual(resourceMeta);
    expect(McpUiResourceMetaSchema.parse(resourceRead.contents[0]?._meta?.ui)).toEqual(
      resourceMeta,
    );
  });
});
