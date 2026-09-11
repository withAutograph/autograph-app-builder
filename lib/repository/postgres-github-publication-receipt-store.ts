import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import type * as databaseSchema from "../db/schema";
import { hostedGitHubPublicationJournals } from "../db/schema";
import { assertCanonicalGitHubMutationReceipt } from "./github-publication";
import type {
  GitHubMutationReceipt,
  GitHubPublicationReceiptStore,
} from "./github-publication";
import type { HostedGitHubTenantAuthority } from "./postgres-github-installation-store";

type Database = PostgresJsDatabase<typeof databaseSchema>;

const journalRowSchema = z
  .object({
    createdAt: z.date(),
    idempotencyKey: z.string().regex(/^[0-9a-f]{64}$/u),
    kind: z.enum(["fresh-repository", "draft-pull-request"]),
    proposalDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    receiptDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    record: z.unknown(),
    status: z.enum(["pending", "failed", "succeeded"]),
    updatedAt: z.date(),
  })
  .strict();

export function parseGitHubPublicationJournalRow(
  input: unknown
): GitHubMutationReceipt {
  const row = journalRowSchema.parse(input);
  const receipt = row.record as GitHubMutationReceipt;
  assertCanonicalGitHubMutationReceipt(receipt);
  if (
    row.proposalDigest !== receipt.proposalDigest ||
    row.receiptDigest !== receipt.digest ||
    row.idempotencyKey !== receipt.idempotencyKey ||
    row.kind !== receipt.kind ||
    row.status !== receipt.status ||
    row.createdAt.getTime() > row.updatedAt.getTime()
  ) {
    throw new Error("GitHub publication journal row is not canonically bound.");
  }
  return receipt;
}

function journalValues(receipt: GitHubMutationReceipt, now: Date) {
  assertCanonicalGitHubMutationReceipt(receipt);
  return {
    createdAt: now,
    idempotencyKey: receipt.idempotencyKey,
    kind: receipt.kind,
    proposalDigest: receipt.proposalDigest,
    receiptDigest: receipt.digest,
    record: receipt,
    status: receipt.status,
    updatedAt: now,
  };
}

/** PostgreSQL CAS journal for provider mutation intent and terminal receipts.
 * Failed or pending rows are never expired by the hosted tenant-retention
 * operation because deleting them could authorize a duplicate side effect. */
export function createPostgresGitHubPublicationReceiptStore(
  database: Database,
  authorityInput: HostedGitHubTenantAuthority,
  now: () => Date = () => new Date()
): GitHubPublicationReceiptStore {
  const authority = hostedTenantAuthoritySchema.parse(authorityInput);
  const tenantPredicate = and(
    eq(hostedGitHubPublicationJournals.issuer, authority.issuer),
    eq(hostedGitHubPublicationJournals.audience, authority.audience),
    eq(hostedGitHubPublicationJournals.workspaceId, authority.workspaceId),
    eq(hostedGitHubPublicationJournals.ownerUserId, authority.ownerUserId)
  );
  return {
    async compareAndSet(proposalDigest, expectedDigest, receipt) {
      if (
        !/^[0-9a-f]{64}$/u.test(proposalDigest) ||
        receipt.proposalDigest !== proposalDigest ||
        (expectedDigest !== undefined &&
          !/^[0-9a-f]{64}$/u.test(expectedDigest))
      ) {
        throw new Error("GitHub journal CAS binding is invalid.");
      }
      const timestamp = now();
      if (!Number.isFinite(timestamp.getTime())) {
        throw new Error("GitHub journal timestamp is invalid.");
      }
      const values = journalValues(receipt, timestamp);
      if (expectedDigest === undefined) {
        const inserted = await database
          .insert(hostedGitHubPublicationJournals)
          .values({ ...authority, ...values })
          .onConflictDoNothing()
          .returning({
            proposalDigest: hostedGitHubPublicationJournals.proposalDigest,
          });
        return inserted.length === 1;
      }
      const updated = await database
        .update(hostedGitHubPublicationJournals)
        .set({
          receiptDigest: values.receiptDigest,
          idempotencyKey: values.idempotencyKey,
          kind: values.kind,
          status: values.status,
          record: values.record,
          updatedAt: values.updatedAt,
        })
        .where(
          and(
            tenantPredicate,
            eq(hostedGitHubPublicationJournals.proposalDigest, proposalDigest),
            eq(hostedGitHubPublicationJournals.receiptDigest, expectedDigest),
            eq(hostedGitHubPublicationJournals.kind, receipt.kind),
            eq(
              hostedGitHubPublicationJournals.idempotencyKey,
              receipt.idempotencyKey
            )
          )
        )
        .returning({
          proposalDigest: hostedGitHubPublicationJournals.proposalDigest,
        });
      return updated.length === 1;
    },

    async read(proposalDigest) {
      if (!/^[0-9a-f]{64}$/u.test(proposalDigest)) {
        throw new Error("GitHub proposal digest is invalid.");
      }
      const rows = await database
        .select()
        .from(hostedGitHubPublicationJournals)
        .where(
          and(
            tenantPredicate,
            eq(hostedGitHubPublicationJournals.proposalDigest, proposalDigest)
          )
        )
        .limit(1);
      return rows[0] === undefined
        ? undefined
        : parseGitHubPublicationJournalRow(rows[0]);
    },
  };
}
