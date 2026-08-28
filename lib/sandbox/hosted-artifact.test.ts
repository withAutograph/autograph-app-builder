import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  HOSTED_ARTIFACT_BYTES,
  HOSTED_ARTIFACT_PATH,
  HOSTED_ARTIFACT_SHA256,
  HOSTED_SOURCE_PATH,
  hostedExecutionArtifactDigest,
  readHostedArtifactBytes,
} from "./hosted-artifact";
import {
  HOSTED_SOURCE_RECEIPT_DIGEST,
  hostedSourceReceipt,
} from "../repository/hosted-source";

const sha256 = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

describe("hosted Arrusted artifact", () => {
  it("keeps exact artifact bytes in a server-only traced path", () => {
    const content = readHostedArtifactBytes();
    expect(content.byteLength).toBe(HOSTED_ARTIFACT_BYTES);
    expect(sha256(content)).toBe(HOSTED_ARTIFACT_SHA256);
    expect(HOSTED_ARTIFACT_PATH).toMatch(/^artifacts\/hosted\//u);
    expect(HOSTED_ARTIFACT_PATH).not.toMatch(/^public\//u);
    expect(existsSync("public/hosted-artifacts")).toBe(false);
    expect(readFileSync("next.config.ts", "utf8")).toContain(
      `"./${HOSTED_ARTIFACT_PATH}"`,
    );
    expect(hostedExecutionArtifactDigest()).toBe(
      `vercel-sandbox-seed@sha256:${HOSTED_ARTIFACT_SHA256}`,
    );
  });

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
