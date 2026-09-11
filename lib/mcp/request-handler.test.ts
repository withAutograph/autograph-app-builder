import { McpUiResourceMetaSchema } from "@modelcontextprotocol/ext-apps";
import { describe, expect, it, vi } from "vitest";

import type { VerifiedHostedClaims } from "../eve/hosted-auth";
import type { HostedEveTransport } from "../eve/hosted-service";
import { InMemoryHostedEveStore } from "../eve/hosted-store";
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

function claims(
  input: Partial<VerifiedHostedClaims> = {}
): VerifiedHostedClaims {
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
  async cancel() {
    throw new Error("Transport must not run while listing tools.");
  },
  async get() {
    throw new Error("Transport must not run while listing tools.");
  },
  async respond() {
    throw new Error("Transport must not run while listing tools.");
  },
  async send() {
    throw new Error("Transport must not run while listing tools.");
  },
  async start() {
    throw new Error("Transport must not run while listing tools.");
  },
};

function runtime(
  input: {
    verifiedClaims?: VerifiedHostedClaims;
    verifierError?: Error;
    membership?: (workspaceId: string) => Promise<boolean>;
  } = {}
): HostedMcpRuntime {
  return {
    auth,
    membership: {
      async isMember({ workspaceId }) {
        return input.membership?.(workspaceId) ?? true;
      },
    },
    now: () => 2_000_000_000_000,
    store: new InMemoryHostedEveStore(),
    transport,
    verifier: {
      async verify() {
        if (input.verifierError !== undefined) throw input.verifierError;
        return input.verifiedClaims ?? claims();
      },
    },
  };
}

