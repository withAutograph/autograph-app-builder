import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  HOSTED_ARTIFACT_BYTES,
  HOSTED_ARTIFACT_RELEASE_NAME,
  HOSTED_ARTIFACT_RELEASE_TAG,
  HOSTED_ARTIFACT_SHA256,
  HOSTED_ARTIFACT_URL,
  HOSTED_SOURCE_PATH,
  hostedExecutionArtifactDigest,
} from "./hosted-artifact";
import {
  HOSTED_CONTRACT_DIGEST,
  HOSTED_ELIGIBILITY_DIGEST,
  HOSTED_SOURCE_RECEIPT_DIGEST,
  hostedSourceReceipt,
} from "../repository/hosted-source";
import {
  ARRUSTED_TARGET_SHA,
  ARRUSTED_TARGET_TREE,
} from "../repository/dependency-cache";
import { LEGACY_SOURCE_RECEIPT_VERSION } from "../repository/source-receipt";

describe("hosted Arrusted artifact", () => {
  it("pins an immutable release asset without embedding its bytes", () => {
    expect(HOSTED_ARTIFACT_URL).toBe(
      `https://github.com/withAutograph/autograph-app-builder/releases/download/${HOSTED_ARTIFACT_RELEASE_TAG}/${HOSTED_ARTIFACT_RELEASE_NAME}`,
    );
    expect(HOSTED_ARTIFACT_BYTES).toBe(180_168_876);
    expect(HOSTED_ARTIFACT_SHA256).toMatch(/^[0-9a-f]{64}$/u);
    expect(existsSync("lib/sandbox/hosted-artifact.generated.ts")).toBe(false);
    expect(existsSync("public/hosted-artifacts")).toBe(false);
    expect(readFileSync("next.config.ts", "utf8")).not.toContain(
      "artifacts/hosted",
    );
    expect(hostedExecutionArtifactDigest()).toBe(
      `vercel-sandbox-seed@sha256:${HOSTED_ARTIFACT_SHA256}`,
    );
  }, 20_000);

  it.each(["preview", "production"] as const)(
    "exposes only the fixed release-disabled source receipt in %s",
    (environmentName) => {
      const receipt = hostedSourceReceipt(
        "existing-repository",
        HOSTED_SOURCE_PATH,
        {
          VERCEL: "1",
          EVE_HOSTED_ADAPTER: "1",
          VERCEL_ENV: environmentName,
          EVE_HOSTED_VERCEL_ENVIRONMENT: environmentName,
        },
      );
      expect(receipt?.version).toBe(LEGACY_SOURCE_RECEIPT_VERSION);
      expect(receipt?.digest).toBe(HOSTED_SOURCE_RECEIPT_DIGEST);
      expect(receipt?.releaseEnabled).toBe(false);
      expect(() =>
        hostedSourceReceipt("existing-repository", "/tmp/other", {
          VERCEL: "1",
          EVE_HOSTED_ADAPTER: "1",
          VERCEL_ENV: environmentName,
          EVE_HOSTED_VERCEL_ENVIRONMENT: environmentName,
        }),
      ).toThrow("supports only the fixed source");
      expect(
        hostedSourceReceipt("existing-repository", HOSTED_SOURCE_PATH, {}),
      ).toBeUndefined();
    },
  );

  it("binds release identity to the exact hosted execution receipt", () => {
    expect(HOSTED_ARTIFACT_RELEASE_TAG).toContain(
      ARRUSTED_TARGET_SHA.slice(0, 8),
    );
    expect(HOSTED_ELIGIBILITY_DIGEST).toMatch(/^[0-9a-f]{64}$/u);
    expect(HOSTED_CONTRACT_DIGEST).toMatch(/^[0-9a-f]{64}$/u);
    expect(ARRUSTED_TARGET_TREE).toMatch(/^[0-9a-f]{40}$/u);
  });

  it("rejects a hosted source before inspection when environments differ", () => {
    expect(() =>
      hostedSourceReceipt("existing-repository", HOSTED_SOURCE_PATH, {
        VERCEL: "1",
        EVE_HOSTED_ADAPTER: "1",
        VERCEL_ENV: "production",
        EVE_HOSTED_VERCEL_ENVIRONMENT: "preview",
      }),
    ).toThrow("exact matching Preview or Production");
  });
});
