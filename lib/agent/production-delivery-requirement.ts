import { defineState } from "eve/context";

export interface ManagedProductionDeliveryRequirement {
  appId: string;
  repositoryId: string;
  repositoryFullName: string;
  operationRef: string;
}

/** Retained service enrollment survives ordinary app revisions and temporary configuration loss. */
export const managedProductionDeliveryRequirements = defineState<
  ManagedProductionDeliveryRequirement[]
>("autograph-app-builder.managed-production-delivery-requirements.v1", () => []);

export const retainManagedProductionDeliveryRequirement = (
  requirement: ManagedProductionDeliveryRequirement,
): void => {
  managedProductionDeliveryRequirements.update((current) => [
    ...current.filter(
      (entry) =>
        entry.appId !== requirement.appId || entry.repositoryId !== requirement.repositoryId,
    ),
    requirement,
  ]);
};
