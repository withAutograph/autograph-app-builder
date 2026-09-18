import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEVELOPMENT_SANDBOX_ENVIRONMENT,
  developmentDependencySymlinkScript,
  developmentPinnedToolchainCommand,
  developmentVercelDependencyCommand,
  developmentVercelDependencyRepairCommand,
  developmentVercelProviderTemplateKey,
  developmentVercelRevalidationKey,
} from "./development-toolchain";
import type { DevelopmentVercelBootstrapInput } from "./development-toolchain";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function input(override: Partial<DevelopmentVercelBootstrapInput> = {}) {
  const sourceArchive = Buffer.from("source");
  return {
    dependencyKey: "d".repeat(64),
    lockfiles: {
      ".config/mise/config.toml": "1".repeat(64),
      ".config/mise/mise.lock": "2".repeat(64),
      "Cargo.lock": "4".repeat(64),
      "bun.lock": "3".repeat(64),
    },
    sourceArchive,
    sourceArchiveSha256: "41cf6794ba4200b839c53531555f0f3998df4cbb01a4d5cb0b94e3ca5e23947d",
    sourceFingerprint: "a".repeat(64),
    sourceRoot: "/private/source",
    sourceSha: "b".repeat(40),
    sourceTree: "c".repeat(40),
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
    expect(developmentVercelRevalidationKey({ dependencyKey: first.dependencyKey })).toBe(
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
    expect(command).toContain("/workspace/.app-builder/dependency-cache/cargo/config.toml");
    expect(command).toContain("bun install --frozen-lockfile --ignore-scripts --linker=hoisted");
    expect(command).toContain("stage='mise-tools'");
    expect(command).toContain("mise install --locked cue");
    expect(command).toContain('node - "$work/source"');
    expect(command).not.toContain('readlink -f -- "$link"');
    expect(command).toContain(
      'directory = "/workspace/.app-builder/dependency-cache/cargo/vendor"',
    );
    expect(command).toContain('if grep -F "$work" "$work/cargo-closure/config.toml"');
    expect(command).not.toContain("docker");
    expect(command).not.toContain("microsandbox");
    expect(command).not.toContain("sudo");
    expect(command).not.toContain("chmod -R a-w");
    expect(command).toContain('test "$(realpath "$cache_root")" = "$cache_root"');
    expect(command).toContain('find "$cache_root" \\( -type f -o -type d \\) -perm /022');
    expect(DEVELOPMENT_SANDBOX_ENVIRONMENT).toMatchObject({
      LD_LIBRARY_PATH: "/workspace/.app-builder/toolchain/rust/lib",
      MISE_AUTO_INSTALL: "false",
      TERM: "xterm-256color",
    });
  });

  it("reuses a matching dependency cache before staging or installing source dependencies", () => {
    const command = developmentVercelDependencyCommand(input());
    const cacheHit = command.indexOf("development_vercel_dependency_cache_hit");
    const staging = command.indexOf('work="$(mktemp -d');
    const install = command.indexOf(
      "bun install --frozen-lockfile --ignore-scripts --linker=hoisted --silent",
    );
    expect(cacheHit).toBeGreaterThan(-1);
    expect(cacheHit).toBeLessThan(staging);
    expect(cacheHit).toBeLessThan(install);
    expect(command).toContain('"scope":"development-execution"');
    expect(command).toContain(`"dependencyKey":"${input().dependencyKey}`);
    expect(command).toContain("node_modules/path-to-regexp/package.json");
    expect(command).toContain(
      "node_modules/@vercel/microfrontends/node_modules/path-to-regexp/package.json",
    );
    expect(command).toContain('"$cache_root/cargo/config.toml"');
    expect(command).toContain('unlink "$source_archive"');
    expect(command).toContain("mise install --locked cue");
  });

  it("accepts validated Bun symlinks while rejecting writable cache entries", () => {
    const command = developmentVercelDependencyRepairCommand(input().dependencyKey);
    expect(command).toContain('find "$cache_root" \\( -type f -o -type d \\) -perm /022');
    expect(command).not.toContain('find "$cache_root" -perm /022');
    expect(command).toContain(developmentDependencySymlinkScript);
    expect(command).toContain("stage='mise-tools'");
    expect(command).toContain("mise install --locked cue");
  });

  it("keeps Bun links inside the closure and rebinds only workspace links", async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "app-builder-development-links-")),
    );
    try {
      const source = path.join(root, "source");
      const modules = path.join(source, "node_modules");
      const packageRoot = path.join(
        modules,
        ".bun/path-to-regexp@8.4.2/node_modules/path-to-regexp",
      );
      const workspacePackage = path.join(source, "packages/shared");
      const workspaceBin = path.join(workspacePackage, "bin/shared.mjs");
      await mkdir(packageRoot, { recursive: true });
      await mkdir(path.join(workspacePackage, "bin"), { recursive: true });
      await mkdir(path.join(modules, ".bin"));
      await writeFile(path.join(packageRoot, "package.json"), "{}\n");
      await writeFile(path.join(workspacePackage, "package.json"), "{}\n");
      await writeFile(workspaceBin, "export {};\n");
      await symlink(packageRoot, path.join(modules, "path-to-regexp"));
      await symlink(workspacePackage, path.join(modules, "workspace-shared"));
      await symlink("../workspace-shared/bin/shared.mjs", path.join(modules, ".bin/shared"));

      execFileSync(process.execPath, ["-", source], {
        input: developmentDependencySymlinkScript,
      });

      expect(await readlink(path.join(modules, "path-to-regexp"))).toBe(
        ".bun/path-to-regexp@8.4.2/node_modules/path-to-regexp",
      );
      expect(await readlink(path.join(modules, "workspace-shared"))).toBe(
        "/workspace/repository/packages/shared",
      );
      expect(await readlink(path.join(modules, ".bin/shared"))).toBe(
        "/workspace/repository/packages/shared/bin/shared.mjs",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects unresolved and outside dependency links", async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "app-builder-development-links-")),
    );
    try {
      const source = path.join(root, "source");
      const modules = path.join(source, "node_modules");
      const outside = path.join(root, "outside");
      await mkdir(modules, { recursive: true });
      await mkdir(outside);
      await symlink(path.join(source, "missing"), path.join(modules, "missing"));
      const unresolved = spawnSync(process.execPath, ["-", source], {
        input: developmentDependencySymlinkScript,
      });
      expect(unresolved.status).not.toBe(0);
      expect(unresolved.stderr.toString()).toContain(
        "Unresolved development dependency link: missing",
      );

      await rm(path.join(modules, "missing"));
      await symlink(outside, path.join(modules, "outside"));
      const escaped = spawnSync(process.execPath, ["-", source], {
        input: developmentDependencySymlinkScript,
      });
      expect(escaped.status).not.toBe(0);
      expect(escaped.stderr.toString()).toContain(
        "Development dependency link escaped the source: outside",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("installs the complete development toolchain in the disposable Vercel Sandbox", () => {
    const command = developmentPinnedToolchainCommand();
    const nativeToolchain = command.indexOf("sudo dnf install -y gcc");
    const rustInstallation = command.indexOf(
      '"$work/$rustc_directory/install.sh" --prefix="$root/rust" --disable-ldconfig',
    );
    expect(nativeToolchain).toBeGreaterThan(-1);
    expect(nativeToolchain).toBeLessThan(rustInstallation);
    expect(command).toContain("stage='native-toolchain'");
    expect(command).toContain("command -v cc >/dev/null");
    expect(command).toContain("cc --version >/dev/null");
    expect(command).toContain("sudo apt-get update");
    expect(command).toContain("sudo apt-get install -y build-essential");
    expect(command).toContain("root='/workspace/.app-builder/toolchain'");
    expect(command).toContain("command -v python3 >/dev/null");
    expect(command).toContain("extract_verified_archive() {");
    expect(command).toContain('extract_verified_archive "$work/cargo.tar.xz" "$work"');
    expect(command).toContain('archive.extractall(destination, filter="data")');
    expect(command).not.toContain("tar -xJf");
    expect(command).toContain("sha256sum --check --strict");
    expect(command).toContain("node --version");
    expect(command).toContain("bun --version");
    expect(command).toContain("cargo --version");
    expect(command).not.toContain("/usr/local");
    expect(command).not.toContain("hosted-seed");
  });
});
