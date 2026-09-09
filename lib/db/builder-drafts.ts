import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";
import { hostedTenantAuthoritySchema } from "./hosted-admin";

type Database = PostgresJsDatabase<typeof schema>;
type HostedTenantAuthority = z.infer<typeof hostedTenantAuthoritySchema>;
export type BuilderDraftRecord = { version: 1; draft: Record<string, unknown> };

function where(authorityInput: HostedTenantAuthority, draftId: string) {
  const authority = hostedTenantAuthoritySchema.parse(authorityInput);
  return and(
    eq(schema.builderDrafts.issuer, authority.issuer),
    eq(schema.builderDrafts.audience, authority.audience),
    eq(schema.builderDrafts.workspaceId, authority.workspaceId),
    eq(schema.builderDrafts.ownerUserId, authority.ownerUserId),
    eq(schema.builderDrafts.draftId, draftId),
  );
}

export function createBuilderDraftStore(database: Database) {
  return {
    async read(input: { authority: HostedTenantAuthority; draftId: string }) {
      const rows = await database
        .select()
        .from(schema.builderDrafts)
        .where(where(input.authority, input.draftId))
        .limit(1);
      return rows[0];
    },
    async save(input: {
      authority: HostedTenantAuthority;
      draftId: string;
      record: BuilderDraftRecord;
      now: Date;
    }) {
      const authority = hostedTenantAuthoritySchema.parse(input.authority);
      const rows = await database
        .insert(schema.builderDrafts)
        .values({
          ...authority,
          draftId: input.draftId,
          revision: 1,
          record: input.record,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: [
            schema.builderDrafts.issuer,
            schema.builderDrafts.audience,
            schema.builderDrafts.workspaceId,
            schema.builderDrafts.ownerUserId,
            schema.builderDrafts.draftId,
          ],
          set: {
            record: input.record,
            revision: sql`${schema.builderDrafts.revision} + 1`,
            updatedAt: input.now,
          },
        })
        .returning();
      if (!rows[0]) throw new Error("builder-draft-not-durable");
      return rows[0];
    },
  };
}
