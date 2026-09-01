import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { SandboxSession } from "eve/sandbox";

import {
  ARRUSTED_APP_VALIDATION_SHA256,
  ARRUSTED_APP_TEMPLATE_PACKAGE_SHA256,
  ARRUSTED_CREATE_APP_SHA256,
  ARRUSTED_MICROFRONTENDS_PATH_TO_REGEXP_VERSION,
  ARRUSTED_MICROFRONTENDS_VERSION,
  ARRUSTED_PATH_TO_REGEXP_VERSION,
  ARRUSTED_RUST_VERSION,
  ARRUSTED_TARGET_SHA,
  ARRUSTED_TARGET_TREE,
  DEPENDENCY_CACHE_ARCHIVE_PATH,
  DEPENDENCY_CACHE_CARGO_ARCHIVE_PATH,
  assertExactDependencyTargetBinding,
  bootstrapLiveTemplateDependencies,
  dependencyTargetForWorkspace,
  inspectDependencyCache,
  materializedDependencyNodeModulesRoot,
  materializeOfflineDependencies,
} from "./dependency-cache";

const archiveDigest = "a".repeat(64);
const hostedArchiveDigest =
  "d1febde038cc4f84394293e80bf076c944809a3e6cb6485accf67f4af2c4b1ce";
const hostedExecutionManifest = {
  version: 1,
  scope: "builder-execution",
  platform: "linux/x86_64",
  target: {
    sha: ARRUSTED_TARGET_SHA,
    tree: ARRUSTED_TARGET_TREE,
    miseConfigSha256:
      "da8fe48559f8250494bdbea0f1a6caa644b59d5be14658a7aaf26ccd6fab0199",
    miseLockSha256:
      "415008336ed45882fce91f681fdce7648583ce6744372beb4d5212ab644e3462",
    bunLockSha256:
      "e313e11efc00e7439a6e91f832c80508a6b15cacda267b86a152f76aa5ad4dd0",
    appIdentitySha256:
      "10d474a28cb941686e768cf642f0e0466a6ac1c359ef5d3c2737c5548606ff6c",
    appContractSha256:
      "03889bce16d5368da287ae4215056ed786ba8c161b3bb4a0e10c9e17cb70994e",
    repositoryPreflightSha256:
      "c30fb6d26d49a229d8e4283c1350d86fa61a6f1708ada614f55f8f40358cbbba",
    repositoryExecSha256:
      "7816d61ce34ccf3b7680d6e03ddd8655650312901f23a03fae2b1aab50a051dc",
  },
  runtime: { bun: "1.3.14" },
  closure: {
    package: "@vercel/microfrontends",
    version: "2.4.0",
    archivePath: DEPENDENCY_CACHE_ARCHIVE_PATH,
    archiveSha256: hostedArchiveDigest,
    archiveBytes: 1_356_765,
  },
} as const;
const manifest = {
  version: 1,
  scope: "builder-execution",
  platform: "linux/arm64",
  target: {
    sha: ARRUSTED_TARGET_SHA,
    tree: ARRUSTED_TARGET_TREE,
    miseConfigSha256:
      "da8fe48559f8250494bdbea0f1a6caa644b59d5be14658a7aaf26ccd6fab0199",
    miseLockSha256:
      "415008336ed45882fce91f681fdce7648583ce6744372beb4d5212ab644e3462",
    bunLockSha256:
      "e313e11efc00e7439a6e91f832c80508a6b15cacda267b86a152f76aa5ad4dd0",
    cargoLockSha256:
      "8ba85741c6021d44cb8f211939f3b0488db22a7b0e11a1d703eccb2d31e259cb",
    appIdentitySha256:
      "10d474a28cb941686e768cf642f0e0466a6ac1c359ef5d3c2737c5548606ff6c",
    appContractSha256:
      "03889bce16d5368da287ae4215056ed786ba8c161b3bb4a0e10c9e17cb70994e",
    appValidationSha256: ARRUSTED_APP_VALIDATION_SHA256,
    createAppSha256: ARRUSTED_CREATE_APP_SHA256,
    appTemplatePackageSha256: ARRUSTED_APP_TEMPLATE_PACKAGE_SHA256,
    repositoryPreflightSha256:
      "c30fb6d26d49a229d8e4283c1350d86fa61a6f1708ada614f55f8f40358cbbba",
    repositoryExecSha256:
      "7816d61ce34ccf3b7680d6e03ddd8655650312901f23a03fae2b1aab50a051dc",
  },
  runtime: { bun: "1.3.14", rust: ARRUSTED_RUST_VERSION },
  closure: {
    package: "@vercel/microfrontends",
    version: "2.4.0",
    archivePath: DEPENDENCY_CACHE_ARCHIVE_PATH,
    archiveSha256: archiveDigest,
    archiveBytes: 123,
    cargoArchivePath: DEPENDENCY_CACHE_CARGO_ARCHIVE_PATH,
    cargoArchiveSha256: "c".repeat(64),
    cargoArchiveBytes: 456,
  },
} as const;

