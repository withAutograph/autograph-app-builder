import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import pathModule from "node:path";

const cyclePattern = /^[a-f0-9]{64}$/u;

function canonicalCyclePath(path: string) {
  if (!pathModule.isAbsolute(path) || pathModule.resolve(path) !== path) {
    throw new Error("The local Eve cycle binding path was not canonical.");
  }
  return path;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function isOwnerOnlyDirectory(path: string) {
  const info = lstatSync(path);
  const hasUnsafePermissions = (info.mode & 0o077) !== 0;
  const isCanonicalPath = realpathSync(path) === path;
  const isOwnedByCurrentUser = info.uid === process.getuid?.();
  return (
    isCanonicalPath &&
    info.isDirectory() &&
    !info.isSymbolicLink() &&
    isOwnedByCurrentUser &&
    !hasUnsafePermissions
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function readLocalEveCycleBinding(path: string) {
  canonicalCyclePath(path);
  if (realpathSync(path) !== path) {
    throw new Error("The local Eve cycle binding path was not canonical.");
  }
  const info = lstatSync(path);
  const isOwnedByCurrentUser = info.uid === process.getuid?.();
  const hasUnsafePermissions = (info.mode & 0o077) !== 0;
  if (!info.isFile() || info.isSymbolicLink() || !isOwnedByCurrentUser || hasUnsafePermissions) {
    throw new Error("The local Eve cycle binding was not owner-only.");
  }
  const generation = readFileSync(path, "utf-8").trim();
  if (!cyclePattern.test(generation)) {
    throw new Error("The local Eve cycle binding was invalid.");
  }
  return generation;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function rotateLocalEveCycleBinding(path: string) {
  canonicalCyclePath(path);
  const parent = pathModule.dirname(path);
  if (!isOwnerOnlyDirectory(parent)) {
    throw new Error("The local Eve cycle binding directory was not owner-only.");
  }
  const generation = randomBytes(32).toString("hex");
  const temporary = `${path}.${process.pid}.${generation}.tmp`;
  try {
    await writeFile(temporary, `${generation}\n`, {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  if (readLocalEveCycleBinding(path) !== generation) {
    throw new Error("The local Eve cycle binding could not be read back.");
  }
  return generation;
}