function mcpRequest(
  headers: Record<string, string> = {},
  method = "tools/list",
  params: Record<string, unknown> = {}
): Request {
  return new Request(auth.resourceUrl, {
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
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

function mcpToolRequest(name: string, args: Record<string, unknown>): Request {
  return new Request(auth.resourceUrl, {
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    method: "POST",
  });
}

async function mcpResult<T>(response: Response): Promise<T> {
  const body = await response.text();
  const data = body
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  const payload = JSON.parse(data ?? body) as { result?: T };
  if (payload.result === undefined) {
    throw new Error(`MCP result was missing: ${body}`);
  }
  return payload.result;
}

async function toolNames(response: Response): Promise<string[]> {
  const result = await mcpResult<{
    tools?: { name?: string }[];
  }>(response);
  return (result.tools ?? []).map((tool) => tool.name ?? "").sort();
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
      async cancel() {
        return result;
      },
      async get(input: Parameters<EveSessionService["get"]>[0]) {
        calls.push({ operation: "get", input });
        return result;
      },
      async list() {
        return { kind: "session_list" as const, cursor: 0, sessions: [] };
      },
      async recoverStart(
        input: Parameters<NonNullable<EveSessionService["recoverStart"]>>[0]
      ) {
        calls.push({ operation: "recoverStart", input });
        return result;
      },
      async respond() {
        return result;
      },
      async send() {
        return result;
      },
      async start(input: Parameters<EveSessionService["start"]>[0]) {
        calls.push({ operation: "start", input });
        return result;
      },
    } satisfies EveSessionService;
    let redeemed = false;
    const bindSession = vi.fn(async () => {
      redeemed = true;
    });
    const wrapped = withHostedBuilderHandoffs({
      handoffs: {
        bindSession,
        async recheckRepositoryAccess({ principal, repository }) {
          calls.push({
            operation: "recheckRepositoryAccess",
            input: { principal, repository },
          });
          return { status: "authorization-required", action: "update" };
        },
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
            "Build the server-owned handoff. Call resolve_repository_access before repository work.",
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
      async cancel() {
        return result;
      },
      async get() {
        return result;
      },
      async list() {
        return { kind: "session_list" as const, cursor: 0, sessions: [] };
      },
      async respond() {
        return result;
      },
      async send() {
        return result;
      },
      start,
    } satisfies EveSessionService;
    const wrapped = withHostedBuilderHandoffs({
      handoffs: {
        bindSession,
        async recheckRepositoryAccess() {
          return { status: "provider-unavailable" };
        },
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
      })
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
    const start = vi.fn(async () => result);
    const bindSession = vi.fn();
    const recheckRepositoryAccess = vi.fn(async () => ({
      status: "ready" as const,
    }));
    const service = {
      async cancel() {
        return result;
      },
      async get() {
        return result;
      },
      async list() {
        return { kind: "session_list" as const, cursor: 0, sessions: [] };
      },
      async respond() {
        return result;
      },
      async send() {
        return result;
      },
      start,
    } satisfies EveSessionService;
    const wrapped = withHostedBuilderHandoffs({
      handoffs: {
        bindSession,
        recheckRepositoryAccess,
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
      })
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

    expect((result.tools ?? []).map(({ name }) => name).sort()).toEqual(
      exactTools
    );
    expect(
      (result.tools ?? []).every(
        ({ _meta }) => _meta?.ui?.resourceUri === undefined
      )
    ).toBe(true);
    expect(
      result.tools?.find(({ name }) => name === "autograph_respond")?._meta?.ui
        ?.visibility
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
      async cancel(input) {
        calls.push({ operation: "cancel", input });
        return result;
      },
      async get(input) {
        calls.push({ operation: "get", input });
        return result;
      },
      async list(input) {
        calls.push({ operation: "list", input });
        return { kind: "session_list", cursor: 0, sessions: [] };
      },
      async respond(input) {
        calls.push({ operation: "respond", input });
        return result;
      },
      async send(input) {
        calls.push({ operation: "send", input });
        return result;
      },
      async start(input) {
        calls.push({ operation: "start", input });
        return result;
      },
    };
    const handler = createAutographMcpHandler(service);
    const invocations = [
      [
        "autograph_start",
        { clientRequestId: "start-one", prompt: "Build an app" },
      ],
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
      const response = await handler(mcpToolRequest(name, args));
      expect(response.status).toBe(200);
      const callResult = await mcpResult<{ structuredContent?: unknown }>(
        response
      );
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
      cancel: vi.fn(async () => sessionResult),
      get: vi.fn(async () => sessionResult),
      list: vi.fn(async () => listed),
      respond: vi.fn(async () => sessionResult),
      send: vi.fn(async () => sessionResult),
      start: vi.fn(async () => sessionResult),
    } satisfies EveSessionService;
    const handler = createAutographMcpHandler(service);
    const response = await handler(
      mcpToolRequest("autograph_get", { cursor: 0, limit: 25 })
    );
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
        digest:
          "e8385bab4b1d1c12641b37bdeec4e359c40a6f30016f724ec61b5b8b20ca8c0f",
        mediaType: "text/html" as const,
        path: "prototype/vendor-onboarding/index.html",
        revision: "b".repeat(64),
      },
      sessionId: "session-one",
      status: "completed" as const,
    };
    const service = {
      cancel: vi.fn(async () => result),
      get: vi.fn(async () => result),
      list: vi.fn(async () => ({
        kind: "session_list" as const,
        cursor: 0,
        sessions: [],
      })),
      respond: vi.fn(async () => result),
      send: vi.fn(async () => result),
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
      })
    );
    const callResult = await mcpResult<{
      structuredContent: Omit<typeof result, "prototype"> & {
        prototype: typeof result.prototype & { previewUrl: string };
      };
      _meta?: unknown;
    }>(response);

    expect(callResult.structuredContent.prototype.previewUrl).toBe(
      `https://builder.example.test/preview/session-one/${result.prototype.digest}`
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
      tools: {
        name: string;
        _meta?: {
          securitySchemes?: Array<{ type: string; scopes?: string[] }>;
        };
      }[];
    }>(await handler(mcpRequest({}, "tools/list")));
    expect(discovery.tools.map(({ name }) => name).sort()).toEqual(exactTools);
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
      })
    );
    expect(protectedCall.status).toBe(200);
    const authResult = await mcpResult<{
      isError: boolean;
      _meta: { "mcp/www_authenticate": string[] };
      structuredContent: { error: { code: string } };
    }>(protectedCall);
    expect(authResult.isError).toBe(true);
    expect(authResult.structuredContent.error.code).toBe(
      "authentication_required"
    );
    expect(authResult._meta["mcp/www_authenticate"][0]).toContain(
      'error="invalid_token"'
    );
    expect(authResult._meta["mcp/www_authenticate"][0]).toContain(
      'error_description="Sign in to Autograph App Builder to continue"'
    );
    expect(authResult._meta["mcp/www_authenticate"][0]).toContain(
      'scope="autograph:session autograph:start autograph:get autograph:send autograph:respond autograph:cancel"'
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
    const response = await handler(
      mcpRequest({ authorization: "Bearer token" }, "tools/call")
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
          arguments: { cursor: 0, limit: 20 },
          name: "autograph_get",
        })
      ),
      handler(
        mcpRequest({ authorization: "Bearer two tokens" }, "tools/call", {
          arguments: { cursor: 0, limit: 20 },
          name: "autograph_get",
        })
      ),
      handler(
        mcpRequest({ authorization: "Basic token" }, "tools/call", {
          arguments: { cursor: 0, limit: 20 },
          name: "autograph_get",
        })
      ),
    ]);
    expect(verifier).not.toHaveBeenCalled();
    for (const response of responses) {
      expect(response.status).toBe(200);
      const result = await mcpResult<{
        _meta: { "mcp/www_authenticate": string[] };
      }>(response);
      expect(result._meta["mcp/www_authenticate"][0]).toContain(
        'error="invalid_token"'
      );
      expect(result._meta["mcp/www_authenticate"][0]).toContain(
        'scope="autograph:session autograph:start autograph:get autograph:send autograph:respond autograph:cancel"'
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
      })
    );
    expect(invalidResponse.status).toBe(200);
    expect(
      (
        await mcpResult<{
          _meta: { "mcp/www_authenticate": string[] };
        }>(invalidResponse)
      )._meta["mcp/www_authenticate"][0]
    ).toContain('error="invalid_token"');

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
      })
    );
    expect(insufficientResponse.status).toBe(200);
    const insufficientResult = await mcpResult<{
      _meta: { "mcp/www_authenticate": string[] };
    }>(insufficientResponse);
    expect(insufficientResult._meta["mcp/www_authenticate"][0]).toContain(
      'error="insufficient_scope"'
    );
    expect(insufficientResult._meta["mcp/www_authenticate"][0]).toContain(
      'scope="autograph:session autograph:start autograph:get autograph:send autograph:respond autograph:cancel"'
    );
  });

  it("makes denied and membership-error workspaces indistinguishable", async () => {
    const requestHeaders = { authorization: "Bearer token" };
    const handlers = [
      createMcpRequestHandler({
        environment: { EVE_HOSTED_ADAPTER: "1" },
        hostedRuntime: runtime({
          membership: async () => false,
          verifiedClaims: claims({ workspaceId: "workspace-two" }),
        }),
      }),
      createMcpRequestHandler({
        environment: { EVE_HOSTED_ADAPTER: "1" },
        hostedRuntime: runtime({
          membership: async () => {
            throw new Error("store unavailable");
          },
          verifiedClaims: claims({ workspaceId: "workspace-two" }),
        }),
      }),
    ];
    const responses = [
      await handlers[0]!(mcpRequest(requestHeaders, "tools/call")),
      await handlers[1]!(mcpRequest(requestHeaders, "tools/call")),
    ];
    const projections = await Promise.all(
      responses.map(async (response) => ({
        body: await response.json(),
        cache: response.headers.get("cache-control"),
        status: response.status,
      }))
    );
    expect(
      new Set(projections.map((projection) => JSON.stringify(projection))).size
    ).toBe(1);
    expect(projections[0]).toEqual({
      body: { error: "not_found" },
      cache: "no-store",
      status: 404,
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
          arguments: { cursor: 0, limit: 20 },
          name: "autograph_get",
        })
      ),
      handler(
        mcpRequest({ authorization: "Bearer two" }, "tools/call", {
          arguments: { cursor: 0, limit: 20 },
          name: "autograph_get",
        })
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
      })
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
    expect(toolResult.tools.map(({ name }) => name).sort()).toEqual(exactTools);
    expect(toolResult.tools.every(({ name }) => !name.startsWith("eve_"))).toBe(
      true
    );
    expect(
      Object.fromEntries(
        toolResult.tools.map(({ name, title }) => [name, title])
      )
    ).toEqual({
      autograph_cancel: "Stop App Builder work",
      autograph_get: "Check App Builder progress",
      autograph_respond: "Answer App Builder questions",
      autograph_send: "Send App Builder feedback",
      autograph_start: "Start with Autograph App Builder",
    });
    expect(
      Object.fromEntries(
        toolResult.tools.map(({ name, description }) => [name, description])
      )
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
      Object.fromEntries(
        toolResult.tools.map(({ name, annotations }) => [name, annotations])
      )
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
      })
    );
    const resourceMeta = resourceResult.resources[0]?._meta?.ui;
    expect(McpUiResourceMetaSchema.parse(resourceMeta)).toEqual(resourceMeta);

    const resourceRead = await mcpResult<{
      contents: { _meta?: { ui?: unknown } }[];
    }>(resourceReadResponse);
    expect(resourceRead.contents).toHaveLength(1);
    expect(resourceRead.contents[0]?._meta?.ui).toEqual(resourceMeta);
    expect(
      McpUiResourceMetaSchema.parse(resourceRead.contents[0]?._meta?.ui)
    ).toEqual(resourceMeta);
  });
});
