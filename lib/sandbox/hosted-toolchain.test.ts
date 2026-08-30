import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SANDBOX_EXECUTION_POLICY } from "./execution-policy";
import {
  HOSTED_BOOTSTRAP_MINIMUM_FILE_BYTES,
  HOSTED_BUN_VERSION,
  HOSTED_MISE_VERSION,
  HOSTED_NODE_VERSION,
  HOSTED_RUST_VERSION,
  HOSTED_TOOLCHAIN_CONTRACT_VERSION,
  HOSTED_TOOLCHAIN_DOWNLOAD_HOSTS,
  hostedToolchainArtifacts,
  hostedArtifactWorkspaceInstallCommand,
  hostedToolchainBootstrapCommand,
  hostedToolchainRevalidationKey,
} from "./hosted-toolchain";

describe("hosted Vercel Sandbox toolchain", () => {
  it("reserves enough single-file capacity for the pinned bootstrap artifact", () => {
    expect(SANDBOX_EXECUTION_POLICY.command.maximumFileBytes).toBe(268_435_456);
    expect(SANDBOX_EXECUTION_POLICY.command.maximumFileBytes).toBeGreaterThan(
      HOSTED_BOOTSTRAP_MINIMUM_FILE_BYTES,
    );
    expect(() =>
      hostedToolchainBootstrapCommand(HOSTED_BOOTSTRAP_MINIMUM_FILE_BYTES - 1),
    ).toThrow("cannot hold the hosted artifact");
  });

  it("pins both supported Linux architectures by checksum", () => {
    for (const artifact of Object.values(hostedToolchainArtifacts)) {
      expect(artifact.miseUrl).toContain(`v${HOSTED_MISE_VERSION}`);
      expect(artifact.bunUrl).toContain(`bun-v${HOSTED_BUN_VERSION}`);
      expect(artifact.nodeUrl).toContain(`v${HOSTED_NODE_VERSION}`);
      expect(artifact.miseSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(artifact.bunSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(artifact.nodeSha256).toMatch(/^[0-9a-f]{64}$/u);
      for (const url of [
        artifact.rust.cargoUrl,
        artifact.rust.rustcUrl,
        artifact.rust.stdUrl,
      ])
        expect(url).toContain(HOSTED_RUST_VERSION);
      for (const checksum of [
        artifact.rust.cargoSha256,
        artifact.rust.rustcSha256,
        artifact.rust.stdSha256,
      ])
        expect(checksum).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(HOSTED_TOOLCHAIN_DOWNLOAD_HOSTS).toEqual([
      "github.com",
      "release-assets.githubusercontent.com",
      "nodejs.org",
      "static.rust-lang.org",
    ]);
  });

  it("downloads to temporary files, verifies, and installs without piping code", () => {
    const command = hostedToolchainBootstrapCommand();
    expect(
      command.indexOf("install -d -m 0755 /workspace/.app-builder"),
    ).toBeLessThan(command.indexOf("curl --fail"));
    expect(command).toContain("hosted_toolchain_bootstrap_failed:%s");
    for (const stage of [
      "artifact-verification",
      "mise-download-verification",
      "bun-download-verification",
      "node-download-verification",
      "cargo-download-verification",
      "rustc-download-verification",
      "rust-std-download-verification",
      "toolchain-extraction",
      "toolchain-installation",
      "workspace-source-installation",
      "toolchain-readback",
    ])
      expect(command).toContain(`stage='${stage}'`);
    expect(command).toContain('case "$(uname -m)"');
    expect(command).toContain("command -v python3 >/dev/null");
    expect(command).toContain('archive.extractall(destination, filter="data")');
    expect(command).toContain('extract_verified_archive "$seed" "$work"');
    expect(command).toContain(
      'extract_verified_archive "$artifact/source-tree.tar.gz" /workspace/repository',
    );
    expect(command).not.toContain(
      'tar --extract --gzip --file "$seed" --directory "$work"',
    );
    expect(command).toContain("sha256sum --check --strict");
    expect(command).toContain("sudo install --owner=root --group=root");
    expect(command).toContain("mise --version");
    expect(command).toContain("bun --version");
    expect(command).toContain("node --version");
    expect(command).toContain("node -e 'const fs=require");
    expect(command).toContain("cargo --version");
    expect(command).toContain("rustc --version");
    expect(command).toContain(
      "--prefix=/opt/app-builder/rust --disable-ldconfig",
    );
    expect(command).toContain(
      'sudo install --owner=root --group=root --mode=0755 "$work/$node_directory/bin/node" /usr/local/bin/node',
    );
    expect(command).not.toMatch(/curl[^\n]*\|/u);
    expect(command).not.toMatch(/token|password|authorization/iu);
  });

  it("seeds the model-facing workspace with the exact hosted source tree", () => {
    const command = hostedToolchainBootstrapCommand();
    expect(command).toContain("rm -rf /workspace/repository");
    expect(command).toContain(
      'extract_verified_archive "$artifact/source-tree.tar.gz" /workspace/repository',
    );
    expect(command).toContain("/workspace/.app-builder/source-files.json");
    expect(command).toContain(
      "/workspace/.app-builder/source-checksums.sha256",
    );
    expect(command).toContain(
      "(cd /workspace && sha256sum -c .app-builder/source-checksums.sha256 >/dev/null)",
    );
  });

  it("binds snapshot revalidation to the contract, inputs, and exact command bytes", () => {
    expect(HOSTED_TOOLCHAIN_CONTRACT_VERSION).toBe(4);
    expect(hostedToolchainRevalidationKey()).toMatch(
      /^autograph-app-builder-vercel-toolchain-v4:[0-9a-f]{64}$/u,
    );
    expect(hostedToolchainRevalidationKey()).toBe(
      hostedToolchainRevalidationKey(),
    );
    const command = hostedToolchainBootstrapCommand();
    expect(hostedToolchainRevalidationKey(`${command}\n# changed`)).not.toBe(
      hostedToolchainRevalidationKey(command),
    );
  });

  it("materializes the sealed dependency closure in the proof workspace", () => {
    const command = hostedArtifactWorkspaceInstallCommand();
    expect(
      command.indexOf("install -d -m 0755 /workspace/.app-builder"),
    ).toBeLessThan(command.indexOf("curl --fail"));
    expect(command).toContain(
      "/workspace/.app-builder/hosted-dependency-cache",
    );
    expect(command).toContain("sha256sum --check --strict");
    expect(command).toContain("node-modules.tar.gz");
    expect(command).not.toContain("/opt/app-builder/dependency-cache");
    expect(command).not.toMatch(/sudo|token|password|authorization/iu);
    expect(command).toContain(
      "releases/download/hosted-arrusted-d378904a-execution-v4",
    );
  });

  it("narrows live sessions after the bootstrap snapshot", () => {
    const definition = readFileSync("agent/sandbox.ts", "utf8");
    expect(definition).toContain("backend: createHostedVercelBackend({");
    expect(definition).toContain("runtimeRecoveryPrewarmInput: () => ({");
    expect(definition).toContain("bootstrap: bootstrapHostedVercelSandbox");
    expect(definition).toContain("seedFiles: readHostedManagedSeedFiles()");
    expect(definition).not.toContain("readHostedArtifactBytes");
    expect(definition).toContain('await use({ networkPolicy: "deny-all" })');
    expect(definition).toContain("HOSTED_TOOLCHAIN_DOWNLOAD_HOSTS");
    expect(definition).toContain("useHostedArtifactProof");
    expect(definition).toContain(
      "revalidationKey: hostedToolchainRevalidationKey",
    );
  });

  it("selects the environment before constructing any sandbox backend", () => {
    const definition = readFileSync("agent/sandbox.ts", "utf8");
    expect(definition).toContain(
      "export default selectSandboxDefinition(plan.kind, {",
    );
    expect(definition).toContain(
      "localMicrosandbox: createMicrosandboxDefinition",
    );
    expect(definition).not.toContain("const microsandboxDefinition =");
    expect(definition).not.toContain(
      "export default function resolveSandboxDefinition",
    );
  });
});
