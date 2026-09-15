import {
  productRequestState,
  reviewCurrentProductSource,
} from "@/lib/agent/product-source-review-state";
import { readProductReviewSource } from "@/lib/agent/product-source-review-input";
import { inspectApplyOverlay } from "@/lib/repository/target-apply";
import { hasTestCapability } from "@/lib/testing/test-capability";
import { unavailableSourceAssessment } from "@/lib/agent/product-source-review";
import type {
  ProductSourceAssessment,
  ProductSourceReviewInput,
} from "@/lib/agent/product-source-review";
import type { SandboxSession } from "eve/sandbox";
import type { AcceptedAppSpec } from "./workflow-state";
import type { TargetApplyReceipt } from "../repository/target-apply";

export interface AppliedSourceObservation {
  source: Pick<ProductSourceReviewInput, "files" | "omissions" | "sourceDigest">;
  currentDigest: () => Promise<string>;
}

/** Observe and assess through the same boundary for validation and review. */
export const reviewObservedProductSource = async (
  input: {
    reviewInput: ProductSourceReviewInput;
    mockModel: boolean;
    observe: () => Promise<AppliedSourceObservation>;
    abortSignal?: AbortSignal;
  },
  review = reviewCurrentProductSource,
): Promise<ProductSourceAssessment> => {
  input.abortSignal?.throwIfAborted();
  let assessment: ProductSourceAssessment;
  if (input.mockModel) {
    assessment = unavailableSourceAssessment(
      input.reviewInput,
      "Independent review is unassessed in the credential-free mock profile.",
    );
  } else if (input.reviewInput.originalRequest === null) {
    assessment = unavailableSourceAssessment(
      input.reviewInput,
      "Original user request was not retained; the AppSpec cannot substitute for it.",
    );
  } else {
    try {
      const observed = await input.observe();
      assessment = await review(
        { ...input.reviewInput, ...observed.source },
        false,
        observed.currentDigest,
        undefined,
        input.abortSignal,
      );
    } catch {
      assessment = unavailableSourceAssessment(
        input.reviewInput,
        "Applied source observation was unavailable; independent review remains blocked.",
        "blocked",
      );
    }
  }
  input.abortSignal?.throwIfAborted();
  return assessment;
};

/** Shared post-validation assessment; never substitutes for executed product behavior. */
export const reviewAppliedProductSource = async (input: {
  appSpec: AcceptedAppSpec;
  applyReceipt: TargetApplyReceipt;
  getSandbox: () => Promise<SandboxSession>;
  abortSignal?: AbortSignal;
}): Promise<ProductSourceAssessment> => {
  const request = productRequestState.get();
  return await reviewObservedProductSource({
    abortSignal: input.abortSignal,
    mockModel: hasTestCapability("mock-model"),
    observe: async () => {
      const sandbox = await input.getSandbox();
      const observed = await inspectApplyOverlay(sandbox, input.applyReceipt.applyRoot);
      const source = await readProductReviewSource({
        appId: input.appSpec.appId,
        applyRoot: input.applyReceipt.applyRoot,
        changedPaths: input.applyReceipt.changes.map((change) => change.path),
        observed,
        sandbox,
      });
      return {
        currentDigest: async () => {
          const latest = await inspectApplyOverlay(sandbox, input.applyReceipt.applyRoot);
          return latest.treeDigest;
        },
        source: { ...source, sourceDigest: observed.treeDigest },
      };
    },
    reviewInput: {
      appSpec: input.appSpec.content,
      appSpecDigest: input.appSpec.digest,
      clarifications: request.clarifications,
      files: [],
      omissions: [],
      originalRequest: request.original,
      sourceDigest: input.applyReceipt.postTreeDigest,
    },
  });
};
