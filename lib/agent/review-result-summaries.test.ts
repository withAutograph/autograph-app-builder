import { describe, expect, it } from "vitest";
import type { ReviewedChangeSetReceipt } from "../repository/reviewed-change-set";
import { reviewedChangeSetSummary } from "./review-result-summaries";
import type { ReviewedChangeSetSummaryInput } from "./review-result-summaries";
import { readOwnedReviewDetailPage } from "./review-detail-pages";
import type { ReviewDetailCursor } from "./review-detail-pages";
import { serializedNativeActionResultBytes } from "../eve/payload-envelope";

const receipt: ReviewedChangeSetReceipt = {
  appSpecDigest: "spec",
  appSpecPath: "spec.md",
  applyDigest: "apply",
  approvedPaths: ["apps/example/index.ts"],
  artifactRevision: "revision",
  changeSetDigest: "change-set",
  changedContentDigest: "changed-content",
  changes: [{ kind: "added", path: "apps/example/index.ts" }],
  contractDigest: "contract",
  dependencyCacheContentDigest: "cache-content",
  dependencyCacheDigest: "cache",
  dependencyReceiptDigest: "dependencies",
  digest: "review",
  eligibilityDigest: "eligibility",
  identityDigest: "identity",
  imageDigest: "image",
  postTreeDigest: "post-tree",
  preTreeDigest: "pre-tree",
  proposalDigest: "proposal",
  repositoryContractDigest: "repository-contract",
  reviewedByCallId: "review-call",
  sourceReceiptDigest: "source-receipt",
  sourceSha: "source-sha",
  sourceTree: "source-tree",
  targetReceipt: {
    topology: { newDigest: "new", oldDigest: "old", path: "topology" },
    version: 1,
  },
  validationDigest: "validation",
  version: 2,
  workspaceDigest: "workspace",
};

const sourceAssessment: ReviewedChangeSetSummaryInput["sourceAssessment"] = {
  basis: "source-review",
  bindingDigest: "source-binding",
  evidenceDigest: "source-evidence",
  evidenceNote: "Source evidence only",
  findings: [],
  modelId: "review-model",
  omissions: [],
  reason: "Runtime verification remains pending",
  remainingRuntimeChecks: ["Save and reload"],
  reviewCompleted: true,
  status: "unassessed",
};

const input: ReviewedChangeSetSummaryInput = {
  productAcceptance: {
    appSpecDigest: "spec",
    evidence: [{ result: "passed" }],
    implementationPrompt: "Implement the walkthrough",
    productStatus: "unassessed",
    reason: "Product evidence is pending",
    sourceAssessment,
    walkthrough: "Save and reload",
  },
  receipt,
  reused: false,
  sessionId: "owner-session",
  sourceAssessment,
};

