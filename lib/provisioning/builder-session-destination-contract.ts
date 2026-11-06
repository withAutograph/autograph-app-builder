import { z } from "zod";
import { builderAppIdSchema } from "./names";

/** Reference to the normal provisioning journal; never a claim of provider success. */
export const builderSessionDestinationSchema = z.strictObject({
  appId: builderAppIdSchema,
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  requestId: z.uuid(),
});
export type BuilderSessionDestination = z.infer<typeof builderSessionDestinationSchema>;
export const builderDestinationEpochSchema = z.strictObject({
  adapterGeneration: z.number().int().positive(),
  adapterSessionId: z.string().min(1),
  cancellationRevision: z.number().int().nonnegative(),
  checkpointDigest: z.string().optional(),
});
export type BuilderDestinationEpoch = z.infer<typeof builderDestinationEpochSchema>;
