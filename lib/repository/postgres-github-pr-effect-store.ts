import { and, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { hostedGitHubPrEffectJournals as journals } from "../db/schema";
import { parseGitHubPrEffectReceipt } from "./github-pr-effect-journal";
import type { GitHubPrEffectStore } from "./github-pr-effect-journal";
import type { HostedGitHubTenantAuthority } from "./postgres-github-installation-store";

const digestPattern = /^[0-9a-f]{64}$/u;

export const createPostgresGitHubPrEffectStore = <
  Result extends PgQueryResultHKT,
  Schema extends Record<string, unknown>,
>(
  database: PgDatabase<Result, Schema>,
  authorityInput: HostedGitHubTenantAuthority,
  now: () => Date = () => new Date(),
): GitHubPrEffectStore => {
  const authority = hostedTenantAuthoritySchema.parse(authorityInput);
  const tenantPredicate = and(
    eq(journals.issuer, authority.issuer),
    eq(journals.audience, authority.audience),
    eq(journals.workspaceId, authority.workspaceId),
    eq(journals.ownerUserId, authority.ownerUserId),
  );
  return {
    async compareAndSet(intentDigest, expectedDigest, input) {
      const receipt = parseGitHubPrEffectReceipt(input);
      if (
        receipt.intentDigest !== intentDigest ||
        (expectedDigest !== undefined && !digestPattern.test(expectedDigest)) ||
        (receipt.status === "pending") !== (expectedDigest === undefined)
      ) {
        throw new Error("Invalid GitHub effect journal transition.");
      }
      const timestamp = now();
      if (!Number.isFinite(timestamp.getTime())) {
        throw new TypeError("Invalid GitHub effect timestamp.");
      }
      const values = {
        receiptDigest: receipt.digest,
        record: receipt,
        status: receipt.status,
        updatedAt: timestamp,
      };
      if (expectedDigest === undefined) {
        const inserted = await database
          .insert(journals)
          .values({
            ...authority,
            ...values,
            createdAt: timestamp,
            intentDigest,
            kind: receipt.intent.kind,
          })
          .onConflictDoNothing()
          .returning({ intentDigest: journals.intentDigest });
        return inserted.length === 1;
      }
      const updated = await database
        .update(journals)
        .set(values)
        .where(
          and(
            tenantPredicate,
            eq(journals.intentDigest, intentDigest),
            eq(journals.kind, receipt.intent.kind),
            eq(journals.status, "pending"),
            eq(journals.receiptDigest, expectedDigest),
            sql`${journals.record}->>'approvedByCallId' = ${receipt.approvedByCallId}`,
          ),
        )
        .returning({ intentDigest: journals.intentDigest });
      return updated.length === 1;
    },
    async read(intentDigest) {
      if (!digestPattern.test(intentDigest)) {
        throw new Error("Invalid GitHub effect intent digest.");
      }
      const [row] = await database
        .select({
          kind: journals.kind,
          receiptDigest: journals.receiptDigest,
          record: journals.record,
          status: journals.status,
        })
        .from(journals)
        .where(and(tenantPredicate, eq(journals.intentDigest, intentDigest)))
        .limit(1);
      if (row === undefined) {
        return row;
      }
      const receipt = parseGitHubPrEffectReceipt(row.record);
      if (
        receipt.intentDigest !== intentDigest ||
        row.kind !== receipt.intent.kind ||
        row.receiptDigest !== receipt.digest ||
        row.status !== receipt.status
      ) {
        throw new Error("Stored GitHub effect receipt does not match its journal row.");
      }
      return receipt;
    },
  };
};
