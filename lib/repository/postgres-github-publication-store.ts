import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import * as databaseSchema from "../db/schema";
import { githubPublicationProposals } from "../db/schema";
import {
  assertExactDraftPullRequestProposal,
  assertExactFreshRepositoryProposal,
  type DraftPullRequestProposal,
  type FreshRepositoryProposal,
  type GitHubPublicationReceiptStore,
} from "./github-publication";
import { createPostgresGitHubPublicationReceiptStore } from "./postgres-github-publication-receipt-store";

type Database = PostgresJsDatabase<typeof databaseSchema>;
export type GitHubPublicationProposal =
  FreshRepositoryProposal | DraftPullRequestProposal;

export interface GitHubPublicationProposalStore {
  read(proposalDigest: string): Promise<GitHubPublicationProposal | undefined>;
  save(proposal: GitHubPublicationProposal): Promise<void>;
}

const proposalRowSchema = z
  .object({
    proposalDigest: z.string(),
    kind: z.enum(["fresh-repository", "draft-pull-request"]),
    idempotencyKey: z.string(),
    proposal: z.unknown(),
    createdAt: z.date(),
  })
  .strict();

function proposalKind(
  proposal: GitHubPublicationProposal,
): "fresh-repository" | "draft-pull-request" {
  return proposal.intendedOutcome === "create-private-fresh-history-repository"
    ? "fresh-repository"
    : "draft-pull-request";
}

function parseProposal(input: unknown): GitHubPublicationProposal {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("GitHub publication proposal JSON is malformed.");
  }
  const proposal = input as GitHubPublicationProposal;
  if (proposal.intendedOutcome === "create-private-fresh-history-repository") {
    assertExactFreshRepositoryProposal(proposal);
    return proposal;
  }
  assertExactDraftPullRequestProposal(proposal as DraftPullRequestProposal);
  return proposal as DraftPullRequestProposal;
}

export function parseGitHubPublicationProposalRow(
  input: unknown,
): GitHubPublicationProposal {
  const row = proposalRowSchema.parse(input);
  const proposal = parseProposal(row.proposal);
  if (
    row.proposalDigest !== proposal.digest ||
    row.kind !== proposalKind(proposal) ||
    row.idempotencyKey !== proposal.idempotencyKey
  ) {
    throw new Error(
      "GitHub publication proposal row is not canonically bound.",
    );
  }
  return proposal;
}

function proposalValues(proposal: GitHubPublicationProposal, now: Date) {
  return {
    proposalDigest: proposal.digest,
    kind: proposalKind(proposal),
    idempotencyKey: proposal.idempotencyKey,
    proposal,
    createdAt: now,
  };
}

/**
 * PostgreSQL owns both immutable sealed proposals and the compare-and-set
 * mutation journal. Indexed columns are redundant query aids and are rebound to
 * the closed JSON authority every time a row is read.
 */
export function createPostgresGitHubPublicationStores(
  database: Database,
  now: () => Date = () => new Date(),
): {
  proposals: GitHubPublicationProposalStore;
  receipts: GitHubPublicationReceiptStore;
} {
  const proposals: GitHubPublicationProposalStore = {
    async read(proposalDigest) {
      const rows = await database
        .select()
        .from(githubPublicationProposals)
        .where(eq(githubPublicationProposals.proposalDigest, proposalDigest))
        .limit(1);
      return rows[0] === undefined
        ? undefined
        : parseGitHubPublicationProposalRow(rows[0]);
    },
    async save(proposalInput) {
      const proposal = parseProposal(proposalInput);
      const inserted = await database
        .insert(githubPublicationProposals)
        .values(proposalValues(proposal, now()))
        .onConflictDoNothing()
        .returning();
      if (inserted.length === 1) {
        parseGitHubPublicationProposalRow(inserted[0]);
        return;
      }
      const existing = await proposals.read(proposal.digest);
      if (JSON.stringify(existing) !== JSON.stringify(proposal)) {
        throw new Error("GitHub publication proposal collided in storage.");
      }
    },
  };

  const receipts: GitHubPublicationReceiptStore =
    createPostgresGitHubPublicationReceiptStore(database, now);

  return { proposals, receipts };
}
