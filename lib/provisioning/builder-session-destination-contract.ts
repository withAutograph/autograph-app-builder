import { z } from "zod";
import { builderAppIdSchema } from "./names";

/** Reference to the normal provisioning journal; never a claim of provider success. */
export const builderSessionDestinationSchema = z.strictObject({
  appId: builderAppIdSchema,
  requestId: z.uuid(),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type BuilderSessionDestination = z.infer<typeof builderSessionDestinationSchema>;
export const builderDestinationEpochSchema = z.strictObject({
  adapterSessionId: z.string().min(1),
  adapterGeneration: z.number().int().positive(),
  cancellationRevision: z.number().int().nonnegative(),
  checkpointDigest: z.string().optional(),
});
export type BuilderDestinationEpoch = z.infer<typeof builderDestinationEpochSchema>;
