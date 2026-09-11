import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  HOSTED_ARTIFACT_BYTES,
  HOSTED_ARTIFACT_RELEASE_NAME,
  HOSTED_ARTIFACT_RELEASE_TAG,
  HOSTED_ARTIFACT_SHA256,
  HOSTED_ARTIFACT_URL,
  hostedExecutionArtifactDigest,
} from "./hosted-artifact";
import {
  ARRUSTED_TARGET_SHA,
  ARRUSTED_TARGET_TREE,
} from "../repository/dependency-cache";

describe("hosted Arrusted artifact", () => {
  it("pins an immutable release asset without embedding its bytes", () => {
    expect(HOSTED_ARTIFACT_URL).toBe(
      `https://github.com/withAutograph/autograph-app-builder/releases/download/${HOSTED_ARTIFACT_RELEASE_TAG}/${HOSTED_ARTIFACT_RELEASE_NAME}`,
    );
    expect(HOSTED_ARTIFACT_BYTES).toBe(175_953_869);
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

  it("binds release identity to the exact hosted dependency closure", () => {
    expect(HOSTED_ARTIFACT_RELEASE_TAG).toContain(
      ARRUSTED_TARGET_SHA.slice(0, 8),
    );
    expect(ARRUSTED_TARGET_TREE).toMatch(/^[0-9a-f]{40}$/u);
  });

  it("contains no production fixed-source receipt or materialization path", () => {
    for (const path of [
      "agent/tools/inspect_source.ts",
      "agent/tools/prepare_workspace.ts",
      "lib/sandbox/hosted-toolchain.ts",
    ]) {
      const definition = readFileSync(path, "utf8");
      expect(definition).not.toContain("hosted-source");
      expect(definition).not.toContain("source-tree.tar.gz");
    }
    expect(
      readFileSync("lib/repository/supported-template.ts", "utf8"),
    ).not.toContain("/opt/app-builder/hosted-source");
    expect(existsSync("lib/repository/hosted-source.ts")).toBe(false);
  });
});
