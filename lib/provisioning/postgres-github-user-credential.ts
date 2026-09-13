import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { hostedGitHubUserCredentials } from "../db/schema";
import type * as databaseSchema from "../db/schema";
import {
  decryptGitHubUserTokens,
  encryptGitHubUserTokens,
  githubCredentialAssociatedData,
  githubUserTokenSetSchema,
} from "./github-user-credential";
import type {
  GitHubUserCredentialConfig,
  GitHubUserCredentialStore,
} from "./github-user-credential";
import type { BuilderProvisionAuthority } from "./journal";

type Database = PostgresJsDatabase<typeof databaseSchema>;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function predicate(authority: BuilderProvisionAuthority, providerUserId: string) {
  return and(
    eq(hostedGitHubUserCredentials.issuer, authority.issuer),
    eq(hostedGitHubUserCredentials.audience, authority.audience),
    eq(hostedGitHubUserCredentials.workspaceId, authority.workspaceId),
    eq(hostedGitHubUserCredentials.ownerUserId, authority.ownerUserId),
    eq(hostedGitHubUserCredentials.providerUserId, providerUserId),
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createPostgresGitHubUserCredentialStore(input: {
  database: Database;
  config: GitHubUserCredentialConfig;
}): GitHubUserCredentialStore {
  const parse = (row: typeof hostedGitHubUserCredentials.$inferSelect) => {
    const authority = hostedTenantAuthoritySchema.parse({
      audience: row.audience,
      issuer: row.issuer,
      ownerUserId: row.ownerUserId,
      workspaceId: row.workspaceId,
    });
    if (row.keyVersion !== input.config.keyVersion)
      throw new Error("github-credential-key-version");
    return {
      active: row.active,
      providerLogin: row.providerLogin,
      providerUserId: row.providerUserId,
      revision: row.revision,
      tokens: decryptGitHubUserTokens({
        associatedData: githubCredentialAssociatedData({
          authority,
          providerUserId: row.providerUserId,
        }),
        credentialIv: row.credentialIv,
        credentialTag: row.credentialTag,
        encryptedCredential: row.encryptedCredential,
        key: input.config.key,
      }),
      updatedAt: row.updatedAt,
    };
  };
  return {
    async bind(value) {
      const authority = hostedTenantAuthoritySchema.parse(value.authority);
      const tokens = githubUserTokenSetSchema.parse(value.tokens);
      const encrypted = encryptGitHubUserTokens({
        associatedData: githubCredentialAssociatedData({
          authority,
          providerUserId: value.providerUserId,
        }),
        key: input.config.key,
        tokens,
      });
      const rows = await input.database
        .insert(hostedGitHubUserCredentials)
        .values({
          ...authority,
          active: true,
          ...encrypted,
          keyVersion: input.config.keyVersion,
          providerLogin: value.providerLogin,
          providerUserId: value.providerUserId,
          revision: 1,
          updatedAt: value.now,
        })
        .onConflictDoUpdate({
          set: {
            active: true,
            ...encrypted,
            keyVersion: input.config.keyVersion,
            providerLogin: value.providerLogin,
            revision: 1,
            updatedAt: value.now,
          },
          target: [
            hostedGitHubUserCredentials.issuer,
            hostedGitHubUserCredentials.audience,
            hostedGitHubUserCredentials.workspaceId,
            hostedGitHubUserCredentials.ownerUserId,
            hostedGitHubUserCredentials.providerUserId,
          ],
        })
        .returning();
      if (!rows[0]) throw new Error("github-credential-not-durable");
      return parse(rows[0]);
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
        associatedData: githubCredentialAssociatedData({
          authority,
          providerUserId: value.providerUserId,
        }),
        key: input.config.key,
        tokens,
      });
      const rows = await input.database
        .update(hostedGitHubUserCredentials)
        .set({
          ...encrypted,
          active: true,
          keyVersion: input.config.keyVersion,
          revision: value.expectedRevision + 1,
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
  };
}
