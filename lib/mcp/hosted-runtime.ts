import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type * as databaseSchema from "../db/schema";
import { createPostgresHostedEveStore } from "../eve/postgres-hosted-store";
import { createPostgresWorkspaceMembership } from "../eve/postgres-workspace-membership";
import { createSameOriginEveTransport } from "../eve/same-origin-http";
import type { HostedWorkloadIdentity } from "../eve/same-origin-http";
import {
  createRemoteJwksAccessTokenVerifier,
  hostedMcpAuthConfigSchema,
} from "./request-auth";
import type { HostedMcpRuntime } from "./request-handler";

/**
 * Pure composition boundary for a hosted deployment. Callers must inject an
 * already-created database handle and workload identity; this module reads no
 * process environment, obtains no credential, and opens no connection itself.
 */
export function composeHostedMcpRuntime(input: {
  auth: unknown;
  database: PostgresJsDatabase<typeof databaseSchema>;
  eve: {
    baseUrl: string;
    timeoutMs?: number;
  };
  workloadIdentity: HostedWorkloadIdentity;
  fetchImplementation?: typeof fetch;
  now?: () => number;
}): HostedMcpRuntime {
  const auth = hostedMcpAuthConfigSchema.parse(input.auth);
  const httpInput = {
    config: input.eve,
    fetchImplementation: input.fetchImplementation,
    workloadIdentity: input.workloadIdentity,
  };
  return {
    auth,
    membership: createPostgresWorkspaceMembership(input.database),
    now: input.now,
    store: createPostgresHostedEveStore(input.database),
    transport: createSameOriginEveTransport(httpInput),
    verifier: createRemoteJwksAccessTokenVerifier({
      config: auth,
      fetchImplementation: input.fetchImplementation,
    }),
  };
}
