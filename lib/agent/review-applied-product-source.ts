import {
  currentProductSourceAssessment,
  productRequestState,
  reviewCurrentProductSource,
  retainCurrentProductSourceAssessment,
} from "@/lib/agent/product-source-review-state";
import { readProductReviewSourcePages } from "@/lib/agent/product-source-review-pages";
import { inspectApplyOverlay, overlayChanges } from "@/lib/repository/target-apply";
import type { OverlaySnapshot } from "@/lib/repository/target-apply";
import { hasTestCapability } from "@/lib/testing/test-capability";
import {
  assessProductSourcePages,
  unavailableSourceAssessment,
} from "@/lib/agent/product-source-review";
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

/** Validation repairs may change files beyond the original apply proposal. */
export const currentChangedSourcePaths = (
  receipt: Pick<TargetApplyReceipt, "preTree" | "preTreeDigest">,
  observed: OverlaySnapshot,
): string[] =>
  overlayChanges({ files: receipt.preTree, treeDigest: receipt.preTreeDigest }, observed).flatMap(
    (change) => (change.kind === "deleted" ? [] : [change.path]),
  );

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
  const reviewInput: ProductSourceReviewInput = {
    appSpec: input.appSpec.content,
    appSpecDigest: input.appSpec.digest,
    clarifications: request.clarifications,
    files: [],
    omissions: [],
    originalRequest: request.original,
    sourceDigest: input.applyReceipt.postTreeDigest,
  };
  if (hasTestCapability("mock-model")) {
    return unavailableSourceAssessment(
      reviewInput,
      "Independent review is unassessed in the credential-free mock profile.",
    );
  }
  if (request.original === null) {
    return unavailableSourceAssessment(
      reviewInput,
      "Original user request was not retained; the AppSpec cannot substitute for it.",
    );
  }
  try {
    input.abortSignal?.throwIfAborted();
    const sandbox = await input.getSandbox();
    const observed = await inspectApplyOverlay(sandbox, input.applyReceipt.applyRoot);
    const currentInput = { ...reviewInput, sourceDigest: observed.treeDigest };
    const retained = currentProductSourceAssessment(currentInput);
    if (retained !== undefined) {
      const latest = await inspectApplyOverlay(sandbox, input.applyReceipt.applyRoot);
      if (latest.treeDigest === observed.treeDigest) {
        input.abortSignal?.throwIfAborted();
        return retained;
      }
      return unavailableSourceAssessment(
        currentInput,
        "Source changed during review; this assessment is stale. Review the current implementation when ready.",
      );
    }
    const source = readProductReviewSourcePages({
      applyRoot: input.applyReceipt.applyRoot,
      changedPaths: currentChangedSourcePaths(input.applyReceipt, observed),
      observed,
      sandbox,
    });
    const assessedInput = { ...currentInput, omissions: source.omissions };
    const assessment = await assessProductSourcePages(assessedInput, source.pages, {
      abortSignal: input.abortSignal,
    });
    input.abortSignal?.throwIfAborted();
    const latest = await inspectApplyOverlay(sandbox, input.applyReceipt.applyRoot);
    if (latest.treeDigest !== observed.treeDigest) {
      return unavailableSourceAssessment(
        assessedInput,
        "Source changed during review; this assessment is stale. Review the current implementation when ready.",
      );
    }
    retainCurrentProductSourceAssessment(assessment);
    return assessment;
  } catch {
    input.abortSignal?.throwIfAborted();
    return unavailableSourceAssessment(
      reviewInput,
      "Applied source review could not complete. Check source streaming, provider context, and the current repository revision; then retry.",
      "blocked",
    );
  }
};
