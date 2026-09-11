import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

const schema = z
  .object({
    configurationId: z.string().min(1),
    expiresAt: z.number().int().positive(),
    origin: z.string().url(),
    state: z.string().min(32).max(512),
    teamId: z.string().min(1),
  })
  .strict();
export function signLocalVercelRelay(
  input: z.infer<typeof schema>,
  secret: string
) {
  const payload = Buffer.from(JSON.stringify(schema.parse(input))).toString(
    "base64url"
  );
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
export function verifyLocalVercelRelay(
  value: string,
  secret: string,
  now = Date.now(),
  expectedOrigin?: string
) {
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) {
    throw new Error("invalid-relay");
  }
  const expected = createHmac("sha256", secret).update(payload).digest();
  const provided = Buffer.from(signature, "base64url");
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    throw new Error("invalid-relay");
  }
  const result = schema.parse(
    JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"))
  );
  if (result.expiresAt <= now) {
    throw new Error("expired-relay");
  }
  if (expectedOrigin !== undefined && result.origin !== expectedOrigin) {
    throw new Error("invalid-relay-origin");
  }
  return result;
}
