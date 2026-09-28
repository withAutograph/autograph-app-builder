import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { ReviewedChangeSetReceipt } from "./reviewed-change-set";
import type { GitHubDraftAdoption } from "./postgres-github-draft-adoption-store";
import { readExactGitHubPublicationContent } from "./github-publication";
import type {
  DraftPullRequestSuccessReceipt,
  GitHubDraftPullRequestContent,
  GitHubDraftPullRequestContentSource,
  GitHubInstallationIdentity,
  GitHubMutationAcknowledgement,
  GitHubRepositoryObservation,
} from "./github-publication";

type DigestMaterial =
  | Omit<ExistingDraftUpdateProposal, "digest">
  | Omit<ExistingDraftUpdateProposal, "digest" | "idempotencyKey">;

const hash = (value: DigestMaterial) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** A fresh, provider-observed PR and head reference, never caller-supplied authority. */
export interface ExistingDraftObservation {
  repositoryId: string;
  owner: string;
  name: string;
  number: number;
  pullRequestId: string;
  draft: boolean;
  state: "open" | "closed";
  headRepositoryId: string;
  headBranch: string;
  headSha: string;
  headTree: string;
  baseRepositoryId: string;
  baseBranch: string;
  verifiedBuilderOrigin?: {
    appId: string;
    authorId: string;
    marker: string;
  };
}

export interface ExistingDraftUpdateProposal {
  version: 1;
  intendedOutcome: "update-existing-draft-pull-request";
  installationIdentityDigest: string;
  repositoryId: string;
  owner: string;
  name: string;
  pullRequestNumber: number;
  pullRequestId: string;
  branchName: string;
  expectedHeadSha: string;
  expectedHeadTree: string;
  priorPublicationDigest: string;
  originMarker: string;
  baseBranch: string;
  reviewDigest: string;
  changeSetDigest: string;
  changedContentDigest: string;
  approvedPaths: readonly string[];
  idempotencyKey: string;
  digest: string;
}

export interface ExistingDraftUpdateAdapter {
  inspectInstallation: () => Promise<GitHubInstallationIdentity>;
  inspectDraft: (input: {
    repositoryId: string;
    owner: string;
    name: string;
    number: number;
  }) => Promise<ExistingDraftObservation>;
  updateDraft: (
    proposal: ExistingDraftUpdateProposal,
    content: GitHubDraftPullRequestContent,
  ) => Promise<GitHubMutationAcknowledgement>;
  inspectAppliedUpdate: (
    proposal: ExistingDraftUpdateProposal,
    content: GitHubDraftPullRequestContent,
    observed: ExistingDraftObservation,
  ) => Promise<boolean>;
}

const sameDraft = (proposal: ExistingDraftUpdateProposal, observed: ExistingDraftObservation) =>
  isDeepStrictEqual(
    {
      baseBranch: observed.baseBranch,
      baseRepositoryId: observed.baseRepositoryId,
      draft: observed.draft,
      headBranch: observed.headBranch,
      headRepositoryId: observed.headRepositoryId,
      name: observed.name,
      number: observed.number,
      owner: observed.owner,
      pullRequestId: observed.pullRequestId,
      repositoryId: observed.repositoryId,
      state: observed.state,
    },
    {
      baseBranch: proposal.baseBranch,
      baseRepositoryId: proposal.repositoryId,
      draft: true,
      headBranch: proposal.branchName,
      headRepositoryId: proposal.repositoryId,
      name: proposal.name,
      number: proposal.pullRequestNumber,
      owner: proposal.owner,
      pullRequestId: proposal.pullRequestId,
      repositoryId: proposal.repositoryId,
      state: "open",
    },
  );

