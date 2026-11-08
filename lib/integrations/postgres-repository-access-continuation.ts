import { and, asc, eq, gt, isNotNull, isNull } from "drizzle-orm";
import type { HostedDatabase } from "../db/hosted-postgres";
import { githubRepositoryAccessContinuations } from "../db/schema";
import type { HostedGitHubTenantAuthority } from "../repository/postgres-github-installation-store";
import { repositoryAccessContinuationSchema } from "./repository-access-continuation";
import type {
  RepositoryAccessContinuation,
  RepositoryAccessContinuationStore,
} from "./repository-access-continuation";

type Database = HostedDatabase;

const columns = {
  audience: githubRepositoryAccessContinuations.audience,
  authorizedAt: githubRepositoryAccessContinuations.authorizedAt,
  callbackUrl: githubRepositoryAccessContinuations.callbackUrl,
  consumedAt: githubRepositoryAccessContinuations.consumedAt,
  continuationDigest: githubRepositoryAccessContinuations.continuationDigest,
  createdAt: githubRepositoryAccessContinuations.createdAt,
  expiresAt: githubRepositoryAccessContinuations.expiresAt,
  issuer: githubRepositoryAccessContinuations.issuer,
  ownerUserId: githubRepositoryAccessContinuations.ownerUserId,
  repositoryName: githubRepositoryAccessContinuations.repositoryName,
  repositoryOwner: githubRepositoryAccessContinuations.repositoryOwner,
  requestId: githubRepositoryAccessContinuations.requestId,
  selectedInstallationId: githubRepositoryAccessContinuations.selectedInstallationId,
  sessionId: githubRepositoryAccessContinuations.sessionId,
  workspaceId: githubRepositoryAccessContinuations.workspaceId,
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function tenant(authority: HostedGitHubTenantAuthority) {
  return and(
    eq(githubRepositoryAccessContinuations.issuer, authority.issuer),
    eq(githubRepositoryAccessContinuations.audience, authority.audience),
    eq(githubRepositoryAccessContinuations.workspaceId, authority.workspaceId),
    eq(githubRepositoryAccessContinuations.ownerUserId, authority.ownerUserId),
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function record(
  row: typeof githubRepositoryAccessContinuations.$inferSelect,
): RepositoryAccessContinuation {
  const parse = repositoryAccessContinuationSchema.parse.bind(repositoryAccessContinuationSchema);
  const authority: Pick<RepositoryAccessContinuation, "authority" | "authorizedAt"> = {
    authority: {
      audience: row.audience,
      issuer: row.issuer,
      ownerUserId: row.ownerUserId,
      workspaceId: row.workspaceId,
    },
  };
  if (row.authorizedAt) {
    authority.authorizedAt = row.authorizedAt;
  }
  const continuation: typeof authority &
    Pick<RepositoryAccessContinuation, "callbackUrl" | "continuationDigest" | "consumedAt"> = {
    ...authority,
    callbackUrl: row.callbackUrl,
    continuationDigest: row.continuationDigest,
  };
  if (row.consumedAt) {
    continuation.consumedAt = row.consumedAt;
  }
  const details: typeof continuation &
    Pick<
      RepositoryAccessContinuation,
      "createdAt" | "expiresAt" | "repository" | "requestId" | "selectedInstallationId"
    > = {
    ...continuation,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    repository: {
      fullName: `${row.repositoryOwner}/${row.repositoryName}`,
      name: row.repositoryName,
      owner: row.repositoryOwner,
    },
    requestId: row.requestId,
  };
  if (row.selectedInstallationId) {
    details.selectedInstallationId = row.selectedInstallationId;
  }
  return parse({
    ...details,
    sessionId: row.sessionId,
  });
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createPostgresRepositoryAccessContinuationStore(
  database: Database,
): RepositoryAccessContinuationStore {
  return {
    async authorize(value) {
      const rows = await database
        .update(githubRepositoryAccessContinuations)
        .set({ authorizedAt: value.now })
        .where(
          and(
            tenant(value.authority),
            eq(githubRepositoryAccessContinuations.continuationDigest, value.continuationDigest),
            isNull(githubRepositoryAccessContinuations.authorizedAt),
            isNull(githubRepositoryAccessContinuations.consumedAt),
            gt(githubRepositoryAccessContinuations.expiresAt, value.now),
          ),
        )
        .returning(columns);
      return rows[0] === undefined ? undefined : record(rows[0]);
    },

    async consume(value) {
      const rows = await database
        .update(githubRepositoryAccessContinuations)
        .set({ consumedAt: value.now })
        .where(
          and(
            tenant(value.authority),
            eq(githubRepositoryAccessContinuations.continuationDigest, value.continuationDigest),
            eq(githubRepositoryAccessContinuations.sessionId, value.sessionId),
            eq(githubRepositoryAccessContinuations.requestId, value.requestId),
            eq(githubRepositoryAccessContinuations.repositoryOwner, value.repository.owner),
            eq(githubRepositoryAccessContinuations.repositoryName, value.repository.name),
            value.selectedInstallationId === undefined
              ? isNull(githubRepositoryAccessContinuations.selectedInstallationId)
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
      return rows[0] === undefined ? undefined : record(rows[0]);
    },

    async create(value) {
      await database.insert(githubRepositoryAccessContinuations).values({
        ...value.authority,
        authorizedAt: null,
        callbackUrl: value.callbackUrl,
        consumedAt: null,
        continuationDigest: value.continuationDigest,
        createdAt: value.createdAt,
        expiresAt: value.expiresAt,
        repositoryName: value.repository.name,
        repositoryOwner: value.repository.owner,
        requestId: value.requestId,
        selectedInstallationId: value.selectedInstallationId ?? null,
        sessionId: value.sessionId,
      });
    },

    async inspect(value) {
      const rows = await database
        .select(columns)
        .from(githubRepositoryAccessContinuations)
        .where(
          and(
            tenant(value.authority),
            eq(githubRepositoryAccessContinuations.continuationDigest, value.continuationDigest),
            isNull(githubRepositoryAccessContinuations.consumedAt),
            gt(githubRepositoryAccessContinuations.expiresAt, value.now),
          ),
        )
        .limit(1);
      return rows[0] === undefined ? undefined : record(rows[0]);
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