describe("review result summaries", () => {
  it("replays full authoritative receipt and acceptance bytes through owner/session detail pages", () => {
    const details = {
      productAcceptance: {
        ...input.productAcceptance,
        walkthrough: 'Review "quoted" 💙 source\n'.repeat(2000),
      },
      reviewReceipt: receipt,
    };
    const metadata = {
      callId: "owned-call",
      deliveryIds: ["native-delivery"],
      toolName: "change_set_status",
      turnId: "owned-turn",
    };
    let cursor: ReviewDetailCursor | undefined;
    const parts: string[] = [];
    do {
      const page = readOwnedReviewDetailPage({
        cursor,
        details,
        maxBytes: 1800,
        metadata,
        sessionId: "owner-session",
      });
      expect(serializedNativeActionResultBytes(page, metadata)).toBeLessThanOrEqual(1800);
      expect(page.reviewReference).toEqual({
        digest: receipt.digest,
        kind: "current-session-reviewed-change-set",
        sessionId: "owner-session",
      });
      parts.push(page.content);
      cursor = page.detailCursor;
    } while (cursor !== undefined);
    expect(parts.length).toBeGreaterThan(1);
    expect(JSON.parse(parts.join(""))).toEqual(details);
    const first = readOwnedReviewDetailPage({
      details,
      maxBytes: 1800,
      metadata,
      sessionId: "owner-session",
    });
    expect(() =>
      readOwnedReviewDetailPage({
        cursor: first.detailCursor,
        details: { ...details, reviewReceipt: { ...receipt, digest: "changed-review" } },
        maxBytes: 1800,
        metadata,
        sessionId: "owner-session",
      }),
    ).toThrow("current owner/session review");
  });
  it("retains bindings, counts, and current session references", () => {
    expect(reviewedChangeSetSummary(input)).toEqual({
      approvedPathCount: 1,
      changeSetDigest: "change-set",
      changedContentDigest: "changed-content",
      digest: "review",
      postTreeDigest: "post-tree",
      productAcceptance: {
        appSpecDigest: "spec",
        detailReference: {
          appSpecDigest: "spec",
          applyDigest: "apply",
          kind: "current-session-product-acceptance",
          sessionId: "owner-session",
        },
        evidenceCount: 1,
        productStatus: "unassessed",
        walkthroughPresent: true,
      },
      reused: false,
      reviewReference: {
        digest: "review",
        kind: "current-session-reviewed-change-set",
        sessionId: "owner-session",
      },
      sourceAssessment: {
        bindingDigest: "source-binding",
        detailReference: {
          bindingDigest: "source-binding",
          kind: "current-session-source-assessment",
          sessionId: "owner-session",
        },
        evidenceDigest: "source-evidence",
        findingCount: 0,
        omissionCount: 0,
        remainingRuntimeCheckCount: 1,
        reviewCompleted: true,
        status: "unassessed",
      },
      sourceSha: "source-sha",
      sourceTree: "source-tree",
      validationDigest: "validation",
    });
  });

  it("does not duplicate large authoritative details or mutate inputs", () => {
    const largeText = "PRIVATE_DETAIL".repeat(100_000);
    const largeInput: ReviewedChangeSetSummaryInput = {
      ...input,
      productAcceptance: {
        ...input.productAcceptance,
        evidence: Array.from({ length: 1000 }, () => ({ detail: largeText })),
        implementationPrompt: largeText,
        reason: largeText,
        walkthrough: largeText,
      },
      receipt: {
        ...receipt,
        approvedPaths: Array.from({ length: 10_000 }, (_, index) => `apps/example/${index}.ts`),
        changes: Array.from({ length: 10_000 }, (_, index) => ({
          kind: "added",
          path: `apps/example/${index}.ts`,
        })),
      },
      sourceAssessment: {
        ...input.sourceAssessment,
        evidenceNote: largeText,
        findings: Array.from({ length: 1000 }, () => ({
          citations: [],
          explanation: largeText,
          repair: largeText,
          requirement: largeText,
          requirementQuoteDigest: "quote",
        })),
        omissions: Array.from({ length: 1000 }, () => largeText),
        reason: largeText,
        remainingRuntimeChecks: Array.from({ length: 1000 }, () => largeText),
      },
    };
    Object.freeze(largeInput.receipt.changes);
    Object.freeze(largeInput.receipt.approvedPaths);
    Object.freeze(largeInput.receipt);
    Object.freeze(largeInput.productAcceptance.evidence);
    Object.freeze(largeInput.productAcceptance);
    Object.freeze(largeInput.sourceAssessment.findings);
    Object.freeze(largeInput.sourceAssessment.omissions);
    Object.freeze(largeInput.sourceAssessment.remainingRuntimeChecks);
    Object.freeze(largeInput.sourceAssessment);
    Object.freeze(largeInput);
    const summary = reviewedChangeSetSummary(largeInput);
    const serialized = JSON.stringify(summary);
    expect(Buffer.byteLength(serialized)).toBeLessThan(2000);
    expect(serialized).not.toContain("PRIVATE_DETAIL");
    expect(summary.approvedPathCount).toBe(10_000);
    expect(summary.productAcceptance.evidenceCount).toBe(1000);
    expect(summary.sourceAssessment.findingCount).toBe(1000);
    expect(summary.sourceAssessment.omissionCount).toBe(1000);
    expect(summary.sourceAssessment.remainingRuntimeCheckCount).toBe(1000);
    expect(largeInput.receipt.changes).toHaveLength(10_000);
    expect(largeInput.productAcceptance.walkthrough).toBe(largeText);
    expect(largeInput.sourceAssessment.findings[0]?.explanation).toBe(largeText);
    expect(summary.reviewReference).toEqual(reviewedChangeSetSummary(input).reviewReference);
    expect(summary.productAcceptance.detailReference).toEqual(
      reviewedChangeSetSummary(input).productAcceptance.detailReference,
    );
    const ordinaryAssessment = reviewedChangeSetSummary(input).sourceAssessment;
    expect("detailReference" in summary.sourceAssessment).toBe(true);
    expect("detailReference" in ordinaryAssessment).toBe(true);
    if ("detailReference" in summary.sourceAssessment && "detailReference" in ordinaryAssessment) {
      expect(summary.sourceAssessment.detailReference).toEqual(ordinaryAssessment.detailReference);
    }
  });

  it("preserves failure and reuse flags without inventing walkthroughs", () => {
    const summary = reviewedChangeSetSummary({
      ...input,
      productAcceptance: { ...input.productAcceptance, productStatus: "failed", walkthrough: "" },
      reused: true,
      sourceAssessment: { ...input.sourceAssessment, reviewCompleted: false, status: "blocked" },
    });
    expect(summary.reused).toBe(true);
    expect(summary.productAcceptance.productStatus).toBe("failed");
    expect(summary.productAcceptance.walkthroughPresent).toBe(false);
    expect(summary.sourceAssessment.status).toBe("blocked");
    expect(summary.sourceAssessment.reviewCompleted).toBe(false);
    expect("detailReference" in summary.sourceAssessment).toBe(false);
    expect("reason" in summary.sourceAssessment).toBe(true);
    if ("reason" in summary.sourceAssessment) {
      expect(summary.sourceAssessment.reason).toBe(input.sourceAssessment.reason);
    }
  });
});
