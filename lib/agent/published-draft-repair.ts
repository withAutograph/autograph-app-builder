import { createHash } from "node:crypto";
import type { AppBuilderWorkflowState } from "./workflow-state";
import type {
  DraftReconciliationCandidate,
  DraftPublicationCompletion,
} from "./draft-reconciliation-state";
import { assertOwnedPublicationReconciliationScope } from "../repository/github-draft-reconciliation";
import { assertExactImmutableGitHubSourceReceipt } from "../repository/github-publication";
import type { ImmutableGitHubSourceReceipt } from "../repository/github-publication";
import type { ExistingDraftObservation } from "../repository/github-draft-update";

/** A second acquired source; the accepted fresh-template workflow remains its origin. */
export interface PublishedDraftRepairSource {
  kind: "published-draft-repair";
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
  const draft = value.draft;
  const material = {
    kind: value.kind,
    version: value.version,
    appId: value.appId,
    appSpecDigest: value.appSpecDigest,
    originSourceReceiptDigest: value.originSourceReceiptDigest,
    publicationProposalDigest: value.publicationProposalDigest,
    publicationDigest: value.publicationDigest,
    installationId: value.installationId,
    sourceDigest: value.source.digest,
    draft: {
      repositoryId: draft.repositoryId,
      owner: draft.owner,
      name: draft.name,
      number: draft.number,
      pullRequestId: draft.pullRequestId,
      draft: draft.draft,
      state: draft.state,
      headRepositoryId: draft.headRepositoryId,
      headBranch: draft.headBranch,
      headSha: draft.headSha,
      headTree: draft.headTree,
      baseRepositoryId: draft.baseRepositoryId,
      baseBranch: draft.baseBranch,
      verifiedBuilderOrigin:
        draft.verifiedBuilderOrigin === undefined
          ? undefined
          : {
              appId: draft.verifiedBuilderOrigin.appId,
              authorId: draft.verifiedBuilderOrigin.authorId,
              marker: draft.verifiedBuilderOrigin.marker,
            },
    },
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
};

export const draftCandidateValidationDigest = (
  validation: NonNullable<DraftReconciliationCandidate["validation"]>,
): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        resolvedTree: validation.resolvedTree,
        commands: validation.commands.map(({ command, exitCode }) => ({ command, exitCode })),
        validatedByCallId: validation.validatedByCallId,
      }),
    )
    .digest("hex");

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
    receipt.kind === "published-draft-repair",
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
  const unsigned = { kind: "published-draft-repair" as const, version: 1 as const, ...input };
  const receipt = { ...unsigned, digest: digest(unsigned) };
  assertPublishedDraftRepairSource(receipt);
  return receipt;
};

/** One authority predicate for every candidate consumer, including compiled source capture. */
export const currentDraftCandidateSource = (
  state: AppBuilderWorkflowState,
  candidate: DraftReconciliationCandidate | null,
): ImmutableGitHubSourceReceipt | undefined => {
  if (
    state.phase !== "reviewed" ||
    candidate === null ||
    state.reviewReceipt.digest !== candidate.originalReviewDigest
  ) {
    return undefined;
  }
  const repair =
    candidate.kind === "published-draft-repair" ? candidate.repair : candidate.publishedOrigin;
  if (repair === undefined) {
    return candidate.publicationScope === undefined &&
      state.githubSource?.digest === candidate.githubSourceDigest
      ? state.githubSource
      : undefined;
  }
  assertPublishedDraftRepairSource(repair);
  if (candidate.kind !== "published-draft-repair") {
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
    candidate.kind !== "published-draft-repair" || candidate.baseSha === candidate.headSha,
    candidate.kind !== "published-draft-repair" || candidate.baseTree === candidate.headTree,
  ].every(Boolean);
  if (!matches) {
    return undefined;
  }
  return repair.source;
};

const publishedOriginInstallation = (origin: PublishedDraftRepairSource | undefined) => {
  if (origin === undefined) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Keep the optional selected-installation return explicit on both branches.
    return undefined;
  }
  assertPublishedDraftRepairSource(origin);
  return { selectedInstallationId: origin.installationId };
};

export const draftCandidateInstallation = (candidate: DraftReconciliationCandidate) =>
  publishedOriginInstallation(
    candidate.kind === "published-draft-repair" ? candidate.repair : candidate.publishedOrigin,
  );

export const draftCompletionInstallation = (completion: DraftPublicationCompletion) =>
  publishedOriginInstallation(
    "kind" in completion ? completion.repair : completion.publishedOrigin,
  );
