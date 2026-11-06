import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { hostedGitHubPublicationProposals } from "../db/schema";
import type { schema as databaseSchema } from "../db/schema";
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
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type GitHubPublicationProposal = FreshRepositoryProposal | DraftPullRequestProposal;

export interface GitHubPublicationProposalStore {
  read: (proposalDigest: string) => Promise<GitHubPublicationProposal | undefined>;
  save: (proposal: GitHubPublicationProposal) => Promise<GitHubPublicationProposal>;
}

const proposalRowSchema = z.strictObject({
  createdAt: z.date(),
  idempotencyKey: z.string(),
  kind: z.enum(["fresh-repository", "draft-pull-request"]),
  proposal: z.unknown(),
  proposalDigest: z.string(),
});

// Project exactly the closed receipt fields. The database row also contains
// tenant columns used by the SQL predicate, but those are not proposal data.
const proposalRowSelection = {
  createdAt: hostedGitHubPublicationProposals.createdAt,
  idempotencyKey: hostedGitHubPublicationProposals.idempotencyKey,
  kind: hostedGitHubPublicationProposals.kind,
  proposal: hostedGitHubPublicationProposals.proposal,
  proposalDigest: hostedGitHubPublicationProposals.proposalDigest,
};
interface GitHubPublicationProposalRow {
  createdAt: Date;
  idempotencyKey: string;
  kind: "fresh-repository" | "draft-pull-request";
  proposal: JsonValue;
  proposalDigest: string;
}

function proposalKind(
  proposal: GitHubPublicationProposal,
): "fresh-repository" | "draft-pull-request" {
  return proposal.intendedOutcome === "create-private-fresh-history-repository"
    ? "fresh-repository"
    : "draft-pull-request";
}

const releaseGateName = "REPOSITORY_RELEASE_ENABLED";
const freshOutcome = "create-private-fresh-history-repository";
const draftOutcome: DraftPullRequestProposal["intendedOutcome"] =
  "publish-reviewed-change-set-as-draft-pull-request";
const storedProposalError = "Stored proposal fields are missing or unexpected.";

const releaseGateSchema = z.strictObject({
  configured: z.boolean(),
  name: z.literal(releaseGateName),
});

const storedProposalSchema = z.record(z.string(), z.unknown());

const hasExactStoredKeys = (
  value: z.infer<typeof storedProposalSchema>,
  keys: readonly string[],
): boolean =>
  JSON.stringify(Object.keys(value).toSorted()) === JSON.stringify([...keys].toSorted());

function parseProposal(input: JsonValue): GitHubPublicationProposal {
  const stored = storedProposalSchema.parse(input);
  // PostgreSQL jsonb reorders object keys. Publication v2 digests use the
  // constructor's JSON.stringify order, so restore that exact order after
  // checking the stored object has no missing or extra fields.
  if (stored.intendedOutcome === freshOutcome) {
    if (
      !hasExactStoredKeys(stored, freshProposalKeys) ||
      !releaseGateSchema.safeParse(stored.releaseGate).success
    ) {
      throw new Error(storedProposalError);
    }
    const proposal: FreshRepositoryProposal = {
      changeSetDigest: z.string().parse(stored.changeSetDigest),
      contractDigest: z.string().parse(stored.contractDigest),
      defaultBranch: z.literal("main").parse(stored.defaultBranch),
      destinationName: z.string().parse(stored.destinationName),
      destinationOwner: z.string().parse(stored.destinationOwner),
      eligibilityDigest: z.string().parse(stored.eligibilityDigest),
      idempotencyKey: z.string().parse(stored.idempotencyKey),
      initialCommitMessage: z
        .literal("Initialize repository from supported template")
        .parse(stored.initialCommitMessage),
      installationIdentityDigest: z.string().parse(stored.installationIdentityDigest),
      intendedOutcome: z.literal(freshOutcome).parse(stored.intendedOutcome),
      releaseGate: { configured: false, name: releaseGateName },
      reviewDigest: z.string().parse(stored.reviewDigest),
      sourceReceiptDigest: z.string().parse(stored.sourceReceiptDigest),
      sourceSha: z.string().parse(stored.sourceSha),
      sourceTree: z.string().parse(stored.sourceTree),
      version: z.literal(2).parse(stored.version),
      visibility: z.literal("private").parse(stored.visibility),
      digest: z.string().parse(stored.digest),
    };
    assertExactFreshRepositoryProposal(proposal);
    return proposal;
  }
  if (
    !hasExactStoredKeys(stored, draftProposalKeys) ||
    !releaseGateSchema.safeParse(stored.releaseGate).success
  ) {
    throw new Error(storedProposalError);
  }
  const gate = releaseGateSchema.parse(stored.releaseGate);
  const draft: DraftPullRequestProposal = {
    approvedPaths: z.array(z.string()).parse(stored.approvedPaths),
    baseBranch: z.string().parse(stored.baseBranch),
    baseSha: z.string().parse(stored.baseSha),
    baseTree: z.string().parse(stored.baseTree),
    branchName: z.string().parse(stored.branchName),
    changeSetDigest: z.string().parse(stored.changeSetDigest),
    changedContentDigest: z.string().parse(stored.changedContentDigest),
    digest: z.string().parse(stored.digest),
    draft: z.literal(true).parse(stored.draft),
    idempotencyKey: z.string().parse(stored.idempotencyKey),
    installationIdentityDigest: z.string().parse(stored.installationIdentityDigest),
    intendedOutcome: z.literal(draftOutcome).parse(stored.intendedOutcome),
    name: z.string().parse(stored.name),
    owner: z.string().parse(stored.owner),
    releaseGate: gate,
    repositoryId: z.string().parse(stored.repositoryId),
    repositoryObservationDigest: z.string().parse(stored.repositoryObservationDigest),
    reviewDigest: z.string().parse(stored.reviewDigest),
    title: z.string().parse(stored.title),
    version: z.literal(2).parse(stored.version),
    visibility: z.literal("private").parse(stored.visibility),
  };
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

export function parseGitHubPublicationProposalRow(
  input: GitHubPublicationProposalRow,
): GitHubPublicationProposal {
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
export function createPostgresGitHubPublicationStores(
  database: Database,
  authorityInput: HostedGitHubTenantAuthority,
  now: () => Date = () => new Date(),
) {
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
      const proposal = parseProposal(storedProposalSchema.parse(proposalInput));
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
        prior?.intendedOutcome === draftOutcome &&
        proposal.intendedOutcome === draftOutcome &&
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

  return { proposals, receipts } satisfies {
    proposals: GitHubPublicationProposalStore;
    receipts: GitHubPublicationReceiptStore;
  };
}
