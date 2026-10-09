import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Drizzle database requires the full schema.
import type * as databaseSchema from "../db/schema";
import { productSourceReviewJournal } from "../db/schema";
import { exactForwardedSessionAuthority } from "../hosted/session-authority";
import {
  serializeSourceReviewRecord,
  sourceReviewJournalRecordSchema,
  sourceReviewPairKeySchema,
} from "./product-source-review-journal";
import type { SourceReviewJournal } from "./product-source-review-journal";

export const createPostgresSourceReviewJournal = (input: {
  db: PostgresJsDatabase<typeof databaseSchema>;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Exact forwarded authentication is validated at this boundary.
  sessionAuth: unknown;
  sessionId: string;
  assertCurrentOwner: () => Promise<void>;
}): SourceReviewJournal => {
  const { authority } = exactForwardedSessionAuthority(input.sessionAuth);
  if (!input.sessionId) {
    throw new Error("Source review session is unavailable.");
  }
  const predicate = (key: string) =>
    and(
      eq(productSourceReviewJournal.issuer, authority.issuer),
      eq(productSourceReviewJournal.audience, authority.audience),
      eq(productSourceReviewJournal.workspaceId, authority.workspaceId),
      eq(productSourceReviewJournal.ownerUserId, authority.ownerUserId),
      eq(productSourceReviewJournal.sessionId, input.sessionId),
      eq(productSourceReviewJournal.pairKey, sourceReviewPairKeySchema.parse(key)),
    );
  const assertOwner = async () => {
    if (
      JSON.stringify(exactForwardedSessionAuthority(input.sessionAuth).authority) !==
      JSON.stringify(authority)
    ) {
      throw new Error("Source review journal authority changed.");
    }
    await input.assertCurrentOwner();
  };
  const readBytes = async (key: string) => {
    await assertOwner();
    const [row] = await input.db
      .select({ record: productSourceReviewJournal.record })
      .from(productSourceReviewJournal)
      .where(predicate(key));
    return row?.record;
  };
  return {
    async put(key, record) {
      await assertOwner();
      const pairKey = sourceReviewPairKeySchema.parse(key);
      const bytes = serializeSourceReviewRecord(record);
      await input.db
        .insert(productSourceReviewJournal)
        .values({
          ...authority,
          createdAt: new Date(),
          pairKey,
          record: bytes,
          sessionId: input.sessionId,
        })
        .onConflictDoNothing();
      const stored = await readBytes(pairKey);
      if (stored === undefined) {
        throw new Error("Source review journal write was unavailable.");
      }
      return sourceReviewJournalRecordSchema.parse(JSON.parse(stored));
    },
    async read(key) {
      const bytes = await readBytes(key);
      return bytes === undefined
        ? undefined
        : sourceReviewJournalRecordSchema.parse(JSON.parse(bytes));
    },
  };
};
