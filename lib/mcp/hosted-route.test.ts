import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { describe, expect, it, vi } from "vitest";

import * as databaseSchema from "../db/schema";
import type { HostedWorkloadIdentity } from "../eve/same-origin-http";
import {
  createDeploymentMcpRequestHandler,
  readHostedDeploymentConfig,
} from "./hosted-route";

const nowEpochMs = Date.parse("2026-08-27T01:00:00.000Z");

const environment = {
  EVE_HOSTED_ADAPTER: "1",
  VERCEL_ENV: "preview",
  EVE_HOSTED_VERCEL_TEAM_SLUG: "withautograph",
  EVE_HOSTED_VERCEL_PROJECT_NAME: "autograph-app-builder",
  EVE_HOSTED_VERCEL_ENVIRONMENT: "preview",
  DATABASE_URL: "postgresql://user:password@database.example.test/eve",
  MCP_OAUTH_ISSUER: "https://builder.example.test/api/auth",
  MCP_OAUTH_AUDIENCE: "https://builder.example.test/mcp",
  MCP_OAUTH_JWKS_URL: "https://builder.example.test/api/auth/jwks",
  MCP_OAUTH_ALGORITHM: "ES256",
  MCP_RESOURCE_URL: "https://builder.example.test/mcp",
  EVE_HOSTED_ADMISSION_CONTROL: JSON.stringify({
    version: 1,
    environment: "preview",
    enforcement: "provider-readback",
    scope: "issuer-audience-workspace-subject",
    startsPerSubjectPerMinute: 10,
    startsPerWorkspacePerMinute: 50,
    maxConcurrentSessionsPerSubject: 2,
    maxActiveSessionsPerWorkspace: 20,
    monthlySpendUsedUsdCents: 0,
    monthlySpendLimitUsdCents: 10_000,
    observedAt: "2026-08-27T00:55:00.000Z",
    expiresAt: "2026-08-27T01:55:00.000Z",
    readbackDigest: `sha256:${"a".repeat(64)}`,
  }),
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
  it("accepts an exact Production runtime binding without changing its authority shape", () => {
    const productionEnvironment = {
      ...environment,
      VERCEL_ENV: "production",
      EVE_HOSTED_VERCEL_ENVIRONMENT: "production",
      EVE_HOSTED_ADMISSION_CONTROL: JSON.stringify({
        ...JSON.parse(environment.EVE_HOSTED_ADMISSION_CONTROL),
        environment: "production",
      }),
    };
    const config = readHostedDeploymentConfig(
      productionEnvironment,
      nowEpochMs,
    );
    expect(config.forwarderSubject).toBe(
      "owner:withautograph:project:autograph-app-builder:environment:production",
    );
    expect(config.admissionControl.environment).toBe("production");
  });

  it("opens no connection during construction and reuses one principal-free runtime", async () => {
    const openDatabase = vi.fn(() => ({}) as unknown as Database);
    const handler = createDeploymentMcpRequestHandler({
      environment,
      workloadIdentity,
      openDatabase,
      now: () => nowEpochMs,
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
    for (const invalidEnvironment of [
      { ...environment, MCP_RESOURCE_URL: "http://local/mcp" },
      { ...environment, EVE_HOSTED_VERCEL_ENVIRONMENT: "production" },
      { ...environment, EVE_HOSTED_ADMISSION_CONTROL: undefined },
    ]) {
      const openDatabase = vi.fn(() => ({}) as unknown as Database);
      const handler = createDeploymentMcpRequestHandler({
        environment: invalidEnvironment,
        workloadIdentity,
        openDatabase,
        now: () => nowEpochMs,
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
      workloadIdentity,
      openDatabase,
      now: () => nowEpochMs,
    });

    const wrongOrigin = await handler(
      new Request("https://other.example.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(wrongOrigin.status).toBe(503);
    expect(openDatabase).not.toHaveBeenCalled();

    expect((await handler(request())).status).toBe(401);
    expect(openDatabase).toHaveBeenCalledTimes(1);
    expect(
      (
        await handler(
          new Request(`${environment.MCP_RESOURCE_URL}?unexpected=1`, {
            method: "POST",
          }),
        )
      ).status,
    ).toBe(503);
    expect(openDatabase).toHaveBeenCalledTimes(1);
  });

  it("never falls back after a hosted storage composition failure", async () => {
    const openDatabase = vi.fn(() => {
      throw new Error("database unavailable");
    });
    const handler = createDeploymentMcpRequestHandler({
      environment,
      workloadIdentity,
      openDatabase,
      now: () => nowEpochMs,
    });

    const response = await handler(request());
    expect(response.status).toBe(503);
    expect(openDatabase).toHaveBeenCalledTimes(1);
  });

  it("accepts only a bounded PostgreSQL deployment URL", () => {
    expect(
      readHostedDeploymentConfig(environment, nowEpochMs).databaseUrl,
    ).toBe(environment.DATABASE_URL);
    for (const databaseUrl of [
      "mysql://database.example.test/eve",
      "postgresql://database.example.test/eve\n",
      "not-a-url",
    ]) {
      expect(() =>
        readHostedDeploymentConfig(
          { ...environment, DATABASE_URL: databaseUrl },
          nowEpochMs,
        ),
      ).toThrow();
    }
    expect(readHostedDeploymentConfig(environment, nowEpochMs).eve).toEqual({
      baseUrl: "https://builder.example.test",
    });
    expect(
      readHostedDeploymentConfig(environment, nowEpochMs).forwarderSubject,
    ).toBe(
      "owner:withautograph:project:autograph-app-builder:environment:preview",
    );
    expect(
      readHostedDeploymentConfig(environment, nowEpochMs).admissionControl,
    ).toMatchObject({
      environment: "preview",
      enforcement: "provider-readback",
      maxConcurrentSessionsPerSubject: 2,
    });
    expect(() =>
      readHostedDeploymentConfig(
        {
          ...environment,
          MCP_RESOURCE_URL: "https://builder.example.test/not-mcp",
          MCP_OAUTH_AUDIENCE: "https://builder.example.test/not-mcp",
        },
        nowEpochMs,
      ),
    ).toThrow("resourceUrl must be the exact /mcp URL");
    expect(() =>
      readHostedDeploymentConfig(
        { ...environment, EVE_HOSTED_ADMISSION_CONTROL: undefined },
        nowEpochMs,
      ),
    ).toThrow("admission-control readback is required");
  });
});
