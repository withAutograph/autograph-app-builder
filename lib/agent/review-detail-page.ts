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

export interface ReviewDetailNextCall {
  view: "acceptance";
  detailSection: ReviewDetailSection;
  expectedReviewDigest: string;
  sourceAssessmentBindingDigest?: string;
  detailCursor: ReviewDetailCursor;
}

export interface ReviewDetailPage {
  complete: boolean;
  nextCall?: ReviewDetailNextCall;
  detailCursor?: ReviewDetailCursor;
  reviewReference: {
    digest: string;
    kind: "current-session-reviewed-change-set";
    sessionId: string;
  };
  digest: string;
  mediaType: "application/json";
  section: ReviewDetailSection;
  offsetBytes: number;
  totalBytes: number;
  content: string;
}

const modelOutputCharacters = (output: ReviewDetailPage): number =>
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
  const { sourceAssessment } = input.details.productAcceptance;
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
    makePayload: (piece, nextOffsetBytes): ReviewDetailPage => {
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
