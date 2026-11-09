import { z } from "zod";
import { builderAppIdSchema } from "./names";

/** Reference to the normal provisioning journal; never a claim of provider success. */
const provisionedDestinationSchema = z.strictObject({
  appId: builderAppIdSchema,
  requestId: z.uuid(),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});
/** Server-resolved repository selection; never authorizes creating a repository or deployment. */
export const existingRepositoryDestinationSchema = z.strictObject({
  kind: z.literal("existing-repository"),
  version: z.literal(1),
  appId: builderAppIdSchema,
  repository: z.strictObject({
    repositoryId: z.string().regex(/^[1-9][0-9]*$/u),
    owner: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    defaultBranch: z.string().min(1).max(255),
  }),
  installationId: z.string().regex(/^[1-9][0-9]*$/u),
  confirmedByCallId: z.string().min(1).max(255),
});
export type ExistingRepositoryDestination = z.infer<typeof existingRepositoryDestinationSchema>;
export const builderSessionDestinationSchema = z.union([
  provisionedDestinationSchema,
  existingRepositoryDestinationSchema,
]);
export const isExistingRepositoryDestination = (
  value: z.infer<typeof builderSessionDestinationSchema>,
): value is ExistingRepositoryDestination =>
  "kind" in value && value.kind === "existing-repository";
export const sameBuilderDestination = (
  left: z.infer<typeof builderSessionDestinationSchema>,
  right: z.infer<typeof builderSessionDestinationSchema>,
): boolean => {
  if (isExistingRepositoryDestination(left) && isExistingRepositoryDestination(right)) {
    return [
      left.appId === right.appId,
      left.repository.repositoryId === right.repository.repositoryId,
      left.installationId === right.installationId,
    ].every(Boolean);
  }
  if (isExistingRepositoryDestination(left) || isExistingRepositoryDestination(right)) {
    return false;
  }
  return [
    left.appId === right.appId,
    left.requestId === right.requestId,
    left.requestDigest === right.requestDigest,
  ].every(Boolean);
};
export type BuilderSessionDestination = z.infer<typeof builderSessionDestinationSchema>;
export const builderDestinationEpochSchema = z.strictObject({
  adapterSessionId: z.string().min(1),
  adapterGeneration: z.number().int().positive(),
  cancellationRevision: z.number().int().nonnegative(),
  checkpointDigest: z.string().optional(),
});
export type BuilderDestinationEpoch = z.infer<typeof builderDestinationEpochSchema>;
