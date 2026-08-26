import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as databaseSchema from "../db/schema";
import {
  createHostedHttpMembership,
  createHostedHttpTransport,
  type HostedWorkloadIdentity,
} from "../eve/hosted-http";
import { createPostgresHostedEveStore } from "../eve/postgres-hosted-store";
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
  gateway: {
    baseUrl: string;
    workloadAudience: string;
    timeoutMs?: number;
  };
  workloadIdentity: HostedWorkloadIdentity;
  fetchImplementation?: typeof fetch;
  now?: () => number;
}): HostedMcpRuntime {
  const auth = hostedMcpAuthConfigSchema.parse(input.auth);
  const httpInput = {
    config: input.gateway,
    workloadIdentity: input.workloadIdentity,
    fetchImplementation: input.fetchImplementation,
  };
  return {
    auth,
    verifier: createRemoteJwksAccessTokenVerifier({
      config: auth,
      fetchImplementation: input.fetchImplementation,
    }),
    membership: createHostedHttpMembership(httpInput),
    store: createPostgresHostedEveStore(input.database),
    transport: createHostedHttpTransport(httpInput),
    now: input.now,
  };
}
