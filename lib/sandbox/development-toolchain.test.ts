import { describe, expect, it } from "vitest";

import {
  DEVELOPMENT_SANDBOX_ENVIRONMENT,
  developmentPinnedToolchainCommand,
  developmentVercelDependencyCommand,
  developmentVercelProviderTemplateKey,
  developmentVercelRevalidationKey,
  type DevelopmentVercelBootstrapInput,
} from "./development-toolchain";

function input(override: Partial<DevelopmentVercelBootstrapInput> = {}) {
  const sourceArchive = Buffer.from("source");
  return {
    sourceRoot: "/private/source",
    sourceFingerprint: "a".repeat(64),
    sourceSha: "b".repeat(40),
    sourceTree: "c".repeat(40),
    dependencyKey: "d".repeat(64),
    sourceArchive,
    sourceArchiveSha256:
      "41cf6794ba4200b839c53531555f0f3998df4cbb01a4d5cb0b94e3ca5e23947d",
    lockfiles: {
      ".config/mise/config.toml": "1".repeat(64),
      ".config/mise/mise.lock": "2".repeat(64),
      "bun.lock": "3".repeat(64),
      "Cargo.lock": "4".repeat(64),
    },
    ...override,
  } satisfies DevelopmentVercelBootstrapInput;
}

describe("Development Vercel Sandbox dependency template", () => {
  it("keys provider reuse only by dependency inputs", () => {
    const first = input();
    const codeOnlyChange = input({
      sourceFingerprint: "e".repeat(64),
      sourceSha: "f".repeat(40),
      sourceTree: "1".repeat(40),
    });
    expect(developmentVercelRevalidationKey(codeOnlyChange)).toBe(
      developmentVercelRevalidationKey(first),
    );
    expect(developmentVercelProviderTemplateKey(first.dependencyKey)).toBe(
      developmentVercelProviderTemplateKey(codeOnlyChange.dependencyKey),
    );
    expect(developmentVercelProviderTemplateKey("9".repeat(64))).not.toBe(
      developmentVercelProviderTemplateKey(first.dependencyKey),
    );
  });

  it("builds the standard closed development-execution cache without an image", () => {
    const command = developmentVercelDependencyCommand(input());
    expect(command).toContain('"scope":"development-execution"');
    expect(command).toContain('"version":2');
    expect(command).toContain(
      "/opt/app-builder/dependency-cache/node-modules.tar.gz",
    );
    expect(command).toContain(
      "/opt/app-builder/dependency-cache/cargo-closure.tar.gz",
    );
    expect(command).toContain(
      "bun install --frozen-lockfile --ignore-scripts --linker=hoisted",
    );
    expect(command).toContain('directory = "/opt/app-builder/cargo/vendor"');
    expect(command).toContain(
      'if grep -F "$work" "$work/cargo-closure/config.toml"',
    );
    expect(command).not.toContain("docker");
    expect(command).not.toContain("microsandbox");
    expect(DEVELOPMENT_SANDBOX_ENVIRONMENT).toMatchObject({
      CARGO_NET_OFFLINE: "true",
      MISE_AUTO_INSTALL: "false",
    });
  });

  it("installs pinned tools only inside the disposable Vercel workspace", () => {
    const command = developmentPinnedToolchainCommand();
    expect(command).toContain("root='/workspace/.app-builder/toolchain'");
    expect(command).toContain("command -v python3 >/dev/null");
    expect(command).toContain("extract_verified_archive() {");
    expect(command).toContain(
      'extract_verified_archive "$work/cargo.tar.xz" "$work"',
    );
    expect(command).toContain('archive.extractall(destination, filter="data")');
    expect(command).not.toContain("tar -xJf");
    expect(command).toContain("sha256sum --check --strict");
    expect(command).toContain("node --version");
    expect(command).toContain("bun --version");
    expect(command).toContain("cargo --version");
    expect(command).not.toContain("/usr/local");
    expect(command).not.toContain("sudo");
    expect(command).not.toContain("hosted-seed");
  });
});
