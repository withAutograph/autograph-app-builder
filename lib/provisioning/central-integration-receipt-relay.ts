/* oxlint-disable eslint/no-await-in-loop -- Preserve bounded sequential request-stream reads. */
import { z } from "zod";

export const CENTRAL_DEPLOYMENT_RECEIPT_PATH = "/v1/central-deployment-events";
export const centralDeploymentReceiptRelaySchema = z.strictObject({
  subscriptionRef: z.uuid(),
  signature: z.string().regex(/^[a-f0-9]{40}$/u),
  bodyBase64: z
    .string()
    .min(1)
    .max(349_528)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/u),
});
/** Bounded byte transport, not a provider response journal or mutation authority. */
export const readCentralReceiptBody = async (
  request: Pick<Request, "body" | "signal">,
  limit: number,
): Promise<Buffer> => {
  request.signal.throwIfAborted();
  const reader = request.body?.getReader();
  if (reader === undefined) throw new Error("central_receipt_body_required");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      request.signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > limit) throw new Error("central_receipt_body_too_large");
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  request.signal.throwIfAborted();
  return Buffer.concat(chunks);
};
