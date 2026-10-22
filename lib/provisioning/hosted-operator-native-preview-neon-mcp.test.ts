/* oxlint-disable promise/avoid-new -- Owned HTTPS fixtures adapt callback server/request APIs to promises. */
// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { createMCPClient } from "@ai-sdk/mcp";
import { connectAuthProvider } from "@vercel/connect/mcp";
import { beforeAll, afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPreviewNeonMcpReader } from "./hosted-operator-native-preview-neon-mcp";
import type { PreviewNeonMcpDependencies } from "./hosted-operator-native-preview-neon-mcp";
import type { HostedOperatorContext } from "./hosted-operator-service";

import { HostedOperatorError } from "./hosted-operator-contract";
import type {
  HostedOperatorConsentDiagnostic,
  HostedOperatorConsentDiagnosticSink,
} from "./hosted-operator-consent-diagnostic";

const scope = {
  branchId: "br-synthetic",
  endpointId: "ep-synthetic",
  hostname: "ep-synthetic.us-east-1.aws.neon.tech",
  maintenanceDatabase: "neondb",
  maintenanceRole: "bootstrap_owner",
  projectId: "native-project",
};
const context: HostedOperatorContext = {
  authority: {
    audience: "https://builder.example/mcp",
    issuer: "https://builder.example/api/auth",
    ownerUserId: "owner",
    workspaceId: "workspace",
  },
  target: {
    appId: "spend-review",
    branch: "owned-preview",
    environment: "preview",
    installationId: "owner-vercel-connection",
    projectId: "prj-app",
    scopeId: "team-owner",
    scopeType: "team",
    sessionId: "original-session",
  },
};
const configuration = {
  connector: "oauth/neon-fixture",
  nativeStore: {
    configurationId: "icfg-native",
    resourceId: "store-native",
    sourceProjectId: "prj-source",
  },
  operator: {
    audience: "https://vercel.com/team",
    environment: "preview" as const,
    issuer: "https://oidc.vercel.com/team",
    ownerId: "team-owner",
    projectId: "prj-operator",
  },
};
let scratch = "";
let origin = "";
let server: ReturnType<typeof createServer>;
let provenance = "schema-only";
let revoked = false;
let wrongEndpoint = false;
let wrongCredential = false;
let invalidMetadataTool = "";
type NeonFixtureMetadata = z.infer<ReturnType<typeof z.json>>;
const toolResponseText = (name: string, value: NeonFixtureMetadata) => {
  if (name === "get_connection_string" && name !== invalidMetadataTool) {
    const credential = z
      .object({
        uri: z.string(),
        projectId: z.string(),
        databaseName: z.string(),
        roleName: z.string(),
        branchId: z.string(),
        computeId: z.string(),
      })
      .parse(value);
    return [
      "Connection string details:",
      `URI: ${credential.uri}`,
      `Project ID: ${credential.projectId}`,
      `Database: ${credential.databaseName}`,
      `Role: ${credential.roleName}`,
      `Branch ID: ${credential.branchId}`,
      `Compute ID: ${credential.computeId}`,
      "",
      "You can use this connection string with any PostgreSQL client to connect to your Neon database.",
    ].join("\n");
  }
  return JSON.stringify(name === invalidMetadataTool ? {} : value);
};
const called: { name: string; arguments: Record<string, string> }[] = [];
const projectOidc = "fixture-project-oidc";
const privateMcpBearer = "fixture-private-owner-token";
const uri = `postgresql://bootstrap_owner:fixture-private-password@${scope.hostname}/neondb?sslmode=require`;
beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "owned-neon-mcp-"));
  const certificate = // oxlint-disable-next-line sonarjs/no-os-command-from-path -- System OpenSSL generates only an owned disposable TLS fixture key.
    spawnSync(
      "/usr/bin/openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        path.join(scratch, "key.pem"),
        "-out",
        path.join(scratch, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
      ],
      { stdio: "ignore" },
    );
  if (certificate.status !== 0) {
    throw new Error("Owned TLS fixture failed");
  }
  server = createServer(
    {
      cert: await readFile(path.join(scratch, "cert.pem")),
      key: await readFile(path.join(scratch, "key.pem")),
    },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        chunks.push(Buffer.from(chunk));
      });
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/token") {
          if (revoked || req.headers.authorization !== `Bearer ${projectOidc}`) {
            res.writeHead(403);
            res.end(JSON.stringify({ error: "revoked" }));
            return;
          }
          res.end(
            JSON.stringify({
              connector: { id: "scl_fixture", type: "oauth", uid: configuration.connector },
              expiresAt: Date.now() + 60_000,
              token: privateMcpBearer,
            }),
          );
          return;
        }
        if (req.headers.authorization !== `Bearer ${privateMcpBearer}`) {
          res.writeHead(401);
          res.end("{}");
          return;
        }
        if (req.method === "GET") {
          res.writeHead(405);
          res.end("{}");
          return;
        }
        if (req.method === "DELETE") {
          res.writeHead(204);
          res.end();
          return;
        }
        const message = z
          .object({
            id: z.union([z.string(), z.number()]).optional(),
            method: z.string(),
            params: z.json().optional(),
          })
          .parse(JSON.parse(Buffer.concat(chunks).toString()));
        if (message.id === undefined) {
          res.writeHead(202);
          res.end();
          return;
        }
        if (message.method === "initialize") {
          res.end(
            JSON.stringify({
              id: message.id,
              jsonrpc: "2.0",
              result: {
                capabilities: { tools: {} },
                protocolVersion: "2025-11-25",
                serverInfo: { name: "owned-neon-fixture", version: "1" },
              },
            }),
          );
          return;
        }
        if (message.method !== "tools/call") {
          res.writeHead(400);
          res.end("{}");
          return;
        }
        const params = z
          .object({ arguments: z.record(z.string(), z.string()), name: z.string() })
          .parse(message.params);
        called.push(params);
        const { name } = params;
        let value;
        if (name === "describe_project") {
          value = { id: scope.projectId };
        } else if (name === "get_branch") {
          value = {
            default: false,
            id: scope.branchId,
            init_source: provenance,
            project_id: scope.projectId,
          };
        } else if (name === "get_postgres_endpoint") {
          value = {
            branch_id: wrongEndpoint ? "br-other" : scope.branchId,
            host: scope.hostname,
            id: scope.endpointId,
            project_id: scope.projectId,
            type: "read_write",
          };
        } else if (name === "get_postgres_database") {
          value = { branch_id: scope.branchId, name: scope.maintenanceDatabase };
        } else if (name === "get_postgres_role") {
          value = { branch_id: scope.branchId, name: scope.maintenanceRole };
        } else if (name === "get_connection_string") {
          value = {
            branchId: scope.branchId,
            computeId: scope.endpointId,
            databaseName: scope.maintenanceDatabase,
            projectId: scope.projectId,
            roleName: wrongCredential ? "other_role" : scope.maintenanceRole,
            uri: uri.replace(".", "-pooler."),
          };
        } else {
          res.writeHead(400);
          res.end("{}");
          return;
        }
        res.end(
          JSON.stringify({
            id: message.id,
            jsonrpc: "2.0",
            result: {
              content: [{ text: toolResponseText(name, value), type: "text" }],
            },
          }),
        );
      });
    },
  );
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node socket API returns a Unix path or a TCP address, not model input.
  if (address === null || typeof address === "string") {
    throw new Error("Owned fixture port failed");
  }
  origin = `https://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await rm(scratch, { force: true, recursive: true });
});
beforeEach(() => {
  provenance = "schema-only";
  revoked = false;
  wrongEndpoint = false;
  wrongCredential = false;
  invalidMetadataTool = "";
  called.length = 0;
});
afterEach(() => vi.unstubAllGlobals());
// Source-injected TLS transport only routes the official Connect token endpoint and the owned MCP endpoint to a disposable HTTPS server.
const fixtureFetch: typeof fetch = async (input, init) => {
  let target: string;
  if (input instanceof Request) {
    target = input.url;
  } else if (input instanceof URL) {
    target = input.href;
  } else {
    target = input;
  }
  const requested = new URL(target);
  let url = requested;
  if (
    requested.origin === "https://api.vercel.com" &&
    requested.pathname.startsWith("/v1/connect/token/")
  ) {
    url = new URL("/token", origin);
  } else if (requested.origin !== origin) {
    throw new Error("Unexpected private transport target");
  }
  return await new Promise<Response>((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        headers: Object.fromEntries(new Headers(init?.headers)),
        method: init?.method ?? "GET",
        rejectUnauthorized: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          resolve(
            new Response(Uint8Array.from(Buffer.concat(chunks)), {
              headers: { "content-type": "application/json" },
              status: response.statusCode ?? 500,
            }),
          );
        });
      },
    );
    request.on("error", reject);
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SDK HTTP transport serializes these fixture JSON-RPC bodies as strings.
    if (typeof init?.body === "string") {
      request.write(init.body);
    }
    request.end();
  });
};
const fixture = (
  ioOverrides: Partial<NonNullable<PreviewNeonMcpDependencies["io"]>> = {},
  diagnosticSink?: HostedOperatorConsentDiagnosticSink,
  useLocalPlanningOwner = false,
  useLocalApprovedOwner = false,
) => {
  vi.stubGlobal("fetch", fixtureFetch);
  const events: string[] = [];
  const planningOwner = vi.fn(async () => {
    events.push("local-owner");
    await Promise.resolve();
  });
  const approved = vi.fn(async () => {
    events.push("approved-scope");
    await Promise.resolve();
  });
  const approvedOwner = vi.fn(async () => {
    events.push("approved-owner");
    await Promise.resolve();
  });
  const planning = vi.fn(async () => {
    events.push("provider-scope");
    await Promise.resolve();
  });
  const owner = vi.fn(async () => {
    events.push("native-store");
    await Promise.resolve();
    return {
      configurationId: configuration.nativeStore.configurationId,
      neonProjectId: scope.projectId,
      ownerId: "team-owner",
      resourceId: configuration.nativeStore.resourceId,
      vercelProjectId: configuration.nativeStore.sourceProjectId,
    };
  });
  const close = vi.fn(async () => {
    await Promise.resolve();
  });
  const io: NonNullable<PreviewNeonMcpDependencies["io"]> = {
    createAuthProvider: (...args) => {
      const broker = connectAuthProvider(...args);
      return {
        ...broker,
        tokens: async () => {
          events.push("token-start");
          const tokens = await broker.tokens();
          events.push("token-end");
          return tokens;
        },
      };
    },
    createClient: async (config) => {
      if (!("url" in config.transport)) {
        throw new Error("Unexpected fixture transport");
      }
      expect(new URL(config.transport.url).searchParams.get("projectId")).toBe(scope.projectId);
      expect(config.transport.redirect).toBe("error");
      const client = await createMCPClient({
        ...config,
        transport: { ...config.transport, fetch: fixtureFetch, url: `${origin}/mcp` },
      });
      close.mockImplementation(async () => {
        await client.close();
      });
      return {
        callTool: async (
          input: Parameters<Awaited<ReturnType<typeof createMCPClient>>["callTool"]>[0],
        ) => {
          events.push(`tool-start:${input.name}`);
          const result = await client.callTool(input);
          events.push(`tool-end:${input.name}`);
          return result;
        },
        close,
      };
    },
    getOidc: async () => {
      events.push("oidc-start");
      return await Promise.resolve(projectOidc);
    },
    readSqlIdentity: async (privateUrl) => {
      events.push("sql-start");
      expect(privateUrl).toContain("sslmode=verify-full");
      const identity = await Promise.resolve({
        database: scope.maintenanceDatabase,
        role: scope.maintenanceRole,
      });
      events.push("sql-end");
      return identity;
    },
    verifyOidc: async () => {
      events.push("oidc-end");
      await Promise.resolve();
    },
  };
  return {
    approved,
    approvedOwner,
    close,
    events,
    owner,
    planningOwner,
    planning,
    reader: createPreviewNeonMcpReader({
      assertApprovedScope: approved,
      ...(useLocalApprovedOwner ? { assertApprovedOwner: approvedOwner } : {}),
      assertPlanningScope: planning,
      assertPlanningOwner: useLocalPlanningOwner ? planningOwner : undefined,
      configuration,
      diagnosticSink,
      io: { ...io, ...ioOverrides },
      readCurrentOwnerNativeStore: owner,
    }),
  };
};
describe("private Neon reader failure diagnostics", () => {
  it.each([
    ["describe_project", "neon_project_metadata"],
    ["get_postgres_endpoint", "neon_endpoint_metadata"],
    ["get_postgres_database", "neon_database_metadata"],
    ["get_postgres_role", "neon_role_metadata"],
    ["get_connection_string", "neon_connection_credential"],
  ])("classifies %s parsing without changing public errors or cleanup", async (tool, stage) => {
    const diagnostics: HostedOperatorConsentDiagnostic[] = [];
    invalidMetadataTool = tool;
    const f = fixture({}, (event) => {
      diagnostics.push(event);
    });
    const operation =
      tool === "get_connection_string"
        ? f.reader.withMaintenanceCredential(context, scope, async () => {})
        : f.reader.inspectPlanningTarget(context, scope);
    await expect(operation).rejects.toThrow(
      /^Protected Preview Neon MCP credential is unavailable\.$/u,
    );
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ planningFailure: { stage, errorClass: "validation_error" } }),
      ]),
    );
    expect(f.close).toHaveBeenCalledTimes(1);
    if (tool !== "get_connection_string") {
      expect(called.some((call) => call.name === "get_connection_string")).toBe(false);
    }
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain(uri);
    expect(serialized).not.toContain(projectOidc);
    expect(serialized).not.toContain(privateMcpBearer);
    expect(serialized).not.toContain(context.target.sessionId);
    expect(serialized).not.toContain(scope.hostname);
  });

  it("labels configuration parsing and denied current ownership before tools", async () => {
    const diagnostics: HostedOperatorConsentDiagnostic[] = [];
    const f = fixture({}, (event) => {
      diagnostics.push(event);
    });
    await expect(
      f.reader.inspectPlanningTarget(context, { ...scope, projectId: "" }),
    ).rejects.toThrow(/^Protected Preview Neon MCP credential is unavailable\.$/u);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          planningFailure: { stage: "neon_configuration", errorClass: "validation_error" },
        }),
      ]),
    );
    f.planning.mockRejectedValue(new HostedOperatorError("authorization_required"));
    await expect(f.reader.inspectPlanningTarget(context, scope)).rejects.toThrow(
      /^authorization_required$/u,
    );
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          planningFailure: {
            stage: "neon_owner_guard",
            errorClass: "operator_error",
            code: "authorization_required",
          },
        }),
      ]),
    );
    expect(f.close).not.toHaveBeenCalled();
    expect(called).toEqual([]);
  });

  it("reports a plain client error privately and preserves the opaque original error", async () => {
    const diagnostics: HostedOperatorConsentDiagnostic[] = [];
    const f = fixture(
      {
        createClient: async () => {
          await Promise.resolve();
          throw new Error(`private client failure ${privateMcpBearer}`);
        },
      },
      (event) => {
        diagnostics.push(event);
      },
    );
    await expect(f.reader.inspectPlanningTarget(context, scope)).rejects.toThrow(
      /^Protected Preview Neon MCP credential is unavailable\.$/u,
    );
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          planningFailure: { stage: "neon_mcp_client", errorClass: "unexpected" },
        }),
      ]),
    );
    expect(JSON.stringify(diagnostics)).not.toContain(privateMcpBearer);
    expect(f.close).not.toHaveBeenCalled();
    expect(called).toEqual([]);
  });

  it("labels provider authorization and OIDC failure without exposing their errors", async () => {
    const diagnostics: HostedOperatorConsentDiagnostic[] = [];
    const sink: HostedOperatorConsentDiagnosticSink = (event) => {
      diagnostics.push(event);
    };
    const denied = fixture(
      {
        createAuthProvider: () => {
          throw new HostedOperatorError("authorization_required");
        },
      },
      sink,
    );
    await expect(denied.reader.inspectPlanningTarget(context, scope)).rejects.toThrow(
      /^authorization_required$/u,
    );
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          planningFailure: {
            stage: "neon_connect_broker",
            errorClass: "operator_error",
            code: "authorization_required",
          },
        }),
      ]),
    );
    const oidc = fixture(
      {
        getOidc: async () => {
          await Promise.resolve();
          throw new Error(projectOidc);
        },
      },
      sink,
    );
    await expect(oidc.reader.inspectPlanningTarget(context, scope)).rejects.toThrow(
      /^Protected Preview Neon MCP credential is unavailable\.$/u,
    );
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          planningFailure: { stage: "neon_oidc", errorClass: "unexpected" },
        }),
      ]),
    );
    expect(JSON.stringify(diagnostics)).not.toContain(projectOidc);
    expect(called).toEqual([]);
  });

  it("keeps branch provenance rejection and cleanup unchanged", async () => {
    provenance = "parent-data";
    const diagnostics: HostedOperatorConsentDiagnostic[] = [];
    const f = fixture({}, (event) => {
      diagnostics.push(event);
    });
    await expect(f.reader.inspectPlanningTarget(context, scope)).rejects.toThrow(
      /^Protected Preview Neon MCP credential is unavailable\.$/u,
    );
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          planningFailure: { stage: "neon_branch_metadata", errorClass: "unexpected" },
        }),
      ]),
    );
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(called.some((call) => call.name === "get_connection_string")).toBe(false);
  });

  it("preserves the original reader failure when the diagnostic sink throws", async () => {
    const f = fixture(
      {
        createClient: async () => {
          await Promise.resolve();
          throw new Error("private client failure");
        },
      },
      () => {
        throw new Error("private sink failure");
      },
    );
    await expect(f.reader.inspectPlanningTarget(context, scope)).rejects.toThrow(
      /^Protected Preview Neon MCP credential is unavailable\.$/u,
    );
    expect(called).toEqual([]);
  });
});

describe("metadata owner observation boundaries", () => {
  it("freshly checks full provider scope around each observation and local ownership around every tool and token", async () => {
    const f = fixture({}, undefined, true);
    await expect(f.reader.inspectPlanningTarget(context, scope)).resolves.toEqual({
      initSource: "schema-only",
      scope,
    });
    expect(f.planning).toHaveBeenCalledTimes(2);
    expect(f.owner).toHaveBeenCalledTimes(2);
    expect(f.events.slice(0, 2)).toEqual(["provider-scope", "native-store"]);
    expect(f.events.slice(-2)).toEqual(["provider-scope", "native-store"]);
    // Connect can overlap token and OIDC lifetimes. Ownership brackets each
    // operation, while unrelated operations may interleave between those guards.
    const starts = f.events.flatMap((event, index) => {
      if (event.startsWith("tool-start:")) {
        return [{ operation: event.slice("tool-start:".length), index }];
      }
      if (event === "token-start") {
        return [{ operation: "token", index }];
      }
      if (event === "oidc-start") {
        return [{ operation: "oidc", index }];
      }
      return [];
    });
    for (const { operation, index } of starts) {
      const end =
        operation === "token" || operation === "oidc"
          ? `${operation}-end`
          : `tool-end:${operation}`;
      const endIndex = f.events.indexOf(end, index + 1);
      expect(endIndex).toBeGreaterThan(index);
      expect(f.events.slice(0, index)).toContain("local-owner");
      expect(f.events.slice(endIndex + 1)).toContain("local-owner");
    }
    expect(f.events).toContain("token-start");
    expect(f.events).toContain("oidc-start");
    expect(f.planningOwner).toHaveBeenCalledWith(context, scope, configuration.nativeStore);
    expect(f.approved).not.toHaveBeenCalled();
    expect(called.some((call) => call.name === "get_connection_string")).toBe(false);
    await f.reader.inspectPlanningTarget(context, scope);
    expect(f.planning).toHaveBeenCalledTimes(4);
    expect(f.owner).toHaveBeenCalledTimes(4);
  });

  it("denies metadata when final provider ownership is revoked", async () => {
    const f = fixture({}, undefined, true);
    f.planning
      .mockImplementationOnce(async () => {
        await Promise.resolve();
      })
      .mockRejectedValueOnce(new Error("revoked"));
    await expect(f.reader.inspectPlanningTarget(context, scope)).rejects.toThrow(
      /^Protected Preview Neon MCP credential is unavailable\.$/u,
    );
    expect(called.map((call) => call.name)).toContain("get_postgres_role");
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("denies metadata when the final native binding changes", async () => {
    const f = fixture({}, undefined, true);
    f.owner
      .mockResolvedValueOnce({
        configurationId: configuration.nativeStore.configurationId,
        neonProjectId: scope.projectId,
        ownerId: "team-owner",
        resourceId: configuration.nativeStore.resourceId,
        vercelProjectId: configuration.nativeStore.sourceProjectId,
      })
      .mockRejectedValueOnce(new Error("binding revoked"));
    await expect(f.reader.inspectPlanningTarget(context, scope)).rejects.toThrow();
    expect(called.map((call) => call.name)).toContain("get_postgres_role");
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("denies a revoked local owner before obtaining tokens or tools", async () => {
    const f = fixture({}, undefined, true);
    f.planningOwner.mockRejectedValue(new Error("revoked"));
    await expect(f.reader.inspectPlanningTarget(context, scope)).rejects.toThrow();
    expect(f.planning).toHaveBeenCalledTimes(1);
    expect(called).toEqual([]);
    expect(f.events).not.toContain("token-start");
    expect(f.events).not.toContain("oidc-start");
  });

  it("denies metadata when local ownership is revoked during a tool call", async () => {
    const f = fixture({}, undefined, true);
    f.planningOwner.mockImplementation(async () => {
      await Promise.resolve();
      if (called.some((call) => call.name === "get_postgres_role")) {
        throw new Error("revoked during observation");
      }
    });
    await expect(f.reader.inspectPlanningTarget(context, scope)).rejects.toThrow();
    expect(called.at(-1)?.name).toBe("get_postgres_role");
    expect(f.planning).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it.each(["token-end", "oidc-end"])(
    "denies metadata when local ownership is revoked before returning from %s",
    async (boundary) => {
      const f = fixture({}, undefined, true);
      f.planningOwner.mockImplementation(async () => {
        await Promise.resolve();
        if (f.events.includes(boundary)) {
          throw new Error("revoked during private credential observation");
        }
      });
      await expect(f.reader.inspectPlanningTarget(context, scope)).rejects.toThrow(
        /^Protected Preview Neon MCP credential is unavailable\.$/u,
      );
      expect(f.events).toContain(boundary);
      expect(called).toEqual([]);
      expect(f.planning).toHaveBeenCalledTimes(1);
    },
  );

  it("retains approved scope and native binding checks for credential acquisition", async () => {
    const f = fixture({}, undefined, true);
    f.planningOwner.mockRejectedValue(new Error("metadata guard cannot grant credentials"));
    await expect(
      f.reader.withMaintenanceCredential(
        context,
        scope,
        async () => await Promise.resolve("ready"),
      ),
    ).resolves.toBe("ready");
    expect(f.planningOwner).not.toHaveBeenCalled();
    expect(f.planning).not.toHaveBeenCalled();
    expect(f.approved.mock.calls.length).toBeGreaterThan(2);
    expect(f.owner).toHaveBeenCalledTimes(f.approved.mock.calls.length);
    expect(called.at(-1)?.name).toBe("get_connection_string");
  });
});

describe("private Preview Neon OAuth MCP credentials", () => {
  it("reads planning metadata through the actual broker without an approved SQL effect or URI acquisition", async () => {
    const f = fixture();
    expect(await f.reader.inspectPlanningTarget(context, scope)).toEqual({
      initSource: "schema-only",
      scope,
    });
    expect(f.planning).toHaveBeenCalled();
    expect(f.approved).not.toHaveBeenCalled();
    expect(called.map((value) => value.name)).toEqual([
      "describe_project",
      "get_branch",
      "get_postgres_endpoint",
      "get_postgres_database",
      "get_postgres_role",
    ]);
  });
  it("denies planning when actual current-owner scope is revoked before tools", async () => {
    const f = fixture();
    f.planning.mockRejectedValue(new Error("revoked"));
    await expect(f.reader.inspectPlanningTarget(context, scope)).rejects.toThrow();
    expect(called).toHaveLength(0);
    expect(f.approved).not.toHaveBeenCalled();
  });

  it("uses actual Connect authProvider and MCP HTTPS client with exact private named tool arguments", async () => {
    const f = fixture();
    const consume = vi.fn(async (material: { maintenanceUrl: string }) => {
      expect(material.maintenanceUrl).toContain("fixture-private-password");
      return await Promise.resolve("private-ready");
    });
    expect(await f.reader.withMaintenanceCredential(context, scope, consume)).toBe("private-ready");
    expect(called.map((value) => value.name)).toEqual([
      "describe_project",
      "get_branch",
      "get_postgres_endpoint",
      "get_postgres_database",
      "get_postgres_role",
      "get_connection_string",
    ]);
    expect(called.at(-1)?.arguments).toEqual({
      branch_id: scope.branchId,
      compute_id: scope.endpointId,
      database_name: scope.maintenanceDatabase,
      project_id: scope.projectId,
      role_name: scope.maintenanceRole,
    });
  });
  it.each(["parent-data", "import", "empty"])(
    "denies observed unsafe provenance %s before privileged credential acquisition",
    async (source) => {
      provenance = source;
      const f = fixture();
      await expect(
        f.reader.withMaintenanceCredential(context, scope, async () => {}),
      ).rejects.toThrow();
      expect(called.some((call) => call.name === "get_connection_string")).toBe(false);
    },
  );
  it("denies wrong endpoint and mismatched returned credential identity", async () => {
    wrongEndpoint = true;
    const f = fixture();
    await expect(
      f.reader.withMaintenanceCredential(context, scope, async () => {}),
    ).rejects.toThrow();
    expect(called.some((call) => call.name === "get_connection_string")).toBe(false);
    wrongEndpoint = false;
    wrongCredential = true;
    await expect(
      f.reader.withMaintenanceCredential(context, scope, async () => {}),
    ).rejects.toThrow();
  });
  it("denies absent approval and revoked OAuth grants with opaque failure", async () => {
    const f = fixture();
    f.approved.mockRejectedValue(new Error("not approved"));
    await expect(
      f.reader.withMaintenanceCredential(context, scope, async () => {}),
    ).rejects.toThrow(/^Protected Preview Neon MCP credential is unavailable\.$/u);
    expect(called).toEqual([]);
    const granted = fixture();
    revoked = true;
    await expect(
      granted.reader.withMaintenanceCredential(context, scope, async () => {}),
    ).rejects.toThrow(/^Protected Preview Neon MCP credential is unavailable\.$/u);
  });
  it("never accepts Production resource selection", async () => {
    const f = fixture();
    const production = { ...context, target: { ...context.target } };
    Reflect.set(production.target, "environment", "production");
    await expect(
      f.reader.withMaintenanceCredential(production, scope, async () => {}),
    ).rejects.toThrow();
    expect(called).toEqual([]);
  });
});

describe("approved credential observation boundaries", () => {
  it("uses the approved local guard for token and metadata reads and full scope for URI, SQL and consume", async () => {
    const f = fixture({}, undefined, true, true);
    const consume = vi.fn(async () => {
      f.events.push("consume-start");
      await Promise.resolve();
      f.events.push("consume-end");
      return "ready";
    });
    await expect(f.reader.withMaintenanceCredential(context, scope, consume)).resolves.toBe(
      "ready",
    );
    expect(f.planningOwner).not.toHaveBeenCalled();
    expect(f.planning).not.toHaveBeenCalled();
    expect(f.approvedOwner).toHaveBeenCalledWith(context, scope, configuration.nativeStore);
    expect(f.approved).toHaveBeenCalledWith(context, scope);
    expect(f.events.slice(0, 2)).toEqual(["approved-scope", "native-store"]);
    expect(f.events.slice(-2)).toEqual(["approved-scope", "native-store"]);
    for (const operation of ["tool:get_connection_string", "sql", "consume"]) {
      const start = operation.startsWith("tool:")
        ? `tool-start:${operation.slice(5)}`
        : `${operation}-start`;
      const end = operation.startsWith("tool:")
        ? `tool-end:${operation.slice(5)}`
        : `${operation}-end`;
      const startIndex = f.events.indexOf(start);
      const endIndex = f.events.indexOf(end, startIndex + 1);
      expect(startIndex).toBeGreaterThan(0);
      expect(endIndex).toBeGreaterThan(startIndex);
      expect(f.events.slice(0, startIndex)).toContain("approved-scope");
      expect(f.events.slice(endIndex + 1)).toContain("approved-scope");
    }
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it("retains full approved scope when the optional observation guard is absent", async () => {
    const f = fixture({}, undefined, true);
    await expect(
      f.reader.withMaintenanceCredential(
        context,
        scope,
        async () => await Promise.resolve("ready"),
      ),
    ).resolves.toBe("ready");
    expect(f.approvedOwner).not.toHaveBeenCalled();
    expect(f.planningOwner).not.toHaveBeenCalled();
    expect(f.approved).toHaveBeenCalledWith(context, scope);
    expect(f.owner).toHaveBeenCalled();
  });

  it("retains the original owned scope across asynchronous caller changes", async () => {
    const selectedContext = structuredClone(context);
    const selectedScope = { ...scope };
    const f = fixture(
      {
        getOidc: async () => {
          selectedContext.target.projectId = "foreign-project";
          selectedScope.branchId = "foreign-branch";
          return await Promise.resolve(projectOidc);
        },
      },
      undefined,
      false,
      true,
    );
    const consume = vi.fn(async (material: { scope: typeof scope; maintenanceUrl: string }) => {
      expect(material.scope).toEqual(scope);
      expect(material.maintenanceUrl).toContain(scope.hostname);
      return await Promise.resolve("ready");
    });
    await expect(
      f.reader.withMaintenanceCredential(selectedContext, selectedScope, consume),
    ).resolves.toBe("ready");
    expect(f.approvedOwner).toHaveBeenCalledWith(context, scope, configuration.nativeStore);
    expect(f.approved).toHaveBeenCalledWith(context, scope);
  });

  it.each([
    "token-end",
    "tool-end:get_postgres_role",
    "tool-end:get_connection_string",
    "sql-end",
    "consume-end",
  ])("rejects actual approved owner revocation at %s", async (boundary) => {
    const f = fixture({}, undefined, false, true);
    const assertLive = async () => {
      await Promise.resolve();
      if (f.events.includes(boundary)) {
        throw new Error("approved owner revoked");
      }
    };
    f.approved.mockImplementation(assertLive);
    f.approvedOwner.mockImplementation(assertLive);
    const consume = vi.fn(async () => {
      f.events.push("consume-start");
      await Promise.resolve();
      f.events.push("consume-end");
      return "must-not-escape";
    });
    await expect(f.reader.withMaintenanceCredential(context, scope, consume)).rejects.toThrow(
      /^Protected Preview Neon MCP credential is unavailable\.$/u,
    );
    expect(f.events).toContain(boundary);
    if (boundary !== "consume-end") {
      expect(consume).not.toHaveBeenCalled();
    }
  });
});
