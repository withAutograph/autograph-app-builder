import { z } from "zod";

/** Names observed predecessors; desired source remains in the ordinary delivery plan. */
export const readyDeliveryReplacementIntentSchema = z.strictObject({
  version: z.literal(1),
  predecessor: z.strictObject({
    operationRef: z.uuid(),
    planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    appDeploymentId: z.string().min(1),
    gatewayDeploymentId: z.string().min(1).optional(),
  }),
});

export type ReadyDeliveryReplacementIntent = z.infer<typeof readyDeliveryReplacementIntentSchema>;
