import { and, eq, sql } from "drizzle-orm";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { builderProvisioningJournals } from "../db/schema";
import type { openHostedPostgresDatabase } from "../mcp/hosted-route";
import {
  continuityRecordSchema,
  parseContinuityPlanForOwner,
} from "./hosted-operator-continuity-contract";
import type { ContinuityJournalStore } from "./hosted-operator-continuity";
import type { HostedOperatorContext } from "./hosted-operator-service";

type Database = ReturnType<typeof openHostedPostgresDatabase>;
const predicate = (authorityInput: HostedOperatorContext["authority"], intentId: string) => {
  const authority = hostedTenantAuthoritySchema.parse(authorityInput);
  return and(
    eq(builderProvisioningJournals.issuer, authority.issuer),
    eq(builderProvisioningJournals.audience, authority.audience),
    eq(builderProvisioningJournals.workspaceId, authority.workspaceId),
    eq(builderProvisioningJournals.ownerUserId, authority.ownerUserId),
    eq(builderProvisioningJournals.requestId, intentId),
    sql`${builderProvisioningJournals.record} ->> 'kind' = 'app-continuity'`,
  );
};
export const createPostgresContinuityJournalStore = (
  database: Database,
): ContinuityJournalStore => {
  const read: ContinuityJournalStore["read"] = async (input) => {
    const [row] = await database
      .select()
      .from(builderProvisioningJournals)
      .where(predicate(input.authority, input.intentId))
      .limit(1);
    if (row === undefined) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Optional row absence is an explicit store result.
      return undefined;
    }
    const record = continuityRecordSchema.parse(row.record);
    if (record.revision !== row.revision || record.requestId !== input.intentId) {
      throw new Error("Continuity journal identity is unavailable.");
    }
    parseContinuityPlanForOwner(record.plan, {
      authority: input.authority,
      target: record.plan.target,
    });
    return record;
  };
  return {
    read,
    async reserve(input) {
      const record = continuityRecordSchema.parse(input.record);
      const [created] = await database
        .insert(builderProvisioningJournals)
        .values({
          ...record.plan.authority,
          requestId: record.requestId,
          requestDigest: record.planDigest,
          record,
          revision: record.revision,
          state: "pending",
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoNothing()
        .returning();
      const observed =
        created === undefined
          ? await read({ authority: record.plan.authority, intentId: record.requestId })
          : continuityRecordSchema.parse(created.record);
      if (observed === undefined) {
        throw new Error("Continuity journal reservation is unavailable.");
      }
      return observed;
    },
    async compareAndSet(input) {
      const record = continuityRecordSchema.parse(input.record);
      if (record.revision !== input.expectedRevision + 1) {
        throw new Error("Continuity journal revision differs.");
      }
      const [row] = await database
        .update(builderProvisioningJournals)
        .set({
          record,
          revision: record.revision,
          updatedAt: input.now,
          state: record.state === "settled" ? "settled" : "pending",
        })
        .where(
          and(
            predicate(record.plan.authority, record.requestId),
            eq(builderProvisioningJournals.revision, input.expectedRevision),
          ),
        )
        .returning();
      return row === undefined ? undefined : continuityRecordSchema.parse(row.record);
    },
  };
};
