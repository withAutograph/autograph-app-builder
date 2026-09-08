import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { deterministicGzip } from "../../../../lib/sandbox/deterministic-gzip.ts";

const TARGET_SHA = "d378904a05e1bc2c0896886e6fbd3b816babaee2";
const TARGET_TREE = "6735f4b45cc2b29a139531a41dac990c925e0d39";
const REPOSITORY = "https://github.com/withAutograph/arrusted-development";
const TREE_ENTRY = /^(100644|100755) blob [0-9a-f]{40}\t(.+)$/u;

function sha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function argumentsFrom(values: readonly string[]) {
  const args = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || value === undefined || args.has(name))
      throw new Error("Arguments must be unique --name value pairs.");
    args.set(name, value);
  }
  const root = args.get("--arrusted-root");
  const output = args.get("--output");
  const releaseOrigin = args.get("--release-origin");
  if (!root || !output || !releaseOrigin || args.size !== 3)
    throw new Error(
      "usage: hosted:starter-source-build -- --arrusted-root <path> --output <directory> --release-origin <https-origin>",
    );
  const origin = new URL(releaseOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("Release origin must be an exact HTTPS origin.");
  return { root: realpathSync(root), output: resolve(output), origin };
}

function git(root: string, args: readonly string[], encoding: "utf8"): string;
function git(root: string, args: readonly string[], encoding: "buffer"): Buffer;
function git(
  root: string,
  args: readonly string[],
  encoding: "utf8" | "buffer",
) {
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

const input = argumentsFrom(process.argv.slice(2));
if (git(input.root, ["rev-parse", "HEAD"], "utf8").trim() !== TARGET_SHA)
  throw new Error("Arrusted source SHA is not the pinned supported commit.");
if (
  git(input.root, ["rev-parse", `${TARGET_SHA}^{tree}`], "utf8").trim() !==
  TARGET_TREE
)
  throw new Error("Arrusted source tree is not the pinned supported tree.");

const entries = git(
  input.root,
  ["ls-tree", "-r", "--full-tree", TARGET_SHA],
  "utf8",
)
  .trimEnd()
  .split("\n")
  .map((line) => {
    const match = TREE_ENTRY.exec(line);
    if (!match) throw new Error(`Unsupported starter tree entry: ${line}`);
    const [, mode, path] = match;
    const bytes = git(input.root, ["show", `${TARGET_SHA}:${path}`], "buffer");
    return {
      path,
      mode,
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    };
  });
if (!entries.length) throw new Error("Pinned starter contains no files.");

const archive = deterministicGzip(
  git(input.root, ["archive", "--format=tar", TARGET_SHA], "buffer"),
);
const archiveSha256 = sha256(archive);
const archiveName = `${archiveSha256}.tar.gz`;
const archiveUrl = new URL(archiveName, input.origin).toString();
const manifest = Buffer.from(
  `${JSON.stringify({
    version: 1,
    source: { repository: REPOSITORY, sha: TARGET_SHA, tree: TARGET_TREE },
    archive: {
      url: archiveUrl,
      sha256: archiveSha256,
      bytes: archive.byteLength,
    },
    files: entries,
  })}\n`,
);
const manifestSha256 = sha256(manifest);
const manifestName = `${manifestSha256}.json`;
mkdirSync(input.output, { recursive: true, mode: 0o755 });
writeFileSync(resolve(input.output, archiveName), archive, {
  flag: "wx",
  mode: 0o444,
});
writeFileSync(resolve(input.output, manifestName), manifest, {
  flag: "wx",
  mode: 0o444,
});
process.stdout.write(
  `${JSON.stringify({
    version: 1,
    sourceSha: TARGET_SHA,
    sourceTree: TARGET_TREE,
    archive: {
      name: archiveName,
      sha256: archiveSha256,
      bytes: archive.byteLength,
    },
    manifest: {
      name: manifestName,
      sha256: manifestSha256,
      bytes: manifest.byteLength,
      url: new URL(manifestName, input.origin).toString(),
    },
    fileCount: entries.length,
  })}\n`,
);
