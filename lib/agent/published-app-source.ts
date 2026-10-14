import type { ExistingDraftObservation } from "../repository/github-draft-update";
import type { DraftPullRequestSuccessReceipt } from "../repository/github-publication";
import type { ReviewedChangeSetReceipt } from "../repository/reviewed-change-set";
import { publishedAppSourceSchema } from "../provisioning/hosted-operator-artifact-selection";
import { operatorArtifactUnavailable } from "../provisioning/hosted-operator-artifact-store";
import { recordPublishedOperatorSourceForSession } from "./compiled-operator-artifacts";
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
  },
) => {
  if (input.review.appSpecDigest !== input.appSpecDigest) {
    throw operatorArtifactUnavailable();
  }
  return await recordPublishedOperatorSourceForSession({
    ...input,
    // A retained initial receipt must reuse its original marker instead of becoming a newer source on retry.
    callId: "kind" in input.publication ? input.publication.approvedByCallId : input.callId,
    publishedSource: publishedAppSourceFromResult(input.review, input.publication),
  });
};
