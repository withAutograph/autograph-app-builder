import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  assertCanonicalRoot,
  assertNoSecretMaterial,
  hashArtifact,
} from "./lifecycle.ts";

const fixedGit = "/usr/bin/git";

export type SanitizedGitTree = Readonly<{
  root: string;
  entriesDigest: string;
  entryCount: number;
}>;

const sanitizedEnvironment = (): NodeJS.ProcessEnv => ({
  HOME: homedir(),
  LANG: "C",
  NODE_ENV: "production",
  PATH: "/usr/bin:/bin",
});

const git = (root: string, args: readonly string[]) =>
  execFileSync(fixedGit, ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: sanitizedEnvironment(),
  }).trim();

function ensureNoLinkPath(path: string, label: string): void {
  const canonical = resolve(path);
  assertCanonicalRoot(canonical, realpathSync(canonical), label);
  if (resolve(canonical, "/") === canonical)
    throw new Error(`${label} cannot be the filesystem root.`);
  let cursor = canonical;
  for (;;) {
    if (lstatSync(cursor).isSymbolicLink())
      throw new Error(`${label} contains a symbolic link.`);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

function assertAbsoluteInput(path: string, label: string): void {
  if (!isAbsolute(path) || resolve(path) !== path)
    throw new Error(`${label} must be an absolute normalized path.`);
}

function containsPath(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function writeExactFile(path: string, bytes: Buffer, mode: number): void {
  const descriptor = openSync(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    mode,
  );
  try {
    let offset = 0;
    while (offset < bytes.length)
      offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, mode);
}

export function materializeSanitizedGitTree(
  sourceRoot: string,
  destinationRoot: string,
  expectedCommit: string,
  expectedTree: string,
): SanitizedGitTree {
  assertAbsoluteInput(sourceRoot, "Sanitized tree source");
  assertAbsoluteInput(destinationRoot, "Sanitized tree destination");
  ensureNoLinkPath(sourceRoot, "Sanitized tree source");
  if (existsSync(destinationRoot))
    throw new Error("Sanitized build context destination already exists.");
  const destinationParent = dirname(destinationRoot);
  ensureNoLinkPath(destinationParent, "Sanitized tree destination parent");
  if (git(sourceRoot, ["rev-parse", "HEAD"]) !== expectedCommit)
    throw new Error("Sanitized context source commit changed.");
  if (git(sourceRoot, ["rev-parse", "HEAD^{tree}"]) !== expectedTree)
    throw new Error("Sanitized context source tree changed.");
  const listing = execFileSync(
    fixedGit,
    ["-C", sourceRoot, "ls-tree", "-rz", "-r", "--full-tree", expectedTree],
    { maxBuffer: 128 * 1024 * 1024, env: sanitizedEnvironment() },
  ).toString("utf8");
  const records: string[] = [];
  mkdirSync(destinationRoot, { mode: 0o700 });
  try {
    for (const row of listing.split("\0").filter(Boolean)) {
      const match = /^([0-9]{6}) (blob|commit) ([0-9a-f]{40})\t(.+)$/u.exec(
        row,
      );
      if (match === null)
        throw new Error("Sanitized context contains an unsupported Git entry.");
      const [, mode, type, objectId, path] = match;
      if (
        type !== "blob" ||
        path === undefined ||
        path.includes("\\") ||
        path.includes("\ufffd") ||
        path
          .split("/")
          .some((part) => part === "" || part === "." || part === "..") ||
        path === ".git" ||
        path.startsWith(".git/") ||
        path === ".app-builder-source-manifest.json"
      )
        throw new Error("Sanitized context contains an unsafe Git path.");
      if (mode !== "100644" && mode !== "100755" && mode !== "120000")
        throw new Error("Sanitized context contains an unsupported Git mode.");
      const absolute = resolve(destinationRoot, path);
      if (!containsPath(destinationRoot, absolute))
        throw new Error("Sanitized context path escapes its root.");
      const parent = dirname(absolute);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      ensureNoLinkPath(parent, `Sanitized context parent for ${path}`);
      const bytes = execFileSync(
        fixedGit,
        ["-C", sourceRoot, "cat-file", "blob", objectId],
        { maxBuffer: 128 * 1024 * 1024, env: sanitizedEnvironment() },
      );
      if (mode === "120000") {
        const target = bytes.toString("utf8");
        if (
          target === "" ||
          target.includes("\0") ||
          target.includes("\ufffd") ||
          isAbsolute(target) ||
          !containsPath(destinationRoot, resolve(parent, target))
        )
          throw new Error(`Sanitized context symlink ${path} is unsafe.`);
        symlinkSync(target, absolute);
      } else {
        writeExactFile(absolute, bytes, mode === "100755" ? 0o755 : 0o644);
      }
      records.push(`${mode}\0${objectId}\0${path}`);
    }
    const entriesDigest = hashArtifact(records.join("\n"));
    const manifest = {
      version: 1,
      source: { commit: expectedCommit, tree: expectedTree },
      entriesDigest,
      entryCount: records.length,
    };
    assertNoSecretMaterial(manifest);
    writeExactFile(
      join(destinationRoot, ".app-builder-source-manifest.json"),
      Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8"),
      0o444,
    );
    if (
      git(sourceRoot, ["rev-parse", "HEAD"]) !== expectedCommit ||
      git(sourceRoot, ["rev-parse", "HEAD^{tree}"]) !== expectedTree
    )
      throw new Error(
        "Sanitized context source changed during materialization.",
      );
    return { root: destinationRoot, entriesDigest, entryCount: records.length };
  } catch (error) {
    rmSync(destinationRoot, { recursive: true, force: true });
    throw error;
  }
}
