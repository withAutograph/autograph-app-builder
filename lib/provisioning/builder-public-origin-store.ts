import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { builderProvisioningJournals as table } from "../db/schema";
import type { openHostedPostgresDatabase } from "../mcp/hosted-route";
import {
  builderPublicOriginSchema,
  builderPublicOriginScopeSchema,
} from "./builder-public-origin-contract";
import type { BuilderPublicOriginScope } from "./builder-public-origin-contract";

const BUILDER_ORIGIN_CHOICE_KIND = "builder-public-origin-choice-v1";

type Authority = z.infer<typeof hostedTenantAuthoritySchema>;
const recordSchema = z.strictObject({
  kind: z.literal(BUILDER_ORIGIN_CHOICE_KIND),
  selectionState: z.literal("selected"),
  scope: builderPublicOriginScopeSchema,
  publicOrigin: builderPublicOriginSchema,
});
export interface BuilderPublicOriginStore {
  read: (input: {
    authority: Authority;
    scope: BuilderPublicOriginScope;
  }) => Promise<string | undefined>;
  select: (input: {
    authority: Authority;
    scope: BuilderPublicOriginScope;
    publicOrigin: string;
    expectedPublicOrigin: string | null;
    assertCurrent: () => Promise<void>;
  }) => Promise<void>;
}
const identity = (authority: Authority, scope: BuilderPublicOriginScope) => {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        BUILDER_ORIGIN_CHOICE_KIND,
        hostedTenantAuthoritySchema.parse(authority),
        builderPublicOriginScopeSchema.parse(scope),
      ]),
    )
    .digest("hex");
  return {
    digest,
    requestId: `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
  };
};
export const createBuilderPublicOriginStore = (
  database: ReturnType<typeof openHostedPostgresDatabase>,
): BuilderPublicOriginStore => {
  const predicate = (authority: Authority, requestId: string) =>
    and(
      eq(table.issuer, authority.issuer),
      eq(table.audience, authority.audience),
      eq(table.ownerUserId, authority.ownerUserId),
      eq(table.workspaceId, authority.workspaceId),
      eq(table.requestId, requestId),
    );
  const parse = (
    row: typeof table.$inferSelect | undefined,
    scope: BuilderPublicOriginScope,
    digest: string,
  ): string | undefined => {
    if (row === undefined) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Absent selection remains distinct from a selected origin.
      return undefined;
    }
    const record = recordSchema.parse(row.record);
    if (
      row.state !== "settled" ||
      row.requestDigest !== digest ||
      !isDeepStrictEqual(record.scope, scope)
    ) {
      throw new Error("builder_public_origin_conflict");
    }
    return record.publicOrigin;
  };
  return {
    read: async ({ authority, scope }) => {
      const key = identity(authority, scope);
      const rows = await database
        .select()
        .from(table)
        .where(predicate(authority, key.requestId))
        .limit(1);
      return parse(rows[0], scope, key.digest);
    },
    select: async (input) => {
      const publicOrigin = builderPublicOriginSchema.parse(input.publicOrigin);
      const scope = builderPublicOriginScopeSchema.parse(input.scope);
      const authority = hostedTenantAuthoritySchema.parse(input.authority);
      const key = identity(authority, scope);
      await input.assertCurrent();
      await database.transaction(async (transaction) => {
        // Reserve a fixed owner/destination slot before reading its row lock; concurrent first choices cannot replace each other.
        const now = new Date();
        if (input.expectedPublicOrigin === null) {
          await transaction
            .insert(table)
            .values({
              ...authority,
              requestId: key.requestId,
              requestDigest: key.digest,
              createdAt: now,
              updatedAt: now,
              state: "settled",
              revision: 1,
              record: {
                kind: BUILDER_ORIGIN_CHOICE_KIND,
                selectionState: "selected",
                scope,
                publicOrigin,
              },
            })
            .onConflictDoNothing();
        }
        const rows = await transaction
          .select()
          .from(table)
          .where(predicate(authority, key.requestId))
          .limit(1)
          .for("update");
        const row = rows[0];
        const current = parse(row, scope, key.digest);
        await input.assertCurrent();
        if (current === publicOrigin) {
          return;
        }
        if (row === undefined || current !== input.expectedPublicOrigin) {
          throw new Error("builder_public_origin_conflict");
        }
        const updated = await transaction
          .update(table)
          .set({
            record: {
              kind: BUILDER_ORIGIN_CHOICE_KIND,
              selectionState: "selected",
              scope,
              publicOrigin,
            },
            revision: row.revision + 1,
            updatedAt: now,
          })
          .where(and(predicate(authority, key.requestId), eq(table.revision, row.revision)))
          .returning({ requestId: table.requestId });
        if (updated.length !== 1) {
          throw new Error("builder_public_origin_conflict");
        }
      });
      await input.assertCurrent();
    },
  };
};
