import { createHash } from "node:crypto";
import { defineState } from "eve/context";
import {
  currentProductSourceAssessment,
  productRequestState,
  reviewCurrentProductSource,
  retainCurrentProductSourceAssessment,
} from "@/lib/agent/product-source-review-state";
import { readProductReviewSourcePages } from "@/lib/agent/product-source-review-pages";
import { inspectApplyOverlay } from "@/lib/repository/target-apply";
import type { OverlayChange, OverlaySnapshot } from "@/lib/repository/target-apply";
import { hasTestCapability } from "@/lib/testing/test-capability";
import {
  assessProductSourcePages,
  sourceReviewBindingDigest,
  unavailableSourceAssessment,
} from "@/lib/agent/product-source-review";
import type {
  ProductSourceAssessment,
  ProductSourceReviewInput,
} from "@/lib/agent/product-source-review";
import type { SandboxSession } from "eve/sandbox";
import type { AcceptedAppSpec, StoredPrototypeArtifact } from "./workflow-state";
import { acceptedAppSpecTextParts } from "./accepted-app-spec-content";
import type { TargetApplyReceipt } from "../repository/target-apply";
import { sourceReviewJournalForSession } from "./source-review-journal-runtime";
import { emptySourceReviewInvocation } from "./product-source-review-batches";

export interface AppliedSourceObservation {
  source: Pick<ProductSourceReviewInput, "files" | "omissions" | "sourceDigest">;
  currentDigest: () => Promise<string>;
}

/** Review the current normalized publication diff, including validation repairs. */
export const currentChangedSourcePaths = (
  changes: readonly Pick<OverlayChange, "path" | "kind">[],
): string[] => changes.flatMap((change) => (change.kind === "deleted" ? [] : [change.path]));

/** Aggregate cache identity includes the complete intended diff on the actual source tree. */
export const sourceReviewScopeBindingDigest = (
  input: Parameters<typeof sourceReviewBindingDigest>[0],
  changes: readonly OverlayChange[],
): string =>
  createHash("sha256")
    .update(JSON.stringify([sourceReviewBindingDigest(input), changes]))
    .digest("hex");

const aggregateReviewScope = defineState<string | null>(
  "autograph-app-builder.source-review-scope.v1",
  () => null,
);

/** Scope metadata is private; consumers retain the canonical source/product binding. */
export const currentScopedProductSourceAssessment = (
  input: Parameters<typeof currentProductSourceAssessment>[0],
  scopeBindingDigest: string,
): ProductSourceAssessment | undefined =>
  aggregateReviewScope.get() === scopeBindingDigest
    ? currentProductSourceAssessment(input)
    : undefined;

