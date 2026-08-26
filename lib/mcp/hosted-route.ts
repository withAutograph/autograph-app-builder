import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { z } from "zod";

import * as databaseSchema from "../db/schema";
import type { HostedWorkloadIdentity } from "../eve/hosted-http";
import { composeHostedMcpRuntime } from "./hosted-runtime";
import { readHostedMcpAuthConfig, unavailableResponse } from "./request-auth";
import { createMcpRequestHandler } from "./request-handler";

type Database = PostgresJsDatabase<typeof databaseSchema>;

const databaseUrlSchema = z
  .string()
  .min(1)
  .max(8_192)
  .refine((value) => !/[\0\r\n]/u.test(value), "Malformed database URL.")
  .transform((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: "Invalid database URL." });
      return z.NEVER;
    }
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      context.addIssue({
        code: "custom",
        message: "Hosted storage requires PostgreSQL.",
      });
      return z.NEVER;
    }
    return value;
  });

const httpsOriginSchema = z
  .string()
  .url()
  .startsWith("https://")
  .transform((value, context) => {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    ) {
      context.addIssue({
        code: "custom",
        message: "Hosted Eve gateway must be an HTTPS origin.",
      });
      return z.NEVER;
    }
    return url.origin;
  });

export function readHostedDeploymentConfig(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  return {
    auth: readHostedMcpAuthConfig(environment),
    databaseUrl: databaseUrlSchema.parse(environment.DATABASE_URL),
    gateway: {
      baseUrl: httpsOriginSchema.parse(environment.EVE_HOSTED_GATEWAY_URL),
      workloadAudience: z
        .string()
        .min(1)
        .max(300)
        .parse(environment.EVE_HOSTED_WORKLOAD_AUDIENCE),
    },
  };
}

export function openHostedPostgresDatabase(databaseUrl: string): Database {
  const client = postgres(databaseUrlSchema.parse(databaseUrl), {
    max: 5,
    connect_timeout: 5,
    idle_timeout: 20,
    prepare: false,
    onnotice: () => undefined,
  });
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

  return async (request: Request): Promise<Response> => {
    if (input.environment.EVE_HOSTED_ADAPTER !== "1") {
      return fallbackHandler(request);
    }

    try {
      if (hostedHandler === undefined) {
        const config = readHostedDeploymentConfig(input.environment);
        const database = (input.openDatabase ?? openHostedPostgresDatabase)(
          config.databaseUrl,
        );
        const runtime = composeHostedMcpRuntime({
          auth: config.auth,
          database,
          gateway: config.gateway,
          workloadIdentity: input.workloadIdentity,
          fetchImplementation: input.fetchImplementation,
          now: input.now,
        });
        hostedHandler = createMcpRequestHandler({
          environment: input.environment,
          hostedRuntime: runtime,
        });
      }
      return hostedHandler(request);
    } catch {
      return unavailableResponse();
    }
  };
}
