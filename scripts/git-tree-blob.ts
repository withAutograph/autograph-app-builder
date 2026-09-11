import { execFileSync } from "node:child_process";

const objectId = /^[0-9a-f]{40}$/u;

function git(repositoryRoot: string, args: string[]) {
  return execFileSync("/usr/bin/git", args, {
    cwd: repositoryRoot,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: process.env.HOME,
      LC_ALL: "C",
      NODE_ENV: "production",
    },
    maxBuffer: 16 * 1024 * 1024,
  });
}

function canonicalTrackedPath(path: string) {
  return (
    path !== "" &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/** Reads one exact regular file from an immutable Git tree, never the checkout. */
export function readTrackedTreeBlob(input: {
  repositoryRoot: string;
  tree: string;
  path: string;
}) {
  if (!objectId.test(input.tree) || !canonicalTrackedPath(input.path))
    throw new Error("Tracked tree asset reference was not canonical.");

  const record = git(input.repositoryRoot, [
    "ls-tree",
    "-z",
    "--full-tree",
    input.tree,
    "--",
    input.path,
  ]);
  const separator = record.indexOf(0x09);
  if (
    separator < 0 ||
    record.byteLength < separator + 2 ||
    record[record.byteLength - 1] !== 0 ||
    record.subarray(separator + 1, -1).toString("utf8") !== input.path
  )
    throw new Error(
      `Manifest asset was not one exact tracked file: ${input.path}`,
    );

  const metadata = record.subarray(0, separator).toString("ascii").split(" ");
  const [mode, type, oid] = metadata;
  if (
    metadata.length !== 3 ||
    !["100644", "100755"].includes(mode) ||
    type !== "blob" ||
    !objectId.test(oid)
  )
    throw new Error(
      `Manifest asset was not a tracked regular blob: ${input.path}`,
    );

  return {
    bytes: git(input.repositoryRoot, ["cat-file", "blob", oid]),
    mode,
    oid,
  };
}
