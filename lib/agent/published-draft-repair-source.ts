import { createHash } from "node:crypto";
import type { DraftReviewedWorkflow } from "./draft-reviewed-lineage";
import type { DraftReconciliationCandidate } from "./draft-reconciliation-state";
import { assertOwnedPublicationReconciliationScope } from "../repository/github-draft-reconciliation";
import { assertExactImmutableGitHubSourceReceipt } from "../repository/github-publication";
import type { ImmutableGitHubSourceReceipt } from "../repository/github-publication";
import type { ExistingDraftObservation } from "../repository/github-draft-update";

const PUBLISHED_DRAFT_REPAIR = "published-draft-repair" as const;

/** A second acquired source; the accepted fresh-template workflow remains its origin. */
export interface PublishedDraftRepairSource {
  kind: typeof PUBLISHED_DRAFT_REPAIR;
  version: 1;
  appId: string;
  appSpecDigest: string;
  originSourceReceiptDigest: string;
  publicationProposalDigest: string;
  publicationDigest: string;
  installationId: string;
  source: ImmutableGitHubSourceReceipt;
  draft: ExistingDraftObservation;
  digest: string;
}

const digest = (value: Omit<PublishedDraftRepairSource, "digest">) => {
  const { draft } = value;
  const material = {
    appId: value.appId,
    appSpecDigest: value.appSpecDigest,
    draft: {
      baseBranch: draft.baseBranch,
      baseRepositoryId: draft.baseRepositoryId,
      draft: draft.draft,
      headBranch: draft.headBranch,
      headRepositoryId: draft.headRepositoryId,
      headSha: draft.headSha,
      headTree: draft.headTree,
      name: draft.name,
      number: draft.number,
      owner: draft.owner,
      pullRequestId: draft.pullRequestId,
      repositoryId: draft.repositoryId,
      state: draft.state,
      verifiedBuilderOrigin:
        draft.verifiedBuilderOrigin === undefined
          ? undefined
          : {
              appId: draft.verifiedBuilderOrigin.appId,
              authorId: draft.verifiedBuilderOrigin.authorId,
              marker: draft.verifiedBuilderOrigin.marker,
            },
    },
    installationId: value.installationId,
    kind: value.kind,
    originSourceReceiptDigest: value.originSourceReceiptDigest,
    publicationDigest: value.publicationDigest,
    publicationProposalDigest: value.publicationProposalDigest,
    sourceDigest: value.source.digest,
    version: value.version,
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
};

export const assertPublishedDraftRepairSource = (receipt: PublishedDraftRepairSource): void => {
  assertExactImmutableGitHubSourceReceipt(receipt.source);
  const { digest: claimed, ...unsigned } = receipt;
  const { source, draft } = receipt;
  const keys = [
    "kind",
    "version",
    "appId",
    "appSpecDigest",
    "originSourceReceiptDigest",
    "publicationProposalDigest",
    "publicationDigest",
    "installationId",
    "source",
    "draft",
    "digest",
  ];
  const matches = [
    Object.keys(receipt).toSorted().join("|") === keys.toSorted().join("|"),
    receipt.kind === PUBLISHED_DRAFT_REPAIR,
    receipt.version === 1,
    claimed === digest(unsigned),
    draft.draft,
    draft.state === "open",
    draft.repositoryId === source.repository.repositoryId,
    draft.headRepositoryId === draft.repositoryId,
    draft.baseRepositoryId === draft.repositoryId,
    draft.owner === source.repository.owner,
    draft.name === source.repository.name,
    source.resolvedRef === `refs/heads/${draft.headBranch}`,
    source.resolvedSha === draft.headSha,
    source.resolvedTree === draft.headTree,
    // Provider origin appId names the GitHub App; the generated app is bound by this receipt.
    draft.verifiedBuilderOrigin !== undefined,
  ].every(Boolean);
  if (!matches) {
    throw new Error("The owned published-draft repair source is incomplete or changed.");
  }
};

export const createPublishedDraftRepairSource = (
  input: Omit<PublishedDraftRepairSource, "kind" | "version" | "digest">,
): PublishedDraftRepairSource => {
  const unsigned = { kind: PUBLISHED_DRAFT_REPAIR, version: 1 as const, ...input };
  const receipt = { ...unsigned, digest: digest(unsigned) };
  assertPublishedDraftRepairSource(receipt);
  return receipt;
};

/** Verify candidate authority against a reviewed workflow without resolving state. */
export const reviewedDraftCandidateSource = (
  state: DraftReviewedWorkflow,
  candidate: DraftReconciliationCandidate,
): ImmutableGitHubSourceReceipt | undefined => {
  if (state.reviewReceipt.digest !== candidate.originalReviewDigest) {
    return undefined;
  }
  const repair =
    candidate.kind === PUBLISHED_DRAFT_REPAIR ? candidate.repair : candidate.publishedOrigin;
  if (repair === undefined) {
    return candidate.publicationScope === undefined &&
      state.githubSource?.digest === candidate.githubSourceDigest
      ? state.githubSource
      : undefined;
  }
  assertPublishedDraftRepairSource(repair);
  if (candidate.kind !== PUBLISHED_DRAFT_REPAIR) {
    const scope = candidate.publicationScope;
    if (scope === undefined) {
      return undefined;
    }
    assertOwnedPublicationReconciliationScope(scope);
    if (
      scope.proposal.digest !== repair.publicationProposalDigest ||
      scope.publication.digest !== repair.publicationDigest
    ) {
      return undefined;
    }
  }
  const matches = [
    state.appSpec.appId === candidate.appId,
    state.sourceReceipt.sourceKind === "fresh-template",
    state.githubSource === undefined,
    state.sourceReceipt.digest === repair.originSourceReceiptDigest,
    state.appSpec.digest === repair.appSpecDigest,
    candidate.appId === repair.appId,
    candidate.githubSourceDigest === repair.source.digest,
    candidate.repositoryId === repair.draft.repositoryId,
    candidate.pullRequestNumber === repair.draft.number,
    candidate.headSha === repair.draft.headSha,
    candidate.headTree === repair.draft.headTree,
    candidate.kind !== PUBLISHED_DRAFT_REPAIR || candidate.baseSha === candidate.headSha,
    candidate.kind !== PUBLISHED_DRAFT_REPAIR || candidate.baseTree === candidate.headTree,
  ].every(Boolean);
  if (!matches) {
    return undefined;
  }
  return repair.source;
};
