import { and, eq, gt, isNull } from "drizzle-orm";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import type { openHostedPostgresDatabase } from "../db/hosted-postgres";
import { githubInstallationAuthorizationStates } from "../db/schema";
import type { GitHubInstallationAuthorizationStateStore } from "./github-app-installation";

type Database = ReturnType<typeof openHostedPostgresDatabase>;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createPostgresGitHubInstallationAuthorizationStateStore(
  database: Database,
): GitHubInstallationAuthorizationStateStore {
  return {
    async consume(input) {
      const authority = hostedTenantAuthoritySchema.parse(input.authority);
      const rows = await database
        .update(githubInstallationAuthorizationStates)
        .set({ consumedAt: input.now })
        .where(
          and(
            eq(githubInstallationAuthorizationStates.stateDigest, input.stateDigest),
            eq(githubInstallationAuthorizationStates.authorityDigest, input.authorityDigest),
            eq(githubInstallationAuthorizationStates.issuer, authority.issuer),
            eq(githubInstallationAuthorizationStates.audience, authority.audience),
            eq(githubInstallationAuthorizationStates.workspaceId, authority.workspaceId),
            eq(githubInstallationAuthorizationStates.ownerUserId, authority.ownerUserId),
            isNull(githubInstallationAuthorizationStates.consumedAt),
            gt(githubInstallationAuthorizationStates.expiresAt, input.now),
          ),
        )
        .returning({
          stateDigest: githubInstallationAuthorizationStates.stateDigest,
        });
      return rows.length === 1;
    },

    async create(input) {
      const authority = hostedTenantAuthoritySchema.parse(input.authority);
      await database.insert(githubInstallationAuthorizationStates).values({
        ...authority,
        authorityDigest: input.authorityDigest,
        consumedAt: null,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
        resumeKey: input.returnState.resumeKey ?? null,
        returnTo: input.returnState.returnTo,
        stateDigest: input.stateDigest,
      });
    },
  };
}
