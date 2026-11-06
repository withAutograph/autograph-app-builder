import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { create as createTar } from "tar";

import { deterministicGzip } from "../../../../lib/sandbox/deterministic-gzip.ts";

const TARGET_SHA = "d378904a05e1bc2c0896886e6fbd3b816babaee2";
const TARGET_TREE = "6735f4b45cc2b29a139531a41dac990c925e0d39";
const OUTPUT_NAME = "arrusted-d378904a-dependencies.tar.gz";
const REQUIRED_PACKAGE = "@vercel/microfrontends";
const REQUIRED_PACKAGE_VERSION = "2.4.0";
const EXECUTION_ROOT_PACKAGES = [
  "@tailwindcss/vite",
  "@testing-library/jest-dom",
  "@testing-library/react",
  "@types/node",
  "@types/react",
  "@types/react-dom",
  "@vercel/microfrontends",
  "@vitejs/plugin-react",
  "babel-plugin-react-compiler",
  "next",
  "react",
  "react-dom",
  "typescript",
  "turbo",
  "vite-plus",
  "vitest",
] as const;

const targetDigests = {
  appContractSha256: "03889bce16d5368da287ae4215056ed786ba8c161b3bb4a0e10c9e17cb70994e",
  appIdentitySha256: "10d474a28cb941686e768cf642f0e0466a6ac1c359ef5d3c2737c5548606ff6c",
  bunLockSha256: "e313e11efc00e7439a6e91f832c80508a6b15cacda267b86a152f76aa5ad4dd0",
  miseConfigSha256: "da8fe48559f8250494bdbea0f1a6caa644b59d5be14658a7aaf26ccd6fab0199",
  miseLockSha256: "415008336ed45882fce91f681fdce7648583ce6744372beb4d5212ab644e3462",
  repositoryExecSha256: "7816d61ce34ccf3b7680d6e03ddd8655650312901f23a03fae2b1aab50a051dc",
  repositoryPreflightSha256: "c30fb6d26d49a229d8e4283c1350d86fa61a6f1708ada614f55f8f40358cbbba",
} as const;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function parseArguments(args: readonly string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--"))
      throw new Error("Arguments must be exact --name value pairs.");
    if (values.has(flag)) throw new Error(`Duplicate argument ${flag}.`);
    values.set(flag, value);
  }
  const arrustedRoot = values.get("--arrusted-root");
  const output = values.get("--output");
  values.delete("--arrusted-root");
  values.delete("--output");
  if (arrustedRoot === undefined || output === undefined || values.size !== 0)
    throw new Error("usage: hosted:artifact-build -- --arrusted-root <path> --output <path>");
  return { arrustedRoot: realpathSync(arrustedRoot), output: path.resolve(output) };
}

