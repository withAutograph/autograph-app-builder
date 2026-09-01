import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { create as createTar } from "tar";
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
  hostedArchiveExtractorShellFunction,
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
      "toolchain-readback",
    ])
      expect(command).toContain(`stage='${stage}'`);
    expect(command).toContain('case "$(uname -m)"');
    expect(command).toContain("command -v python3 >/dev/null");
    expect(command).toContain(
      'archive.extractall(destination, members=selected, filter="data")',
    );
    expect(command).toContain('python3 - "$1" "$2" "${3-}"');
    expect(command).toContain(
      `extract_verified_archive "$seed" "$work" '.app-builder-hosted-seed/dependency-cache'`,
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
    expect(command).not.toMatch(
      /source-tree[.]tar[.]gz|hosted-source|source-files[.]json|source-checksums[.]sha256/u,
    );
    expect(command).not.toContain("rm -rf /workspace/repository");
  });

  it("extracts only the requested archive subtree and preserves unfiltered calls", async () => {
    const root = mkdtempSync(join(tmpdir(), "hosted-archive-extractor-"));
    const source = join(root, "source");
    const archive = join(root, "mixed.tar.gz");
    const filteredDestination = join(root, "filtered");
    const unfilteredDestination = join(root, "unfiltered");
    const dependencyPath = join(
      ".app-builder-hosted-seed",
      "dependency-cache",
      "manifest.json",
    );
    const sentinelPath = join(
      ".app-builder-hosted-seed",
      "source-tree",
      "sentinel.txt",
    );

    try {
      mkdirSync(join(source, dependencyPath, ".."), { recursive: true });
      mkdirSync(join(source, sentinelPath, ".."), { recursive: true });
      writeFileSync(join(source, dependencyPath), '{"sealed":true}\n');
      writeFileSync(join(source, sentinelPath), "private source sentinel\n");
      await createTar({ cwd: source, file: archive, gzip: true }, [
        ".app-builder-hosted-seed",
      ]);

      const extractor = hostedArchiveExtractorShellFunction();
      execFileSync(
        "bash",
        [
          "-c",
          `${extractor}\nextract_verified_archive "$1" "$2" "$3"`,
          "hosted-archive-extractor",
          archive,
          filteredDestination,
          ".app-builder-hosted-seed/dependency-cache",
        ],
        { encoding: "utf8" },
      );
      expect(
        readFileSync(join(filteredDestination, dependencyPath), "utf8"),
      ).toBe('{"sealed":true}\n');
      expect(existsSync(join(filteredDestination, sentinelPath))).toBe(false);

      execFileSync(
        "bash",
        [
          "-c",
          `${extractor}\nextract_verified_archive "$1" "$2"`,
          "hosted-archive-extractor",
          archive,
          unfilteredDestination,
        ],
        { encoding: "utf8" },
      );
      expect(
        readFileSync(join(unfilteredDestination, sentinelPath), "utf8"),
      ).toBe("private source sentinel\n");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("leaves the model-facing workspace source to the canonical clone", () => {
    const command = hostedToolchainBootstrapCommand();
    expect(command).not.toContain("/workspace/repository");
    expect(command).toContain("/opt/app-builder/dependency-cache");
  });

  it("binds snapshot revalidation to the contract, inputs, and exact command bytes", () => {
    expect(HOSTED_TOOLCHAIN_CONTRACT_VERSION).toBe(5);
    expect(hostedToolchainRevalidationKey()).toMatch(
      /^autograph-app-builder-vercel-toolchain-v5:[0-9a-f]{64}$/u,
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
    expect(command).toContain(".app-builder-hosted-seed/dependency-cache");
    expect(command).not.toContain("/opt/app-builder/dependency-cache");
    expect(command).not.toMatch(
      /source-tree[.]tar[.]gz|source-files[.]json|source-checksums[.]sha256/u,
    );
    expect(command).not.toMatch(/sudo|token|password|authorization/iu);
    expect(command).toContain(
      "releases/download/hosted-arrusted-d378904a-execution-v6",
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
