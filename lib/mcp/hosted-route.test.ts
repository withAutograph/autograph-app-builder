import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { describe, expect, it, vi } from "vitest";

import * as databaseSchema from "../db/schema";
import type { HostedWorkloadIdentity } from "../eve/hosted-http";
import {
  createDeploymentMcpRequestHandler,
  readHostedDeploymentConfig,
} from "./hosted-route";

const environment = {
  EVE_HOSTED_ADAPTER: "1",
  DATABASE_URL: "postgresql://user:password@database.example.test/eve",
  EVE_HOSTED_GATEWAY_URL: "https://eve-gateway.example.test",
  EVE_HOSTED_WORKLOAD_AUDIENCE: "eve-workload",
  MCP_OAUTH_ISSUER: "https://identity.example.test",
  MCP_OAUTH_AUDIENCE: "eve-hosted",
  MCP_OAUTH_JWKS_URL: "https://identity.example.test/.well-known/jwks.json",
  MCP_OAUTH_ALGORITHM: "ES256",
  MCP_RESOURCE_URL: "https://builder.example.test/mcp",
};

const workloadIdentity: HostedWorkloadIdentity = {
  async token() {
    throw new Error("Workload identity must not run before authorization.");
  },
};

type Database = PostgresJsDatabase<typeof databaseSchema>;

function request() {
  return new Request(environment.MCP_RESOURCE_URL, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });
}

describe("hosted route composition", () => {
  it("opens no connection during construction and reuses one principal-free runtime", async () => {
    const openDatabase = vi.fn(() => ({}) as unknown as Database);
    const handler = createDeploymentMcpRequestHandler({
      environment,
      workloadIdentity,
      openDatabase,
    });

    expect(openDatabase).not.toHaveBeenCalled();
    const first = await handler(request());
    const second = await handler(request());

    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
    expect(openDatabase).toHaveBeenCalledTimes(1);
    expect(openDatabase).toHaveBeenCalledWith(environment.DATABASE_URL);
  });

  it("fails closed without constructing storage when hosted configuration is invalid", async () => {
    const openDatabase = vi.fn(() => ({}) as unknown as Database);
    const handler = createDeploymentMcpRequestHandler({
      environment: { ...environment, EVE_HOSTED_GATEWAY_URL: "http://local" },
      workloadIdentity,
      openDatabase,
    });

    const response = await handler(request());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "service_unavailable",
    });
    expect(openDatabase).not.toHaveBeenCalled();
  });

  it("never falls back after a hosted storage composition failure", async () => {
    const openDatabase = vi.fn(() => {
      throw new Error("database unavailable");
    });
    const handler = createDeploymentMcpRequestHandler({
      environment,
      workloadIdentity,
      openDatabase,
    });

    const response = await handler(request());
    expect(response.status).toBe(503);
    expect(openDatabase).toHaveBeenCalledTimes(1);
  });

  it("accepts only a bounded PostgreSQL deployment URL", () => {
    expect(readHostedDeploymentConfig(environment).databaseUrl).toBe(
      environment.DATABASE_URL,
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
        }),
      ).toThrow();
    }
    for (const gatewayUrl of [
      "http://eve-gateway.example.test",
      "https://eve-gateway.example.test/private",
      "https://user@eve-gateway.example.test",
      "https://eve-gateway.example.test?tenant=one",
    ]) {
      expect(() =>
        readHostedDeploymentConfig({
          ...environment,
          EVE_HOSTED_GATEWAY_URL: gatewayUrl,
        }),
      ).toThrow();
    }
  });
});
