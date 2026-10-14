import { describe, expect, it } from "vitest";

import {
  HOSTED_ARTIFACT_BYTES,
  HOSTED_ARTIFACT_RELEASE_NAME,
  HOSTED_ARTIFACT_RELEASE_TAG,
  HOSTED_ARTIFACT_SHA256,
  HOSTED_ARTIFACT_URL,
  hostedExecutionArtifactDigest,
} from "./hosted-artifact";
import { ARRUSTED_TARGET_SHA, ARRUSTED_TARGET_TREE } from "../repository/dependency-cache";

describe("hosted Arrusted artifact", () => {
  it("pins an immutable release asset without embedding its bytes", () => {
    expect(HOSTED_ARTIFACT_URL).toBe(
      `https://github.com/withAutograph/autograph-app-builder/releases/download/${HOSTED_ARTIFACT_RELEASE_TAG}/${HOSTED_ARTIFACT_RELEASE_NAME}`,
    );
    expect(Number.isSafeInteger(HOSTED_ARTIFACT_BYTES)).toBe(true);
    expect(HOSTED_ARTIFACT_BYTES).toBeGreaterThan(0);
    expect(HOSTED_ARTIFACT_SHA256).toMatch(/^[0-9a-f]{64}$/u);
    expect(hostedExecutionArtifactDigest()).toBe(
      `vercel-sandbox-seed@sha256:${HOSTED_ARTIFACT_SHA256}`,
    );
  }, 20_000);

  it("binds release identity to the exact hosted dependency closure", () => {
    expect(HOSTED_ARTIFACT_RELEASE_TAG).toContain(ARRUSTED_TARGET_SHA.slice(0, 8));
    expect(ARRUSTED_TARGET_TREE).toMatch(/^[0-9a-f]{40}$/u);
  });
});
