import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Existing Drizzle database generic requires the schema namespace.
import type * as databaseSchema from "../db/schema";
import { builderProvisioningJournals } from "../db/schema";
import {
  repositoryProductionDigest,
  repositoryProductionOperationRef,
} from "./repository-production-contract";
import type { RepositoryProductionScope } from "./repository-production-contract";
import {
  repositoryProductionSignupOperationRef,
  repositoryProductionSignupRecordSchema,
} from "./repository-production-signup";
import type {
  RepositoryProductionSignupRow,
  RepositoryProductionSignupStore,
} from "./repository-production-signup";

const scopePredicate = (scope: RepositoryProductionScope) =>
  and(
    eq(builderProvisioningJournals.issuer, scope.authority.issuer),
    eq(builderProvisioningJournals.audience, scope.authority.audience),
    eq(builderProvisioningJournals.workspaceId, scope.authority.workspaceId),
    eq(builderProvisioningJournals.ownerUserId, scope.authority.ownerUserId),
    sql`${builderProvisioningJournals.record}->>'kind' = 'repository-production-signup-v1'`,
    sql`${builderProvisioningJournals.record}->'claim'->>'policyId' = ${repositoryProductionOperationRef(scope)}`,
  );
const predicate = (scope: RepositoryProductionScope, claimId: string) =>
  and(
    scopePredicate(scope),
    eq(
      builderProvisioningJournals.requestId,
      repositoryProductionSignupOperationRef(repositoryProductionOperationRef(scope), claimId),
    ),
  );
const parse = (
  raw: typeof builderProvisioningJournals.$inferSelect,
): RepositoryProductionSignupRow => {
  const record = repositoryProductionSignupRecordSchema.parse(raw.record);
  const { scope, claim } = record;
  if (
    raw.requestId !== repositoryProductionSignupOperationRef(claim.policyId, claim.id) ||
    claim.policyId !== repositoryProductionOperationRef(scope) ||
    raw.requestDigest !== repositoryProductionDigest({ scope, claim })
  ) {
    throw new Error("repository_production_signup_scope_mismatch");
  }
  if (
    raw.issuer !== scope.authority.issuer ||
    raw.audience !== scope.authority.audience ||
    raw.workspaceId !== scope.authority.workspaceId ||
    raw.ownerUserId !== scope.authority.ownerUserId
  ) {
    throw new Error("repository_production_signup_scope_mismatch");
  }
  return { operationRef: raw.requestId, revision: raw.revision, record };
};
const stages = [
  "registered",
  "prepared",
  "grant-pending",
  "granted",
  "applied",
  "rejected",
] as const;
const state = (stage: (typeof stages)[number]) =>
  stage === "applied" || stage === "rejected" ? "settled" : "pending";

/** Signup attempts share the existing journal's tenant boundary and UUID/CAS constraints. */
export const createPostgresRepositoryProductionSignupStore = (
  database: PostgresJsDatabase<typeof databaseSchema>,
): RepositoryProductionSignupStore => {
  const read: RepositoryProductionSignupStore["read"] = async (scope, claimId) => {
    const [raw] = await database
      .select()
      .from(builderProvisioningJournals)
      .where(predicate(scope, claimId))
      .limit(1);
    const row = raw === undefined ? undefined : parse(raw);
    if (row && !isDeepStrictEqual(row.record.scope, scope)) {
      throw new Error("repository_production_signup_scope_mismatch");
    }
    return row;
  };
  return {
    read,
    async pending(scope) {
      const rows = await database
        .select()
        .from(builderProvisioningJournals)
        .where(and(scopePredicate(scope), eq(builderProvisioningJournals.state, "pending")));
      return rows.map((raw) => {
        const row = parse(raw);
        if (!isDeepStrictEqual(row.record.scope, scope)) {
          throw new Error("repository_production_signup_scope_mismatch");
        }
        return row;
      });
    },
    async reserve(input) {
      const record = repositoryProductionSignupRecordSchema.parse(input);
      const now = new Date();
      const [raw] = await database
        .insert(builderProvisioningJournals)
        .values({
          ...record.scope.authority,
          requestId: repositoryProductionSignupOperationRef(record.claim.policyId, record.claim.id),
          requestDigest: repositoryProductionDigest({ scope: record.scope, claim: record.claim }),
          record,
          revision: 1,
          state: state(record.stage),
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning();
      const row = raw === undefined ? await read(record.scope, record.claim.id) : parse(raw);
      if (!row || !isDeepStrictEqual(row.record.claim, record.claim)) {
        throw new Error("repository_production_signup_conflict");
      }
      return row;
    },
    async compareAndSet(row, input) {
      const record = repositoryProductionSignupRecordSchema.parse(input);
      if (
        !isDeepStrictEqual(record.scope, row.record.scope) ||
        !isDeepStrictEqual(record.claim, row.record.claim) ||
        stages.indexOf(record.stage) < stages.indexOf(row.record.stage) ||
        !isDeepStrictEqual(
          record.workerCheckpoints.slice(0, row.record.workerCheckpoints.length),
          row.record.workerCheckpoints,
        )
      ) {
        throw new Error("repository_production_signup_scope_mismatch");
      }
      const [raw] = await database
        .update(builderProvisioningJournals)
        .set({
          record,
          revision: row.revision + 1,
          state: state(record.stage),
          updatedAt: new Date(),
        })
        .where(
          and(
            predicate(record.scope, record.claim.id),
            eq(builderProvisioningJournals.revision, row.revision),
          ),
        )
        .returning();
      return raw === undefined ? undefined : parse(raw);
    },
  };
};
