import { z } from "zod";

/** The reviewed GitHub destination, independently resolved by the protected service. */
export const repositoryProductionDeliveryTargetSchema = z.strictObject({
  repositoryId: z.string().regex(/^[1-9][0-9]*$/u),
  repositoryFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/u),
});
export type RepositoryProductionDeliveryTarget = z.infer<
  typeof repositoryProductionDeliveryTargetSchema
>;

const fields = {
  version: z.literal(1),
  appId: z.string().min(1),
  ...repositoryProductionDeliveryTargetSchema.shape,
};
/** Read-only setup facts; readiness does not perform or authorize a provider effect. */
export const repositoryProductionDeliveryStatusSchema = z.discriminatedUnion("applicable", [
  z.strictObject({ ...fields, applicable: z.literal(false) }),
  z.strictObject({
    ...fields,
    applicable: z.literal(true),
    operationRef: z.uuid(),
    state: z.enum([
      "ready",
      "identity-required",
      "setting-up-data",
      "checking-access",
      "reconciling",
    ]),
    preparationRequired: z.boolean(),
  }),
]);
export type RepositoryProductionDeliveryStatus = z.infer<
  typeof repositoryProductionDeliveryStatusSchema
>;
