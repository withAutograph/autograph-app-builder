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

export const clearProductBehaviorEvidence = () => {
  productBehaviorEvidenceState.update(() => []);
};

export const recordProductBehaviorEvidence = (evidence: ProductBehaviorEvidence) => {
  productBehaviorEvidenceState.update((current) => [...current, evidence]);
};

export const currentProductBehaviorEvidence = (appSpecDigest: string, applyDigest: string) =>
  productBehaviorEvidenceState
    .get()
    .filter((item) => item.appSpecDigest === appSpecDigest && item.applyDigest === applyDigest);
