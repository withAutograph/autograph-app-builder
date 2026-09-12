import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const cyclePattern = /^[a-f0-9]{64}$/u;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function canonicalCyclePath(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error("The local Eve cycle binding path was not canonical.");
  }
  return path;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function readLocalEveCycleBinding(path: string) {
  canonicalCyclePath(path);
  if (realpathSync(path) !== path)
    throw new Error("The local Eve cycle binding path was not canonical.");
  const info = lstatSync(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    (info.mode & 0o077) !== 0
  )
    throw new Error("The local Eve cycle binding was not owner-only.");
  const generation = readFileSync(path, "utf-8").trim();
  if (!cyclePattern.test(generation)) throw new Error("The local Eve cycle binding was invalid.");
  return generation;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function rotateLocalEveCycleBinding(path: string) {
  canonicalCyclePath(path);
  const parent = dirname(path);
  const parentInfo = lstatSync(parent);
  if (
    realpathSync(parent) !== parent ||
    !parentInfo.isDirectory() ||
    parentInfo.isSymbolicLink() ||
    parentInfo.uid !== process.getuid?.() ||
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    (parentInfo.mode & 0o077) !== 0
  )
    throw new Error("The local Eve cycle binding directory was not owner-only.");
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
  if (readLocalEveCycleBinding(path) !== generation)
    throw new Error("The local Eve cycle binding could not be read back.");
  return generation;
}
