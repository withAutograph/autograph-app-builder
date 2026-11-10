import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const githubPrDeliveryReviewScopeSchema = z.strictObject({
  appId: z.string().min(1),
  appSpecDigest: digest,
  reviewDigest: digest,
  proposalDigest: digest,
  installationId: z
    .string()
    .regex(/^[1-9][0-9]*$/u)
    .optional(),
  reconciliationDigest: digest.optional(),
});
export const githubPrDeliveryManagedRequirementSchema = z.strictObject({
  appId: z.string().min(1),
  repositoryId: z.string().min(1),
  repositoryFullName: z.string().min(1),
  operationRef: z.string().min(1),
});
export const githubPrDeliveryOwnerBindingSchema = z.union([
  z.strictObject({
    ownerKey: z.string().min(1),
    adapterSessionId: z.string().min(1),
    adapterGeneration: z.number().int().positive(),
    cancellationRevision: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("local"),
    ownerKey: z.string().min(1),
    adapterSessionId: z.string().min(1),
  }),
]);
export const githubPrDeliveryCallScopeSchema = z.strictObject({
  owner: githubPrDeliveryOwnerBindingSchema,
  callId: z.string().min(1),
  turnId: z.string().min(1),
  turnSequence: z.number().int().nonnegative(),
  cancelled: z.literal(true).optional(),
  inputDigest: digest,
  subject: githubPrDeliveryReviewScopeSchema,
  requirements: z.array(githubPrDeliveryManagedRequirementSchema),
});
/** Parent-produced facts; native approved workflow execution supplies effect authority. */
export const githubPrDeliveryAuthorityProjectionSchema = z.strictObject({
  version: z.literal(1),
  current: githubPrDeliveryReviewScopeSchema.nullable(),
  requirements: z.array(githubPrDeliveryManagedRequirementSchema),
  calls: z.array(githubPrDeliveryCallScopeSchema),
});
export type GitHubPrDeliveryOwnerBinding = z.infer<typeof githubPrDeliveryOwnerBindingSchema>;
export type GitHubPrDeliveryReviewScope = z.infer<typeof githubPrDeliveryReviewScopeSchema>;
export type GitHubPrDeliveryCallScope = z.infer<typeof githubPrDeliveryCallScopeSchema>;
export type GitHubPrDeliveryAuthorityProjection = z.infer<
  typeof githubPrDeliveryAuthorityProjectionSchema
>;
