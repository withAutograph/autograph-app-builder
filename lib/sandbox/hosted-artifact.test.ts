import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { extract } from "tar";

import {
  HOSTED_ARTIFACT_BYTES,
  HOSTED_ARTIFACT_PATH,
  HOSTED_ARTIFACT_SHA256,
  HOSTED_SOURCE_PATH,
  hostedExecutionArtifactDigest,
  readHostedArtifactBytes,
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
  hostedPlanningDependencyCacheManifestSchema,
} from "../repository/dependency-cache";

const sha256 = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

describe("hosted Arrusted artifact", () => {
  it("keeps exact artifact bytes embedded in the Eve service bundle", () => {
    const content = readHostedArtifactBytes();
    const authoredContent = readFileSync(HOSTED_ARTIFACT_PATH);
    expect(content.byteLength).toBe(HOSTED_ARTIFACT_BYTES);
    expect(sha256(content)).toBe(HOSTED_ARTIFACT_SHA256);
    expect(authoredContent.byteLength).toBe(HOSTED_ARTIFACT_BYTES);
    expect(sha256(authoredContent)).toBe(HOSTED_ARTIFACT_SHA256);
    expect(HOSTED_ARTIFACT_PATH).toMatch(/^artifacts\/hosted\//u);
    expect(HOSTED_ARTIFACT_PATH).not.toMatch(/^public\//u);
    expect(existsSync("public/hosted-artifacts")).toBe(false);
    expect(readFileSync("next.config.ts", "utf8")).not.toContain(
      `"./${HOSTED_ARTIFACT_PATH}"`,
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

  it("binds the authored artifact to the exact hosted planning receipt", () => {
    const root = mkdtempSync(join(tmpdir(), "hosted-artifact-binding-"));
    try {
      extract({ cwd: root, file: HOSTED_ARTIFACT_PATH, sync: true });
      const seed = join(root, ".app-builder-hosted-seed");
      const artifactManifest = JSON.parse(
        readFileSync(join(seed, "artifact-manifest.json"), "utf8"),
      ) as { target: Record<string, unknown> };
      const dependencyManifest = JSON.parse(
        readFileSync(join(seed, "dependency-cache", "manifest.json"), "utf8"),
      ) as unknown;

      expect(artifactManifest.target).toEqual(
        expect.objectContaining({
          sha: ARRUSTED_TARGET_SHA,
          tree: ARRUSTED_TARGET_TREE,
          eligibilityDigest: HOSTED_ELIGIBILITY_DIGEST,
          contractDigest: HOSTED_CONTRACT_DIGEST,
        }),
      );
      expect(
        hostedPlanningDependencyCacheManifestSchema.parse(dependencyManifest),
      ).toEqual(dependencyManifest);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
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
