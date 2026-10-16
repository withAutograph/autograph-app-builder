import { describe, expect, it } from "vitest";

import {
  draftPreparationPrerequisiteDiagnostic,
  draftPrerequisiteMessage,
  draftSealPrerequisiteDiagnostic,
} from "./draft-reconciliation-prerequisites";

type SealInput = Parameters<typeof draftSealPrerequisiteDiagnostic>[0];

const sealInput = (): SealInput => ({
  candidate: {
    githubSourceDigest: "private-source-binding",
    originalReviewDigest: "private-app-review",
    review: { digest: "private-merge-review" },
    reviewReadProgress: {
      reviewDigest: "private-merge-review",
      baseComplete: true,
      headComplete: true,
    },
    validation: { resolvedTree: "private-tree" },
  },
  expectedReviewDigest: "private-merge-review",
  state: {
    phase: "reviewed",
    githubSource: { digest: "private-source-binding" },
    reviewReceipt: { digest: "private-app-review" },
    sourceReceipt: { sourceKind: "existing-repository" },
  },
});

const candidateFor = (input: SealInput) => {
  if (input.candidate === null) {
    throw new Error("Expected the fixture candidate.");
  }
  return input.candidate;
};

interface SealCase {
  reason: string;
  recovery: string;
  change: (input: SealInput) => void;
}

const sealCases: SealCase[] = [
  {
    reason: "candidate_missing",
    recovery: "prepare-reconciliation",
    change: (input) => {
      input.candidate = null;
    },
  },
  {
    reason: "candidate_review_missing",
    recovery: "review-candidate",
    change: (input) => {
      delete candidateFor(input).review;
    },
  },
  {
    reason: "candidate_validation_missing",
    recovery: "resume-validation",
    change: (input) => {
      delete candidateFor(input).validation;
    },
  },
  {
    reason: "diff_progress_missing",
    recovery: "inspect-diff",
    change: (input) => {
      delete candidateFor(input).reviewReadProgress;
    },
  },
  {
    reason: "diff_progress_review_changed",
    recovery: "inspect-diff",
    change: (input) => {
      candidateFor(input).reviewReadProgress = {
        reviewDigest: "private-old-merge-review",
        baseComplete: true,
        headComplete: true,
      };
    },
  },
  {
    reason: "base_diff_incomplete",
    recovery: "inspect-diff",
    change: (input) => {
      candidateFor(input).reviewReadProgress = {
        reviewDigest: input.expectedReviewDigest,
        baseComplete: false,
        headComplete: true,
      };
    },
  },
  {
    reason: "head_diff_incomplete",
    recovery: "inspect-diff",
    change: (input) => {
      candidateFor(input).reviewReadProgress = {
        reviewDigest: input.expectedReviewDigest,
        baseComplete: true,
        headComplete: false,
      };
    },
  },
  {
    reason: "workflow_not_reviewed",
    recovery: "review-app",
    change: (input) => {
      input.state.phase = "validated";
    },
  },
  {
    reason: "selected_source_missing",
    recovery: "select-source",
    change: (input) => {
      delete input.state.githubSource;
    },
  },
  {
    reason: "source_binding_changed",
    recovery: "prepare-reconciliation",
    change: (input) => {
      input.state.githubSource = { digest: "private-new-source" };
    },
  },
  {
    reason: "app_review_changed",
    recovery: "prepare-reconciliation",
    change: (input) => {
      input.state.reviewReceipt = { digest: "private-new-app-review" };
    },
  },
  {
    reason: "seal_review_input_changed",
    recovery: "use-current-review",
    change: (input) => {
      input.expectedReviewDigest = "private-old-merge-review";
    },
  },
];

describe("draft reconciliation prerequisite diagnostics", () => {
  it("does not diagnose a satisfied seal prerequisite", () => {
    expect(draftSealPrerequisiteDiagnostic(sealInput())).toBeNull();
  });

  it.each(sealCases)(
    "classifies $reason without changing state",
    ({ change, reason, recovery }) => {
      const input = sealInput();
      change(input);
      const before = structuredClone(input);
      const result = draftSealPrerequisiteDiagnostic(input);
      expect(result).toMatchObject({ reason, recovery });
      expect(input).toEqual(before);
      const message = draftPrerequisiteMessage(result, "fallback");
      for (const value of [
        "private-source-binding",
        "private-app-review",
        "private-merge-review",
        "private-tree",
        "private-new-source",
        "private-new-app-review",
        "private-old-merge-review",
      ]) {
        expect(message).not.toContain(value);
      }
    },
  );

  it("reports the first failed seal prerequisite when several are missing", () => {
    const input = sealInput();
    delete candidateFor(input).review;
    delete candidateFor(input).validation;
    delete candidateFor(input).reviewReadProgress;
    input.state.phase = "validated";
    expect(draftSealPrerequisiteDiagnostic(input)?.reason).toBe("candidate_review_missing");
  });

  it("retains diff inspection recovery when validation already exists", () => {
    const input = sealInput();
    delete candidateFor(input).reviewReadProgress;
    input.state.phase = "validated";
    expect(draftSealPrerequisiteDiagnostic(input)?.recovery).toBe("inspect-diff");
    expect(candidateFor(input).validation).toEqual({ resolvedTree: "private-tree" });
  });

  it("preserves the existing fallback for satisfied or unclassified input", () => {
    expect(draftPrerequisiteMessage(null, "fallback")).toBe("fallback");
  });

  it("accepts the existing preparation source prerequisites", () => {
    expect(draftPreparationPrerequisiteDiagnostic(sealInput().state)).toBeNull();
  });

  it("classifies preparation failures in the original guard order", () => {
    const { state } = sealInput();
    state.phase = "validated";
    delete state.githubSource;
    state.sourceReceipt = { sourceKind: "new-app" };
    expect(draftPreparationPrerequisiteDiagnostic(state)).toMatchObject({
      reason: "workflow_not_reviewed",
      recovery: "review-app",
    });
    state.phase = "reviewed";
    expect(draftPreparationPrerequisiteDiagnostic(state)).toMatchObject({
      reason: "selected_source_missing",
      recovery: "select-source",
    });
    state.githubSource = { digest: "private-source-binding" };
    expect(draftPreparationPrerequisiteDiagnostic(state)).toMatchObject({
      reason: "source_not_existing_repository",
      recovery: "select-source",
    });
  });
});
