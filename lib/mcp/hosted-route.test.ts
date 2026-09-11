import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { describe, expect, it, vi } from "vitest";

import type * as databaseSchema from "../db/schema";
import type { HostedWorkloadIdentity } from "../eve/same-origin-http";
import {
  createDeploymentMcpRequestHandler,
  readHostedDeploymentConfig,
} from "./hosted-route";

const nowEpochMs = Date.parse("2026-08-27T01:00:00.000Z");

const environment = {
  DATABASE_URL: "postgresql://user:password@database.example.test/eve",
  EVE_HOSTED_ADAPTER: "1",
  EVE_HOSTED_VERCEL_ENVIRONMENT: "preview",
  EVE_HOSTED_VERCEL_PROJECT_NAME: "autograph-app-builder",
  EVE_HOSTED_VERCEL_TEAM_SLUG: "withautograph",
  MCP_OAUTH_ALGORITHM: "ES256",
  MCP_OAUTH_AUDIENCE: "https://builder.example.test/mcp",
  MCP_OAUTH_ISSUER: "https://builder.example.test/api/auth",
  MCP_OAUTH_JWKS_URL: "https://builder.example.test/api/auth/jwks",
  MCP_RESOURCE_URL: "https://builder.example.test/mcp",
  VERCEL_ENV: "preview",
};

const workloadIdentity: HostedWorkloadIdentity = {
  async token() {
    throw new Error("Workload identity must not run before authorization.");
  },
};

type Database = PostgresJsDatabase<typeof databaseSchema>;

function request() {
  return new Request(environment.MCP_RESOURCE_URL, {
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "autograph_get", arguments: {} },
    }),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    method: "POST",
  });
}

describe("hosted route composition", () => {
  it("accepts an exact Production runtime binding without changing its authority shape", () => {
    const productionEnvironment = {
      ...environment,
      EVE_HOSTED_VERCEL_ENVIRONMENT: "production",
      VERCEL_ENV: "production",
    };
    const config = readHostedDeploymentConfig(productionEnvironment);
    expect(config.forwarderSubject).toBe(
      "owner:withautograph:project:autograph-app-builder:environment:production"
    );
  });

  it("opens no connection during construction and reuses one principal-free runtime", async () => {
    const openDatabase = vi.fn(() => ({}) as unknown as Database);
    const handler = createDeploymentMcpRequestHandler({
      environment,
      now: () => nowEpochMs,
      openDatabase,
      workloadIdentity,
    });

    expect(openDatabase).not.toHaveBeenCalled();
    const first = await handler(request());
    const second = await handler(request());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(openDatabase).toHaveBeenCalledTimes(1);
    expect(openDatabase).toHaveBeenCalledWith(environment.DATABASE_URL);
  });

  it("fails closed without constructing storage when hosted configuration is invalid", async () => {
    for (const invalidEnvironment of [
      { ...environment, MCP_RESOURCE_URL: "http://local/mcp" },
      { ...environment, EVE_HOSTED_VERCEL_ENVIRONMENT: "production" },
    ]) {
      const openDatabase = vi.fn(() => ({}) as unknown as Database);
      const handler = createDeploymentMcpRequestHandler({
        environment: invalidEnvironment,
        now: () => nowEpochMs,
        openDatabase,
        workloadIdentity,
      });

      const response = await handler(request());
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "service_unavailable",
      });
      expect(openDatabase).not.toHaveBeenCalled();
    }
  });

  it("binds every hosted request to the exact configured MCP resource before opening storage", async () => {
    const openDatabase = vi.fn(() => ({}) as unknown as Database);
    const handler = createDeploymentMcpRequestHandler({
      environment,
      now: () => nowEpochMs,
      openDatabase,
      workloadIdentity,
    });

    const wrongOrigin = await handler(
      new Request("https://other.example.test/mcp", {
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "autograph_get", arguments: {} },
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );
    expect(wrongOrigin.status).toBe(503);
    expect(openDatabase).not.toHaveBeenCalled();

    expect((await handler(request())).status).toBe(200);
    expect(openDatabase).toHaveBeenCalledTimes(1);
    expect(
      (
        await handler(
          new Request(`${environment.MCP_RESOURCE_URL}?unexpected=1`, {
            method: "POST",
          })
        )
      ).status
    ).toBe(503);
    expect(openDatabase).toHaveBeenCalledTimes(1);
  });

  it("never falls back after a hosted storage composition failure", async () => {
    const openDatabase = vi.fn(() => {
      throw new Error("database unavailable");
    });
    const handler = createDeploymentMcpRequestHandler({
      environment,
      now: () => nowEpochMs,
      openDatabase,
      workloadIdentity,
    });

    const response = await handler(request());
    expect(response.status).toBe(503);
    expect(openDatabase).toHaveBeenCalledTimes(1);
  });

  it("accepts only a bounded PostgreSQL deployment URL", () => {
    expect(readHostedDeploymentConfig(environment).databaseUrl).toBe(
      environment.DATABASE_URL
    );
    for (const databaseUrl of [
      "mysql://database.example.test/eve",
      "postgresql://database.example.test/eve\n",
      "not-a-url",
    ]) {
      expect(() =>
        readHostedDeploymentConfig({
          ...environment,
          DATABASE_URL: databaseUrl,
        })
      ).toThrow();
    }
    expect(readHostedDeploymentConfig(environment).eve).toEqual({
      baseUrl: "https://builder.example.test",
    });
    expect(readHostedDeploymentConfig(environment).forwarderSubject).toBe(
      "owner:withautograph:project:autograph-app-builder:environment:preview"
    );
    expect(() =>
      readHostedDeploymentConfig({
        ...environment,
        MCP_OAUTH_AUDIENCE: "https://builder.example.test/not-mcp",
        MCP_RESOURCE_URL: "https://builder.example.test/not-mcp",
      })
    ).toThrow("resourceUrl must be the exact /mcp URL");
  });
});
