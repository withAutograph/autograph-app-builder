import { createHash } from "node:crypto";

import {
  EVE_NATIVE_RESULT_PAGE_BYTES,
  largestUtf8PayloadChunk,
  serializedNativeActionResultBytes,
  fitOutputNativeFrame,
} from "../eve/payload-envelope";
import type { NativeActionResultMetadata } from "../eve/payload-envelope";
import type { ReviewedChangeSetReceipt } from "../repository/reviewed-change-set";
import type { productAcceptanceObligations } from "./product-acceptance";
import { productAcceptanceObligations as acceptanceObligations } from "./product-acceptance";
import type { AppBuilderWorkflowState } from "./workflow-state";
import {
  productRequestState,
  currentProductSourceAssessment,
  retainedProductSourceAssessmentForReference,
} from "./product-source-review-state";
import { currentProductBehaviorEvidence } from "./product-behavior-state";

export interface OwnedReviewDetails {
  reviewReceipt: ReviewedChangeSetReceipt;
  productAcceptance: ReturnType<typeof productAcceptanceObligations>;
}
export interface ReviewDetailCursor {
  digest: string;
  offsetBytes: number;
}

export type ReviewDetailSection = "all" | "source-assessment";

/** eve 0.68 capToolResults measures JSON.stringify(tool-result output) in UTF-16 units. */
export const EVE_REVIEW_DETAIL_HISTORY_CHARACTERS = 2000;

const modelOutputCharacters = (output: object): number =>
  JSON.stringify({ type: "json", value: output }).length;

/** Full receipt and acceptance data remain in their original owner/session state. */
export const readOwnedReviewDetailPage = (input: {
  details: OwnedReviewDetails;
  sessionId: string;
  metadata: NativeActionResultMetadata;
  cursor?: ReviewDetailCursor;
  section?: ReviewDetailSection;
  maxBytes?: number;
}) => {
  const section = input.section ?? "all";
  const sourceAssessment = input.details.productAcceptance.sourceAssessment;
  if (section === "source-assessment" && sourceAssessment === undefined) {
    throw new Error("The source assessment is unavailable in this owner/session context.");
  }
  const content = JSON.stringify(section === "all" ? input.details : sourceAssessment);
  const digest = createHash("sha256")
    .update(JSON.stringify([input.sessionId, input.details.reviewReceipt.digest, section]))
    .update(content, "utf-8")
    .digest("hex");
  if (input.cursor !== undefined && input.cursor.digest !== digest) {
    throw new Error(
      "The detail cursor no longer matches the current owner/session review. Start its details from the first page.",
    );
  }
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const offsetBytes = input.cursor?.offsetBytes ?? 0;
  const maxBytes = input.maxBytes ?? EVE_NATIVE_RESULT_PAGE_BYTES;
  const chunk = largestUtf8PayloadChunk({
    content,
    makePayload: (piece, nextOffsetBytes) => {
      const detailCursor =
        nextOffsetBytes < totalBytes ? { digest, offsetBytes: nextOffsetBytes } : undefined;
      return {
        complete: nextOffsetBytes === totalBytes,
        nextCall:
          detailCursor === undefined
            ? undefined
            : {
                view: "acceptance" as const,
                detailSection: section,
                expectedReviewDigest: input.details.reviewReceipt.digest,
                ...(sourceAssessment === undefined
                  ? {}
                  : { sourceAssessmentBindingDigest: sourceAssessment.bindingDigest }),
                detailCursor,
              },
        detailCursor,
        reviewReference: {
          digest: input.details.reviewReceipt.digest,
          kind: "current-session-reviewed-change-set" as const,
          sessionId: input.sessionId,
        },
        digest,
        mediaType: "application/json" as const,
        section,
        offsetBytes,
        totalBytes,
        content: piece,
      };
    },
    maxBytes,
    measurePayloadBytes: (output) =>
      modelOutputCharacters(output) <= EVE_REVIEW_DETAIL_HISTORY_CHARACTERS
        ? serializedNativeActionResultBytes(output, input.metadata)
        : maxBytes + 1,
    offsetBytes,
  });
  return fitOutputNativeFrame(chunk.payload, input.metadata, maxBytes);
};

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
