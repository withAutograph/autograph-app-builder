import { defineState } from "eve/context";

type DirectProductionStage = "draft" | "setup" | "live" | "activation-unavailable";

export const directProductionProgressState = defineState<{
  grantDigest: string;
  stage: DirectProductionStage;
} | null>("autograph-app-builder.direct-production-progress.v1", () => null);

export const recordDirectProductionProgress = (
  grantDigest: string,
  stage: DirectProductionStage,
): void => {
  directProductionProgressState.update((current) =>
    current?.grantDigest === grantDigest && current.stage === "live"
      ? current
      : { grantDigest, stage },
  );
};
