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
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { create as createTar } from "tar";

import { deterministicGzip } from "../../../../lib/sandbox/deterministic-gzip.ts";

const TARGET_SHA = "ffa0c34adad449c1fe9a7d64d2178cb01bfc8d49";
const TARGET_TREE = "88ead91d7b11aae11c526f1c2ee40f5b6db70642";
const OUTPUT_NAME = "arrusted-ffa0c34a-preview.tar.gz";
const REQUIRED_PACKAGE = "@vercel/microfrontends";
const REQUIRED_PACKAGE_VERSION = "2.4.0";
const SOURCE_FILE = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/u;

const targetDigests = {
  miseConfigSha256:
    "be05ac034f1d73b62526a81b8353963692817dfbedce6698e5ff4baacbb0e3a8",
  miseLockSha256:
    "415008336ed45882fce91f681fdce7648583ce6744372beb4d5212ab644e3462",
  bunLockSha256:
    "e313e11efc00e7439a6e91f832c80508a6b15cacda267b86a152f76aa5ad4dd0",
  appIdentitySha256:
    "10d474a28cb941686e768cf642f0e0466a6ac1c359ef5d3c2737c5548606ff6c",
  appContractSha256:
    "03889bce16d5368da287ae4215056ed786ba8c161b3bb4a0e10c9e17cb70994e",
  repositoryPreflightSha256:
    "7c6f5fb5f44aaf436cfc558ea82cc78dae02895dd7012497fa0c1ee7dc589340",
  repositoryExecSha256:
    "7816d61ce34ccf3b7680d6e03ddd8655650312901f23a03fae2b1aab50a051dc",
} as const;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

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
    throw new Error(
      "usage: hosted:artifact-build -- --arrusted-root <path> --output <path>",
    );
  return { arrustedRoot: realpathSync(arrustedRoot), output: resolve(output) };
}

function git(root: string, args: readonly string[], encoding: "utf8"): string;
function git(root: string, args: readonly string[], encoding: "buffer"): Buffer;
function git(
  root: string,
  args: readonly string[],
  encoding: "utf8" | "buffer",
): string | Buffer {
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

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep))
  );
}

function packageRoot(
  installedRoot: string,
  resolutionRoot: string,
  name: string,
): string | undefined {
  const candidate = join(resolutionRoot, ...name.split("/"));
  if (!existsSync(candidate)) return undefined;
  const resolved = realpathSync(candidate);
  if (!within(installedRoot, resolved))
    throw new Error(`Dependency ${name} resolves outside node_modules.`);
  return resolved;
}

function packageResolutionRoot(packagePath: string): string {
  const marker = `${sep}node_modules${sep}`;
  const index = packagePath.lastIndexOf(marker);
  if (index === -1) throw new Error("Dependency is outside a package store.");
  return packagePath.slice(0, index + marker.length - 1);
}

