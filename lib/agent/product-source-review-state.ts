import { defineState } from "eve/context";
import {
  assessProductSource,
  sourceReviewEvidenceDigest,
  sourceReviewBindingDigest,
  unavailableSourceAssessment,
} from "./product-source-review";
import type { ProductSourceAssessment, ProductSourceReviewInput } from "./product-source-review";

export interface RetainedProductRequest {
  original: string | null;
  clarifications: string[];
  sequences: string[];
}
export const productRequestState = defineState<RetainedProductRequest>(
  "autograph-app-builder.product-request.v1",
  () => ({ clarifications: [], original: null, sequences: [] }),
);
const sourceAssessmentState = defineState<ProductSourceAssessment | null>(
  "autograph-app-builder.product-source-assessment.v1",
  () => null,
);
export const retainProductRequest = (
  current: RetainedProductRequest,
  message: string,
  sequence: string,
  initialTurn = false,
): RetainedProductRequest => {
  if (current.sequences.includes(sequence)) {
    return current;
  }
  return {
    ...current,
    clarifications:
      current.original === null && initialTurn ? [] : [...current.clarifications, message],
    original: current.original ?? (initialTurn ? message : null),
    sequences: [...current.sequences, sequence],
  };
};
export interface SourceAssessmentStore {
  get: () => ProductSourceAssessment | null;
  set: (assessment: ProductSourceAssessment) => void;
}
const sessionAssessmentStore: SourceAssessmentStore = {
  get: () => sourceAssessmentState.get(),
  set: (assessment) => {
    sourceAssessmentState.update(() => assessment);
  },
};
export const reviewCurrentProductSource = async (
  input: ProductSourceReviewInput,
  mockModel: boolean,
  currentDigest: () => string | Promise<string>,
  store: SourceAssessmentStore = sessionAssessmentStore,
  abortSignal?: AbortSignal,
): Promise<ProductSourceAssessment> => {
  const cached = store.get();
  const assessment =
    cached?.evidenceDigest === sourceReviewEvidenceDigest(input)
      ? cached
      : await assessProductSource(input, { abortSignal, mockModel });
  if ((await currentDigest()) !== input.sourceDigest) {
    return unavailableSourceAssessment(
      input,
      "Source changed during review; this assessment is stale. Review the current implementation when ready.",
    );
  }
  if (assessment.reviewCompleted) {
    store.set(assessment);
  }
  return assessment;
};

/** Return retained findings only when all current requirements and observed source still match. */
export const currentProductSourceAssessment = (
  input: Pick<
    ProductSourceReviewInput,
    "sourceDigest" | "appSpecDigest" | "originalRequest" | "clarifications"
  >,
  store: SourceAssessmentStore = sessionAssessmentStore,
): ProductSourceAssessment | undefined => {
  const current = store.get();
  return current?.bindingDigest === sourceReviewBindingDigest(input) ? current : undefined;
};