// oxlint-disable-next-line eslint/complexity -- seal checks installation, exact PR identity, checkout head, and verified adoption before creating an update proposal
export const sealExistingDraftUpdate = async (input: {
  adapter: ExistingDraftUpdateAdapter;
  installation: GitHubInstallationIdentity;
  repository: GitHubRepositoryObservation;
  review: ReviewedChangeSetReceipt;
  pullRequestNumber: number;
  priorPublication?: DraftPullRequestSuccessReceipt;
  adoptedDraft?: GitHubDraftAdoption;
  selectedSourceRef: string;
  selectedCheckoutHeadSha: string;
  selectedCheckoutHeadTree: string;
}): Promise<ExistingDraftUpdateProposal> => {
  if (!Number.isSafeInteger(input.pullRequestNumber) || input.pullRequestNumber < 1) {
    throw new Error("Choose a positive pull request number for the draft update.");
  }
  if (
    input.installation.operation !== "publish-draft-pull-request" ||
    input.repository.installationIdentityDigest !== input.installation.digest ||
    !input.installation.selectedRepositoryIds.includes(input.repository.repositoryId)
  ) {
    throw new Error("The selected GitHub installation cannot update this repository.");
  }
  const observed = await input.adapter.inspectDraft({
    name: input.repository.name,
    number: input.pullRequestNumber,
    owner: input.repository.owner,
    repositoryId: input.repository.repositoryId,
  });
  if (input.selectedSourceRef !== `refs/heads/${observed.headBranch}`) {
    throw new Error(
      "The reviewed Builder source is not this draft PR branch. Start a new Builder session, select the draft PR as the source, and review its current app diff before updating it.",
    );
  }
  if (
    input.selectedCheckoutHeadSha !== observed.headSha ||
    input.selectedCheckoutHeadTree !== observed.headTree
  ) {
    throw new Error(
      "The draft PR branch moved since Builder prepared this checkout. Reopen the current PR branch as the app source, review the resulting diff, and seal the update again.",
    );
  }
  if (
    input.priorPublication !== undefined &&
    !isDeepStrictEqual(
      {
        branchName: observed.headBranch,
        pullRequestNumber: observed.number,
        repositoryId: observed.repositoryId,
      },
      {
        branchName: input.priorPublication.branchName,
        pullRequestNumber: input.priorPublication.pullRequestNumber,
        repositoryId: input.priorPublication.repositoryId,
      },
    )
  ) {
    throw new Error(
      "The draft PR is not Builder's previously approved publication. Inspect its origin and select the correct PR before updating.",
    );
  }
  if (
    input.priorPublication === undefined &&
    (input.adoptedDraft === undefined ||
      observed.verifiedBuilderOrigin === undefined ||
      !isDeepStrictEqual(
        {
          appId: observed.verifiedBuilderOrigin.appId,
          authorId: observed.verifiedBuilderOrigin.authorId,
          builderMarker: observed.verifiedBuilderOrigin.marker,
          pullRequestId: observed.pullRequestId,
          pullRequestNumber: observed.number,
          repositoryId: observed.repositoryId,
        },
        {
          appId: input.adoptedDraft.appId,
          authorId: input.adoptedDraft.authorId,
          builderMarker: input.adoptedDraft.builderMarker,
          pullRequestId: input.adoptedDraft.pullRequestId,
          pullRequestNumber: input.adoptedDraft.pullRequestNumber,
          repositoryId: input.adoptedDraft.repositoryId,
        },
      ))
  ) {
    throw new Error(
      "Builder cannot verify this draft PR's author and matching PR/head commit origin marker. Refresh its GitHub provenance, then retry; no branch was changed.",
    );
  }
  if (
    !isDeepStrictEqual(
      {
        baseBranch: observed.baseBranch,
        baseRepositoryId: observed.baseRepositoryId,
        draft: observed.draft,
        headRepositoryId: observed.headRepositoryId,
        name: observed.name,
        number: observed.number,
        owner: observed.owner,
        repositoryId: observed.repositoryId,
        state: observed.state,
      },
      {
        baseBranch: input.repository.defaultBranch,
        baseRepositoryId: input.repository.repositoryId,
        draft: true,
        headRepositoryId: input.repository.repositoryId,
        name: input.repository.name,
        number: input.pullRequestNumber,
        owner: input.repository.owner,
        repositoryId: input.repository.repositoryId,
        state: "open",
      },
    )
  ) {
    throw new Error(
      "The selected pull request is not an open draft in the selected repository with a branch in that repository. Choose the correct draft PR and review its current files.",
    );
  }
  const unsigned = {
    approvedPaths: input.review.approvedPaths,
    baseBranch: observed.baseBranch,
    branchName: observed.headBranch,
    changeSetDigest: input.review.changeSetDigest,
    changedContentDigest: input.review.changedContentDigest,
    expectedHeadSha: observed.headSha,
    expectedHeadTree: observed.headTree,
    installationIdentityDigest: input.installation.digest,
    intendedOutcome: "update-existing-draft-pull-request" as const,
    name: observed.name,
    originMarker:
      observed.verifiedBuilderOrigin?.marker ?? input.priorPublication?.idempotencyKey ?? "",
    owner: observed.owner,
    priorPublicationDigest:
      input.priorPublication?.digest ?? input.adoptedDraft?.adoptionDigest ?? "",
    pullRequestId: observed.pullRequestId,
    pullRequestNumber: observed.number,
    repositoryId: observed.repositoryId,
    reviewDigest: input.review.digest,
    version: 1 as const,
  };
  const idempotencyKey = hash(unsigned);
  return { ...unsigned, digest: hash({ ...unsigned, idempotencyKey }), idempotencyKey };
};

