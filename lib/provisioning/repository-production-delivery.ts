import { z } from "zod";

const repositoryFields = {
  repositoryId: z.string().regex(/^[1-9][0-9]*$/u),
  repositoryFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/u),
};

/** The reviewed GitHub destination and optional read-only head evidence. */
export const repositoryProductionDeliveryTargetSchema = z.strictObject({
  ...repositoryFields,
  reviewedHeadSha: z
    .string()
    .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u)
    .optional(),
});
export type RepositoryProductionDeliveryTarget = z.infer<
  typeof repositoryProductionDeliveryTargetSchema
>;

const fields = {
  version: z.literal(1),
  appId: z.string().min(1),
  ...repositoryFields,
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
