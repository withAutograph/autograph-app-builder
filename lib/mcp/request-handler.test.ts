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
  type HostedMcpRuntime,
} from "./request-handler";

const auth = {
  issuer: "https://builder.example.test/api/auth",
  audience: "https://builder.example.test/mcp",
  jwksUrl: "https://builder.example.test/api/auth/jwks",
  algorithm: "ES256" as const,
  resourceUrl: "https://builder.example.test/mcp",
};
const exactTools = [
  "autograph_cancel",
  "autograph_get",
  "autograph_respond",
  "autograph_send",
  "autograph_start",
];

function claims(
  input: Partial<VerifiedHostedClaims> = {},
): VerifiedHostedClaims {
  return {
    issuer: auth.issuer,
    audience: auth.audience,
    subject: "user-one",
    workspaceId: "workspace-one",
    scopes: [
      "autograph:session",
      "autograph:start",
      "autograph:get",
      "autograph:send",
      "autograph:respond",
      "autograph:cancel",
    ],
    ...input,
  };
}

const transport: HostedEveTransport = {
  async start() {
    throw new Error("Transport must not run while listing tools.");
  },
  async get() {
    throw new Error("Transport must not run while listing tools.");
  },
  async send() {
    throw new Error("Transport must not run while listing tools.");
  },
  async respond() {
    throw new Error("Transport must not run while listing tools.");
  },
  async cancel() {
    throw new Error("Transport must not run while listing tools.");
  },
};

function runtime(
  input: {
    verifiedClaims?: VerifiedHostedClaims;
    verifierError?: Error;
    membership?: (workspaceId: string) => Promise<boolean>;
  } = {},
): HostedMcpRuntime {
  return {
    auth,
    verifier: {
      async verify() {
        if (input.verifierError !== undefined) throw input.verifierError;
        return input.verifiedClaims ?? claims();
      },
    },
    membership: {
      async isMember({ workspaceId }) {
        return input.membership?.(workspaceId) ?? true;
      },
    },
    store: new InMemoryHostedEveStore(),
    transport,
    now: () => 2_000_000_000_000,
  };
}

function mcpRequest(
  headers: Record<string, string> = {},
  method = "tools/list",
  params: Record<string, unknown> = {},
): Request {
  return new Request(auth.resourceUrl, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });
}