// oxlint-disable-next-line eslint/complexity -- verifies sealed review, current PR, and uncertain-result recovery in one operation
export const updateExistingDraft = async (input: {
  adapter: ExistingDraftUpdateAdapter;
  proposal: ExistingDraftUpdateProposal;
  review: ReviewedChangeSetReceipt;
  contentSource: GitHubDraftPullRequestContentSource;
}): Promise<ExistingDraftObservation> => {
  const { proposal } = input;
  const { digest: proposalDigest, ...unsigned } = proposal;
  const { idempotencyKey, ...identity } = unsigned;
  if (proposal.version !== 1 || proposal.intendedOutcome !== "update-existing-draft-pull-request") {
    throw new Error("The draft update proposal has an invalid operation. Seal a new proposal.");
  }
  const reviewMatches = isDeepStrictEqual(
    [
      proposal.reviewDigest,
      proposal.changeSetDigest,
      proposal.changedContentDigest,
      proposal.approvedPaths,
    ],
    [
      input.review.digest,
      input.review.changeSetDigest,
      input.review.changedContentDigest,
      input.review.approvedPaths,
    ],
  );
  if (!reviewMatches || proposalDigest !== hash(unsigned) || idempotencyKey !== hash(identity)) {
    throw new Error(
      "The draft update proposal no longer matches the reviewed app change set. Review and seal it again.",
    );
  }
  const installation = await input.adapter.inspectInstallation();
  if (
    installation.digest !== proposal.installationIdentityDigest ||
    !installation.selectedRepositoryIds.includes(proposal.repositoryId)
  ) {
    throw new Error(
      "GitHub installation access changed before the draft update. Reconnect access and seal a new proposal.",
    );
  }
  const current = await input.adapter.inspectDraft({
    name: proposal.name,
    number: proposal.pullRequestNumber,
    owner: proposal.owner,
    repositoryId: proposal.repositoryId,
  });
  if (!sameDraft(proposal, current)) {
    throw new Error(
      "The pull request changed or is no longer an open draft in the selected repository. Review it again.",
    );
  }
  const content = await readExactGitHubPublicationContent({
    proposal,
    review: input.review,
    source: input.contentSource,
  });
  if (
    current.headSha !== proposal.expectedHeadSha ||
    current.headTree !== proposal.expectedHeadTree
  ) {
    if (await input.adapter.inspectAppliedUpdate(proposal, content, current)) {
      return current;
    }
    throw new Error(
      "The draft PR branch moved after review and does not contain the exact approved update. Reopen its current branch, review the diff, and request update approval again.",
    );
  }
  let result: GitHubMutationAcknowledgement;
  try {
    result = await input.adapter.updateDraft(proposal, content);
  } catch (error) {
    const latest = await input.adapter.inspectDraft({
      name: proposal.name,
      number: proposal.pullRequestNumber,
      owner: proposal.owner,
      repositoryId: proposal.repositoryId,
    });
    if (
      sameDraft(proposal, latest) &&
      (await input.adapter.inspectAppliedUpdate(proposal, content, latest))
    ) {
      return latest;
    }
    throw error;
  }
  if (result.status === "rejected") {
    if (result.code === "reviewed-path-changed") {
      throw new Error(
        `The draft PR branch contains different content at ${result.path ?? "a reviewed path"} than the app diff used for approval. Reopen the app from the PR branch, review its current files, seal a new update proposal, and request approval again.`,
      );
    }
    const location = result.path === undefined ? "" : `: ${result.path}`;
    throw new Error(
      `GitHub rejected the draft PR update (${result.code}${location}). Refresh the branch and reviewed app diff before retrying.`,
    );
  }
  const updated = await input.adapter.inspectDraft({
    name: proposal.name,
    number: proposal.pullRequestNumber,
    owner: proposal.owner,
    repositoryId: proposal.repositoryId,
  });
  if (
    !sameDraft(proposal, updated) ||
    !(await input.adapter.inspectAppliedUpdate(proposal, content, updated))
  ) {
    throw new Error(
      "GitHub accepted the draft update, but its new branch head could not be verified. Inspect the PR before retrying.",
    );
  }
  return updated;
};
