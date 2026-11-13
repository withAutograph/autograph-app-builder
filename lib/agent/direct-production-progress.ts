import { defineState } from "eve/context";

const schemaSettled = "schema-settled";
const schemaSettledAvailabilityUnconfirmed = "schema-settled-availability-unconfirmed";

type DirectProductionStage =
  | "draft"
  | "setup"
  | "live"
  | "activation-unavailable"
  | typeof schemaSettled
  | typeof schemaSettledAvailabilityUnconfirmed
  | "schema-update-pending";

export const hasAvailableDirectProductionPredecessor = (stage?: DirectProductionStage): boolean =>
  stage === "live" || stage === schemaSettled;

export const directProductionDeliverySettled = (stage?: DirectProductionStage): boolean =>
  hasAvailableDirectProductionPredecessor(stage) || stage === schemaSettledAvailabilityUnconfirmed;

export const directProductionProgressState = defineState<{
  grantDigest: string;
  stage: DirectProductionStage;
} | null>("autograph-app-builder.direct-production-progress.v1", () => null);

export const recordDirectProductionProgress = (
  grantDigest: string,
  stage: DirectProductionStage,
): void => {
  directProductionProgressState.update((current) => {
    if (current?.grantDigest === grantDigest) {
      if (current.stage === schemaSettled && stage !== "live") {
        return current;
      }
      if (
        current.stage === schemaSettledAvailabilityUnconfirmed &&
        stage !== schemaSettled &&
        stage !== "live"
      ) {
        return current;
      }
      if (current.stage === "live" && stage !== "schema-update-pending") {
        return current;
      }
    }
    return { grantDigest, stage };
  });
};