function mcpToolRequest(name: string, args: Record<string, unknown>): Request {
  return new Request(auth.resourceUrl, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
}

async function mcpResult<T>(response: Response): Promise<T> {
  const body = await response.text();
  const data = body
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  const payload = JSON.parse(data ?? body) as { result?: T };
  if (payload.result === undefined)
    throw new Error(`MCP result was missing: ${body}`);
  return payload.result;
}

async function toolNames(response: Response): Promise<string[]> {
  const result = await mcpResult<{
    tools?: Array<{ name?: string }>;
  }>(response);
  return (result.tools ?? []).map((tool) => tool.name ?? "").sort();
}

describe("branded public tool mapping", () => {
  it("redeems an opaque handoff once and returns the same session after a lost response", async () => {
    const calls: Array<{ operation: string; input: unknown }> = [];
    const result = {
      sessionId: "session-one",
      status: "waiting" as const,
      cursor: 1,
      events: [],
    };
    const service = {
      async start(input: Parameters<EveSessionService["start"]>[0]) {
        calls.push({ operation: "start", input });
        return result;
      },
      async get(input: Parameters<EveSessionService["get"]>[0]) {
        calls.push({ operation: "get", input });
        return result;
      },
      async recoverStart(
        input: Parameters<NonNullable<EveSessionService["recoverStart"]>>[0],
      ) {
        calls.push({ operation: "recoverStart", input });
        return result;
      },
      async list() {
        return { kind: "session_list" as const, cursor: 0, sessions: [] };
      },
      async send() {
        return result;
      },
      async respond() {
        return result;
      },
      async cancel() {
        return result;
      },
    } satisfies EveSessionService;
    let redeemed = false;
    const bindSession = vi.fn(async () => {
      redeemed = true;
    });
    const wrapped = withHostedBuilderHandoffs({
      service,
      principal: {
        issuer: auth.issuer,
        audience: auth.audience,
        workspaceId: "workspace-one",
        ownerUserId: "user-one",
        scopes: claims().scopes,
      },
      handoffs: {
        async resolve({ authority, handoffId }) {
          expect(authority).toEqual({
            issuer: auth.issuer,
            audience: auth.audience,
            workspaceId: "workspace-one",
            ownerUserId: "user-one",
          });
          expect(handoffId).toBe("123e4567-e89b-42d3-a456-426614174000");
          return redeemed
            ? { status: "redeemed" as const, sessionId: "session-one" }
            : {
                status: "unredeemed" as const,
                prompt:
                  "Build the server-owned handoff. Call resolve_repository_access before repository work.",
                deterministicClientRequestId: `handoff:${"a".repeat(64)}`,
                record: {
                  requestDigest: "a".repeat(64),
                  intent: {
                    repository: {
                      requestedName: "app-builder-dogfood",
                      resolvedFullName: "withAutograph/app-builder-dogfood",
                    },
                  },
                },
              };
        },
        bindSession,
        async recheckRepositoryAccess({ principal, repository }) {
          calls.push({
            operation: "recheckRepositoryAccess",
            input: { principal, repository },
          });
          return { status: "authorization-required", action: "update" };
        },
      },
    });
    const request = {
      handoffId: "123e4567-e89b-42d3-a456-426614174000",
      clientRequestId: "caller-one",
    };

    await expect(wrapped.start(request)).resolves.toEqual(result);
    await expect(wrapped.start(request)).resolves.toEqual(result);
    expect(bindSession).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      {
        operation: "recheckRepositoryAccess",
        input: {
          principal: {
            issuer: auth.issuer,
            audience: auth.audience,
            workspaceId: "workspace-one",
            ownerUserId: "user-one",
            scopes: claims().scopes,
          },
          repository: "withAutograph/app-builder-dogfood",
        },
      },
      {
        operation: "start",
        input: {
          prompt:
            "Build the server-owned handoff. Call resolve_repository_access before repository work.",
          clientRequestId: `handoff:${"a".repeat(64)}`,
        },
      },
      {
        operation: "recoverStart",
        input: { sessionId: "session-one", cursor: 0, limit: 100 },
      },
    ]);
  });

  it("leaves an opaque handoff unbound when the provider re-read is unavailable", async () => {
    const start = vi.fn();
    const bindSession = vi.fn();
    const result = {
      sessionId: "session-one",
      status: "waiting" as const,
      cursor: 1,
      events: [],
    };
    const service = {
      start,
      async list() {
        return { kind: "session_list" as const, cursor: 0, sessions: [] };
      },
      async get() {
        return result;
      },
      async send() {
        return result;
      },
      async respond() {
        return result;
      },
      async cancel() {
        return result;
      },
    } satisfies EveSessionService;
    const wrapped = withHostedBuilderHandoffs({
      service,
      principal: {
        issuer: auth.issuer,
        audience: auth.audience,
        workspaceId: "workspace-one",
        ownerUserId: "user-one",
        scopes: claims().scopes,
      },
      handoffs: {
        async resolve() {
          return {
            status: "unredeemed" as const,
            prompt: "Build the server-owned handoff.",
            deterministicClientRequestId: `handoff:${"a".repeat(64)}`,
            record: {
              requestDigest: "a".repeat(64),
              intent: {
                repository: {
                  requestedName: "app-builder-dogfood",
                  resolvedFullName: "withAutograph/app-builder-dogfood",
                },
              },
            },
          };
        },
        bindSession,
        async recheckRepositoryAccess() {
          return { status: "provider-unavailable" };
        },
      },
    });

    await expect(
      wrapped.start({
        handoffId: "123e4567-e89b-42d3-a456-426614174000",
        clientRequestId: "caller-one",
      }),
    ).rejects.toThrow("handoff-repository-access-unavailable");
    expect(start).not.toHaveBeenCalled();
    expect(bindSession).not.toHaveBeenCalled();
  });

  it("silently starts an opaque handoff after a current ready provider read", async () => {
    const result = {
      sessionId: "session-one",
      status: "waiting" as const,
      cursor: 1,
      events: [],
    };
    const start = vi.fn(async () => result);
    const bindSession = vi.fn();
    const recheckRepositoryAccess = vi.fn(async () => ({
      status: "ready" as const,
    }));
    const service = {
      start,
      async list() {
        return { kind: "session_list" as const, cursor: 0, sessions: [] };
      },
      async get() {
        return result;
      },
      async send() {
        return result;
      },
      async respond() {
        return result;
      },
      async cancel() {
        return result;
      },
    } satisfies EveSessionService;
    const wrapped = withHostedBuilderHandoffs({
      service,
      principal: {
        issuer: auth.issuer,
        audience: auth.audience,
        workspaceId: "workspace-one",
        ownerUserId: "user-one",
        scopes: claims().scopes,
      },
      handoffs: {
        async resolve() {
          return {
            status: "unredeemed" as const,
            prompt: "Build the server-owned handoff.",
            deterministicClientRequestId: `handoff:${"a".repeat(64)}`,
            record: {
              requestDigest: "a".repeat(64),
              intent: {
                repository: {
                  requestedName: "app-builder-dogfood",
                  resolvedFullName: "withAutograph/app-builder-dogfood",
                },
              },
            },
          };
        },
        bindSession,
        recheckRepositoryAccess,
      },
    });

    await expect(
      wrapped.start({
        handoffId: "123e4567-e89b-42d3-a456-426614174000",
        clientRequestId: "caller-one",
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
      tools?: Array<{
        name?: string;
        _meta?: { ui?: { resourceUri?: string; visibility?: string[] } };
      }>;
    }>(response);

    expect((result.tools ?? []).map(({ name }) => name).sort()).toEqual(
      exactTools,
    );
    expect(
      (result.tools ?? []).every(
        ({ _meta }) => _meta?.ui?.resourceUri === undefined,
      ),
    ).toBe(true);
    expect(
      result.tools?.find(({ name }) => name === "autograph_respond")?._meta?.ui
        ?.visibility,
    ).toEqual(["model", "app"]);
  });

  it("maps each public operation to the unchanged Eve session service", async () => {
    const calls: Array<{ operation: string; input: unknown }> = [];
    const result = {
      sessionId: "session-one",
      status: "waiting" as const,
      cursor: 1,
      events: [],
    };
    const service: EveSessionService = {
      async start(input) {
        calls.push({ operation: "start", input });
        return result;
      },
      async list(input) {
        calls.push({ operation: "list", input });
        return { kind: "session_list", cursor: 0, sessions: [] };
      },
      async get(input) {
        calls.push({ operation: "get", input });
        return result;
      },
      async send(input) {
        calls.push({ operation: "send", input });
        return result;
      },
      async respond(input) {
        calls.push({ operation: "respond", input });
        return result;
      },
      async cancel(input) {
        calls.push({ operation: "cancel", input });
        return result;
      },
    };
    const handler = createAutographMcpHandler(service);
    const invocations = [
      [
        "autograph_start",
        { prompt: "Build an app", clientRequestId: "start-one" },
      ],
      ["autograph_get", { sessionId: "session-one", cursor: 0, limit: 25 }],
      [
        "autograph_send",
        {
          sessionId: "session-one",
          message: "Use the compact layout",
          clientRequestId: "send-one",
        },
      ],
      [
        "autograph_respond",
        {
          sessionId: "session-one",
          responses: [
            { requestId: "approval-one", response: { kind: "approve" } },
            {
              requestId: "question-one",
              response: { kind: "answer", value: "Compact" },
            },
          ],
          clientRequestId: "respond-one",
        },
      ],
      ["autograph_cancel", { sessionId: "session-one", turnId: "turn-one" }],
    ] as const;

    for (const [name, args] of invocations) {
      const response = await handler(mcpToolRequest(name, args));
      expect(response.status).toBe(200);
      const callResult = await mcpResult<{ structuredContent?: unknown }>(
        response,
      );
      expect(callResult.structuredContent).toEqual(result);
    }

    expect(calls).toEqual([
      { operation: "start", input: invocations[0][1] },
      { operation: "get", input: invocations[1][1] },
      { operation: "send", input: invocations[2][1] },
      { operation: "respond", input: invocations[3][1] },
      { operation: "cancel", input: invocations[4][1] },
    ]);
  });

  it("lists recent sessions when autograph_get omits sessionId", async () => {
    const sessionResult = {
      sessionId: "session-one",
      status: "waiting" as const,
      cursor: 0,
      events: [],
    };
    const listed = {
      kind: "session_list" as const,
      cursor: 1,
      sessions: [
        {
          sessionId: "session-one",
          title: "Vendor workspace",
          stage: "prototype" as const,
          status: "waiting" as const,
          resumability: "live" as const,
          updatedAt: "2026-09-01T12:00:00.000Z",
        },
      ],
    };
    const service = {
      start: vi.fn(async () => sessionResult),
      list: vi.fn(async () => listed),
      get: vi.fn(async () => sessionResult),
      send: vi.fn(async () => sessionResult),
      respond: vi.fn(async () => sessionResult),
      cancel: vi.fn(async () => sessionResult),
    } satisfies EveSessionService;
    const handler = createAutographMcpHandler(service);
    const response = await handler(
      mcpToolRequest("autograph_get", { cursor: 0, limit: 25 }),
    );
    const result = await mcpResult<{ structuredContent: unknown }>(response);

    expect(result.structuredContent).toEqual(listed);
    expect(service.list).toHaveBeenCalledWith({ cursor: 0, limit: 25 });
    expect(service.get).not.toHaveBeenCalled();
  });

  it("returns a Browser-openable URL without attaching prototype UI", async () => {
    const content = "<!doctype html><html><body>Vendor queue</body></html>";
    const result = {
      sessionId: "session-one",
      status: "completed" as const,
      cursor: 1,
      events: [],
      prototype: {
        path: "prototype/vendor-onboarding/index.html",
        mediaType: "text/html" as const,
        content,
        digest:
          "e8385bab4b1d1c12641b37bdeec4e359c40a6f30016f724ec61b5b8b20ca8c0f",
        revision: "b".repeat(64),
      },
    };
    const service = {
      start: vi.fn(async () => result),
      list: vi.fn(async () => ({
        kind: "session_list" as const,
        cursor: 0,
        sessions: [],
      })),
      get: vi.fn(async () => result),
      send: vi.fn(async () => result),
      respond: vi.fn(async () => result),
      cancel: vi.fn(async () => result),
    } satisfies EveSessionService;
    const handler = createAutographMcpHandler(service, {
      requestUrl: auth.resourceUrl,
    });
    const response = await handler(
      mcpToolRequest("autograph_get", {
        sessionId: "session-one",
        cursor: 0,
        limit: 100,
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
    const verifier = vi.fn(async () => claims());
    const membership = vi.fn(async () => true);
    const hostedRuntime = runtime();
    hostedRuntime.verifier = { verify: verifier };
    hostedRuntime.membership = { isMember: membership };
    const handler = createMcpRequestHandler({
      environment: { EVE_HOSTED_ADAPTER: "1" },
      hostedRuntime,
    });

    const discovery = await mcpResult<{
      tools: Array<{
        name: string;
        _meta?: {
          securitySchemes?: Array<{ type: string; scopes?: string[] }>;
        };
      }>;
    }>(await handler(mcpRequest({}, "tools/list")));
    expect(discovery.tools.map(({ name }) => name).sort()).toEqual(exactTools);
    for (const tool of discovery.tools) {
      expect(tool._meta?.securitySchemes).toEqual([
        {
          type: "oauth2",
          scopes: [
            "autograph:session",
            `autograph:${tool.name.replace("autograph_", "")}`,
          ],
        },
      ]);
    }
    expect(verifier).not.toHaveBeenCalled();
    expect(membership).not.toHaveBeenCalled();

    const protectedCall = await handler(
      mcpRequest({}, "tools/call", {
        name: "autograph_get",
        arguments: { cursor: 0, limit: 20 },
      }),
    );
    expect(protectedCall.status).toBe(200);
    const authResult = await mcpResult<{
      isError: boolean;
      _meta: { "mcp/www_authenticate": string[] };
      structuredContent: { error: { code: string } };
    }>(protectedCall);
    expect(authResult.isError).toBe(true);
    expect(authResult.structuredContent.error.code).toBe(
      "authentication_required",
    );
    expect(authResult._meta["mcp/www_authenticate"][0]).toContain(
      'error="invalid_token"',
    );
    expect(authResult._meta["mcp/www_authenticate"][0]).toContain(
      'error_description="Sign in to Autograph App Builder to continue"',
    );
    expect(authResult._meta["mcp/www_authenticate"][0]).toContain(
      'scope="autograph:session autograph:get"',
    );
  });

  it("does not fall back to local or unconfigured service in hosted mode", async () => {
    const handler = createMcpRequestHandler({
      environment: {
        EVE_HOSTED_ADAPTER: "1",
        APP_BUILDER_LOCAL_ADAPTER: "0",
        EVE_AGENT_HOST: "http://127.0.0.1:9999",
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
    const response = await handler(
      mcpRequest({ authorization: "Bearer token" }, "tools/call"),
    );
    expect(response.status).toBe(503);
  });

  it("returns the same tool-level auth challenge for missing and malformed credentials", async () => {
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
          name: "autograph_get",
          arguments: { cursor: 0, limit: 20 },
        }),
      ),
      handler(
        mcpRequest({ authorization: "Bearer two tokens" }, "tools/call", {
          name: "autograph_get",
          arguments: { cursor: 0, limit: 20 },
        }),
      ),
      handler(
        mcpRequest({ authorization: "Basic token" }, "tools/call", {
          name: "autograph_get",
          arguments: { cursor: 0, limit: 20 },
        }),
      ),
    ]);
    expect(verifier).not.toHaveBeenCalled();
    for (const response of responses) {
      expect(response.status).toBe(200);
      const result = await mcpResult<{
        _meta: { "mcp/www_authenticate": string[] };
      }>(response);
      expect(result._meta["mcp/www_authenticate"][0]).toContain(
        'error="invalid_token"',
      );
      expect(result._meta["mcp/www_authenticate"][0]).toContain(
        'scope="autograph:session autograph:get"',
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
        name: "autograph_get",
        arguments: { cursor: 0, limit: 20 },
      }),
    );
    expect(invalidResponse.status).toBe(200);
    expect(
      (
        await mcpResult<{
          _meta: { "mcp/www_authenticate": string[] };
        }>(invalidResponse)
      )._meta["mcp/www_authenticate"][0],
    ).toContain('error="invalid_token"');

    const insufficient = createMcpRequestHandler({
      environment: { EVE_HOSTED_ADAPTER: "1" },
      hostedRuntime: runtime({
        verifiedClaims: claims({ scopes: ["autograph:session"] }),
      }),
    });
    const insufficientResponse = await insufficient(
      mcpRequest({ authorization: "Bearer token" }, "tools/call", {
        name: "autograph_get",
        arguments: { cursor: 0, limit: 20 },
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
      'scope="autograph:session autograph:get"',
    );
  });

  it("makes denied and membership-error workspaces indistinguishable", async () => {
    const requestHeaders = { authorization: "Bearer token" };
    const handlers = [
      createMcpRequestHandler({
        environment: { EVE_HOSTED_ADAPTER: "1" },
        hostedRuntime: runtime({
          verifiedClaims: claims({ workspaceId: "workspace-two" }),
          membership: async () => false,
        }),
      }),
      createMcpRequestHandler({
        environment: { EVE_HOSTED_ADAPTER: "1" },
        hostedRuntime: runtime({
          verifiedClaims: claims({ workspaceId: "workspace-two" }),
          membership: async () => {
            throw new Error("store unavailable");
          },
        }),
      }),
    ];
    const responses = [
      await handlers[0]!(mcpRequest(requestHeaders, "tools/call")),
      await handlers[1]!(mcpRequest(requestHeaders, "tools/call")),
    ];
    const projections = await Promise.all(
      responses.map(async (response) => ({
        status: response.status,
        cache: response.headers.get("cache-control"),
        body: await response.json(),
      })),
    );
    expect(
      new Set(projections.map((projection) => JSON.stringify(projection))).size,
    ).toBe(1);
    expect(projections[0]).toEqual({
      status: 404,
      cache: "no-store",
      body: { error: "not_found" },
    });
  });

  it("binds each protected hosted request to its own principal and membership check", async () => {
    const seen: string[] = [];
    const hostedRuntime = runtime({
      membership: async (workspaceId) => {
        seen.push(workspaceId);
        return true;
      },
    });
    hostedRuntime.verifier = {
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
          name: "autograph_get",
          arguments: { cursor: 0, limit: 20 },
        }),
      ),
      handler(
        mcpRequest({ authorization: "Bearer two" }, "tools/call", {
          name: "autograph_get",
          arguments: { cursor: 0, limit: 20 },
        }),
      ),
    ]);
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(seen.sort()).toEqual(["workspace-one", "workspace-two"]);
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
      tools: Array<{ name: string; title?: string; description?: string }>;
    }>(toolResponse);
    expect(toolResult.tools.map(({ name }) => name).sort()).toEqual(exactTools);
    expect(toolResult.tools.every(({ name }) => !name.startsWith("eve_"))).toBe(
      true,
    );
    expect(
      Object.fromEntries(
        toolResult.tools.map(({ name, title }) => [name, title]),
      ),
    ).toEqual({
      autograph_start: "Start with Autograph App Builder",
      autograph_get: "Check App Builder progress",
      autograph_send: "Send App Builder feedback",
      autograph_respond: "Answer App Builder questions",
      autograph_cancel: "Stop App Builder work",
    });
    expect(
      Object.fromEntries(
        toolResult.tools.map(({ name, description }) => [name, description]),
      ),
    ).toEqual({
      autograph_start:
        "Start a durable app build and return immediately; check progress separately.",
      autograph_get:
        "List recent app builds, or read the next page of one app build's progress and requests.",
      autograph_send:
        "Send additional direction while the current app build is waiting.",
      autograph_respond:
        "Answer the complete outstanding set of App Builder questions in one response.",
      autograph_cancel: "Request cancellation of the active app build.",
    });

    const resourceResult = await mcpResult<{
      resources: Array<{
        name: string;
        title?: string;
        description?: string;
        _meta?: { ui?: unknown };
      }>;
    }>(resourceResponse);
    expect(resourceResult.resources).toContainEqual(
      expect.objectContaining({
        name: "autograph-session",
        title: "Autograph App Builder progress",
        description: "Live progress and requests from Autograph App Builder.",
        _meta: {
          ui: {
            prefersBorder: false,
            csp: {
              connectDomains: [],
              resourceDomains: [],
              frameDomains: ["about:"],
              baseUriDomains: [],
            },
          },
        },
      }),
    );
    const resourceMeta = resourceResult.resources[0]?._meta?.ui;
    expect(McpUiResourceMetaSchema.parse(resourceMeta)).toEqual(resourceMeta);

    const resourceRead = await mcpResult<{
      contents: Array<{ _meta?: { ui?: unknown } }>;
    }>(resourceReadResponse);
    expect(resourceRead.contents).toHaveLength(1);
    expect(resourceRead.contents[0]?._meta?.ui).toEqual(resourceMeta);
    expect(
      McpUiResourceMetaSchema.parse(resourceRead.contents[0]?._meta?.ui),
    ).toEqual(resourceMeta);
  });
});
