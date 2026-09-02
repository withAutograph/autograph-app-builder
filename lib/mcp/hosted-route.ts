import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as databaseSchema from "../db/schema";
import {
  hostedRuntimePostgresOptions,
  parseHostedDatabaseUrl,
} from "../db/postgres-connection-policy";
import { readHostedForwarderSubject } from "../eve/hosted-forwarder";
import type { HostedPrincipal } from "../eve/hosted-auth";
import type { HostedWorkloadIdentity } from "../eve/same-origin-http";
import { createPostgresBuilderHandoffStore } from "../handoff/postgres-store";
import { createBuilderHandoffService } from "../handoff/service";
import { composeHostedMcpRuntime } from "./hosted-runtime";
import { readHostedMcpAuthConfig, unavailableResponse } from "./request-auth";
import {
  createMcpRequestHandler,
  type HostedBuilderHandoffRuntime,
} from "./request-handler";

type Database = PostgresJsDatabase<typeof databaseSchema>;
type ResumeRepositoryAccess = (input: {
  sessionAuth: unknown;
  sessionId: string;
  fetchImplementation?: typeof fetch;
}) => Promise<unknown>;
type RecheckRepositoryAccess = (input: {
  sessionAuth: unknown;
  repository: string;
}) => ReturnType<HostedBuilderHandoffRuntime["recheckRepositoryAccess"]>;

function forwardedSessionAuth(principal: HostedPrincipal) {
  const context = {
    attributes: {
      "mcp:audience": principal.audience,
      "mcp:scopes": principal.scopes,
      "mcp:workspace-id": principal.workspaceId,
    },
    authenticator: "mcp-oauth-jwks" as const,
    issuer: principal.issuer,
    principalId: principal.ownerUserId,
    principalType: "user" as const,
    subject: principal.ownerUserId,
  };
  return { current: context, initiator: context };
}

export function readHostedDeploymentConfig(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
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
  resumeRepositoryAccess?: ResumeRepositoryAccess;
  recheckRepositoryAccess?: RecheckRepositoryAccess;
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
        const config = readHostedDeploymentConfig(input.environment);
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
          fetchImplementation: input.fetchImplementation,
          now: input.now,
        });
        const handoffService = createBuilderHandoffService({
          store: createPostgresBuilderHandoffStore(database),
        });
        hostedHandler = createMcpRequestHandler({
          environment: input.environment,
          hostedRuntime: {
            ...runtime,
            handoffs: {
              ...handoffService,
              async recheckRepositoryAccess({ principal, repository }) {
                if (input.recheckRepositoryAccess !== undefined)
                  return input.recheckRepositoryAccess({
                    sessionAuth: forwardedSessionAuth(principal),
                    repository,
                  });
                const repositoryAccessRuntime =
                  await import("../agent/deployment-repository-access-runtime");
                return (
                  await repositoryAccessRuntime.repositoryAccessRuntimeForSession(
                    forwardedSessionAuth(principal),
                  )
                ).classify({ repository });
              },
            },
            async beforeRead({ principal, adapterSessionId }) {
              try {
                const resumeRepositoryAccess =
                  input.resumeRepositoryAccess ??
                  (
                    await import("../agent/deployment-repository-access-runtime")
                  ).resumeAuthorizedRepositoryAccessForSession;
                await resumeRepositoryAccess({
                  sessionAuth: forwardedSessionAuth(principal),
                  sessionId: adapterSessionId,
                  ...(input.fetchImplementation === undefined
                    ? {}
                    : { fetchImplementation: input.fetchImplementation }),
                });
              } catch {
                // A lost callback notification is recoverable. Repository
                // access remains parked and the ordinary session read still
                // returns its exact outstanding authorization request.
              }
            },
          },
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
