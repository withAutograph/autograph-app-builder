import type { ReviewedChangeSetReceipt } from "../repository/reviewed-change-set";
import type { productAcceptanceObligations } from "./product-acceptance";
import type { ProductSourceAssessment } from "./product-source-review";

export interface ReviewedChangeSetSummaryInput {
  receipt: ReviewedChangeSetReceipt;
  sessionId: string;
  reused: boolean;
  sourceAssessment: ProductSourceAssessment;
  productAcceptance: ReturnType<typeof productAcceptanceObligations>;
}

/** Full details remain authoritative in the owner's current session state. */
export const reviewedChangeSetSummary = ({
  receipt,
  sessionId,
  reused,
  sourceAssessment,
  productAcceptance,
}: ReviewedChangeSetSummaryInput) => ({
  approvedPathCount: receipt.approvedPaths.length,
  changeSetDigest: receipt.changeSetDigest,
  changedContentDigest: receipt.changedContentDigest,
  digest: receipt.digest,
  postTreeDigest: receipt.postTreeDigest,
  productAcceptance: {
    appSpecDigest: productAcceptance.appSpecDigest,
    detailReference: {
      appSpecDigest: productAcceptance.appSpecDigest,
      applyDigest: receipt.applyDigest,
      kind: "current-session-product-acceptance" as const,
      sessionId,
    },
    evidenceCount: productAcceptance.evidence.length,
    productStatus: productAcceptance.productStatus,
    walkthroughPresent: productAcceptance.walkthrough.length > 0,
  },
  reused,
  reviewReference: {
    digest: receipt.digest,
    kind: "current-session-reviewed-change-set" as const,
    sessionId,
  },
  sourceAssessment: {
    bindingDigest: sourceAssessment.bindingDigest,
    ...(sourceAssessment.reviewCompleted
      ? {
          detailReference: {
            bindingDigest: sourceAssessment.bindingDigest,
            kind: "current-session-source-assessment" as const,
            sessionId,
          },
        }
      : { reason: sourceAssessment.reason }),
    evidenceDigest: sourceAssessment.evidenceDigest,
    findingCount: sourceAssessment.findings.length,
    omissionCount: sourceAssessment.omissions.length,
    remainingRuntimeCheckCount: sourceAssessment.remainingRuntimeChecks.length,
    reviewCompleted: sourceAssessment.reviewCompleted,
    status: sourceAssessment.status,
  },
  sourceSha: receipt.sourceSha,
  sourceTree: receipt.sourceTree,
  validationDigest: receipt.validationDigest,
});