function dependencyClosure(root: string): Map<string, string> {
  const installedRoot = join(root, "node_modules");
  const pending = [{ name: REQUIRED_PACKAGE, resolutionRoot: installedRoot }];
  const packages = new Map<string, string>();
  while (pending.length > 0) {
    const { name, resolutionRoot } = pending.shift()!;
    const packagePath = packageRoot(installedRoot, resolutionRoot, name);
    if (packagePath === undefined)
      throw new Error(`Dependency ${name} is missing.`);
    const manifest = JSON.parse(
      readFileSync(join(packagePath, "package.json"), "utf8"),
    ) as {
      version?: string;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    if (
      name === REQUIRED_PACKAGE &&
      manifest.version !== REQUIRED_PACKAGE_VERSION
    )
      throw new Error("The required microfrontends version drifted.");
    const existing = packages.get(name);
    if (existing !== undefined) {
      const existingVersion = JSON.parse(
        readFileSync(join(existing, "package.json"), "utf8"),
      ) as { version?: string };
      if (existingVersion.version !== manifest.version)
        throw new Error(`Dependency ${name} requires conflicting versions.`);
      continue;
    }
    packages.set(name, packagePath);
    const childResolutionRoot = packageResolutionRoot(packagePath);
    for (const dependency of Object.keys(
      manifest.dependencies ?? {},
    ).toSorted())
      pending.push({ name: dependency, resolutionRoot: childResolutionRoot });
    for (const dependency of Object.keys(
      manifest.optionalDependencies ?? {},
    ).toSorted()) {
      if (
        packageRoot(installedRoot, childResolutionRoot, dependency) !==
        undefined
      )
        pending.push({ name: dependency, resolutionRoot: childResolutionRoot });
    }
  }
  return new Map(
    [...packages.entries()].toSorted(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function normalizeTree(root: string): void {
  const visit = (path: string): void => {
    const entry = lstatSync(path);
    if (entry.isDirectory()) {
      for (const name of readdirSync(path).toSorted()) visit(join(path, name));
      chmodSync(path, 0o755);
    } else if (entry.isSymbolicLink()) {
      const target = realpathSync(path);
      if (!within(root, target))
        throw new Error("Artifact symlink escapes its root.");
    } else if (entry.isFile()) {
      if (path.endsWith(".node"))
        throw new Error("Hosted dependency closure must be platform-portable.");
      chmodSync(path, entry.mode & 0o111 ? 0o755 : 0o644);
    } else {
      throw new Error("Artifact contains an unsupported filesystem entry.");
    }
    utimesSync(path, 0, 0);
  };
  visit(root);
}

function writeGzipTar(
  root: string,
  entries: readonly string[],
  output: string,
) {
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
const scratch = mkdtempSync(join(tmpdir(), "app-builder-hosted-artifact."));
try {
  const commit = git(
    arrustedRoot,
    ["rev-parse", "HEAD^{commit}"],
    "utf8",
  ).trim();
  const tree = git(arrustedRoot, ["rev-parse", "HEAD^{tree}"], "utf8").trim();
  const status = git(arrustedRoot, ["status", "--porcelain=v1"], "utf8").trim();
  if (commit !== TARGET_SHA || tree !== TARGET_TREE || status !== "")
    throw new Error("Arrusted source is not the exact clean supported target.");

  const seed = join(scratch, ".app-builder-hosted-seed");
  const dependencyRoot = join(seed, "dependency-cache");
  mkdirSync(dependencyRoot, { recursive: true });

  const entries = git(
    arrustedRoot,
    ["ls-tree", "-rz", "--full-tree", TARGET_SHA],
    "utf8",
  )
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = SOURCE_FILE.exec(line);
      if (match === null) throw new Error("Unsupported Arrusted Git entry.");
      const content = git(
        arrustedRoot,
        ["cat-file", "blob", match[2]!],
        "buffer",
      );
      return {
        mode: match[1] as "100644" | "100755",
        objectId: match[2]!,
        path: match[3]!,
        sha256: sha256(content),
      };
    });
  const sourceArchive = join(seed, "source-tree.tar.gz");
  const sourceTar = git(
    arrustedRoot,
    ["archive", "--format=tar", TARGET_SHA],
    "buffer",
  );
  writeFileSync(sourceArchive, deterministicGzip(sourceTar));
  writeFileSync(
    join(seed, "source-files.json"),
    `${JSON.stringify(entries, null, 2)}\n`,
  );
  writeFileSync(
    join(seed, "source-checksums.sha256"),
    `${entries.map((entry) => `${entry.sha256}  repository/${entry.path}`).join("\n")}\n`,
  );

  const dependencyStage = join(scratch, "dependency-stage", "node_modules");
  mkdirSync(dependencyStage, { recursive: true });
  const packages = dependencyClosure(arrustedRoot);
  for (const [name, source] of packages) {
    const destination = join(dependencyStage, ...name.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { dereference: true, recursive: true });
  }
  normalizeTree(join(scratch, "dependency-stage"));
  const dependencyArchive = join(dependencyRoot, "node-modules.tar.gz");
  writeGzipTar(
    join(scratch, "dependency-stage"),
    ["node_modules"],
    dependencyArchive,
  );
  const archiveBytes = statSync(dependencyArchive).size;
  const archiveSha256 = sha256(readFileSync(dependencyArchive));
  const dependencyManifest = {
    version: 1,
    scope: "identity-planning",
    platform: "linux/portable",
    target: { sha: TARGET_SHA, tree: TARGET_TREE, ...targetDigests },
    runtime: { bun: "1.3.14" },
    closure: {
      package: REQUIRED_PACKAGE,
      version: REQUIRED_PACKAGE_VERSION,
      archivePath: "/opt/app-builder/dependency-cache/node-modules.tar.gz",
      archiveSha256,
      archiveBytes,
    },
  } as const;
  writeFileSync(
    join(dependencyRoot, "manifest.json"),
    `${JSON.stringify(dependencyManifest, null, 2)}\n`,
  );
  const artifactManifest = {
    version: 1,
    target: {
      sha: TARGET_SHA,
      tree: TARGET_TREE,
      eligibilityDigest:
        "c47f3c720cce4b4bcf64e430d248284570776f48a886c20fc18d255815985c6e",
      contractDigest:
        "f3c8499305c983b3d82f3b78687f4106a149decd7faa486d3d106bdaf83e928f",
      workspaceDigest: sha256(JSON.stringify(entries)),
    },
    source: {
      archiveSha256: sha256(readFileSync(sourceArchive)),
      archiveBytes: statSync(sourceArchive).size,
      entryCount: entries.length,
    },
    dependency: {
      manifestSha256: sha256(
        readFileSync(join(dependencyRoot, "manifest.json")),
      ),
      archiveSha256,
      archiveBytes,
      packages: [...packages.keys()],
    },
  } as const;
  writeFileSync(
    join(seed, "artifact-manifest.json"),
    `${JSON.stringify(artifactManifest, null, 2)}\n`,
  );
  normalizeTree(seed);
  const temporaryOutput = `${output}.${process.pid}.tmp`;
  mkdirSync(dirname(output), { recursive: true });
  writeGzipTar(scratch, [basename(seed)], temporaryOutput);
  chmodSync(temporaryOutput, 0o644);
  renameSync(temporaryOutput, output);
  process.stdout.write(
    `${JSON.stringify({ output, name: OUTPUT_NAME, bytes: statSync(output).size, sha256: sha256(readFileSync(output)), manifest: artifactManifest }, null, 2)}\n`,
  );
} finally {
  rmSync(scratch, { force: true, recursive: true });
}
