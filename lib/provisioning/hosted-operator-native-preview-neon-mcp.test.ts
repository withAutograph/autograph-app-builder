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
            uri,
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
            result: { content: [{ text: JSON.stringify(value), type: "text" }] },
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
const fixture = () => {
  vi.stubGlobal("fetch", fixtureFetch);
  const approved = vi.fn(async () => {
    await Promise.resolve();
  });
  const owner = vi.fn(async () => {
    await Promise.resolve();
    return {
      configurationId: configuration.nativeStore.configurationId,
      neonProjectId: scope.projectId,
      ownerId: "team-owner",
      resourceId: configuration.nativeStore.resourceId,
      vercelProjectId: configuration.nativeStore.sourceProjectId,
    };
  });
  const io: NonNullable<PreviewNeonMcpDependencies["io"]> = {
    createAuthProvider: connectAuthProvider,
    createClient: async (config) => {
      if (!("url" in config.transport)) {
        throw new Error("Unexpected fixture transport");
      }
      expect(new URL(config.transport.url).searchParams.get("projectId")).toBe(scope.projectId);
      expect(config.transport.redirect).toBe("error");
      return await createMCPClient({
        ...config,
        transport: { ...config.transport, fetch: fixtureFetch, url: `${origin}/mcp` },
      });
    },
    getOidc: async () => await Promise.resolve(projectOidc),
    readSqlIdentity: async (privateUrl) => {
      expect(privateUrl).toContain("sslmode=verify-full");
      return await Promise.resolve({
        database: scope.maintenanceDatabase,
        role: scope.maintenanceRole,
      });
    },
    verifyOidc: async () => {
      await Promise.resolve();
    },
  };
  return {
    approved,
    owner,
    reader: createPreviewNeonMcpReader({
      assertApprovedScope: approved,
      configuration,
      io,
      readCurrentOwnerNativeStore: owner,
    }),
  };
};
describe("private Preview Neon OAuth MCP credentials", () => {
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
