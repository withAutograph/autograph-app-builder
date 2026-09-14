import { defineState } from "eve/context";

import type { executeProductReadback } from "./product-behavior";

type ProductReadbackResult = Awaited<ReturnType<typeof executeProductReadback>>;

export interface ProductBehaviorEvidence {
  acceptedOutcomeText: string;
  appSpecDigest: string;
  applyDigest: string;
  observedAt: string;
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
const productBehaviorPreview = defineState<{ commandId: string; generation: number } | null>(
  "autograph-app-builder.product-behavior-preview.v1",
  () => null,
);
export const currentProductBehaviorGeneration = () => productBehaviorGeneration.get();
export const bindProductBehaviorPreview = (commandId: string, generation: number) => {
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

export const clearProductBehaviorEvidence = () => {
  productBehaviorEvidenceState.update(() => []);
  productBehaviorGeneration.update((generation) => generation + 1);
};

export const recordProductBehaviorEvidence = (evidence: ProductBehaviorEvidence) => {
  productBehaviorEvidenceState.update((current) => [...current, evidence]);
};

export const currentProductBehaviorEvidence = (appSpecDigest: string, applyDigest: string) =>
  productBehaviorEvidenceState
    .get()
    .filter((item) => item.appSpecDigest === appSpecDigest && item.applyDigest === applyDigest);