export const retainScopedProductSourceAssessment = (
  assessment: ProductSourceAssessment,
  scopeBindingDigest: string,
): void => {
  if (assessment.reviewCompleted) {
    retainCurrentProductSourceAssessment(assessment);
    aggregateReviewScope.update(() => scopeBindingDigest);
  }
};

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
  normalizedChanges: readonly OverlayChange[];
  observed: OverlaySnapshot;
  getSandbox: () => Promise<SandboxSession>;
  abortSignal?: AbortSignal;
  callId?: string;
  artifacts?: readonly StoredPrototypeArtifact[];
  sessionAuth?: unknown;
  sessionId?: string;
}): Promise<ProductSourceAssessment> => {
  const logPhase = (
    phase: string,
    detail?: {
      changedPathCount?: number;
      changedPathGroups?: Record<string, number>;
      errorName?: string;
      fileCount?: number;
      status?: string;
    },
  ) => {
    console.info(
      JSON.stringify({
        callId: input.callId,
        event: "app_builder.source_review_progress",
        phase,
        ...detail,
      }),
    );
  };
  const request = productRequestState.get();
  const reviewInput: ProductSourceReviewInput = {
    appSpec: input.appSpec.content ?? "",
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
    logPhase("observing_current_source");
    const sandbox = await input.getSandbox();
    const { observed } = input;
    logPhase("current_source_observed", { fileCount: observed.files.length });
    const currentInput = { ...reviewInput, sourceDigest: observed.treeDigest };
    // Aggregate reuse follows both the actual source tree and its intended diff.
    // Pair journals remain reusable for identical source pages and requirements.
    const bindingDigest = sourceReviewScopeBindingDigest(currentInput, input.normalizedChanges);
    const retained = currentScopedProductSourceAssessment(currentInput, bindingDigest);
    if (retained !== undefined) {
      const latest = await inspectApplyOverlay(sandbox, input.applyReceipt.applyRoot);
      if (latest.treeDigest === observed.treeDigest) {
        input.abortSignal?.throwIfAborted();
        logPhase("retained_review_reused");
        return { ...retained, invocation: emptySourceReviewInvocation() };
      }
      logPhase("source_changed_during_review");
      return unavailableSourceAssessment(
        currentInput,
        "Source changed during review; this assessment is stale. Review the current implementation when ready.",
      );
    }
    const changedPaths = currentChangedSourcePaths(input.normalizedChanges);
    const groups = new Map<string, number>();
    for (const path of changedPaths) {
      const group = path.split("/")[0] ?? "";
      groups.set(group, (groups.get(group) ?? 0) + 1);
    }
    const changedPathGroups = Object.fromEntries(
      [...groups].toSorted(([a], [b]) => a.localeCompare(b)),
    );
    const source = readProductReviewSourcePages({
      applyRoot: input.applyReceipt.applyRoot,
      changedPaths,
      observed,
      sandbox,
    });
    logPhase("reviewing_changed_source", {
      changedPathCount: changedPaths.length,
      changedPathGroups,
    });
    const assessedInput = { ...currentInput, omissions: source.omissions };
    const reviewOptions: NonNullable<Parameters<typeof assessProductSourcePages>[2]> = {
      abortSignal: input.abortSignal,
      journal: await sourceReviewJournalForSession({
        sessionAuth: input.sessionAuth,
        sessionId: input.sessionId ?? "",
      }),
      onInvocation(invocation) {
        console.info(
          JSON.stringify({
            callId: input.callId,
            event: "app_builder.source_review_invocation",
            sessionId: input.sessionId,
            ...invocation,
          }),
        );
      },
      onProgress(progress) {
        console.info(
          JSON.stringify({
            callId: input.callId,
            event: "app_builder.source_review_progress",
            ...progress,
          }),
        );
      },
      onRequest(completedRequest) {
        console.info(
          JSON.stringify({
            callId: input.callId,
            event: "app_builder.source_review_request_finished",
            sessionId: input.sessionId,
            ...completedRequest,
          }),
        );
      },
      sessionId: input.sessionId,
    };
    if (input.appSpec.version === 2) {
      reviewOptions.reviewAppSpecParts = () =>
        acceptedAppSpecTextParts({
          accepted: input.appSpec,
          artifacts: input.artifacts ?? [],
          sessionAuth: input.sessionAuth,
          sessionId: input.sessionId ?? "",
        });
    }
    const assessment = await assessProductSourcePages(assessedInput, source.pages, reviewOptions);
    logPhase("changed_source_review_finished", { status: assessment.status });
    input.abortSignal?.throwIfAborted();
    const latest = await inspectApplyOverlay(sandbox, input.applyReceipt.applyRoot);
    if (latest.treeDigest !== observed.treeDigest) {
      logPhase("source_changed_during_review");
      return unavailableSourceAssessment(
        assessedInput,
        "Source changed during review; this assessment is stale. Review the current implementation when ready.",
      );
    }
    retainScopedProductSourceAssessment(assessment, bindingDigest);
    return assessment;
  } catch (error) {
    input.abortSignal?.throwIfAborted();
    logPhase("source_review_unavailable", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return unavailableSourceAssessment(
      reviewInput,
      "Applied source review could not complete. Check source streaming, provider context, and the current repository revision; then retry.",
      "blocked",
    );
  }
};