function git(root: string, args: readonly string[], encoding: "utf-8"): string;
function git(root: string, args: readonly string[], encoding: "utf-8"): string {
  return execFileSync(
    "/usr/bin/git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.attributesfile=/dev/null",
      "-C",
      root,
      ...args,
    ],
    { encoding, maxBuffer: 256 * 1024 * 1024 },
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function within(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !relativePath.startsWith(path.sep))
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function packageRoot(
  installedRoot: string,
  resolutionRoot: string,
  name: string,
): string | undefined {
  const candidate = path.join(resolutionRoot, ...name.split("/"));
  if (!existsSync(candidate)) return undefined;
  const resolved = realpathSync(candidate);
  if (!within(installedRoot, resolved))
    throw new Error(`Dependency ${name} resolves outside node_modules.`);
  return resolved;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function packageResolutionRoot(packagePath: string): string {
  const marker = `${path.sep}node_modules${path.sep}`;
  const index = packagePath.lastIndexOf(marker);
  if (index === -1) throw new Error("Dependency is outside a package store.");
  return packagePath.slice(0, index + marker.length - 1);
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function packageVersion(packagePath: string): string {
  const manifest = JSON.parse(readFileSync(path.join(packagePath, "package.json"), "utf-8")) as {
    version?: string;
  };
  if (typeof manifest.version !== "string")
    throw new Error("Dependency package version is missing.");
  return manifest.version;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function dependencyClosure(root: string): Map<string, string> {
  const installedRoot = path.join(root, "node_modules");
  const pending = EXECUTION_ROOT_PACKAGES.map((name) => ({
    destination: name,
    name,
    resolutionRoot: installedRoot,
  }));
  const packages = new Map<string, string>();
  const rootVersions = new Map<string, string>();
  for (const name of EXECUTION_ROOT_PACKAGES) {
    const packagePath = packageRoot(installedRoot, installedRoot, name);
    if (packagePath === undefined) throw new Error(`Dependency ${name} is missing.`);
    rootVersions.set(name, packageVersion(packagePath));
  }
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined) continue;
    const { name, resolutionRoot, destination } = current;
    const packagePath = packageRoot(installedRoot, resolutionRoot, name);
    if (packagePath === undefined) throw new Error(`Dependency ${name} is missing.`);
    const manifest = JSON.parse(readFileSync(path.join(packagePath, "package.json"), "utf-8")) as {
      version?: string;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    if (typeof manifest.version !== "string")
      throw new Error("Dependency package version is missing.");
    if (name === REQUIRED_PACKAGE && manifest.version !== REQUIRED_PACKAGE_VERSION)
      throw new Error("The required microfrontends version drifted.");
    const existing = packages.get(destination);
    if (existing !== undefined) {
      if (packageVersion(existing) !== manifest.version)
        throw new Error(`Dependency destination ${destination} drifted.`);
      continue;
    }
    packages.set(destination, packagePath);
    if (!rootVersions.has(name)) rootVersions.set(name, manifest.version);
    const childResolutionRoot = packageResolutionRoot(packagePath);
    const enqueue = (dependency: string) => {
      const dependencyPath = packageRoot(installedRoot, childResolutionRoot, dependency);
      if (dependencyPath === undefined) return false;
      const dependencyVersion = packageVersion(dependencyPath);
      const rootVersion = rootVersions.get(dependency);
      if (rootVersion === undefined) rootVersions.set(dependency, dependencyVersion);
      const dependencyDestination =
        rootVersion === undefined || rootVersion === dependencyVersion
          ? dependency
          : path.join(destination, "node_modules", dependency);
      pending.push({
        destination: dependencyDestination,
        name: dependency,
        resolutionRoot: childResolutionRoot,
      });
      return true;
    };
    for (const dependency of Object.keys(manifest.dependencies ?? {}).toSorted())
      if (!enqueue(dependency)) throw new Error(`Dependency ${dependency} is missing.`);
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {}).toSorted()) {
      if (dependency.includes("musl")) continue;
      enqueue(dependency);
    }
  }
  return new Map([...packages.entries()].toSorted(([left], [right]) => left.localeCompare(right)));
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function normalizeTree(root: string): void {
  const visit = (entryPath: string): void => {
    const entry = lstatSync(entryPath);
    if (entry.isDirectory()) {
      for (const name of readdirSync(entryPath).toSorted()) visit(path.join(entryPath, name));
      chmodSync(entryPath, 0o755);
    } else if (entry.isSymbolicLink()) {
      const target = realpathSync(entryPath);
      if (!within(root, target)) throw new Error("Artifact symlink escapes its root.");
    } else if (entry.isFile()) {
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
      chmodSync(entryPath, entry.mode & 0o111 ? 0o755 : 0o644);
    } else {
      throw new Error("Artifact contains an unsupported filesystem entry.");
    }
    utimesSync(entryPath, 0, 0);
  };
  visit(root);
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function writeGzipTar(root: string, entries: readonly string[], output: string) {
  const uncompressed = `${output}.${process.pid}.tar`;
  createTar(
    {
      cwd: root,
      file: uncompressed,
      mtime: new Date(0),
      portable: true,
      sync: true,
    },
    [...entries],
  );
  try {
    writeFileSync(output, deterministicGzip(readFileSync(uncompressed)));
  } finally {
    rmSync(uncompressed, { force: true });
  }
}

const { arrustedRoot, output } = parseArguments(process.argv.slice(2));
if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error("Hosted execution artifacts must be built on Linux x86_64.");
const scratch = mkdtempSync(path.join(tmpdir(), "app-builder-hosted-artifact."));
try {
  const commit = git(arrustedRoot, ["rev-parse", "HEAD^{commit}"], "utf-8").trim();
  const tree = git(arrustedRoot, ["rev-parse", "HEAD^{tree}"], "utf-8").trim();
  const status = git(arrustedRoot, ["status", "--porcelain=v1"], "utf-8").trim();
  if (commit !== TARGET_SHA || tree !== TARGET_TREE || status !== "")
    throw new Error("Arrusted source is not the exact clean supported target.");

  const seed = path.join(scratch, ".app-builder-hosted-seed");
  const dependencyRoot = path.join(seed, "dependency-cache");
  mkdirSync(dependencyRoot, { recursive: true });

  const dependencyStage = path.join(scratch, "dependency-stage", "node_modules");
  mkdirSync(dependencyStage, { recursive: true });
  const packages = dependencyClosure(arrustedRoot);
  for (const [name, source] of packages) {
    const destination = path.join(dependencyStage, ...name.split("/"));
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(source, destination, { dereference: true, recursive: true });
  }
  const viteConfigDestination = path.join(dependencyStage, "@autograph", "vite-config");
  mkdirSync(path.dirname(viteConfigDestination), { recursive: true });
  cpSync(path.join(arrustedRoot, "packages", "vite-config"), viteConfigDestination, {
    dereference: true,
    recursive: true,
  });
  const binaryDirectory = path.join(dependencyStage, ".bin");
  mkdirSync(binaryDirectory, { recursive: true });
  for (const [name, target] of [
    ["next", "../next/dist/bin/next"],
    ["turbo", "../turbo/bin/turbo"],
    ["vp", "../vite-plus/bin/vp"],
  ] as const)
    symlinkSync(target, path.join(binaryDirectory, name));
  for (const binary of ["next", "turbo", "vp"] as const)
    execFileSync(process.execPath, [path.join(binaryDirectory, binary), "--version"], {
      cwd: dependencyStage,
      encoding: "utf-8",
    });
  execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", 'await import("@autograph/vite-config")'],
    { cwd: dependencyStage, encoding: "utf-8" },
  );
  normalizeTree(path.join(scratch, "dependency-stage"));
  const dependencyArchive = path.join(dependencyRoot, "node-modules.tar.gz");
  writeGzipTar(path.join(scratch, "dependency-stage"), ["node_modules"], dependencyArchive);
  const archiveBytes = statSync(dependencyArchive).size;
  const archiveSha256 = sha256(readFileSync(dependencyArchive));
  const dependencyManifest = {
    closure: {
      archiveBytes,
      archivePath: "/opt/app-builder/dependency-cache/node-modules.tar.gz",
      archiveSha256,
      package: REQUIRED_PACKAGE,
      version: REQUIRED_PACKAGE_VERSION,
    },
    platform: "linux/x86_64",
    runtime: { bun: "1.3.14" },
    scope: "builder-execution",
    target: { sha: TARGET_SHA, tree: TARGET_TREE, ...targetDigests },
    version: 1,
  } as const;
  writeFileSync(
    path.join(dependencyRoot, "manifest.json"),
    `${JSON.stringify(dependencyManifest, null, 2)}\n`,
  );
  const artifactManifest = {
    dependency: {
      archiveBytes,
      archiveSha256,
      manifestSha256: sha256(readFileSync(path.join(dependencyRoot, "manifest.json"))),
      packages: [...packages.keys()],
    },
    target: {
      sha: TARGET_SHA,
      tree: TARGET_TREE,
    },
    version: 2,
  } as const;
  writeFileSync(
    path.join(seed, "artifact-manifest.json"),
    `${JSON.stringify(artifactManifest, null, 2)}\n`,
  );
  normalizeTree(seed);
  const temporaryOutput = `${output}.${process.pid}.tmp`;
  mkdirSync(path.dirname(output), { recursive: true });
  writeGzipTar(scratch, [path.basename(seed)], temporaryOutput);
  chmodSync(temporaryOutput, 0o644);
  renameSync(temporaryOutput, output);
  process.stdout.write(
    `${JSON.stringify({ bytes: statSync(output).size, manifest: artifactManifest, name: OUTPUT_NAME, output, sha256: sha256(readFileSync(output)) }, null, 2)}\n`,
  );
} finally {
  rmSync(scratch, { force: true, recursive: true });
}
