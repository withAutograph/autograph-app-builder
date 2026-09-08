import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { hostedGitHubUserCredentials } from "../db/schema";
import * as databaseSchema from "../db/schema";
import {
  decryptGitHubUserTokens,
  encryptGitHubUserTokens,
  githubCredentialAssociatedData,
  githubUserTokenSetSchema,
  type GitHubUserCredentialConfig,
  type GitHubUserCredentialStore,
} from "./github-user-credential";
import type { BuilderProvisionAuthority } from "./journal";

type Database = PostgresJsDatabase<typeof databaseSchema>;

function predicate(
  authority: BuilderProvisionAuthority,
  providerUserId: string,
) {
  return and(
    eq(hostedGitHubUserCredentials.issuer, authority.issuer),
    eq(hostedGitHubUserCredentials.audience, authority.audience),
    eq(hostedGitHubUserCredentials.workspaceId, authority.workspaceId),
    eq(hostedGitHubUserCredentials.ownerUserId, authority.ownerUserId),
    eq(hostedGitHubUserCredentials.providerUserId, providerUserId),
  );
}

export function createPostgresGitHubUserCredentialStore(input: {
  database: Database;
  config: GitHubUserCredentialConfig;
}): GitHubUserCredentialStore {
  const parse = (row: typeof hostedGitHubUserCredentials.$inferSelect) => {
    const authority = hostedTenantAuthoritySchema.parse({
      issuer: row.issuer,
      audience: row.audience,
      workspaceId: row.workspaceId,
      ownerUserId: row.ownerUserId,
    });
    if (row.keyVersion !== input.config.keyVersion)
      throw new Error("github-credential-key-version");
    return {
      providerUserId: row.providerUserId,
      providerLogin: row.providerLogin,
      tokens: decryptGitHubUserTokens({
        encryptedCredential: row.encryptedCredential,
        credentialIv: row.credentialIv,
        credentialTag: row.credentialTag,
        key: input.config.key,
        associatedData: githubCredentialAssociatedData({
          authority,
          providerUserId: row.providerUserId,
        }),
      }),
      revision: row.revision,
      active: row.active,
      updatedAt: row.updatedAt,
    };
  };
  return {
    async bind(value) {
      const authority = hostedTenantAuthoritySchema.parse(value.authority);
      const tokens = githubUserTokenSetSchema.parse(value.tokens);
      const encrypted = encryptGitHubUserTokens({
        tokens,
        key: input.config.key,
        associatedData: githubCredentialAssociatedData({
          authority,
          providerUserId: value.providerUserId,
        }),
      });
      const rows = await input.database
        .insert(hostedGitHubUserCredentials)
        .values({
          ...authority,
          providerUserId: value.providerUserId,
          providerLogin: value.providerLogin,
          ...encrypted,
          keyVersion: input.config.keyVersion,
          revision: 1,
          active: true,
          updatedAt: value.now,
        })
        .onConflictDoUpdate({
          target: [
            hostedGitHubUserCredentials.issuer,
            hostedGitHubUserCredentials.audience,
            hostedGitHubUserCredentials.workspaceId,
            hostedGitHubUserCredentials.ownerUserId,
            hostedGitHubUserCredentials.providerUserId,
          ],
          set: {
            providerLogin: value.providerLogin,
            ...encrypted,
            keyVersion: input.config.keyVersion,
            revision: 1,
            active: true,
            updatedAt: value.now,
          },
        })
        .returning();
      if (!rows[0]) throw new Error("github-credential-not-durable");
      return parse(rows[0]);
    },
    async read(value) {
      const authority = hostedTenantAuthoritySchema.parse(value.authority);
      const rows = await input.database
        .select()
        .from(hostedGitHubUserCredentials)
        .where(predicate(authority, value.providerUserId))
        .limit(1);
      return rows[0] ? parse(rows[0]) : undefined;
    },
    async rotate(value) {
      const authority = hostedTenantAuthoritySchema.parse(value.authority);
      const tokens = githubUserTokenSetSchema.parse(value.tokens);
      const encrypted = encryptGitHubUserTokens({
        tokens,
        key: input.config.key,
        associatedData: githubCredentialAssociatedData({
          authority,
          providerUserId: value.providerUserId,
        }),
      });
      const rows = await input.database
        .update(hostedGitHubUserCredentials)
        .set({
          ...encrypted,
          keyVersion: input.config.keyVersion,
          revision: value.expectedRevision + 1,
          active: true,
          updatedAt: value.now,
        })
        .where(
          and(
            predicate(authority, value.providerUserId),
            eq(hostedGitHubUserCredentials.revision, value.expectedRevision),
            eq(hostedGitHubUserCredentials.active, true),
          ),
        )
        .returning();
      return rows[0] ? parse(rows[0]) : undefined;
    },
    async deactivate(value) {
      const authority = hostedTenantAuthoritySchema.parse(value.authority);
      const rows = await input.database
        .update(hostedGitHubUserCredentials)
        .set({ active: false, updatedAt: value.now })
        .where(predicate(authority, value.providerUserId))
        .returning({
          providerUserId: hostedGitHubUserCredentials.providerUserId,
        });
      return rows.length;
    },
  };
}
