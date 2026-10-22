import type { DraftReconciliationCompletion } from "./draft-reconciliation-state";
import type { AppDescription } from "../repository/app-description";
import type { ReconciliationReviewReceipt } from "../repository/github-draft-reconciliation";
import type { ExistingDraftObservation } from "../repository/github-draft-update";
import type { DraftPullRequestSuccessReceipt } from "../repository/github-publication";
import type { ReviewedChangeSetReceipt } from "../repository/reviewed-change-set";
import { publishedAppSourceSchema } from "../provisioning/hosted-operator-artifact-selection";
import { operatorArtifactUnavailable } from "../provisioning/hosted-operator-artifact-store";
import {
  recordPublishedOperatorSourceForSession,
  recordPublishedReconciliationSourceForSession,
} from "./compiled-operator-artifacts";
import type { CompiledOperatorArtifactSessionInput } from "./compiled-operator-artifacts";

export type PublishedAppSourceResult = DraftPullRequestSuccessReceipt | ExistingDraftObservation;
export type PublishedAppSourceReview = Pick<
  ReviewedChangeSetReceipt,
  "appSpecDigest" | "changeSetDigest" | "digest"
>;

/** Fields come from the actual approved publisher's independently observed result. */
export const publishedAppSourceFromResult = (
  review: PublishedAppSourceReview,
  publication: PublishedAppSourceResult,
) =>
  publishedAppSourceSchema.parse({
    ...("kind" in publication
      ? {
          branch: publication.branchName,
          gitSha: publication.branchSha,
          gitTree: publication.branchTree,
        }
      : {
          branch: publication.headBranch,
          gitSha: publication.headSha,
          gitTree: publication.headTree,
        }),
    changeSetDigest: review.changeSetDigest,
    repositoryId: publication.repositoryId,
    reviewDigest: review.digest,
  });

/** Trusted publication-tool completion hook; it neither supplies source bytes nor publishes Git. */
export const recordPublishedAppSourceForSession = async (
  input: CompiledOperatorArtifactSessionInput & {
    publication: PublishedAppSourceResult;
    review: PublishedAppSourceReview;
    backendKind?: AppDescription["backend"]["kind"];
    reconciliationReview?: Pick<ReconciliationReviewReceipt, "digest">;
  },
) => {
  if (input.review.appSpecDigest !== input.appSpecDigest) {
    throw operatorArtifactUnavailable();
  }
  const publishedSource = publishedAppSourceFromResult(input.review, input.publication);
  return await recordPublishedOperatorSourceForSession({
    ...input,
    // A retained initial receipt must reuse its original marker instead of becoming a newer source on retry.
    callId: "kind" in input.publication ? input.publication.approvedByCallId : input.callId,
    // The app review identifies the compiled app; the reconciliation review identifies the approved merged source.
    publishedSource:
      input.reconciliationReview === undefined
        ? publishedSource
        : { ...publishedSource, reviewDigest: input.reconciliationReview.digest },
  });
};

/** Recovery consumes only the sealed metadata and a provider-verified result, never current candidate bytes. */
export const recordPublishedReconciliationForSession = async (input: {
  completion: DraftReconciliationCompletion;
  publication: ExistingDraftObservation;
  sessionAuth: unknown;
  adapterSessionId: string;
  recordCurrentEquivalentRelease?: true;
  callbackExecution?: CompiledOperatorArtifactSessionInput["callbackExecution"];
}) => {
  const { completion, publication } = input;
  if (
    publication.repositoryId !== completion.proposal.repositoryId ||
    publication.headBranch !== completion.proposal.branchName ||
    publication.headTree !== completion.proposal.resolvedTree
  ) {
    throw operatorArtifactUnavailable();
  }
  return await recordPublishedReconciliationSourceForSession({
    ...input,
    publishedSource: {
      ...publishedAppSourceFromResult(completion.appReview, publication),
      reviewDigest: completion.review.digest,
    },
  });
};
