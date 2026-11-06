import { z } from "zod";

/** Names observed predecessors; desired source remains in the ordinary delivery plan. */
export const readyDeliveryReplacementIntentSchema = z.strictObject({
  predecessor: z.strictObject({
    appDeploymentId: z.string().min(1),
    gatewayDeploymentId: z.string().min(1).optional(),
    operationRef: z.uuid(),
    planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  version: z.literal(1),
});

export type ReadyDeliveryReplacementIntent = z.infer<typeof readyDeliveryReplacementIntentSchema>;
