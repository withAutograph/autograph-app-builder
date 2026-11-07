/* oxlint-disable eslint/require-await -- The read-only HTTP transport is a controlled Promise fixture. */
import { createHmac } from "node:crypto";
import { z } from "zod";
import { expect, test, vi } from "vitest";
import { observeAppIntegrationPublicRelease } from "./app-integration-release-observation";
import { integrationTestAttachment as attachment } from "./app-integration-release-test-fixture";

const secret = "r".repeat(32);
const seconds = 1_800_000_000;
const challengeSchema = z.object({
  appId: z.string(),
  capabilitySha256: z.string(),
  configurationReference: z.uuid(),
  configurationSha256: z.string(),
  expiresAt: z.number(),
  issuedAt: z.number(),
  nonce: z.uuid(),
});
const signature = (purpose: string, bytes: string) =>
  createHmac("sha256", secret)
    .update(`app-integration-readiness/v1/${purpose}\n`)
    .update(bytes)
    .digest("hex");
const mutations = ["nonce", "configuration", "generation", "signature", "vercel-login"] as const;
const fixture = (change?: (typeof mutations)[number]) => {
  const http = vi.fn<typeof fetch>(async (_url, init) => {
    expect(init?.redirect).toBe("error");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("x-vercel-protection-bypass")).toBe(false);
    const bytes = z.string().parse(init?.body);
    expect(headers.get("x-autograph-integration-readiness-signature")).toBe(
      signature("request", bytes),
    );
    const request = challengeSchema.parse(JSON.parse(bytes));
    const body = {
      appId: attachment.capability.appId,
      capabilitySha256: request.capabilitySha256,
      configurationReference: request.configurationReference,
      configurationSha256: request.configurationSha256,
      nonce: request.nonce,
      observedAt: seconds,
      principalGeneration: attachment.capability.control.principalGeneration,
      provider: "quickbooksSandbox",
      releaseId: attachment.capability.release.id,
      scopeSha256: attachment.scopeSha256,
      serviceMemberships: attachment.capability.serviceMemberships.length,
      status: "ready",
      version: 1,
    };
    if (change === "nonce") {
      body.nonce = "99999999-9999-4999-a999-999999999999";
    }
    if (change === "configuration") {
      body.configurationSha256 = "f".repeat(64);
    }
    if (change === "generation") {
      body.principalGeneration += 1;
    }
    return Response.json(body, {
      headers: {
        "x-autograph-integration-readiness-signature":
          change === "signature" ? "0".repeat(64) : signature("response", JSON.stringify(body)),
      },
      status: change === "vercel-login" ? 403 : 200,
    });
  });
  return {
    http,
    input: {
      assertCurrent: vi.fn<() => Promise<void>>().mockResolvedValue(),
      attachment,
      fetch: http,
      now: () => seconds * 1000,
      publicOrigin: "https://invoice-app.example",
      setupProofSecret: secret,
      signal: new AbortController().signal,
    },
  };
};
test("public delivery verifies shared loaded-config and actual SQL proof using a fresh signed challenge", async () => {
  const f = fixture();
  expect(await observeAppIntegrationPublicRelease(f.input)).toBe(true);
  expect(f.http).toHaveBeenCalledTimes(1);
  expect(f.input.assertCurrent).toHaveBeenCalledTimes(3);
});
test.each(["nonce", "configuration", "generation", "signature", "vercel-login"] as const)(
  "never accepts stale/unauthorized integration proof: %s",
  async (change) => {
    const f = fixture(change);
    expect(await observeAppIntegrationPublicRelease(f.input)).toBe(false);
  },
);
test("unrecognized route and revoked canonical owner do not issue a readiness request", async () => {
  const f = fixture();
  expect(
    await observeAppIntegrationPublicRelease({
      ...f.input,
      attachment: { ...attachment, readinessPath: "/unrelated" },
    }),
  ).toBe(false);
  f.input.assertCurrent.mockRejectedValue(new Error("revoked"));
  expect(await observeAppIntegrationPublicRelease(f.input)).toBe(false);
  expect(f.http).not.toHaveBeenCalled();
});
