import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import type { SandboxSession } from "eve/sandbox";

import { DEVELOPMENT_DEPENDENCY_CACHE_ROOT } from "../sandbox/development-toolchain";

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
  DEPENDENCY_PREPARATION_TIMEOUT_MS,
  DependencyCacheMissingError,
  assertExactDependencyTargetBinding,
  bootstrapLiveTemplateDependencies,
  dependencyTargetForWorkspace,
  executionDependencyViewScript,
  inspectDependencyCache,
  materializedDependencyNodeModulesRoot,
  materializeOfflineDependencies,
  liveTemplateClosureInspectionScript,
  liveTemplateDependencyKey,
  shouldPreferLiveTemplateDependencies,
} from "./dependency-cache";

const executeFile = promisify(execFile);

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
const developmentManifest = {
  version: 3,
  scope: "development-execution",
  platform: "linux/amd64",
  dependencyKey: "d".repeat(64),
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
  closure: {
    package: "@vercel/microfrontends",
    version: "2.4.0",
    contentDigest: "d".repeat(64),
    nodeModulesPath: `${DEVELOPMENT_DEPENDENCY_CACHE_ROOT}/dependencies/${"d".repeat(64)}/node_modules`,
    cargoConfigPath: `${DEVELOPMENT_DEPENDENCY_CACHE_ROOT}/cargo/config.toml`,
  },
} as const;

function liveDependencySourceFixture(input?: {
  packageJson?: string;
  ordinarySource?: string;
}) {
  const contents = new Map([
    [".config/mise/config.toml", "[tools]\nnode = '24.18.0'\n"],
    [".config/mise/mise.lock", "mise-lock\n"],
    ["package.json", input?.packageJson ?? '{"workspaces":["apps/*"]}\n'],
    ["bun.lock", "bun-lock\n"],
    ["Cargo.toml", '[workspace]\nmembers = ["crates/*"]\n'],
    ["Cargo.lock", "cargo-lock\n"],
    ["apps/vendor/package.json", '{"name":"@autograph/vendor"}\n'],
    ["crates/vendor/Cargo.toml", '[package]\nname = "vendor"\n'],
    [
      "apps/vendor/app/page.tsx",
      input?.ordinarySource ?? "export default function Page() {}\n",
    ],
  ]);
  const sourceFiles = [...contents].map(([path, content]) => ({
    mode: "100644" as const,
    objectId: createHash("sha1").update(content).digest("hex"),
    path,
    sha256: createHash("sha256").update(content).digest("hex"),
  }));
  const dependencyInputs = Object.fromEntries(
    sourceFiles
      .filter(
        ({ path }) =>
          path === ".config/mise/config.toml" ||
          path === ".config/mise/mise.lock" ||
          path === "package.json" ||
          path === "bun.lock" ||
          path === "Cargo.toml" ||
          path === "Cargo.lock" ||
          path.endsWith("/package.json") ||
          path.endsWith("/Cargo.toml"),
      )
      .map(({ path, sha256 }) => [path, sha256]),
  );
  return { contents, dependencyInputs, sourceFiles };
}

const liveNodeModulesDigest = "a".repeat(64);
const liveCargoHomeDigest = "b".repeat(64);

