import { describe, expect, it } from "vitest";

import { readHostedPreviewAdmissionControlBinding } from "./admission-control";

const nowEpochMs = Date.parse("2026-08-27T01:00:00.000Z");
const binding = {
  version: 1,
  environment: "preview",
  enforcement: "provider-readback",
  scope: "issuer-audience-workspace-subject",
  startsPerSubjectPerMinute: 10,
  startsPerWorkspacePerMinute: 50,
  maxConcurrentSessionsPerSubject: 2,
  maxActiveSessionsPerWorkspace: 20,
  monthlySpendUsedUsdCents: 2_500,
  monthlySpendLimitUsdCents: 10_000,
  observedAt: "2026-08-27T00:55:00.000Z",
  expiresAt: "2026-08-27T01:55:00.000Z",
  readbackDigest: `sha256:${"a".repeat(64)}`,
} as const;

describe("hosted Preview admission-control binding", () => {
  it("accepts one fresh closed provider-readback binding", () => {
    expect(
      readHostedPreviewAdmissionControlBinding(
        { EVE_HOSTED_ADMISSION_CONTROL: JSON.stringify(binding) },
        nowEpochMs,
      ),
    ).toEqual(binding);
  });

  it("fails closed on absent, stale, non-Preview, unbounded, or unknown controls", () => {
    for (const candidate of [
      undefined,
      JSON.stringify({ ...binding, environment: "production" }),
      JSON.stringify({ ...binding, startsPerSubjectPerMinute: 61 }),
      JSON.stringify({ ...binding, monthlySpendUsedUsdCents: 10_000 }),
      JSON.stringify({ ...binding, expiresAt: "2026-08-27T00:59:59.000Z" }),
      JSON.stringify({ ...binding, unknownControl: true }),
    ]) {
      expect(() =>
        readHostedPreviewAdmissionControlBinding(
          { EVE_HOSTED_ADMISSION_CONTROL: candidate },
          nowEpochMs,
        ),
      ).toThrow();
    }
  });
});
