import { and, asc, eq, gt, isNotNull, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as databaseSchema from "../db/schema";
import { githubRepositoryAccessContinuations } from "../db/schema";
import type { HostedGitHubTenantAuthority } from "../repository/postgres-github-installation-store";
import {
  repositoryAccessContinuationSchema,
  type RepositoryAccessContinuation,
  type RepositoryAccessContinuationStore,
} from "./repository-access-continuation";

type Database = PostgresJsDatabase<typeof databaseSchema>;

const columns = {
  continuationDigest: githubRepositoryAccessContinuations.continuationDigest,
  issuer: githubRepositoryAccessContinuations.issuer,
  audience: githubRepositoryAccessContinuations.audience,
  workspaceId: githubRepositoryAccessContinuations.workspaceId,
  ownerUserId: githubRepositoryAccessContinuations.ownerUserId,
  sessionId: githubRepositoryAccessContinuations.sessionId,
  requestId: githubRepositoryAccessContinuations.requestId,
  repositoryOwner: githubRepositoryAccessContinuations.repositoryOwner,
  repositoryName: githubRepositoryAccessContinuations.repositoryName,
  selectedInstallationId:
    githubRepositoryAccessContinuations.selectedInstallationId,
  callbackUrl: githubRepositoryAccessContinuations.callbackUrl,
  createdAt: githubRepositoryAccessContinuations.createdAt,
  expiresAt: githubRepositoryAccessContinuations.expiresAt,
  authorizedAt: githubRepositoryAccessContinuations.authorizedAt,
  consumedAt: githubRepositoryAccessContinuations.consumedAt,
};

function tenant(authority: HostedGitHubTenantAuthority) {
  return and(
    eq(githubRepositoryAccessContinuations.issuer, authority.issuer),
    eq(githubRepositoryAccessContinuations.audience, authority.audience),
    eq(githubRepositoryAccessContinuations.workspaceId, authority.workspaceId),
    eq(githubRepositoryAccessContinuations.ownerUserId, authority.ownerUserId),
  );
}

function record(
  row: typeof githubRepositoryAccessContinuations.$inferSelect,
): RepositoryAccessContinuation {
  return repositoryAccessContinuationSchema.parse({
    continuationDigest: row.continuationDigest,
    authority: {
      issuer: row.issuer,
      audience: row.audience,
      workspaceId: row.workspaceId,
      ownerUserId: row.ownerUserId,
    },
    sessionId: row.sessionId,
    requestId: row.requestId,
    repository: {
      owner: row.repositoryOwner,
      name: row.repositoryName,
      fullName: `${String(row.repositoryOwner)}/${String(row.repositoryName)}`,
    },
    ...(row.selectedInstallationId
      ? { selectedInstallationId: row.selectedInstallationId }
      : {}),
    callbackUrl: row.callbackUrl,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    ...(row.authorizedAt ? { authorizedAt: row.authorizedAt } : {}),
    ...(row.consumedAt ? { consumedAt: row.consumedAt } : {}),
  });
}

export function createPostgresRepositoryAccessContinuationStore(
  database: Database,
): RepositoryAccessContinuationStore {
  return {
    async create(value) {
      await database.insert(githubRepositoryAccessContinuations).values({
        continuationDigest: value.continuationDigest,
        ...value.authority,
        sessionId: value.sessionId,
        requestId: value.requestId,
        repositoryOwner: value.repository.owner,
        repositoryName: value.repository.name,
        selectedInstallationId: value.selectedInstallationId ?? null,
        callbackUrl: value.callbackUrl,
        createdAt: value.createdAt,
        expiresAt: value.expiresAt,
        authorizedAt: null,
        consumedAt: null,
      });
    },

    async authorize(value) {
      const rows = await database
        .update(githubRepositoryAccessContinuations)
        .set({ authorizedAt: value.now })
        .where(
          and(
            tenant(value.authority),
            eq(
              githubRepositoryAccessContinuations.continuationDigest,
              value.continuationDigest,
            ),
            isNull(githubRepositoryAccessContinuations.authorizedAt),
            isNull(githubRepositoryAccessContinuations.consumedAt),
            gt(githubRepositoryAccessContinuations.expiresAt, value.now),
          ),
        )
        .returning(columns);
      return rows[0] ? record(rows[0]) : undefined;
    },

    async consume(value) {
      const rows = await database
        .update(githubRepositoryAccessContinuations)
        .set({ consumedAt: value.now })
        .where(
          and(
            tenant(value.authority),
            eq(
              githubRepositoryAccessContinuations.continuationDigest,
              value.continuationDigest,
            ),
            eq(githubRepositoryAccessContinuations.sessionId, value.sessionId),
            eq(githubRepositoryAccessContinuations.requestId, value.requestId),
            eq(
              githubRepositoryAccessContinuations.repositoryOwner,
              value.repository.owner,
            ),
            eq(
              githubRepositoryAccessContinuations.repositoryName,
              value.repository.name,
            ),
            value.selectedInstallationId === undefined
              ? isNull(
                  githubRepositoryAccessContinuations.selectedInstallationId,
                )
              : eq(
                  githubRepositoryAccessContinuations.selectedInstallationId,
                  value.selectedInstallationId,
                ),
            isNotNull(githubRepositoryAccessContinuations.authorizedAt),
            isNull(githubRepositoryAccessContinuations.consumedAt),
            gt(githubRepositoryAccessContinuations.expiresAt, value.now),
          ),
        )
        .returning(columns);
      return rows[0] ? record(rows[0]) : undefined;
    },

    async listAuthorizedForSession(value) {
      const rows = await database
        .select(columns)
        .from(githubRepositoryAccessContinuations)
        .where(
          and(
            tenant(value.authority),
            eq(githubRepositoryAccessContinuations.sessionId, value.sessionId),
            isNotNull(githubRepositoryAccessContinuations.authorizedAt),
            isNull(githubRepositoryAccessContinuations.consumedAt),
            gt(githubRepositoryAccessContinuations.expiresAt, value.now),
          ),
        )
        .orderBy(asc(githubRepositoryAccessContinuations.createdAt))
        .limit(16);
      return rows.map(record);
    },
  };
}
