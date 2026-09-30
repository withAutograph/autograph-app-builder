import { defineState } from "eve/context";

import type { executeProductReadback } from "./product-behavior";

type ProductReadbackResult = Awaited<ReturnType<typeof executeProductReadback>>;

export interface ProductBehaviorProvenance {
  sourceGeneration: number;
  previewGeneration: number;
  commandId: string;
}

export interface ProductBehaviorEvidence {
  acceptedOutcomeText: string;
  appSpecDigest: string;
  applyDigest: string;
  observedAt: string;
  /** Absent on legacy observations, which remain historical evidence only. */
  provenance?: ProductBehaviorProvenance;
  result: ProductReadbackResult;
}

export const productBehaviorEvidenceState = defineState<ProductBehaviorEvidence[]>(
  "autograph-app-builder.product-behavior-evidence.v1",
  () => [],
);

const productBehaviorGeneration = defineState<number>(
  "autograph-app-builder.product-behavior-generation.v1",
  () => 0,
);
const productBehaviorPreviewGeneration = defineState<number>(
  "autograph-app-builder.product-behavior-preview-generation.v1",
  () => 0,
);
const productBehaviorPreview = defineState<{ commandId: string; generation: number } | null>(
  "autograph-app-builder.product-behavior-preview.v1",
  () => null,
);

type InvalidationReason =
  | "source-apply"
  | "source-repair"
  | "preview-replaced"
  | "preview-released";
export const productBehaviorInvalidationsState = defineState<
  {
    reason: InvalidationReason;
    observedAt: string;
    sourceGeneration: number;
    previewGeneration: number;
  }[]
>("autograph-app-builder.product-behavior-invalidations.v1", () => []);

const recordInvalidation = (reason: InvalidationReason) => {
  productBehaviorInvalidationsState.update((current) => [
    ...current,
    {
      observedAt: new Date().toISOString(),
      previewGeneration: productBehaviorPreviewGeneration.get(),
      reason,
      sourceGeneration: productBehaviorGeneration.get(),
    },
  ]);
};

export const currentProductBehaviorGeneration = () => productBehaviorGeneration.get();

export const invalidateProductBehaviorPreview = (
  reason: "preview-replaced" | "preview-released",
) => {
  productBehaviorPreviewGeneration.update((generation) => generation + 1);
  productBehaviorPreview.update(() => null);
  recordInvalidation(reason);
};

export const bindProductBehaviorPreview = (commandId: string, generation: number) => {
  // A startup that crossed source writes must not overwrite a newer binding.
  if (generation !== productBehaviorGeneration.get()) {
    return;
  }
  const previous = productBehaviorPreview.get();
  if (previous !== null && previous.commandId !== commandId) {
    invalidateProductBehaviorPreview("preview-replaced");
  }
  productBehaviorPreview.update(() => ({ commandId, generation }));
};
export const hasCurrentProductBehaviorPreview = (commandId: string): boolean => {
  const binding = productBehaviorPreview.get();
  return (
    binding !== null &&
    binding.commandId === commandId &&
    binding.generation === productBehaviorGeneration.get()
  );
};

export const captureProductBehaviorProvenance = (
  commandId: string,
): ProductBehaviorProvenance | undefined =>
  hasCurrentProductBehaviorPreview(commandId)
    ? {
        commandId,
        previewGeneration: productBehaviorPreviewGeneration.get(),
        sourceGeneration: productBehaviorGeneration.get(),
      }
    : undefined;

export const hasCurrentProductBehaviorProvenance = (
  provenance: ProductBehaviorProvenance | undefined,
): boolean =>
  provenance !== undefined &&
  provenance.sourceGeneration === productBehaviorGeneration.get() &&
  provenance.previewGeneration === productBehaviorPreviewGeneration.get() &&
  hasCurrentProductBehaviorPreview(provenance.commandId);

export const invalidateProductBehaviorEvidence = (reason: "source-apply" | "source-repair") => {
  productBehaviorGeneration.update((generation) => generation + 1);
  productBehaviorPreview.update(() => null);
  recordInvalidation(reason);
};

export const recordProductBehaviorEvidence = (evidence: ProductBehaviorEvidence) => {
  productBehaviorEvidenceState.update((current) => [...current, evidence]);
};

export const currentProductBehaviorEvidence = (appSpecDigest: string, applyDigest: string) =>
  productBehaviorEvidenceState
    .get()
    .filter(
      (item) =>
        item.appSpecDigest === appSpecDigest &&
        item.applyDigest === applyDigest &&
        hasCurrentProductBehaviorProvenance(item.provenance),
    );
