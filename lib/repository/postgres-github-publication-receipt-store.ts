import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import type * as databaseSchema from "../db/schema";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { hostedGitHubPublicationJournals } from "../db/schema";
import {
  assertCanonicalGitHubMutationReceipt,
  createRepositoryObservation,
  repositoryKeys,
} from "./github-publication";
import type { GitHubMutationReceipt, GitHubPublicationReceiptStore } from "./github-publication";
import type { HostedGitHubTenantAuthority } from "./postgres-github-installation-store";

type Database = PostgresJsDatabase<typeof databaseSchema>;
const freshRepositoryKind = "fresh-repository" as const;

const journalRowSchema = z
  .object({
    createdAt: z.date(),
    idempotencyKey: z.string().regex(/^[0-9a-f]{64}$/u),
    kind: z.enum([freshRepositoryKind, "draft-pull-request"]),
    proposalDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    receiptDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    record: z.unknown(),
    status: z.enum(["pending", "failed", "succeeded"]),
    updatedAt: z.date(),
  })
  .strict();

const journalRowSelection = {
  createdAt: hostedGitHubPublicationJournals.createdAt,
  idempotencyKey: hostedGitHubPublicationJournals.idempotencyKey,
  kind: hostedGitHubPublicationJournals.kind,
  proposalDigest: hostedGitHubPublicationJournals.proposalDigest,
  receiptDigest: hostedGitHubPublicationJournals.receiptDigest,
  record: hostedGitHubPublicationJournals.record,
  status: hostedGitHubPublicationJournals.status,
  updatedAt: hostedGitHubPublicationJournals.updatedAt,
};

const pendingOrder = [
  "approvedByCallId",
  "idempotencyKey",
  "kind",
  "proposalDigest",
  "status",
  "version",
  "digest",
] as const;
const failureOrder = [
  "approvedByCallId",
  "failureCode",
  "idempotencyKey",
  "kind",
  "proposalDigest",
  "providerCode",
  "recoveryRequired",
  "status",
  "version",
  "digest",
] as const;
const freshSuccessOrder = [
  "approvedByCallId",
  "freshHistory",
  "idempotencyKey",
  "initialCommitSha",
  "initialCommitTree",
  "installationIdentityDigest",
  "kind",
  "parentCount",
  "proposalDigest",
  "providerReadBackDigest",
  "recoveredFromPending",
  "releaseGateAbsent",
  "repository",
  "status",
  "version",
  "digest",
] as const;
const draftSuccessOrder = [
  "approvedByCallId",
  "baseBranch",
  "baseSha",
  "branchName",
  "branchSha",
  "branchTree",
  "changeSetDigest",
  "changedContentDigest",
  "draft",
  "idempotencyKey",
  "installationIdentityDigest",
  "kind",
  "normalizedChangedPaths",
  "proposalDigest",
  "providerReadBackDigest",
  "pullRequestId",
  "pullRequestNumber",
  "recoveredFromPending",
  "releaseGateUnchanged",
  "repositoryId",
  "status",
  "version",
  "digest",
] as const;

// JSONB reorders keys. These orders match the receipt constructors used when
// calculating publication v2 digests. Check the field set before rebuilding.
const restoreReceiptOrder = (record: GitHubMutationReceipt): GitHubMutationReceipt => {
  let order: readonly string[];
  if (record.status === "pending") {
    order = pendingOrder;
  } else if (record.status === "failed") {
    order = failureOrder;
  } else if (record.kind === freshRepositoryKind) {
    order = freshSuccessOrder;
  } else {
    order = draftSuccessOrder;
  }
  if (JSON.stringify(Object.keys(record).toSorted()) !== JSON.stringify([...order].toSorted())) {
    throw new Error("Stored GitHub publication receipt fields are missing or unexpected.");
  }
  let repository =
    record.status === "succeeded" && record.kind === freshRepositoryKind
      ? record.repository
      : undefined;
  if (repository !== undefined) {
    if (
      JSON.stringify(Object.keys(repository).toSorted()) !==
      JSON.stringify([...repositoryKeys].toSorted())
    ) {
      throw new Error("Stored GitHub repository observation fields are missing or unexpected.");
    }
    const restored = createRepositoryObservation({
      defaultBranch: repository.defaultBranch,
      headSha: repository.headSha,
      headTree: repository.headTree,
      installationIdentityDigest: repository.installationIdentityDigest,
      name: repository.name,
      owner: repository.owner,
      releaseGate: {
        configured: repository.releaseGate.configured,
        name: repository.releaseGate.name,
      },
      repositoryId: repository.repositoryId,
      visibility: repository.visibility,
    });
    if (restored.digest !== repository.digest) {
      throw new Error("Stored GitHub repository observation digest does not match its fields.");
    }
    repository = restored;
  }
  const orderedFields = Object.entries(record)
    .map(([key, value]) => [key, key === "repository" ? repository : value] as const)
    .toSorted(([left], [right]) => order.indexOf(left) - order.indexOf(right));
  return Object.fromEntries(orderedFields) as GitHubMutationReceipt;
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function parseGitHubPublicationJournalRow(input: unknown): GitHubMutationReceipt {
  const row = journalRowSchema.parse(input);
  const receipt = restoreReceiptOrder(row.record as GitHubMutationReceipt);
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

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
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
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createPostgresGitHubPublicationReceiptStore(
  database: Database,
  authorityInput: HostedGitHubTenantAuthority,
  now: () => Date = () => new Date(),
): GitHubPublicationReceiptStore {
  const authority = hostedTenantAuthoritySchema.parse(authorityInput);
  const tenantPredicate = and(
    eq(hostedGitHubPublicationJournals.issuer, authority.issuer),
    eq(hostedGitHubPublicationJournals.audience, authority.audience),
    eq(hostedGitHubPublicationJournals.workspaceId, authority.workspaceId),
    eq(hostedGitHubPublicationJournals.ownerUserId, authority.ownerUserId),
  );
  return {
    async compareAndSet(proposalDigest, expectedDigest, receipt) {
      if (
        !/^[0-9a-f]{64}$/u.test(proposalDigest) ||
        receipt.proposalDigest !== proposalDigest ||
        (expectedDigest !== undefined && !/^[0-9a-f]{64}$/u.test(expectedDigest))
      ) {
        throw new Error("GitHub journal CAS binding is invalid.");
      }
      const timestamp = now();
      if (!Number.isFinite(timestamp.getTime())) {
        throw new TypeError("GitHub journal timestamp is invalid.");
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
          idempotencyKey: values.idempotencyKey,
          kind: values.kind,
          receiptDigest: values.receiptDigest,
          record: values.record,
          status: values.status,
          updatedAt: values.updatedAt,
        })
        .where(
          and(
            tenantPredicate,
            eq(hostedGitHubPublicationJournals.proposalDigest, proposalDigest),
            eq(hostedGitHubPublicationJournals.receiptDigest, expectedDigest),
            eq(hostedGitHubPublicationJournals.kind, receipt.kind),
            eq(hostedGitHubPublicationJournals.idempotencyKey, receipt.idempotencyKey),
          ),
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
        .select(journalRowSelection)
        .from(hostedGitHubPublicationJournals)
        .where(
          and(tenantPredicate, eq(hostedGitHubPublicationJournals.proposalDigest, proposalDigest)),
        )
        .limit(1);
      return rows[0] === undefined ? undefined : parseGitHubPublicationJournalRow(rows[0]);
    },
  };
}
