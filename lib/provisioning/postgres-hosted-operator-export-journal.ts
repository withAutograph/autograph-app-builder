import { and, eq, sql } from "drizzle-orm";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { builderProvisioningJournals } from "../db/schema";
import type { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { hostedTenantExportExecutionRecordSchema } from "./hosted-operator-export";
import type { TenantExportJournalStore } from "./hosted-operator-export";
import { parseHostedTenantExportPlanForOwner } from "./hosted-operator-export-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";

type Database = ReturnType<typeof openHostedPostgresDatabase>;
const predicate = (authorityInput: HostedOperatorContext["authority"], exportId: string) => {
  const authority = hostedTenantAuthoritySchema.parse(authorityInput);
  return and(
    eq(builderProvisioningJournals.issuer, authority.issuer),
    eq(builderProvisioningJournals.audience, authority.audience),
    eq(builderProvisioningJournals.workspaceId, authority.workspaceId),
    eq(builderProvisioningJournals.ownerUserId, authority.ownerUserId),
    eq(builderProvisioningJournals.requestId, exportId),
    sql`${builderProvisioningJournals.record} ->> 'kind' = 'app-export'`,
  );
};
export const createPostgresTenantExportJournalStore = (
  database: Database,
): TenantExportJournalStore => {
  const read: TenantExportJournalStore["read"] = async (input) => {
    const [row] = await database
      .select()
      .from(builderProvisioningJournals)
      .where(predicate(input.authority, input.exportId))
      .limit(1);
    if (row === undefined) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Optional row absence is an explicit store result.
      return undefined;
    }
    const record = hostedTenantExportExecutionRecordSchema.parse(row.record);
    if (record.journal.revision !== row.revision || record.journal.requestId !== input.exportId) {
      throw new Error("Export journal identity is unavailable.");
    }
    parseHostedTenantExportPlanForOwner(record.journal.plan, {
      authority: input.authority,
      target: record.journal.target,
    });
    return record;
  };
  return {
    read,
    async reserve(input) {
      const record = hostedTenantExportExecutionRecordSchema.parse(input.record);
      const [created] = await database
        .insert(builderProvisioningJournals)
        .values({
          ...record.journal.authority,
          requestId: record.journal.requestId,
          requestDigest: record.journal.planDigest,
          record,
          revision: record.journal.revision,
          state: "pending",
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoNothing()
        .returning();
      const observed =
        created === undefined
          ? await read({ authority: record.journal.authority, exportId: record.journal.requestId })
          : hostedTenantExportExecutionRecordSchema.parse(created.record);
      if (observed === undefined) {
        throw new Error("Export journal reservation is unavailable.");
      }
      return observed;
    },
    async compareAndSet(input) {
      const record = hostedTenantExportExecutionRecordSchema.parse(input.record);
      if (record.journal.revision !== input.expectedRevision + 1) {
        throw new Error("Export journal revision differs.");
      }
      const [row] = await database
        .update(builderProvisioningJournals)
        .set({
          record,
          revision: record.journal.revision,
          updatedAt: input.now,
          state: record.journal.state === "complete" ? "settled" : "pending",
        })
        .where(
          and(
            predicate(record.journal.authority, record.journal.requestId),
            eq(builderProvisioningJournals.revision, input.expectedRevision),
          ),
        )
        .returning();
      return row === undefined
        ? undefined
        : hostedTenantExportExecutionRecordSchema.parse(row.record);
    },
  };
};

/** SELECT-only adapter: the browser reader provides fresh canonical owner/session authority. */
export const createTenantExportCompletionLookup = (input: {
  database: Database;
  assertOwner: (authority: HostedOperatorContext["authority"]) => Promise<void>;
}) => {
  const store = createPostgresTenantExportJournalStore(input.database);
  return async (request: { exportId: string; authority: HostedOperatorContext["authority"] }) => {
    const value = await store.read(request);
    if (value === undefined) {
      return null;
    }
    await input.assertOwner(request.authority);
    return value.journal.state === "complete" ? value.journal : null;
  };
};
