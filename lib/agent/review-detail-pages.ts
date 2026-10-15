import type { NativeActionResultMetadata } from "../eve/payload-envelope";
import { readOwnedReviewDetailPage } from "./review-detail-page";
import type { ReviewDetailCursor, ReviewDetailSection } from "./review-detail-page";
import { productAcceptanceObligations as acceptanceObligations } from "./product-acceptance";
import type { AppBuilderWorkflowState } from "./workflow-state";
import {
  productRequestState,
  currentProductSourceAssessment,
  retainedProductSourceAssessmentForReference,
} from "./product-source-review-state";
import { currentProductBehaviorEvidence } from "./product-behavior-state";

export {
  EVE_REVIEW_DETAIL_HISTORY_CHARACTERS,
  readOwnedReviewDetailPage,
} from "./review-detail-page";
export type {
  OwnedReviewDetails,
  ReviewDetailCursor,
  ReviewDetailNextCall,
  ReviewDetailPage,
  ReviewDetailSection,
} from "./review-detail-page";

/** References resolve only through the active authenticated session's state. */
export const readCurrentOwnedReviewDetails = (input: {
  state: Extract<AppBuilderWorkflowState, { phase: "reviewed" }>;
  sessionId: string;
  metadata: NativeActionResultMetadata;
  cursor?: ReviewDetailCursor;
  expectedReviewDigest?: string;
  sourceAssessmentBindingDigest?: string;
  section?: ReviewDetailSection;
}) => {
  if (
    input.expectedReviewDigest !== undefined &&
    input.expectedReviewDigest !== input.state.reviewReceipt.digest
  ) {
    throw new Error("The review reference belongs to a different current review in this session.");
  }
  const request = productRequestState.get();
  const sourceAssessment =
    input.sourceAssessmentBindingDigest === undefined
      ? currentProductSourceAssessment({
          appSpecDigest: input.state.appSpec.digest,
          clarifications: request.clarifications,
          originalRequest: request.original,
          sourceDigest: input.state.applyReceipt.postTreeDigest,
        })
      : retainedProductSourceAssessmentForReference(input.sourceAssessmentBindingDigest);
  if (input.sourceAssessmentBindingDigest !== undefined && sourceAssessment === undefined) {
    throw new Error(
      "The source assessment reference is unavailable in this owner/session context.",
    );
  }
  return readOwnedReviewDetailPage({
    cursor: input.cursor,
    details: {
      productAcceptance: acceptanceObligations(
        input.state.appSpec,
        currentProductBehaviorEvidence(input.state.appSpec.digest, input.state.applyReceipt.digest),
        sourceAssessment,
      ),
      reviewReceipt: input.state.reviewReceipt,
    },
    metadata: input.metadata,
    section: input.section,
    sessionId: input.sessionId,
  });
};
