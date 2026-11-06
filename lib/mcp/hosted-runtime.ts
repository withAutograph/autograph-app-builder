import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type {
  user,
  session,
  account,
  verification,
  organization,
  member,
  invitation,
  jwks,
  oauthApplication,
  oauthAccessToken,
  oauthConsent,
  workspace,
  workspaceMembership,
  workspaceInvitation,
  workspaceRole,
  hostedEveSession,
  hostedEveEvent,
  productSourceReviewJournal,
} from "../db/schema";
import { createPostgresWorkspaceMembership } from "../eve/postgres-workspace-membership";
import { createSameOriginEveTransport } from "../eve/same-origin-http";
import type { HostedWorkloadIdentity } from "../eve/same-origin-http";
import { createPostgresHostedEveStore } from "../eve/postgres-hosted-store";
import { createRemoteJwksAccessTokenVerifier, hostedMcpAuthConfigSchema } from "./request-auth";
import type { HostedMcpRuntime } from "./request-handler";

/**
 * Pure composition boundary for a hosted deployment. Callers must inject an
 * already-created database handle and workload identity; this module reads no
 * process environment, obtains no credential, and opens no connection itself.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function composeHostedMcpRuntime(input: {
  auth: unknown;
  database: PostgresJsDatabase<{
    user: typeof user;
    session: typeof session;
    account: typeof account;
    verification: typeof verification;
    organization: typeof organization;
    member: typeof member;
    invitation: typeof invitation;
    jwks: typeof jwks;
    oauthApplication: typeof oauthApplication;
    oauthAccessToken: typeof oauthAccessToken;
    oauthConsent: typeof oauthConsent;
    workspace: typeof workspace;
    workspaceMembership: typeof workspaceMembership;
    workspaceInvitation: typeof workspaceInvitation;
    workspaceRole: typeof workspaceRole;
    hostedEveSession: typeof hostedEveSession;
    hostedEveEvent: typeof hostedEveEvent;
    productSourceReviewJournal: typeof productSourceReviewJournal;
  }>;
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
  const store = createPostgresHostedEveStore(input.database);
  return {
    auth,
    membership: createPostgresWorkspaceMembership(input.database),
    now: input.now,
    store,
    transport: createSameOriginEveTransport({
      ...httpInput,
      async verifyReadAuthority({ principal, sessionId, adapterSessionId }) {
        const session = await store.getSession(principal, sessionId);
        return session !== null && session.adapterSessionId === adapterSessionId;
      },
    }),
    verifier: createRemoteJwksAccessTokenVerifier({
      config: auth,
      fetchImplementation: input.fetchImplementation,
    }),
  };
}