function sandboxFixture(inputManifest: unknown = manifest) {
  const run = vi
    .fn()
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: `${JSON.stringify(inputManifest)}\n`,
      stderr: "",
    })
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: `${archiveDigest}  ${DEPENDENCY_CACHE_ARCHIVE_PATH}\n123\n${"c".repeat(64)}  ${DEPENDENCY_CACHE_CARGO_ARCHIVE_PATH}\n456\n`,
      stderr: "",
    })
    .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
  run.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
  run.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
  run.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
  const sandbox = {
    run,
    readTextFile: vi.fn(async () => JSON.stringify({ version: "2.4.0" })),
  } as unknown as SandboxSession;
  return { run, sandbox };
}

function hostedExecutionSandbox(
  inputManifest: unknown = hostedExecutionManifest,
) {
  const run = vi
    .fn()
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: `${JSON.stringify(inputManifest)}\n`,
      stderr: "",
    })
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: `${hostedArchiveDigest}  ${DEPENDENCY_CACHE_ARCHIVE_PATH}\n1356765\n`,
      stderr: "",
    });
  return { run, sandbox: { run } as unknown as SandboxSession };
}

describe("offline dependency cache", () => {
  it("builds the hosted seed as an execution-complete Linux closure", () => {
    const producer = readFileSync(
      ".config/mise/scripts/repository/build-hosted-arrusted-artifact.mts",
      "utf8",
    );
    for (const packageName of [
      "@testing-library/react",
      "@tailwindcss/vite",
      "@vitejs/plugin-react",
      "next",
      "react",
      "react-dom",
      "typescript",
      "turbo",
      "vite-plus",
      "vitest",
    ])
      expect(producer).toContain(`"${packageName}"`);
    expect(producer).toContain(
      'process.platform !== "linux" || process.arch !== "x64"',
    );
    expect(producer).toContain('["vp", "../vite-plus/bin/vp"]');
    expect(producer).toContain('["turbo", "../turbo/bin/turbo"]');
    expect(producer).toContain('"@autograph",\n    "vite-config"');
    expect(producer).toContain('scope: "builder-execution"');
    expect(producer).toContain('platform: "linux/x86_64"');
    expect(producer).toContain(
      "rootVersions.set(dependency, dependencyVersion)",
    );
  });

  it("resolves the materialized closure root for local and Vercel sandboxes", () => {
    expect(materializedDependencyNodeModulesRoot(archiveDigest, {})).toBe(
      `/opt/app-builder/dependencies/${archiveDigest}/node_modules`,
    );
    expect(
      materializedDependencyNodeModulesRoot(archiveDigest, { VERCEL: "1" }),
    ).toBe(
      `/workspace/.app-builder/hosted-dependencies/${archiveDigest}/node_modules`,
    );
    expect(() =>
      materializedDependencyNodeModulesRoot("invalid", { VERCEL: "1" }),
    ).toThrow(/content digest is invalid/u);
  });

  it("accepts the exact hosted execution closure", async () => {
    const { run, sandbox } = hostedExecutionSandbox();
    const observed = await inspectDependencyCache(sandbox, {
      ...process.env,
      APP_BUILDER_HOSTED_ARTIFACT_PROOF: "1",
      APP_BUILDER_REAL_SANDBOX: "1",
    });

    expect(observed.manifest.scope).toBe("builder-execution");
    expect(observed.contentDigest).toBe(hostedArchiveDigest);
    expect(run).toHaveBeenNthCalledWith(2, {
      command: `sha256sum -- /workspace/.app-builder/hosted-dependency-cache/node-modules.tar.gz && stat --format='%s' -- /workspace/.app-builder/hosted-dependency-cache/node-modules.tar.gz`,
      workingDirectory: "/workspace",
      abortSignal: expect.any(AbortSignal),
    });
  });

  it("rejects hosted execution receipt drift before reading archives", async () => {
    const { run, sandbox } = hostedExecutionSandbox({
      ...hostedExecutionManifest,
      target: { ...hostedExecutionManifest.target, sha: "0".repeat(40) },
    });

    await expect(
      inspectDependencyCache(sandbox, {
        ...process.env,
        APP_BUILDER_HOSTED_ARTIFACT_PROOF: "1",
        APP_BUILDER_REAL_SANDBOX: "1",
      }),
    ).rejects.toThrow("manifest drifted");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("accepts the embedded execution-complete cache on Vercel", async () => {
    const { run, sandbox } = hostedExecutionSandbox();

    await expect(
      inspectDependencyCache(sandbox, { VERCEL: "1" }),
    ).resolves.toEqual(
      expect.objectContaining({ contentDigest: hostedArchiveDigest }),
    );
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("rejects the former planning-only cache on Vercel", async () => {
    const { run, sandbox } = hostedExecutionSandbox({
      ...hostedExecutionManifest,
      scope: "identity-planning",
      platform: "linux/portable",
    });

    await expect(
      inspectDependencyCache(sandbox, { VERCEL: "1" }),
    ).rejects.toThrow("manifest drifted");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("binds fixture cache observations to the exact prepared source", async () => {
    const target = {
      sourceSha: "3".repeat(40),
      sourceTree: "4".repeat(40),
      digest: "5".repeat(64),
    };
    const cache = await inspectDependencyCache(
      {} as SandboxSession,
      process.env,
      target,
    );

    expect(dependencyTargetForWorkspace(cache, target)).toEqual(
      expect.objectContaining({
        sha: target.sourceSha,
        tree: target.sourceTree,
      }),
    );
    expect(() =>
      assertExactDependencyTargetBinding({
        workspace: target,
        sourceReceipt: target,
        cache,
      }),
    ).not.toThrow();
  });

  it("rejects source-tree and durable dependency-receipt drift", async () => {
    const target = {
      sourceSha: "3".repeat(40),
      sourceTree: "4".repeat(40),
      digest: "6".repeat(64),
    };
    const cache = await inspectDependencyCache(
      {} as SandboxSession,
      process.env,
      target,
    );

    expect(() =>
      assertExactDependencyTargetBinding({
        workspace: target,
        sourceReceipt: { ...target, sourceTree: "5".repeat(40) },
        cache,
      }),
    ).toThrow("prepared source does not match");
    expect(() =>
      assertExactDependencyTargetBinding({
        workspace: target,
        sourceReceipt: target,
        cache,
        dependencyReceipt: {
          ...target,
          targetSha: target.sourceSha,
          targetTree: "5".repeat(40),
          sourceReceiptDigest: target.digest,
        },
      }),
    ).toThrow("prepared source does not match");
    expect(() =>
      assertExactDependencyTargetBinding({
        workspace: target,
        sourceReceipt: target,
        cache,
        dependencyReceipt: {
          ...target,
          targetSha: target.sourceSha,
          targetTree: target.sourceTree,
          sourceReceiptDigest: "7".repeat(64),
        },
      }),
    ).toThrow("prepared source does not match");
  });

  it("binds reusable development dependencies to the per-run source without making source bytes part of the cache key", () => {
    const workspace = {
      sourceSha: "7".repeat(40),
      sourceTree: "8".repeat(40),
      digest: "6".repeat(64),
    };
    const cache = {
      manifest: {
        version: 2,
        scope: "development-execution",
        platform: "linux/arm64",
        dependencyKey: "9".repeat(64),
        lockfiles: {
          ".config/mise/config.toml": "1".repeat(64),
          ".config/mise/mise.lock": "2".repeat(64),
          "bun.lock": "3".repeat(64),
          "Cargo.lock": "4".repeat(64),
        },
        runtime: {
          node: "24.18.0",
          bun: "1.3.14",
          mise: "2026.8.12",
          rust: "1.97.1",
        },
        closure: manifest.closure,
      },
      manifestDigest: "a".repeat(64),
      contentDigest: archiveDigest,
    } as const;
    expect(dependencyTargetForWorkspace(cache, workspace)).toEqual({
      sha: workspace.sourceSha,
      tree: workspace.sourceTree,
    });
    expect(() =>
      assertExactDependencyTargetBinding({
        workspace,
        sourceReceipt: workspace,
        cache,
      }),
    ).not.toThrow();
  });

  it("bootstraps a SHA-scoped locked template closure, then restores deny-all networking", async () => {
    const target = { sourceSha: "7".repeat(40), sourceTree: "8".repeat(40) };
    const setNetworkPolicy = vi.fn(async () => undefined);
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "linux/x86_64\n",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          platform: "linux/x86_64",
          locks: {
            miseConfigSha256: "1".repeat(64),
            miseLockSha256: "2".repeat(64),
            bunLockSha256: "3".repeat(64),
            cargoLockSha256: "4".repeat(64),
          },
          microfrontendsVersion: "2.4.0",
        }),
        stderr: "",
      })
      .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const writeTextFile = vi.fn(async () => undefined);
    const sandbox = {
      readTextFile: vi.fn(async () => null),
      setNetworkPolicy,
      run,
      writeTextFile,
    } as unknown as SandboxSession;

    const cache = await bootstrapLiveTemplateDependencies({ sandbox, target });

    expect(cache.manifest).toMatchObject({
      scope: "live-template-execution",
      target: { sha: target.sourceSha, tree: target.sourceTree },
      closure: { nodeModulesPath: "/workspace/repository/node_modules" },
    });
    expect(run.mock.calls[1]?.[0].command).toContain(
      "bun install --frozen-lockfile --ignore-scripts --linker=hoisted",
    );
    expect(run.mock.calls[1]?.[0].command).toContain("cargo fetch --locked");
    expect(setNetworkPolicy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        allow: expect.arrayContaining(["registry.npmjs.org"]),
      }),
    );
    expect(setNetworkPolicy).toHaveBeenLastCalledWith("deny-all");
    expect(writeTextFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: `.app-builder/template-dependency-cache/${target.sourceSha}/linux/x86_64/manifest.json`,
      }),
    );
  });

  it("verifies target-bound manifest and archive bytes before extraction", async () => {
    const { run, sandbox } = sandboxFixture();
    const result = await materializeOfflineDependencies({
      sandbox,
      artifactRevision: "b".repeat(64),
      target: {
        sourceSha: ARRUSTED_TARGET_SHA,
        sourceTree: ARRUSTED_TARGET_TREE,
      },
      environment: {},
    });
    expect(result.contentDigest).toBe(archiveDigest);
    expect(run).toHaveBeenNthCalledWith(1, {
      command: "cat -- /opt/app-builder/dependency-cache/manifest.json",
      workingDirectory: "/workspace",
      abortSignal: expect.any(AbortSignal),
    });
    expect(run).toHaveBeenNthCalledWith(2, {
      command: `sha256sum -- ${DEPENDENCY_CACHE_ARCHIVE_PATH} && stat --format='%s' -- ${DEPENDENCY_CACHE_ARCHIVE_PATH} && sha256sum -- ${DEPENDENCY_CACHE_CARGO_ARCHIVE_PATH} && stat --format='%s' -- ${DEPENDENCY_CACHE_CARGO_ARCHIVE_PATH}`,
      workingDirectory: "/workspace",
      abortSignal: expect.any(AbortSignal),
    });
    expect(run).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        command: expect.stringContaining(
          `.app-builder/target-inputs/${"b".repeat(64)}/repository/node_modules`,
        ),
        workingDirectory: "/workspace",
      }),
    );
    expect(run.mock.calls[3]?.[0]).not.toHaveProperty("env");
    const linkCommand = run.mock.calls[3]?.[0].command as string;
    expect(linkCommand).toContain(
      `/opt/app-builder/dependencies/${archiveDigest}/node_modules`,
    );
    expect(linkCommand).toContain("test -d");
    expect(linkCommand).toContain("test ! -L");
    for (const required of [
      ".bin/next",
      ".bin/turbo",
      ".bin/vp",
      "@autograph/vite-config/package.json",
      "@tailwindcss/vite/package.json",
      "@testing-library/react/package.json",
      "@vitejs/plugin-react/package.json",
      "next/package.json",
      "react/package.json",
      "react-dom/package.json",
      "typescript/package.json",
      "turbo/package.json",
      "vite-plus/package.json",
      "vitest/package.json",
    ])
      expect(linkCommand).toContain(
        `/opt/app-builder/dependencies/${archiveDigest}/node_modules/${required}`,
      );
    expect(linkCommand).toContain(
      `test -x /opt/app-builder/dependencies/${archiveDigest}/node_modules/.bin/vp`,
    );
    expect(linkCommand).toContain(
      `test -x /opt/app-builder/dependencies/${archiveDigest}/node_modules/.bin/turbo`,
    );
    expect(linkCommand).toContain('await import("@autograph/vite-config")');
    expect(linkCommand).toContain("\\( -type f -o -type d \\) -perm /222");
    expect(linkCommand).toContain("ln -s");
    expect(linkCommand).toContain(
      `test -L /workspace/.app-builder/target-inputs/${"b".repeat(64)}/repository/node_modules`,
    );
    expect(linkCommand).toContain("readlink --");
    expect(run).toHaveBeenNthCalledWith(5, {
      command: expect.stringContaining(
        'const {match}=require("path-to-regexp")',
      ),
      workingDirectory: `/workspace/.app-builder/target-inputs/${"b".repeat(64)}/repository/packages/platform-microfrontends`,
      abortSignal: expect.any(AbortSignal),
    });
    const resolutionCommand = run.mock.calls[4]?.[0].command as string;
    expect(resolutionCommand).toContain(ARRUSTED_PATH_TO_REGEXP_VERSION);
    expect(resolutionCommand).toContain(ARRUSTED_MICROFRONTENDS_VERSION);
    expect(resolutionCommand).toContain(
      ARRUSTED_MICROFRONTENDS_PATH_TO_REGEXP_VERSION,
    );
    expect(resolutionCommand).toContain('result?.path!=="/vendor"');
    expect(run).toHaveBeenNthCalledWith(6, {
      command: expect.stringContaining(
        `cargo --version | cut -d" " -f2)" = "${ARRUSTED_RUST_VERSION}"`,
      ),
      workingDirectory: `/workspace/.app-builder/target-inputs/${"b".repeat(64)}/repository`,
      abortSignal: expect.any(AbortSignal),
    });
    const rustCommand = run.mock.calls[5]?.[0].command as string;
    expect(rustCommand).toContain("MISE_AUTO_INSTALL=false");
    expect(rustCommand).toContain("MISE_EXEC_AUTO_INSTALL=false");
    expect(rustCommand).toContain("MISE_TASK_RUN_AUTO_INSTALL=false");
    expect(rustCommand).toContain("mise --env app-builder exec --no-deps");
    expect(rustCommand).toContain("CARGO_NET_OFFLINE=true");
    expect(rustCommand).toContain(
      "cargo metadata --format-version 1 --locked --all-features",
    );
  });

  it("rejects target drift and does not extract", async () => {
    const { run, sandbox } = sandboxFixture({
      ...manifest,
      target: { ...manifest.target, sha: "0".repeat(40) },
    });
    await expect(inspectDependencyCache(sandbox, {})).rejects.toThrow(
      "manifest drifted",
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps the image recipe bound to the exact target and closure", () => {
    const dockerfile = readFileSync(
      new URL("../../containers/eve-sandbox/Dockerfile", import.meta.url),
      "utf8",
    );
    expect(dockerfile).toContain(`ARG TARGET_SHA=${ARRUSTED_TARGET_SHA}`);
    expect(dockerfile).toContain(`ARG TARGET_TREE=${ARRUSTED_TARGET_TREE}`);
    expect(dockerfile).toContain("COPY --from=arrusted-target");
    expect(dockerfile).toContain(
      "bun install --frozen-lockfile --ignore-scripts --linker=hoisted",
    );
    expect(dockerfile).toContain("record_workspace_targets() {");
    expect(dockerfile).toContain(
      'find "${node_root}" -type l -print0 > "${link_list}" || return 1',
    );
    expect(dockerfile).toContain('done < "${link_list}"');
    expect(dockerfile).toContain(
      "LC_ALL=C sort -u /tmp/workspace-closure.unsorted",
    );
    expect(dockerfile).toContain(
      "cmp -s /tmp/workspace-closure.expected /tmp/workspace-closure.list",
    );
    expect(dockerfile).toContain(
      "packages/microfrontends-shell|packages/microfrontends-shell/*) dependency_owner=packages/microfrontends-shell",
    );
    expect(dockerfile).toContain(
      "domain-libs/vendor|domain-libs/vendor/*) dependency_owner=domain-libs/vendor",
    );
    expect(dockerfile).toContain('"${node_root}"/*) continue');
    expect(dockerfile).toContain(
      '"${source_root}"/*) dependency_relative="${dependency_target#"${source_root}"/}"',
    );
    expect(dockerfile).toContain("*) exit 1");
    expect(dockerfile).toContain('test -e "${dependency_target}"');
    expect(dockerfile).toContain("workspace-closure-fixtures");
    expect(dockerfile).toContain("@autograph/missing");
    expect(dockerfile).toContain("@autograph/outside");
    expect(dockerfile).toContain("@autograph/unallowlisted");
    expect(dockerfile).toContain("grep -Fx 'packages/vite-config'");
    expect(dockerfile).toContain("--files-from /tmp/workspace-closure.list");
    expect(dockerfile).toContain("--exclude='packages/*/node_modules'");
    expect(dockerfile).toContain(
      'case "${workspace_target}" in "${dependency_root}"/*)',
    );
    expect(dockerfile).toContain(
      'require("\'"${dependency_root}"\'/node_modules/@autograph/vite-config/package.json").name',
    );
    expect(dockerfile).toContain(
      `ARG CARGO_LOCK_SHA256=${manifest.target.cargoLockSha256}`,
    );
    expect(dockerfile).toContain(
      "cargo vendor --locked --versioned-dirs /opt/app-builder/cargo-closure/vendor",
    );
    expect(dockerfile).toContain("[net]\\noffline = true");
    expect(dockerfile).toContain("cargo-closure.tar.gz");
    expect(dockerfile).toContain(
      "! grep -Ev '^(config[.]toml|vendor(/.*)?)$' /tmp/cargo-closure.list",
    );
    expect(dockerfile).toContain("cd packages/platform-microfrontends;");
    expect(dockerfile).toContain(
      `test "$(bun -e 'console.log(require("path-to-regexp/package.json").version)')" = "${ARRUSTED_PATH_TO_REGEXP_VERSION}"`,
    );
    expect(dockerfile).toContain(
      `test "$(bun -e 'console.log(require("../../node_modules/@vercel/microfrontends/node_modules/path-to-regexp/package.json").version)')" = "${ARRUSTED_MICROFRONTENDS_PATH_TO_REGEXP_VERSION}"`,
    );
    expect(dockerfile).toContain("gzip --no-name --best");
    expect(dockerfile).toContain("@vercel/microfrontends");
    expect(dockerfile).toContain(
      "/opt/app-builder/dependencies/${archive_sha}",
    );
    expect(dockerfile).toContain(
      "tar --extract --gzip --file /opt/app-builder/dependency-cache/node-modules.tar.gz",
    );
    expect(dockerfile).toContain(
      "chmod -R a-w,a+rX /opt/app-builder/dependencies",
    );
    expect(dockerfile).toContain(
      "find /opt/app-builder/dependencies \\( -type f -o -type d \\) -perm /222 -print -quit",
    );
    expect(dockerfile).toContain(`ARG RUST_VERSION=${ARRUSTED_RUST_VERSION}`);
    expect(dockerfile).toContain("CARGO_HOME=/opt/app-builder/cargo");
    expect(dockerfile).toContain("RUSTUP_HOME=/opt/app-builder/rustup");
    expect(dockerfile).toContain("RUSTUP_TOOLCHAIN=1.97.1");
    expect(dockerfile).toContain('mise install "rust@${RUST_VERSION}"');
    expect(dockerfile).toContain("chmod -R a-w,a+rX /opt/app-builder/rustup");
    expect(dockerfile).toContain("chmod -R a-w,a+rX /opt/app-builder/cargo");
    expect(dockerfile).toContain(
      `mise exec rust@${ARRUSTED_RUST_VERSION} -- cargo --version`,
    );
    expect(dockerfile.indexOf("USER vercel-sandbox")).toBeLessThan(
      dockerfile.lastIndexOf("RUN --network=none"),
    );
    expect(dockerfile).toContain(
      "MISE_AUTO_INSTALL=false MISE_EXEC_AUTO_INSTALL=false MISE_TASK_RUN_AUTO_INSTALL=false",
    );
    expect(dockerfile).toContain("RUN --network=none");
  });
});
