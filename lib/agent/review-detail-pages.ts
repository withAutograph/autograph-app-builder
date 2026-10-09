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

/** Full receipt and acceptance data remain in their original owner/session state. */
export const readOwnedReviewDetailPage = (input: {
  details: OwnedReviewDetails;
  sessionId: string;
  metadata: NativeActionResultMetadata;
  cursor?: ReviewDetailCursor;
  maxBytes?: number;
}) => {
  const content = JSON.stringify(input.details);
  const digest = createHash("sha256").update(content, "utf-8").digest("hex");
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
    makePayload: (piece, nextOffsetBytes) => ({
      complete: nextOffsetBytes === totalBytes,
      content: piece,
      detailCursor:
        nextOffsetBytes < totalBytes ? { digest, offsetBytes: nextOffsetBytes } : undefined,
      digest,
      mediaType: "application/json" as const,
      offsetBytes,
      reviewReference: {
        digest: input.details.reviewReceipt.digest,
        kind: "current-session-reviewed-change-set" as const,
        sessionId: input.sessionId,
      },
      totalBytes,
    }),
    maxBytes,
    measurePayloadBytes: (output) => serializedNativeActionResultBytes(output, input.metadata),
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
    sessionId: input.sessionId,
  });
};
