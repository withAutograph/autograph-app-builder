import { createHash } from "node:crypto";
import { defineState } from "eve/context";
import {
  currentProductSourceAssessment,
  productRequestState,
  reviewCurrentProductSource,
  retainCurrentProductSourceAssessment,
} from "@/lib/agent/product-source-review-state";
import { assessApplicationSource, applicationSourceReviewKey } from "./application-source-review";
import type {
  ApplicationReviewEvidence,
  ApplicationSourceReviewOptions,
} from "./application-source-review";
import {
  applicationReviewVisibility,
  createApplicationReviewEvidence,
} from "./application-review-evidence";
import type { SourceReviewJournal } from "./product-source-review-journal";
import { appBaselineState } from "./app-baseline-state";
import { readAppBaselineMarker } from "../repository/app-baseline";
import { inspectApplyOverlay } from "@/lib/repository/target-apply";
import type { OverlayChange, OverlaySnapshot } from "@/lib/repository/target-apply";
import { hasTestCapability } from "@/lib/testing/test-capability";
import {
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

const applicationCompletedKind = "application-completed";

/** Canonical owner-authorized application reuse precedes every completed cache return. */
export const reviewApplicationWithJournal = async (
  input: {
    reviewInput: ProductSourceReviewInput;
    normalizedChanges: readonly OverlayChange[];
    evidence: ApplicationReviewEvidence;
    journal: SourceReviewJournal;
    currentDigest: () => Promise<string>;
    options?: ApplicationSourceReviewOptions;
  },
  assess = assessApplicationSource,
): Promise<ProductSourceAssessment> => {
  const signal = input.options?.abortSignal;
  signal?.throwIfAborted();
  const key = applicationSourceReviewKey(input.reviewInput, input.normalizedChanges);
  const retained = await input.journal.read(key);
  signal?.throwIfAborted();
  const reusable =
    retained?.kind === applicationCompletedKind &&
    retained.assessment.bindingDigest === sourceReviewBindingDigest(input.reviewInput);
  const options: ApplicationSourceReviewOptions = {
    ...input.options,
    async assertCurrentOwner() {
      signal?.throwIfAborted();
      await input.journal.read(key);
      signal?.throwIfAborted();
    },
  };
  const assessment = reusable
    ? { ...retained.assessment, invocation: { ...emptySourceReviewInvocation(), journalReuses: 1 } }
    : await assess(input.reviewInput, input.evidence, options);
  signal?.throwIfAborted();
  if ((await input.currentDigest()) !== input.reviewInput.sourceDigest) {
    return unavailableSourceAssessment(
      input.reviewInput,
      "Source changed during review; this assessment is stale. Review the current implementation when ready.",
    );
  }
  signal?.throwIfAborted();
  if (reusable) {
    input.options?.onInvocation?.(assessment.invocation ?? emptySourceReviewInvocation());
    return assessment;
  }
  if (!assessment.reviewCompleted) {
    return assessment;
  }
  const { invocation, ...durableAssessment } = assessment;
  const recorded = await input.journal.put(key, {
    kind: applicationCompletedKind,
    assessment: durableAssessment,
  });
  signal?.throwIfAborted();
  if (recorded.kind !== applicationCompletedKind) {
    throw new Error("Completed application review could not be retained.");
  }
  return { ...recorded.assessment, ...(invocation === undefined ? {} : { invocation }) };
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
    const currentInput = {
      ...reviewInput,
      sourceDigest: observed.treeDigest,
      omissions: [
        "Source tools expose observed eligible code and configuration, including relevant unchanged imports. Uninspected dependencies cannot establish absence of functionality.",
        "Only original request text and textual product clarifications are retained; attached assets are not reviewed.",
      ],
    };
    const bindingDigest = applicationSourceReviewKey(currentInput, input.normalizedChanges);
    const journal = await sourceReviewJournalForSession({
      sessionAuth: input.sessionAuth,
      sessionId: input.sessionId ?? "",
    });
    input.abortSignal?.throwIfAborted();
    const baseline = appBaselineState.get()?.selection;
    const selectedBaseline = baseline?.appId === input.appSpec.appId ? baseline : undefined;
    const marker =
      selectedBaseline === undefined
        ? undefined
        : await readAppBaselineMarker(sandbox, selectedBaseline);
    const visibility = applicationReviewVisibility({
      observedPaths: observed.files.map((file) => file.path),
      changedPaths: input.normalizedChanges.map((change) => change.path),
      hasSelectedBaseline: selectedBaseline !== undefined,
      unexposedReleasePrefixes: marker?.unexposedReleasePrefixes,
    });
    currentInput.omissions.push(...visibility.omissions);
    const evidence = createApplicationReviewEvidence({
      abortSignal: input.abortSignal,
      applyRoot: input.applyReceipt.applyRoot,
      changedPaths: input.normalizedChanges.map((change) => change.path),
      observed,
      reviewInput: currentInput,
      sandbox,
      visiblePaths: visibility.paths,
      ...(input.appSpec.version === 2
        ? {
            appSpecParts: () =>
              acceptedAppSpecTextParts({
                accepted: input.appSpec,
                artifacts: input.artifacts ?? [],
                sessionAuth: input.sessionAuth,
                sessionId: input.sessionId ?? "",
              }),
          }
        : {}),
    });
    const options: ApplicationSourceReviewOptions = {
      abortSignal: input.abortSignal,
      sessionId: input.sessionId,
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
    };
    const assessment = await reviewApplicationWithJournal({
      reviewInput: currentInput,
      normalizedChanges: input.normalizedChanges,
      evidence,
      journal,
      options,
      currentDigest: async () => {
        const { treeDigest } = await inspectApplyOverlay(sandbox, input.applyReceipt.applyRoot);
        return treeDigest;
      },
    });
    input.abortSignal?.throwIfAborted();
    retainScopedProductSourceAssessment(assessment, bindingDigest);
    logPhase("application_source_review_finished", { status: assessment.status });
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
