import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { member, organization, user } from "../db/schema";
import { member, organization, user } from "../db/schema";
import type { HostedWorkspaceMembership } from "../mcp/request-handler";
import { hostedPrincipalSchema } from "./hosted-auth";

type Database = PostgresJsDatabase<{
  user: typeof user;
  session: typeof session;
  organization: typeof organization;
  member: typeof member;
  personalWorkspace: typeof personalWorkspace;
  invitation: typeof invitation;
  account: typeof account;
  verification: typeof verification;
  passkey: typeof passkey;
  passkeyOnboarding: typeof passkeyOnboarding;
  jwks: typeof jwks;
  oauthClient: typeof oauthClient;
  oauthResource: typeof oauthResource;
  oauthClientResource: typeof oauthClientResource;
  oauthRefreshToken: typeof oauthRefreshToken;
  oauthAccessToken: typeof oauthAccessToken;
  oauthConsent: typeof oauthConsent;
  oauthClientAssertion: typeof oauthClientAssertion;
  hostedWorkspaceMemberships: typeof hostedWorkspaceMemberships;
  agentSessions: typeof agentSessions;
  agentSessionCheckpointManifests: typeof agentSessionCheckpointManifests;
  agentSessionCheckpointItems: typeof agentSessionCheckpointItems;
  agentSessionCheckpointChunks: typeof agentSessionCheckpointChunks;
  agentOperations: typeof agentOperations;
  sandboxExecutionLeases: typeof sandboxExecutionLeases;
  githubPublicationProposals: typeof githubPublicationProposals;
  githubPublicationJournals: typeof githubPublicationJournals;
  hostedGitHubInstallations: typeof hostedGitHubInstallations;
  hostedGitHubInstallationBindings: typeof hostedGitHubInstallationBindings;
  hostedVercelInstallations: typeof hostedVercelInstallations;
  hostedGitHubUserCredentials: typeof hostedGitHubUserCredentials;
  builderProvisioningJournals: typeof builderProvisioningJournals;
  builderHandoffs: typeof builderHandoffs;
  builderDrafts: typeof builderDrafts;
  vercelInstallationAuthorizationStates: typeof vercelInstallationAuthorizationStates;
  githubInstallationAuthorizationStates: typeof githubInstallationAuthorizationStates;
  githubRepositoryAccessContinuations: typeof githubRepositoryAccessContinuations;
  hostedGitHubPublicationProposals: typeof hostedGitHubPublicationProposals;
  hostedGitHubPublicationJournals: typeof hostedGitHubPublicationJournals;
  hostedGitHubPrEffectJournals: typeof hostedGitHubPrEffectJournals;
  hostedGitHubDraftAdoptions: typeof hostedGitHubDraftAdoptions;
  emulatePreviewState: typeof emulatePreviewState;
  prototypeArtifactChunks: typeof prototypeArtifactChunks;
  validationLogChunks: typeof validationLogChunks;
  validationLogManifests: typeof validationLogManifests;
  productSourceReviewJournal: typeof productSourceReviewJournal;
}>;

/**
 * Request-time membership authority. A signed workspace claim selects the
 * tenant, but only a currently active exact user/workspace row admits it.
 * Missing rows, revoked rows, and database errors all fail closed.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createPostgresWorkspaceMembership(database: Database): HostedWorkspaceMembership {
  return {
    async isMember({ principal: principalInput, workspaceId }) {
      const principal = hostedPrincipalSchema.parse(principalInput);
      if (workspaceId !== principal.workspaceId) {
        return false;
      }
      const rows = await database
        .select({ banned: user.banned, role: member.role })
        .from(member)
        .innerJoin(organization, eq(member.organizationId, organization.id))
        .innerJoin(user, eq(member.userId, user.id))
        .where(
          and(
            eq(organization.issuer, principal.issuer),
            eq(organization.audience, principal.audience),
            eq(organization.workspaceId, principal.workspaceId),
            eq(member.userId, principal.ownerUserId),
          ),
        )
        .limit(2);
      return (
        rows.length === 1 &&
        rows[0]?.banned !== true &&
        new Set(["owner", "admin", "member"]).has(rows[0]?.role ?? "")
      );
    },
  };
}

/** Consent-time authority for the future Preview issuer. Exactly one active
 * workspace is required; zero or multiple rows fail closed without guessing. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createPostgresOAuthMembershipAuthority(database: Database) {
  return {
    async activeWorkspaceForUser(input: {
      issuer: string;
      audience: string;
      ownerUserId: string;
    }): Promise<string | undefined> {
      const rows = await database
        .select({
          banned: user.banned,
          role: member.role,
          workspaceId: organization.workspaceId,
        })
        .from(member)
        .innerJoin(organization, eq(member.organizationId, organization.id))
        .innerJoin(user, eq(member.userId, user.id))
        .where(
          and(
            eq(organization.issuer, input.issuer),
            eq(organization.audience, input.audience),
            eq(member.userId, input.ownerUserId),
          ),
        )
        .limit(2);
      return rows.length === 1 &&
        rows[0]?.banned !== true &&
        new Set(["owner", "admin", "member"]).has(rows[0]?.role ?? "")
        ? rows[0]?.workspaceId
        : undefined;
    },
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
    async isActiveMember(input: {
      issuer: string;
      audience: string;
      workspaceId: string;
      ownerUserId: string;
    }): Promise<boolean> {
      return await createPostgresWorkspaceMembership(database).isMember({
        principal: {
          audience: input.audience,
          issuer: input.issuer,
          ownerUserId: input.ownerUserId,
          scopes: ["autograph:session"],
          workspaceId: input.workspaceId,
        },
        workspaceId: input.workspaceId,
      });
    },
  };
}
