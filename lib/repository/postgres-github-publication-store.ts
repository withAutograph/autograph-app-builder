import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import type * as databaseSchema from "../db/schema";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { hostedGitHubPublicationProposals } from "../db/schema";
import {
  assertExactDraftPullRequestProposal,
  assertExactFreshRepositoryProposal,
  draftProposalKeys,
  freshProposalKeys,
} from "./github-publication";
import type {
  DraftPullRequestProposal,
  FreshRepositoryProposal,
  GitHubPublicationReceiptStore,
} from "./github-publication";
import { createPostgresGitHubPublicationReceiptStore } from "./postgres-github-publication-receipt-store";
import type { HostedGitHubTenantAuthority } from "./postgres-github-installation-store";

type Database = PostgresJsDatabase<typeof databaseSchema>;
export type GitHubPublicationProposal = FreshRepositoryProposal | DraftPullRequestProposal;

export interface GitHubPublicationProposalStore {
  read: (proposalDigest: string) => Promise<GitHubPublicationProposal | undefined>;
  save: (proposal: GitHubPublicationProposal) => Promise<GitHubPublicationProposal>;
}

const proposalRowSchema = z
  .object({
    createdAt: z.date(),
    idempotencyKey: z.string(),
    kind: z.enum(["fresh-repository", "draft-pull-request"]),
    proposal: z.unknown(),
    proposalDigest: z.string(),
  })
  .strict();

