import { describe, expect, it, vi } from "vitest";

import type { HostedEveTransport } from "../eve/hosted-service";
import { InMemoryHostedEveStore } from "../eve/hosted-store";
import type { VerifiedHostedClaims } from "../eve/hosted-auth";
import type { EveSessionService } from "../eve/service";
import {
  createAutographMcpHandler,
  createMcpRequestHandler,
  type HostedMcpRuntime,
} from "./request-handler";

const auth = {
  issuer: "https://builder.example.test/api/auth",
  audience: "https://builder.example.test/mcp",
  jwksUrl: "https://builder.example.test/api/auth/jwks",
  algorithm: "ES256" as const,
  resourceUrl: "https://builder.example.test/mcp",
};
const admissionControl = {
  version: 1 as const,
  environment: "preview" as const,
  enforcement: "provider-readback" as const,
  scope: "issuer-audience-workspace-subject" as const,
  startsPerSubjectPerMinute: 10,
  startsPerWorkspacePerMinute: 50,
  maxConcurrentSessionsPerSubject: 2,
  maxActiveSessionsPerWorkspace: 20,
  monthlySpendUsedUsdCents: 0,
  monthlySpendLimitUsdCents: 10_000,
  observedAt: "2033-05-18T03:32:00.000Z",
  expiresAt: "2033-05-18T04:32:00.000Z",
  readbackDigest: `sha256:${"a".repeat(64)}`,
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
    admissionControl,
    now: () => 2_000_000_000_000,
  };
}

function mcpRequest(
  headers: Record<string, string> = {},
  method = "tools/list",
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
      params: {},
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
  if (payload.result === undefined) throw new Error("MCP result was missing.");
  return payload.result;
}

async function toolNames(response: Response): Promise<string[]> {
  const result = await mcpResult<{
    tools?: Array<{ name?: string }>;
  }>(response);
  return (result.tools ?? []).map((tool) => tool.name ?? "").sort();
}

describe("branded public tool mapping", () => {
  it("links each exact public tool to the shared MCP App resource", async () => {
    const handler = createAutographMcpHandler({} as EveSessionService);
    const response = await handler(mcpRequest());
    const result = await mcpResult<{
      tools?: Array<{
        name?: string;
        _meta?: { ui?: { resourceUri?: string } };
      }>;
    }>(response);

    expect((result.tools ?? []).map(({ name }) => name).sort()).toEqual(
      exactTools,
    );
    expect(
      (result.tools ?? [])
        .toSorted((left, right) =>
          (left.name ?? "").localeCompare(right.name ?? ""),
        )
        .map(({ _meta }) => _meta?.ui?.resourceUri),
    ).toEqual(
      Array.from(
        { length: exactTools.length },
        () => "ui://autograph-app-builder/session.html",
      ),
    );
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
});

describe("request-scoped MCP service selection", () => {
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
      mcpRequest({
        authorization: "Bearer token",
      }),
    );
    expect(response.status).toBe(503);
  });

  it("rejects missing and malformed credentials with the same 401 challenge", async () => {
    const verifier = vi.fn(async () => claims());
    const hostedRuntime = runtime();
    hostedRuntime.verifier = { verify: verifier };
    const handler = createMcpRequestHandler({
      environment: { EVE_HOSTED_ADAPTER: "1" },
      hostedRuntime,
    });
    const responses = await Promise.all([
      handler(mcpRequest()),
      handler(mcpRequest({ authorization: "Bearer two tokens" })),
      handler(mcpRequest({ authorization: "Basic token" })),
    ]);
    expect(verifier).not.toHaveBeenCalled();
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain(
        'error="invalid_token"',
      );
      await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    }
  });

  it("maps invalid tokens to 401 and missing session scope to 403", async () => {
    const invalid = createMcpRequestHandler({
      environment: { EVE_HOSTED_ADAPTER: "1" },
      hostedRuntime: runtime({ verifierError: new Error("bad token") }),
    });
    const invalidResponse = await invalid(
      mcpRequest({
        authorization: "Bearer token",
      }),
    );
    expect(invalidResponse.status).toBe(401);

    const insufficient = createMcpRequestHandler({
      environment: { EVE_HOSTED_ADAPTER: "1" },
      hostedRuntime: runtime({
        verifiedClaims: claims({ scopes: ["autograph:get"] }),
      }),
    });
    const insufficientResponse = await insufficient(
      mcpRequest({
        authorization: "Bearer token",
      }),
    );
    expect(insufficientResponse.status).toBe(403);
    expect(insufficientResponse.headers.get("www-authenticate")).toContain(
      'error="insufficient_scope"',
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
      await handlers[0]!(mcpRequest(requestHeaders)),
      await handlers[1]!(mcpRequest(requestHeaders)),
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

  it("binds each hosted request to its own principal and membership check", async () => {
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
        mcpRequest({
          authorization: "Bearer one",
        }),
      ),
      handler(
        mcpRequest({
          authorization: "Bearer two",
        }),
      ),
    ]);
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(await toolNames(one)).toEqual(exactTools);
    expect(await toolNames(two)).toEqual(exactTools);
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
    expect(toolResponse.status).toBe(200);
    expect(resourceResponse.status).toBe(200);

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
        "Read the next page of progress and requests for the current app build.",
      autograph_send:
        "Send additional direction while the current app build is waiting.",
      autograph_respond:
        "Answer the complete outstanding set of App Builder questions in one response.",
      autograph_cancel: "Request cancellation of the active app build.",
    });

    const resourceResult = await mcpResult<{
      resources: Array<{ name: string; title?: string; description?: string }>;
    }>(resourceResponse);
    expect(resourceResult.resources).toContainEqual(
      expect.objectContaining({
        name: "autograph-session",
        title: "Autograph App Builder progress",
        description: "Live progress and requests from Autograph App Builder.",
      }),
    );
  });
});
