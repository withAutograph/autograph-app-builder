import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  HOSTED_BUN_VERSION,
  HOSTED_MISE_VERSION,
  HOSTED_TOOLCHAIN_CONTRACT_VERSION,
  HOSTED_TOOLCHAIN_DOWNLOAD_HOSTS,
  hostedToolchainArtifacts,
  hostedToolchainBootstrapCommand,
  hostedToolchainRevalidationKey,
} from "./hosted-toolchain";

describe("hosted Vercel Sandbox toolchain", () => {
  it("pins both supported Linux architectures by checksum", () => {
    for (const artifact of Object.values(hostedToolchainArtifacts)) {
      expect(artifact.miseUrl).toContain(`v${HOSTED_MISE_VERSION}`);
      expect(artifact.bunUrl).toContain(`bun-v${HOSTED_BUN_VERSION}`);
      expect(artifact.miseSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(artifact.bunSha256).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(HOSTED_TOOLCHAIN_DOWNLOAD_HOSTS).toEqual([
      "github.com",
      "release-assets.githubusercontent.com",
    ]);
  });

  it("downloads to temporary files, verifies, and installs without piping code", () => {
    const command = hostedToolchainBootstrapCommand();
    expect(command).toContain('case "$(uname -m)"');
    expect(command).toContain("sha256sum --check --strict");
    expect(command).toContain("sudo install --owner=root --group=root");
    expect(command).toContain("mise --version");
    expect(command).toContain("bun --version");
    expect(command).not.toMatch(/curl[^\n]*\|/u);
    expect(command).not.toMatch(/token|password|authorization/iu);
  });

  it("binds snapshot revalidation to the contract, inputs, and exact command bytes", () => {
    expect(HOSTED_TOOLCHAIN_CONTRACT_VERSION).toBe(2);
    expect(hostedToolchainRevalidationKey()).toMatch(
      /^autograph-app-builder-vercel-toolchain-v2:[0-9a-f]{64}$/u,
    );
    expect(hostedToolchainRevalidationKey()).toBe(
      hostedToolchainRevalidationKey(),
    );
    const command = hostedToolchainBootstrapCommand();
    expect(hostedToolchainRevalidationKey(`${command}\n# changed`)).not.toBe(
      hostedToolchainRevalidationKey(command),
    );
  });

  it("narrows live sessions after the bootstrap snapshot", () => {
    const definition = readFileSync("agent/sandbox.ts", "utf8");
    expect(definition).toContain("backend: createHostedVercelBackend()");
    expect(definition).toContain('await use({ networkPolicy: "deny-all" })');
    expect(definition).toContain(
      "revalidationKey: hostedToolchainRevalidationKey",
    );
  });
});