// Project exactly the closed receipt fields. The database row also contains
// tenant columns used by the SQL predicate, but those are not proposal data.
const proposalRowSelection = {
  createdAt: hostedGitHubPublicationProposals.createdAt,
  idempotencyKey: hostedGitHubPublicationProposals.idempotencyKey,
  kind: hostedGitHubPublicationProposals.kind,
  proposal: hostedGitHubPublicationProposals.proposal,
  proposalDigest: hostedGitHubPublicationProposals.proposalDigest,
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function proposalKind(
  proposal: GitHubPublicationProposal,
): "fresh-repository" | "draft-pull-request" {
  return proposal.intendedOutcome === "create-private-fresh-history-repository"
    ? "fresh-repository"
    : "draft-pull-request";
}

const releaseGateSchema = z
  .object({ configured: z.boolean(), name: z.literal("REPOSITORY_RELEASE_ENABLED") })
  .strict();

const hasExactStoredKeys = (value: GitHubPublicationProposal, keys: readonly string[]): boolean =>
  JSON.stringify(Object.keys(value).toSorted()) === JSON.stringify([...keys].toSorted());

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function parseProposal(input: unknown): GitHubPublicationProposal {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("GitHub publication proposal JSON is malformed.");
  }
  const stored = input as GitHubPublicationProposal;
  // PostgreSQL jsonb reorders object keys. Publication v2 digests use the
  // constructor's JSON.stringify order, so restore that exact order after
  // checking the stored object has no missing or extra fields.
  if (stored.intendedOutcome === "create-private-fresh-history-repository") {
    if (
      !hasExactStoredKeys(stored, freshProposalKeys) ||
      !releaseGateSchema.safeParse(stored.releaseGate).success
    ) {
      throw new Error("Stored fresh-repository proposal fields are missing or unexpected.");
    }
    // oxlint-disable-next-line eslint/sort-keys -- legacy digest depends on constructor field order.
    const proposal: FreshRepositoryProposal = {
      changeSetDigest: stored.changeSetDigest,
      contractDigest: stored.contractDigest,
      defaultBranch: stored.defaultBranch,
      destinationName: stored.destinationName,
      destinationOwner: stored.destinationOwner,
      eligibilityDigest: stored.eligibilityDigest,
      idempotencyKey: stored.idempotencyKey,
      initialCommitMessage: stored.initialCommitMessage,
      installationIdentityDigest: stored.installationIdentityDigest,
      intendedOutcome: stored.intendedOutcome,
      releaseGate: { configured: false, name: stored.releaseGate.name },
      reviewDigest: stored.reviewDigest,
      sourceReceiptDigest: stored.sourceReceiptDigest,
      sourceSha: stored.sourceSha,
      sourceTree: stored.sourceTree,
      version: stored.version,
      visibility: stored.visibility,
      digest: stored.digest,
    };
    assertExactFreshRepositoryProposal(proposal);
    return proposal;
  }
  if (
    !hasExactStoredKeys(stored, draftProposalKeys) ||
    !releaseGateSchema.safeParse(stored.releaseGate).success
  ) {
    throw new Error("Stored draft pull-request proposal fields are missing or unexpected.");
  }
  const draft = stored as DraftPullRequestProposal;
  // oxlint-disable-next-line eslint/sort-keys -- legacy digest depends on constructor field order.
  const proposal: DraftPullRequestProposal = {
    approvedPaths: draft.approvedPaths,
    baseBranch: draft.baseBranch,
    baseSha: draft.baseSha,
    baseTree: draft.baseTree,
    branchName: draft.branchName,
    changeSetDigest: draft.changeSetDigest,
    changedContentDigest: draft.changedContentDigest,
    draft: draft.draft,
    idempotencyKey: draft.idempotencyKey,
    installationIdentityDigest: draft.installationIdentityDigest,
    intendedOutcome: draft.intendedOutcome,
    name: draft.name,
    owner: draft.owner,
    releaseGate: { configured: draft.releaseGate.configured, name: draft.releaseGate.name },
    repositoryId: draft.repositoryId,
    repositoryObservationDigest: draft.repositoryObservationDigest,
    reviewDigest: draft.reviewDigest,
    title: draft.title,
    version: draft.version,
    visibility: draft.visibility,
    digest: draft.digest,
  };
  assertExactDraftPullRequestProposal(proposal);
  return proposal;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function parseGitHubPublicationProposalRow(input: unknown): GitHubPublicationProposal {
  const row = proposalRowSchema.parse(input);
  const proposal = parseProposal(row.proposal);
  if (
    row.proposalDigest !== proposal.digest ||
    row.kind !== proposalKind(proposal) ||
    row.idempotencyKey !== proposal.idempotencyKey
  ) {
    throw new Error("GitHub publication proposal row is not canonically bound.");
  }
  return proposal;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function proposalValues(proposal: GitHubPublicationProposal, now: Date) {
  return {
    createdAt: now,
    idempotencyKey: proposal.idempotencyKey,
    kind: proposalKind(proposal),
    proposal,
    proposalDigest: proposal.digest,
  };
}

// A title change does not alter the proposal's idempotency key. Reuse the
// already sealed proposal only when every publication-relevant field agrees.
export const sameProposalExceptTitle = (
  left: DraftPullRequestProposal,
  right: DraftPullRequestProposal,
): boolean => {
  const { title: _leftTitle, digest: _leftDigest, ...leftContent } = left;
  const { title: _rightTitle, digest: _rightDigest, ...rightContent } = right;
  void _leftTitle;
  void _leftDigest;
  void _rightTitle;
  void _rightDigest;
  return isDeepStrictEqual(leftContent, rightContent);
};

/**
 * PostgreSQL owns both immutable sealed proposals and the compare-and-set
 * mutation journal. Indexed columns are redundant query aids and are rebound to
 * the closed JSON authority every time a row is read.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createPostgresGitHubPublicationStores(
  database: Database,
  authorityInput: HostedGitHubTenantAuthority,
  now: () => Date = () => new Date(),
): {
  proposals: GitHubPublicationProposalStore;
  receipts: GitHubPublicationReceiptStore;
} {
  const authority = hostedTenantAuthoritySchema.parse(authorityInput);
  const tenantPredicate = and(
    eq(hostedGitHubPublicationProposals.issuer, authority.issuer),
    eq(hostedGitHubPublicationProposals.audience, authority.audience),
    eq(hostedGitHubPublicationProposals.workspaceId, authority.workspaceId),
    eq(hostedGitHubPublicationProposals.ownerUserId, authority.ownerUserId),
  );
  const proposals: GitHubPublicationProposalStore = {
    async read(proposalDigest) {
      const rows = await database
        .select(proposalRowSelection)
        .from(hostedGitHubPublicationProposals)
        .where(
          and(tenantPredicate, eq(hostedGitHubPublicationProposals.proposalDigest, proposalDigest)),
        )
        .limit(1);
      return rows[0] === undefined ? undefined : parseGitHubPublicationProposalRow(rows[0]);
    },
    async save(proposalInput) {
      const proposal = parseProposal(proposalInput);
      const inserted = await database
        .insert(hostedGitHubPublicationProposals)
        .values({ ...authority, ...proposalValues(proposal, now()) })
        .onConflictDoNothing()
        .returning(proposalRowSelection);
      if (inserted.length === 1) {
        return parseGitHubPublicationProposalRow(inserted[0]);
      }
      const existing = await proposals.read(proposal.digest);
      if (existing !== undefined && isDeepStrictEqual(existing, proposal)) {
        return existing;
      }
      const rows = await database
        .select(proposalRowSelection)
        .from(hostedGitHubPublicationProposals)
        .where(
          and(
            tenantPredicate,
            eq(hostedGitHubPublicationProposals.kind, proposalKind(proposal)),
            eq(hostedGitHubPublicationProposals.idempotencyKey, proposal.idempotencyKey),
          ),
        )
        .limit(1);
      const prior = rows[0] === undefined ? undefined : parseGitHubPublicationProposalRow(rows[0]);
      if (
        prior?.intendedOutcome === "publish-reviewed-change-set-as-draft-pull-request" &&
        proposal.intendedOutcome === "publish-reviewed-change-set-as-draft-pull-request" &&
        sameProposalExceptTitle(prior, proposal)
      ) {
        return prior;
      }
      throw new Error(
        "GitHub publication proposal collided with different reviewed content. Refresh the current change review and prepare a new draft proposal.",
      );
    },
  };

  const receipts: GitHubPublicationReceiptStore = createPostgresGitHubPublicationReceiptStore(
    database,
    authority,
    now,
  );

  return { proposals, receipts };
}
