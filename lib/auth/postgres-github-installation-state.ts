import { and, eq, gt, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import * as databaseSchema from "../db/schema";
import { githubInstallationAuthorizationStates } from "../db/schema";
import type { GitHubInstallationAuthorizationStateStore } from "./github-app-installation";

type Database = PostgresJsDatabase<typeof databaseSchema>;

export function createPostgresGitHubInstallationAuthorizationStateStore(
  database: Database,
): GitHubInstallationAuthorizationStateStore {
  return {
    async create(input) {
      const authority = hostedTenantAuthoritySchema.parse(input.authority);
      await database.insert(githubInstallationAuthorizationStates).values({
        stateDigest: input.stateDigest,
        ...authority,
        authorityDigest: input.authorityDigest,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
        returnTo: input.returnState.returnTo,
        resumeKey: input.returnState.resumeKey ?? null,
        consumedAt: null,
      });
    },

    async consume(input) {
      const authority = hostedTenantAuthoritySchema.parse(input.authority);
      const rows = await database
        .update(githubInstallationAuthorizationStates)
        .set({ consumedAt: input.now })
        .where(
          and(
            eq(
              githubInstallationAuthorizationStates.stateDigest,
              input.stateDigest,
            ),
            eq(
              githubInstallationAuthorizationStates.authorityDigest,
              input.authorityDigest,
            ),
            eq(githubInstallationAuthorizationStates.issuer, authority.issuer),
            eq(
              githubInstallationAuthorizationStates.audience,
              authority.audience,
            ),
            eq(
              githubInstallationAuthorizationStates.workspaceId,
              authority.workspaceId,
            ),
            eq(
              githubInstallationAuthorizationStates.ownerUserId,
              authority.ownerUserId,
            ),
            isNull(githubInstallationAuthorizationStates.consumedAt),
            gt(githubInstallationAuthorizationStates.expiresAt, input.now),
          ),
        )
        .returning({
          stateDigest: githubInstallationAuthorizationStates.stateDigest,
        });
      return rows.length === 1;
    },
  };
}
