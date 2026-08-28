import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as databaseSchema from "../db/schema";
import {
  hostedRuntimePostgresOptions,
  parseHostedDatabaseUrl,
} from "../db/postgres-connection-policy";
import { readHostedForwarderSubject } from "../eve/hosted-forwarder";
import type { HostedWorkloadIdentity } from "../eve/same-origin-http";
import { readHostedAdmissionControlBinding } from "../hosted/admission-control";
import { composeHostedMcpRuntime } from "./hosted-runtime";
import { readHostedMcpAuthConfig, unavailableResponse } from "./request-auth";
import { createMcpRequestHandler } from "./request-handler";

type Database = PostgresJsDatabase<typeof databaseSchema>;

export function readHostedDeploymentConfig(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
  nowEpochMs = Date.now(),
) {
  const auth = readHostedMcpAuthConfig(environment);
  const resourceUrl = new URL(auth.resourceUrl);
  if (resourceUrl.pathname !== "/mcp") {
    throw new Error("The hosted MCP resource URL must use the /mcp route.");
  }
  const forwarderSubject = readHostedForwarderSubject(environment);
  if (forwarderSubject === undefined) {
    throw new Error("The hosted Eve forwarder binding is unavailable.");
  }
  return {
    auth,
    databaseUrl: parseHostedDatabaseUrl(environment.DATABASE_URL),
    admissionControl: readHostedAdmissionControlBinding(
      environment,
      nowEpochMs,
    ),
    eve: {
      baseUrl: resourceUrl.origin,
    },
    forwarderSubject,
  };
}

export function openHostedPostgresDatabase(databaseUrl: string): Database {
  const client = postgres(
    parseHostedDatabaseUrl(databaseUrl),
    hostedRuntimePostgresOptions,
  );
  return drizzle(client, { schema: databaseSchema });
}

/**
 * Lazily composes the hosted runtime on the first hosted request. Construction
 * performs no environment parsing, connection opening, or credential lookup.
 * The resulting runtime is principal-free and may safely reuse its database
 * pool; the request handler still derives a fresh principal for every request.
 */
export function createDeploymentMcpRequestHandler(input: {
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>;
  workloadIdentity: HostedWorkloadIdentity;
  openDatabase?: (databaseUrl: string) => Database;
  fetchImplementation?: typeof fetch;
  now?: () => number;
}) {
  const fallbackHandler = createMcpRequestHandler({
    environment: input.environment,
  });
  let hostedHandler: ((request: Request) => Promise<Response>) | undefined;
  let hostedResourceUrl: string | undefined;

  return async (request: Request): Promise<Response> => {
    if (input.environment.EVE_HOSTED_ADAPTER !== "1") {
      return fallbackHandler(request);
    }

    try {
      if (hostedHandler === undefined) {
        const config = readHostedDeploymentConfig(
          input.environment,
          input.now?.() ?? Date.now(),
        );
        if (request.url !== config.auth.resourceUrl) {
          throw new Error(
            "The hosted request does not match the configured MCP resource.",
          );
        }
        const database = (input.openDatabase ?? openHostedPostgresDatabase)(
          config.databaseUrl,
        );
        const runtime = composeHostedMcpRuntime({
          auth: config.auth,
          database,
          eve: config.eve,
          workloadIdentity: input.workloadIdentity,
          admissionControl: config.admissionControl,
          fetchImplementation: input.fetchImplementation,
          now: input.now,
        });
        hostedHandler = createMcpRequestHandler({
          environment: input.environment,
          hostedRuntime: runtime,
        });
        hostedResourceUrl = config.auth.resourceUrl;
      }
      if (request.url !== hostedResourceUrl) {
        throw new Error(
          "The hosted request does not match the configured MCP resource.",
        );
      }
      return hostedHandler(request);
    } catch {
      return unavailableResponse();
    }
  };
}
