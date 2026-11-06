import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AppIntegrationReleaseAttachment } from "./app-integration-release-contract";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const observationSchema = z.strictObject({
  appId: z.string().min(1),
  capabilitySha256: digest,
  configurationReference: z.uuid(),
  configurationSha256: digest,
  nonce: z.uuid(),
  observedAt: z.number().int().nonnegative(),
  principalGeneration: z.number().int().positive(),
  provider: z.literal("quickbooksSandbox"),
  releaseId: z.string().min(1),
  scopeSha256: digest,
  serviceMemberships: z.number().int().positive(),
  status: z.literal("ready"),
  version: z.literal(1),
});
const signature = (purpose: "request" | "response", value: string, secret: string) =>
  createHmac("sha256", secret)
    .update(`app-integration-readiness/v1/${purpose}\n`)
    .update(value)
    .digest("hex");
/** Independent shared app handler proves its actually loaded two-key configuration and restricted SQL scope. */
export const observeAppIntegrationPublicRelease = async (input: {
  publicOrigin: string;
  attachment: AppIntegrationReleaseAttachment;
  setupProofSecret: string;
  assertCurrent: () => Promise<void>;
  signal: AbortSignal;
  fetch?: typeof fetch;
  now?: () => number;
}): Promise<boolean> => {
  try {
    const origin = new URL(input.publicOrigin);
    if (
      origin.origin !== input.publicOrigin ||
      origin.protocol !== "https:" ||
      input.attachment.readinessPath !==
        `/${input.attachment.capability.appId}/api/integrations/readiness` ||
      Buffer.byteLength(input.setupProofSecret) < 32
    ) {
      return false;
    }
    await input.assertCurrent();
    const now = input.now ?? Date.now;
    const issuedAt = Math.floor(now() / 1000);
    const { capability } = input.attachment;
    const challenge = {
      appId: capability.appId,
      capabilitySha256: createHash("sha256").update(JSON.stringify(capability)).digest("hex"),
      configurationReference: capability.privateConfiguration.reference,
      configurationSha256: capability.privateConfiguration.sha256,
      expiresAt: issuedAt + 120,
      issuedAt,
      nonce: randomUUID(),
      purpose: "app-integration-readiness",
      version: 1,
    };
    const response = await (input.fetch ?? fetch)(new URL(input.attachment.readinessPath, origin), {
      body: JSON.stringify(challenge),
      headers: {
        "content-type": "application/json",
        "x-autograph-integration-readiness-signature": signature(
          "request",
          JSON.stringify(challenge),
          input.setupProofSecret,
        ),
      },
      method: "POST",
      redirect: "error",
      signal: input.signal,
    });
    await input.assertCurrent();
    if (response.status !== 200) {
      return false;
    }
    const actual = observationSchema.parse(await response.json());
    const supplied = response.headers.get("x-autograph-integration-readiness-signature");
    const current = Math.floor(now() / 1000);
    const notExpired = current < challenge.expiresAt;
    if (supplied === null || !/^[a-f0-9]{64}$/u.test(supplied)) {
      return false;
    }
    const expected = signature("response", JSON.stringify(actual), input.setupProofSecret);
    const valid = [
      timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex")),
      notExpired,
      actual.observedAt >= challenge.issuedAt - 30,
      actual.observedAt <= current + 30,
      actual.appId === challenge.appId,
      actual.nonce === challenge.nonce,
      actual.capabilitySha256 === challenge.capabilitySha256,
      actual.configurationReference === challenge.configurationReference,
      actual.configurationSha256 === challenge.configurationSha256,
      actual.scopeSha256 === input.attachment.scopeSha256,
      actual.releaseId === capability.release.id,
      actual.provider === capability.provider.kind,
      actual.principalGeneration === capability.control.principalGeneration,
      actual.serviceMemberships === capability.serviceMemberships.length,
    ];
    await input.assertCurrent();
    return valid.every(Boolean);
  } catch {
    return false;
  }
};