function liveTemplateCacheFixture() {
  let source = liveDependencySourceFixture();
  let closureState: "cargo-tampered" | "clean" | "missing" | "node-tampered" =
    "clean";
  const stored = new Map<string, string>();
  const setNetworkPolicy = vi.fn(async () => undefined);
  const observation = (tampered: "cargo" | "node" | undefined = undefined) =>
    JSON.stringify({
      platform: "linux/x86_64",
      nodeModulesDigest:
        tampered === "node" ? "c".repeat(64) : liveNodeModulesDigest,
      workspaceNodeModules: [],
      workspaceLinks: [],
      cargoHomeDigest:
        tampered === "cargo" ? "d".repeat(64) : liveCargoHomeDigest,
      microfrontendsVersion: "2.4.0",
    });
  const run = vi.fn(async ({ command }: { command: string }) => {
    if (command.includes("uname -s"))
      return { exitCode: 0, stdout: "linux/x86_64\n", stderr: "" };
    if (command.includes("bun install"))
      return { exitCode: 0, stdout: observation(), stderr: "" };
    if (
      command.includes("function digestTree(root, allowTrackedWorkspaceLinks)")
    ) {
      if (closureState === "missing")
        return { exitCode: 1, stdout: "", stderr: "missing closure" };
      return {
        exitCode: 0,
        stdout: observation(
          closureState === "node-tampered"
            ? "node"
            : closureState === "cargo-tampered"
              ? "cargo"
              : undefined,
        ),
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  const writeTextFile = vi.fn(
    async ({ path, content }: { path: string; content: string }) => {
      stored.set(path, content);
    },
  );
  const sandbox = {
    readTextFile: vi.fn(async ({ path }: { path: string }) =>
      path === ".app-builder/source-files.json"
        ? JSON.stringify(source.sourceFiles)
        : (stored.get(path) ?? null),
    ),
    readBinaryFile: vi.fn(async ({ path }: { path: string }) => {
      const content = source.contents.get(path.replace(/^repository\//u, ""));
      return content === undefined ? null : Buffer.from(content);
    }),
    setNetworkPolicy,
    run,
    writeTextFile,
  } as unknown as SandboxSession;
  return {
    sandbox,
    run,
    setNetworkPolicy,
    stored,
    writeTextFile,
    source: () => source,
    setSource: (next: ReturnType<typeof liveDependencySourceFixture>) => {
      source = next;
    },
    setClosureState: (next: typeof closureState) => {
      closureState = next;
    },
  };
}

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
  run.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  const writeTextFile = vi.fn(async () => undefined);
  const sandbox = {
    run,
    writeTextFile,
    readTextFile: vi.fn(async () => JSON.stringify({ version: "2.4.0" })),
  } as unknown as SandboxSession;
  return { run, sandbox, writeTextFile };
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

async function writeDependencyTopologyFixture(root: string) {
  const source = join(root, "cache", "source");
  const cargo = join(root, "cache", "cargo-home");
  const rootModules = join(source, "node_modules");
  const appModules = join(source, "apps", "vendor", "node_modules");
  await Promise.all([
    mkdir(join(rootModules, "@autograph"), { recursive: true }),
    mkdir(join(rootModules, "@vercel", "microfrontends"), {
      recursive: true,
    }),
    mkdir(join(rootModules, "react"), { recursive: true }),
    mkdir(join(appModules, "@autograph"), { recursive: true }),
    mkdir(join(appModules, "zod"), { recursive: true }),
    mkdir(join(source, "packages", "ui"), { recursive: true }),
    mkdir(cargo, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(source, "package.json"),
      '{"workspaces":["apps/*","packages/*"]}\n',
    ),
    writeFile(
      join(source, "apps", "vendor", "package.json"),
      '{"name":"vendor"}\n',
    ),
    writeFile(
      join(source, "packages", "ui", "index.js"),
      'export const source = "cache";\n',
    ),
    writeFile(
      join(rootModules, "@vercel", "microfrontends", "package.json"),
      '{"version":"2.4.0"}\n',
    ),
    writeFile(
      join(rootModules, "react", "package.json"),
      '{"version":"19.2.4"}\n',
    ),
    writeFile(join(appModules, "zod", "package.json"), '{"version":"4.4.3"}\n'),
    symlink("../../packages/ui", join(rootModules, "@autograph", "ui")),
    symlink("../../../../packages/ui", join(appModules, "@autograph", "ui")),
  ]);
  const trackedPaths = [
    "package.json",
    "apps/vendor/package.json",
    "packages/ui/index.js",
  ];
  const sourceManifest = trackedPaths.map((path) => ({
    mode: "100644",
    objectId: "1".repeat(40),
    path,
    sha256: "2".repeat(64),
  }));
  const manifestPath = join(root, "source-files.json");
  await writeFile(manifestPath, JSON.stringify(sourceManifest));
  await executeFile("/bin/chmod", ["-R", "a-w,a+rX", source, cargo]);
  return {
    source: await realpath(source),
    cargo: await realpath(cargo),
    rootModules: await realpath(rootModules),
    appModules: await realpath(appModules),
    manifestPath: await realpath(manifestPath),
  };
}

describe("offline dependency cache", () => {
  it("invalidates the live cache key only for declared dependency and runtime inputs", () => {
    const source = liveDependencySourceFixture();
    const basis = {
      platform: "linux/x86_64",
      dependencyInputs: source.dependencyInputs,
      runtime: {
        node: "24.18.0",
        mise: "2026.8.12",
        bun: "1.3.14",
        rust: "1.97.1",
      },
      bootstrapVersion: 3,
    } as const;
    const original = liveTemplateDependencyKey(basis);
    for (const path of [
      "Cargo.toml",
      "Cargo.lock",
      ".config/mise/config.toml",
      ".config/mise/mise.lock",
      "apps/vendor/package.json",
      "crates/vendor/Cargo.toml",
    ]) {
      expect(
        liveTemplateDependencyKey({
          ...basis,
          dependencyInputs: {
            ...basis.dependencyInputs,
            [path]: "f".repeat(64),
          },
        }),
        path,
      ).not.toBe(original);
    }
    expect(
      liveTemplateDependencyKey({ ...basis, platform: "linux/arm64" }),
    ).not.toBe(original);
    for (const runtime of ["node", "mise", "bun", "rust"] as const) {
      expect(
        liveTemplateDependencyKey({
          ...basis,
          runtime: { ...basis.runtime, [runtime]: "changed" },
        }),
        runtime,
      ).not.toBe(original);
    }
    expect(
      liveTemplateDependencyKey({ ...basis, bootstrapVersion: 4 }),
    ).not.toBe(original);
  });

  it("executes the live closure inspector and rebinds complete workspace topology", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-builder-topology-"));
    try {
      const fixture = await writeDependencyTopologyFixture(root);
      const inspectionPath = join(root, "inspect.cjs");
      await writeFile(inspectionPath, liveTemplateClosureInspectionScript);
      const inspected = await executeFile(process.execPath, [
        inspectionPath,
        fixture.source,
        fixture.cargo,
        "linux/x86_64",
        fixture.manifestPath,
      ]);
      const observation = JSON.parse(inspected.stdout) as {
        nodeModulesDigest: string;
        workspaceNodeModules: Array<{
          path: string;
          nodeModulesPath: string;
          digest: string;
        }>;
        workspaceLinks: Array<{
          path: string;
          target: string;
          sourcePath: string;
        }>;
      };
      expect(observation.workspaceNodeModules).toEqual([
        expect.objectContaining({
          path: "apps/vendor/node_modules",
          nodeModulesPath: fixture.appModules,
        }),
      ]);
      expect(observation.workspaceLinks).toEqual([
        {
          path: "apps/vendor/node_modules/@autograph/ui",
          target: "../../../../packages/ui",
          sourcePath: "packages/ui",
        },
        {
          path: "node_modules/@autograph/ui",
          target: "../../packages/ui",
          sourcePath: "packages/ui",
        },
      ]);

      const workspace = join(root, "workspace");
      const overlay = join(workspace, "overlay");
      const view = join(workspace, ".app-builder", "dependency-views", "view");
      await Promise.all([
        mkdir(join(overlay, "packages", "ui"), { recursive: true }),
        mkdir(join(overlay, "apps", "vendor"), { recursive: true }),
        mkdir(join(workspace, ".app-builder", "dependency-views"), {
          recursive: true,
        }),
      ]);
      await Promise.all([
        writeFile(
          join(overlay, "packages", "ui", "index.js"),
          'export const source = "overlay";\n',
        ),
        writeFile(
          join(overlay, "apps", "vendor", "package.json"),
          '{"name":"vendor"}\n',
        ),
      ]);
      const layout = {
        version: 1,
        kind: "cache",
        roots: [
          {
            path: "node_modules",
            cachePath: fixture.rootModules,
            digest: observation.nodeModulesDigest,
          },
          ...observation.workspaceNodeModules.map((entry) => ({
            path: entry.path,
            cachePath: entry.nodeModulesPath,
            digest: entry.digest,
          })),
        ],
        workspaceLinks: observation.workspaceLinks,
      };
      const layoutPath = join(root, "layout.json");
      const viewScriptPath = join(root, "view.cjs");
      await Promise.all([
        writeFile(layoutPath, JSON.stringify(layout)),
        writeFile(viewScriptPath, executionDependencyViewScript),
      ]);
      await executeFile(process.execPath, [
        viewScriptPath,
        layoutPath,
        overlay,
        view,
        workspace,
      ]);

      expect(await realpath(join(overlay, "node_modules", "react"))).toBe(
        await realpath(join(fixture.rootModules, "react")),
      );
      expect(
        await realpath(join(overlay, "node_modules", "@autograph", "ui")),
      ).toBe(await realpath(join(overlay, "packages", "ui")));
      expect(
        await realpath(
          join(overlay, "apps", "vendor", "node_modules", "@autograph", "ui"),
        ),
      ).toBe(await realpath(join(overlay, "packages", "ui")));
      expect(
        await realpath(join(overlay, "apps", "vendor", "node_modules", "zod")),
      ).toBe(await realpath(join(fixture.appModules, "zod")));

      const cachedPackage = join(fixture.rootModules, "react", "package.json");
      const cachedBefore = {
        content: await readFile(cachedPackage, "utf8"),
        mode: (await lstat(cachedPackage)).mode,
      };
      const overlayModules = await realpath(join(overlay, "node_modules"));
      await writeFile(join(overlayModules, "overlay-owned.txt"), "owned\n");
      await chmod(overlayModules, 0o700);
      expect(await readFile(cachedPackage, "utf8")).toBe(cachedBefore.content);
      expect((await lstat(cachedPackage)).mode).toBe(cachedBefore.mode);

      await chmod(fixture.rootModules, 0o755);
      await symlink(join(root, "outside"), join(fixture.rootModules, "escape"));
      await mkdir(join(root, "outside"));
      await chmod(fixture.rootModules, 0o555);
      await expect(
        executeFile(process.execPath, [
          inspectionPath,
          fixture.source,
          fixture.cargo,
          "linux/x86_64",
          fixture.manifestPath,
        ]),
      ).rejects.toThrow();
    } finally {
      await executeFile("/bin/chmod", ["-R", "u+w", root]).catch(
        () => undefined,
      );
      await rm(root, { recursive: true, force: true });
    }
  });
  it("keeps cache selection independent of source-receipt transport versions", () => {
    expect(shouldPreferLiveTemplateDependencies(3, {})).toBe(true);
    expect(shouldPreferLiveTemplateDependencies(4, {})).toBe(true);
    expect(
      shouldPreferLiveTemplateDependencies(3, {
        APP_BUILDER_EXECUTION_MODE: "development",
      }),
    ).toBe(false);
    expect(shouldPreferLiveTemplateDependencies(2, {})).toBe(true);
  });

  it("keeps cold dependency preparation bounded below the sandbox session ceiling", () => {
    expect(DEPENDENCY_PREPARATION_TIMEOUT_MS).toBe(600_000);
    expect(DEPENDENCY_PREPARATION_TIMEOUT_MS).toBeLessThan(900_000);
  });

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

  it("reports a typed live-template miss without falling through to another cache", async () => {
    const target = { sourceSha: "7".repeat(40), sourceTree: "8".repeat(40) };
    const source = liveDependencySourceFixture();
    const run = vi.fn(async () => ({
      exitCode: 0,
      stdout: "linux/x86_64\n",
      stderr: "",
    }));
    const sandbox = {
      run,
      readTextFile: vi.fn(async ({ path }: { path: string }) =>
        path === ".app-builder/source-files.json"
          ? JSON.stringify(source.sourceFiles)
          : null,
      ),
      readBinaryFile: vi.fn(async ({ path }: { path: string }) => {
        const content = source.contents.get(path.replace(/^repository\//u, ""));
        return content === undefined ? null : Buffer.from(content);
      }),
    } as unknown as SandboxSession;

    await expect(
      inspectDependencyCache(sandbox, {}, target, true),
    ).rejects.toBeInstanceOf(DependencyCacheMissingError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("bootstraps a dependency-keyed template closure outside the source checkout", async () => {
    const fixture = liveTemplateCacheFixture();
    const originalDependencyInputs = fixture.source().dependencyInputs;

    const first = await bootstrapLiveTemplateDependencies({
      sandbox: fixture.sandbox,
    });
    fixture.setSource(
      liveDependencySourceFixture({
        ordinarySource:
          "export default function Page() { return 'Changed'; }\n",
      }),
    );
    const second = await bootstrapLiveTemplateDependencies({
      sandbox: fixture.sandbox,
    });

    expect(first).toEqual(second);
    expect(first.manifest).toMatchObject({
      version: 4,
      scope: "live-template-execution",
      dependencyKey: expect.stringMatching(/^[0-9a-f]{64}$/u),
      dependencyInputs: originalDependencyInputs,
      bootstrapVersion: 3,
      closure: {
        nodeModulesPath: expect.stringMatching(
          /^\/workspace\/\.app-builder\/template-dependency-cache\/[0-9a-f]{64}\/linux\/x86_64\/source\/node_modules$/u,
        ),
        nodeModulesDigest: liveNodeModulesDigest,
        workspaceNodeModules: [],
        workspaceLinks: [],
        cargoHomePath: expect.stringMatching(
          /^\/workspace\/\.app-builder\/template-dependency-cache\/[0-9a-f]{64}\/linux\/x86_64\/cargo-home$/u,
        ),
        cargoHomeDigest: liveCargoHomeDigest,
      },
    });
    const bootstrap = fixture.run.mock.calls.find(([call]) =>
      call.command.includes("bun install"),
    )?.[0].command;
    expect(bootstrap).toBeDefined();
    expect(bootstrap).toContain(
      "git -C /workspace/repository archive --format=tar HEAD",
    );
    expect(bootstrap).toContain(
      "bun install --frozen-lockfile --ignore-scripts --linker=hoisted",
    );
    expect(bootstrap).toMatch(
      /CARGO_HOME=\/workspace\/\.app-builder\/template-dependency-cache\/[0-9a-f]{64}\/linux\/x86_64\/cargo-home cargo fetch --locked/u,
    );
    expect(bootstrap).toContain(
      "function digestTree(root, allowTrackedWorkspaceLinks)",
    );
    expect(bootstrap).toContain('test "$(node --version)" = "v24.18.0"');
    expect(bootstrap).toContain('test "$(bun --version)" = "1.3.14"');
    expect(bootstrap).toContain(
      'test "$(rustc --version | cut -d\' \' -f2)" = "1.97.1"',
    );
    expect(bootstrap).not.toContain("cd /workspace/repository\n");
    expect(bootstrap).not.toMatch(/chmod[^\n]*\/workspace\/repository/u);
    expect(bootstrap).not.toContain("mise install");
    fixture.setSource(
      liveDependencySourceFixture({
        packageJson: '{"workspaces":["apps/*","packages/*"]}\n',
        ordinarySource:
          "export default function Page() { return 'Changed'; }\n",
      }),
    );
    const changedManifest = await bootstrapLiveTemplateDependencies({
      sandbox: fixture.sandbox,
    });
    if (
      first.manifest.scope !== "live-template-execution" ||
      changedManifest.manifest.scope !== "live-template-execution"
    )
      throw new Error("expected live template manifests");
    expect(changedManifest.manifest.dependencyKey).not.toBe(
      first.manifest.dependencyKey,
    );
    expect(changedManifest.manifest.dependencyInputs).toEqual(
      fixture.source().dependencyInputs,
    );
    expect(fixture.setNetworkPolicy).toHaveBeenCalledTimes(4);
    expect(fixture.setNetworkPolicy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        allow: expect.arrayContaining(["registry.npmjs.org"]),
      }),
    );
    expect(fixture.setNetworkPolicy).toHaveBeenLastCalledWith("deny-all");
    expect(fixture.writeTextFile).toHaveBeenCalledTimes(2);
    expect(fixture.writeTextFile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        path: expect.stringMatching(
          /^\.app-builder\/template-dependency-cache\/[0-9a-f]{64}\/linux\/x86_64\/manifest\.json$/u,
        ),
      }),
    );
    expect(
      fixture.run.mock.calls.filter(([call]) =>
        call.command.includes("bun install"),
      ),
    ).toHaveLength(2);
  });

  it("reuses a manifest-bound live template closure without reinstalling", async () => {
    const fixture = liveTemplateCacheFixture();
    const first = await bootstrapLiveTemplateDependencies({
      sandbox: fixture.sandbox,
    });

    const second = await bootstrapLiveTemplateDependencies({
      sandbox: fixture.sandbox,
    });

    expect(second).toEqual(first);
    expect(
      fixture.run.mock.calls.filter(([call]) =>
        call.command.includes("bun install"),
      ),
    ).toHaveLength(1);
    expect(fixture.setNetworkPolicy).toHaveBeenCalledTimes(2);
    expect(
      fixture.run.mock.calls.filter(([call]) =>
        call.command.includes(
          "function digestTree(root, allowTrackedWorkspaceLinks)",
        ),
      ),
    ).toHaveLength(2);
  });

  it("rejects byte-tampered live template closure content without reinstalling", async () => {
    const fixture = liveTemplateCacheFixture();
    await bootstrapLiveTemplateDependencies({ sandbox: fixture.sandbox });
    fixture.setClosureState("node-tampered");

    await expect(
      inspectDependencyCache(
        fixture.sandbox,
        {},
        { sourceSha: "7".repeat(40), sourceTree: "8".repeat(40) },
        true,
      ),
    ).rejects.toThrow("dependency cache closure drifted");
    expect(
      fixture.run.mock.calls.filter(([call]) =>
        call.command.includes("bun install"),
      ),
    ).toHaveLength(1);
    expect(fixture.setNetworkPolicy).toHaveBeenCalledTimes(2);
  });

  it("rejects byte-tampered Cargo closure content without reinstalling", async () => {
    const fixture = liveTemplateCacheFixture();
    await bootstrapLiveTemplateDependencies({ sandbox: fixture.sandbox });
    fixture.setClosureState("cargo-tampered");

    await expect(
      inspectDependencyCache(
        fixture.sandbox,
        {},
        { sourceSha: "7".repeat(40), sourceTree: "8".repeat(40) },
        true,
      ),
    ).rejects.toThrow("dependency cache closure drifted");
    expect(
      fixture.run.mock.calls.filter(([call]) =>
        call.command.includes("bun install"),
      ),
    ).toHaveLength(1);
    expect(fixture.setNetworkPolicy).toHaveBeenCalledTimes(2);
  });

  it("rejects a missing live template closure with a present manifest without reinstalling", async () => {
    const fixture = liveTemplateCacheFixture();
    await bootstrapLiveTemplateDependencies({ sandbox: fixture.sandbox });
    fixture.setClosureState("missing");

    await expect(
      inspectDependencyCache(
        fixture.sandbox,
        {},
        { sourceSha: "7".repeat(40), sourceTree: "8".repeat(40) },
        true,
      ),
    ).rejects.toThrow("dependency cache closure is missing");
    expect(
      fixture.run.mock.calls.filter(([call]) =>
        call.command.includes("bun install"),
      ),
    ).toHaveLength(1);
    expect(fixture.setNetworkPolicy).toHaveBeenCalledTimes(2);
  });

  it("verifies target-bound manifest and archive bytes before extraction", async () => {
    const { run, sandbox, writeTextFile } = sandboxFixture();
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
    const linkCommand = run.mock.calls
      .map(([request]) => request.command as string)
      .find(
        (command) => command.includes("test -x") && command.includes(".bin/vp"),
      );
    expect(linkCommand).toBeDefined();
    if (linkCommand === undefined) throw new Error("missing closure check");
    expect(linkCommand).not.toContain(
      "test -d /workspace/repository && test ! -L /workspace/repository",
    );
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
    expect(linkCommand).toContain("\\( -type f -o -type d \\) -perm /222");
    expect(linkCommand).not.toContain("ln -s");
    expect(writeTextFile).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining(
          `/opt/app-builder/dependencies/${archiveDigest}/node_modules`,
        ),
      }),
    );
    expect(
      run.mock.calls.some(([request]) =>
        (request.command as string).includes('@autograph/vite-config') &&
        (request.command as string).includes("await import"),
      ),
    ).toBe(false);
    const resolutionCommand = run.mock.calls
      .map(([request]) => request.command as string)
      .find((command) =>
        command.includes('const {match}=require("path-to-regexp")'),
      );
    expect(resolutionCommand).toBeDefined();
    if (resolutionCommand === undefined)
      throw new Error("missing topology check");
    expect(resolutionCommand).toContain(ARRUSTED_PATH_TO_REGEXP_VERSION);
    expect(resolutionCommand).toContain(ARRUSTED_MICROFRONTENDS_VERSION);
    expect(resolutionCommand).toContain(
      ARRUSTED_MICROFRONTENDS_PATH_TO_REGEXP_VERSION,
    );
    expect(resolutionCommand).toContain('result?.path!=="/vendor"');
    expect(
      run.mock.calls.some(([request]) =>
        (request.command as string).includes("cargo metadata"),
      ),
    ).toBe(false);
  });

  it("does not require Rust for the pinned Vercel Development planning closure", async () => {
    const { run, sandbox, writeTextFile } = sandboxFixture(developmentManifest);
    await materializeOfflineDependencies({
      sandbox,
      artifactRevision: "b".repeat(64),
      target: {
        sourceSha: "7".repeat(40),
        sourceTree: "8".repeat(40),
      },
      environment: {
        APP_BUILDER_EXECUTION_MODE: "development",
        APP_BUILDER_DEVELOPMENT_DEPENDENCY_KEY:
          developmentManifest.dependencyKey,
      },
    });

    expect(run.mock.calls.some(([request]) => (request.command as string).includes("cargo metadata"))).toBe(false);
    const developmentLinkCommand = run.mock.calls
      .map(([request]) => request.command as string)
      .find(
        (command) => command.includes("test -x") && command.includes(".bin/vp"),
      );
    expect(developmentLinkCommand).toBeDefined();
    if (developmentLinkCommand === undefined)
      throw new Error("missing development closure check");
    expect(developmentLinkCommand).toContain(
      "test ! -e /workspace/repository/node_modules",
    );
    expect(developmentLinkCommand).toContain(
      `test "$(realpath ${DEVELOPMENT_DEPENDENCY_CACHE_ROOT})" = "${DEVELOPMENT_DEPENDENCY_CACHE_ROOT}"`,
    );
    expect(developmentLinkCommand).toContain("-perm /022");
    expect(developmentLinkCommand).not.toContain("-perm /222");
    expect(developmentLinkCommand).not.toContain("ln -s");
    expect(writeTextFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: expect.stringContaining(".app-builder/dependency-layouts/"),
      }),
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
