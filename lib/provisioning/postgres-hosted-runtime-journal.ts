import { and, eq, sql } from "drizzle-orm";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { builderProvisioningJournals } from "../db/schema";
import type { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { hostedRuntimeIdentity, hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import type {
  HostedRuntimeJournalStore,
  HostedRuntimeJournalRow,
  HostedRuntimeTarget,
} from "./hosted-runtime-journal";
import type { BuilderProvisionAuthority } from "./journal";

type Database = ReturnType<typeof openHostedPostgresDatabase>;
const predicate = (authorityInput: BuilderProvisionAuthority, target: HostedRuntimeTarget) => {
  const authority = hostedTenantAuthoritySchema.parse(authorityInput);
  return and(
    eq(builderProvisioningJournals.issuer, authority.issuer),
    eq(builderProvisioningJournals.audience, authority.audience),
    eq(builderProvisioningJournals.workspaceId, authority.workspaceId),
    eq(builderProvisioningJournals.ownerUserId, authority.ownerUserId),
    eq(builderProvisioningJournals.requestId, hostedRuntimeIdentity(authority, target).requestId),
    sql`${builderProvisioningJournals.record} ->> 'kind' = 'app-runtime'`,
  );
};
const parseRow = (
  row: typeof builderProvisioningJournals.$inferSelect,
): HostedRuntimeJournalRow => ({
  record: hostedRuntimeJournalRecordSchema.parse(row.record),
  revision: row.revision,
});

/** Reuses the tenant/CAS provision journal; the GitHub/Vercel retry worker never selects this record kind. */
export const createPostgresHostedRuntimeJournalStore = (
  database: Database,
): HostedRuntimeJournalStore => {
  const read: HostedRuntimeJournalStore["read"] = async ({ authority, target }) => {
    const [row] = await database
      .select()
      .from(builderProvisioningJournals)
      .where(predicate(authority, target))
      .limit(1);
    return row === undefined ? undefined : parseRow(row);
  };
  return {
    async reserveFenceGeneration(input) {
      const [row] = await database
        .update(builderProvisioningJournals)
        .set({
          record: sql`jsonb_set(
            ${builderProvisioningJournals.record},
            '{operator,fenceGeneration}',
            to_jsonb(nextval('public.builder_protected_access_fence_generation_seq'::regclass)),
            true
          )`,
          revision: input.expectedRevision + 1,
          updatedAt: input.now,
        })
        .where(
          and(
            predicate(input.authority, input.target),
            eq(builderProvisioningJournals.revision, input.expectedRevision),
            sql`${builderProvisioningJournals.record} ->> 'leaseId' = ${input.leaseId}`,
            sql`${builderProvisioningJournals.record} #>> '{operator,operationRef}' = ${input.operationRef}`,
            sql`${builderProvisioningJournals.record} #> '{operator,fenceGeneration}' IS NULL`,
          ),
        )
        .returning();
      return row === undefined ? undefined : parseRow(row);
    },
    async compareAndSet(input) {
      const record = hostedRuntimeJournalRecordSchema.parse(input.record);
      const [row] = await database
        .update(builderProvisioningJournals)
        .set({
          record,
          revision: input.expectedRevision + 1,
          state: record.status === "pending" ? "pending" : "settled",
          updatedAt: input.now,
        })
        .where(
          and(
            predicate(input.authority, input.target),
            eq(builderProvisioningJournals.revision, input.expectedRevision),
          ),
        )
        .returning();
      return row === undefined ? undefined : parseRow(row);
    },
    read,
    async reserve(input) {
      const authority = hostedTenantAuthoritySchema.parse(input.authority);
      const identity = hostedRuntimeIdentity(authority, input.target);
      const [created] = await database
        .insert(builderProvisioningJournals)
        .values({
          ...authority,
          createdAt: input.now,
          record: hostedRuntimeJournalRecordSchema.parse({
            approvedByCallId: input.approvedByCallId,
            kind: "app-runtime",
            operator: input.operator,
            request: input.target,
            status: "pending",
            step: "reserved",
            version: 1,
          }),
          requestDigest: identity.digest,
          requestId: identity.requestId,
          revision: 1,
          state: "pending",
          updatedAt: input.now,
        })
        .onConflictDoNothing()
        .returning();
      const row = created === undefined ? await read(input) : parseRow(created);
      if (!row || hostedRuntimeIdentity(authority, row.record.request).digest !== identity.digest) {
        throw new Error("Runtime preparation journal ownership is unavailable.");
      }
      return row;
    },
  };
};
