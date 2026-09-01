import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEVELOPMENT_SANDBOX_ENVIRONMENT,
  developmentDependencySymlinkScript,
  developmentPinnedToolchainCommand,
  developmentVercelDependencyCommand,
  developmentVercelDependencyRepairCommand,
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
    expect(command).toContain('"version":3');
    expect(command).toContain(
      `/workspace/.app-builder/dependency-cache/dependencies/${input().dependencyKey}/node_modules`,
    );
    expect(command).toContain(
      "/workspace/.app-builder/dependency-cache/cargo/config.toml",
    );
    expect(command).toContain(
      "bun install --frozen-lockfile --ignore-scripts --linker=hoisted",
    );
    expect(command).toContain('node - "$work/source"');
    expect(command).not.toContain('readlink -f -- "$link"');
    expect(command).toContain(
      'directory = "/workspace/.app-builder/dependency-cache/cargo/vendor"',
    );
    expect(command).toContain(
      'if grep -F "$work" "$work/cargo-closure/config.toml"',
    );
    expect(command).not.toContain("docker");
    expect(command).not.toContain("microsandbox");
    expect(command).not.toContain("sudo");
    expect(command).not.toContain("chmod -R a-w");
    expect(command).toContain(
      'test "$(realpath "$cache_root")" = "$cache_root"',
    );
    expect(command).toContain(
      'find "$cache_root" \\( -type f -o -type d \\) -perm /022',
    );
    expect(DEVELOPMENT_SANDBOX_ENVIRONMENT).toMatchObject({
      CARGO_NET_OFFLINE: "true",
      MISE_AUTO_INSTALL: "false",
    });
  });

  it("accepts validated Bun symlinks while rejecting writable cache entries", () => {
    const command = developmentVercelDependencyRepairCommand(
      input().dependencyKey,
    );
    expect(command).toContain(
      'find "$cache_root" \\( -type f -o -type d \\) -perm /022',
    );
    expect(command).not.toContain('find "$cache_root" -perm /022');
    expect(command).toContain(developmentDependencySymlinkScript);
  });

  it("keeps Bun links inside the closure and rebinds only workspace links", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "app-builder-development-links-")),
    );
    try {
      const source = join(root, "source");
      const modules = join(source, "node_modules");
      const packageRoot = join(
        modules,
        ".bun/path-to-regexp@8.4.2/node_modules/path-to-regexp",
      );
      const workspacePackage = join(source, "packages/shared");
      const workspaceBin = join(workspacePackage, "bin/shared.mjs");
      await mkdir(packageRoot, { recursive: true });
      await mkdir(join(workspacePackage, "bin"), { recursive: true });
      await mkdir(join(modules, ".bin"));
      await writeFile(join(packageRoot, "package.json"), "{}\n");
      await writeFile(join(workspacePackage, "package.json"), "{}\n");
      await writeFile(workspaceBin, "export {};\n");
      await symlink(packageRoot, join(modules, "path-to-regexp"));
      await symlink(workspacePackage, join(modules, "workspace-shared"));
      await symlink(
        "../workspace-shared/bin/shared.mjs",
        join(modules, ".bin/shared"),
      );

      execFileSync(process.execPath, ["-", source], {
        input: developmentDependencySymlinkScript,
      });

      expect(await readlink(join(modules, "path-to-regexp"))).toBe(
        ".bun/path-to-regexp@8.4.2/node_modules/path-to-regexp",
      );
      expect(await readlink(join(modules, "workspace-shared"))).toBe(
        "/workspace/repository/packages/shared",
      );
      expect(await readlink(join(modules, ".bin/shared"))).toBe(
        "/workspace/repository/packages/shared/bin/shared.mjs",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unresolved and outside dependency links", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "app-builder-development-links-")),
    );
    try {
      const source = join(root, "source");
      const modules = join(source, "node_modules");
      const outside = join(root, "outside");
      await mkdir(modules, { recursive: true });
      await mkdir(outside);
      await symlink(join(source, "missing"), join(modules, "missing"));
      const unresolved = spawnSync(process.execPath, ["-", source], {
        input: developmentDependencySymlinkScript,
      });
      expect(unresolved.status).not.toBe(0);
      expect(unresolved.stderr.toString()).toContain(
        "Unresolved development dependency link: missing",
      );

      await rm(join(modules, "missing"));
      await symlink(outside, join(modules, "outside"));
      const escaped = spawnSync(process.execPath, ["-", source], {
        input: developmentDependencySymlinkScript,
      });
      expect(escaped.status).not.toBe(0);
      expect(escaped.stderr.toString()).toContain(
        "Development dependency link escaped the source: outside",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
