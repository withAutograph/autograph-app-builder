import type { HookEvent } from "eve/hooks";
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
  pendingInputs?: RetainedProductInput[];
  clarifications: string[];
  sequences: string[];
}
interface RetainedProductInput {
  requestId: string;
  kind: "question" | "tool-approval";
  prompt: string;
  options: { id: string; label: string; description?: string }[];
}

/** Keep presentation context only, never the tool action or its potentially sensitive inputs. */
export const retainProductInputs = (
  current: RetainedProductRequest,
  requests: HookEvent<"input.requested">["data"]["requests"],
): RetainedProductRequest => {
  const pending = [...(current.pendingInputs ?? [])];
  for (const request of requests) {
    if (
      request.kind === "session-limit" ||
      current.sequences.includes(`input:${request.requestId}`) ||
      pending.some((input) => input.requestId === request.requestId)
    ) {
      continue;
    }
    const options = (request.options ?? []).map(({ id, label, description }) => {
      const option: RetainedProductInput["options"][number] = { id, label };
      if (description !== undefined) {
        option.description = description;
      }
      return option;
    });
    pending.push({
      kind: request.kind,
      options,
      prompt: request.prompt,
      requestId: request.requestId,
    });
  }
  return { ...current, pendingInputs: pending };
};

interface ProductClarification {
  context: string;
  question: string;
  outcome: string;
  selectedOption?: RetainedProductInput["options"][number];
  userText?: string;
}
type ProductResolution = HookEvent<"input.resolved">["data"]["resolutions"][number];
const resolutionClarification = (
  request: RetainedProductInput | undefined,
  resolution: ProductResolution,
): string | undefined => {
  if (!request || request.kind !== resolution.kind) {
    return undefined;
  }
  const { response } = resolution;
  if (response && response.requestId !== resolution.requestId) {
    return undefined;
  }
  const option = request.options.find((candidate) => candidate.id === response?.optionId);
  if (response?.optionId !== undefined && !option) {
    return undefined;
  }
  const missingAnswer = option === undefined && (response?.text ?? "").length === 0;
  if (request.kind === "question" && (resolution.outcome !== "answered" || missingAnswer)) {
    return undefined;
  }
  if (request.kind === "tool-approval" && !["approved", "denied"].includes(resolution.outcome)) {
    return undefined;
  }
  const clarification: ProductClarification = {
    context:
      request.kind === "question"
        ? "User answer to product question; explicit scope changes supersede earlier requirements."
        : "User authorization decision only; approval or denial does not by itself waive product requirements.",
    outcome: resolution.outcome,
    question: request.prompt,
  };
  if (option) {
    clarification.selectedOption = option;
  }
  if (response?.text !== undefined) {
    clarification.userText = response.text;
  }
  return JSON.stringify(clarification);
};
export const retainProductResolutions = (
  current: RetainedProductRequest,
  resolutions: HookEvent<"input.resolved">["data"]["resolutions"],
): RetainedProductRequest => {
  const sequences = new Set(current.sequences);
  const pending = new Map((current.pendingInputs ?? []).map((input) => [input.requestId, input]));
  const clarifications = [...current.clarifications];
  for (const resolution of resolutions) {
    const key = `input:${resolution.requestId}`;
    if (sequences.has(key)) {
      continue;
    }
    const clarification = resolutionClarification(pending.get(resolution.requestId), resolution);
    sequences.add(key);
    pending.delete(resolution.requestId);
    if (clarification !== undefined) {
      clarifications.push(clarification);
    }
  }
  return {
    ...current,
    clarifications,
    pendingInputs: [...pending.values()],
    sequences: [...sequences],
  };
};

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
