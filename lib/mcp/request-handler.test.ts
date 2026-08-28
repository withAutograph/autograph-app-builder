import { describe, expect, it, vi } from "vitest";

import type { HostedEveTransport } from "../eve/hosted-service";
import { InMemoryHostedEveStore } from "../eve/hosted-store";
import type { VerifiedHostedClaims } from "../eve/hosted-auth";
import {
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
  "eve_cancel",
  "eve_get",
  "eve_respond",
  "eve_send",
  "eve_start",
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
      "eve:session",
      "eve:start",
      "eve:get",
      "eve:send",
      "eve:respond",
      "eve:cancel",
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
        verifiedClaims: claims({ scopes: ["eve:get"] }),
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

  it("brands public MCP discovery without renaming its protocol surface", async () => {
    const handler = createMcpRequestHandler({ environment: {} });
    const toolResponse = await handler(mcpRequest());
    const resourceResponse = await handler(mcpRequest({}, "resources/list"));
    expect(toolResponse.status).toBe(200);
    expect(resourceResponse.status).toBe(200);

    const toolResult = await mcpResult<{
      tools: Array<{ name: string; title?: string; description?: string }>;
    }>(toolResponse);
    expect(toolResult.tools.map(({ name }) => name).sort()).toEqual(exactTools);
    expect(
      Object.fromEntries(
        toolResult.tools.map(({ name, title }) => [name, title]),
      ),
    ).toEqual({
      eve_start: "Start App Builder work",
      eve_get: "Get App Builder session",
      eve_send: "Send App Builder follow-up",
      eve_respond: "Respond to App Builder request",
      eve_cancel: "Cancel App Builder turn",
    });
    for (const tool of toolResult.tools) {
      expect(tool.description).not.toMatch(/\bEve\b/u);
    }
    expect(
      toolResult.tools.find(({ name }) => name === "eve_respond")?.description,
    ).toContain("one complete outstanding App Builder input batch atomically");

    const resourceResult = await mcpResult<{
      resources: Array<{ name: string; title?: string; description?: string }>;
    }>(resourceResponse);
    expect(resourceResult.resources).toContainEqual(
      expect.objectContaining({
        name: "eve-session",
        title: "Autograph App Builder session",
        description: "A stable live view of Autograph App Builder work.",
      }),
    );
  });
});
