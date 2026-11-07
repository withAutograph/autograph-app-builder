import { createHash } from "node:crypto";
import { createReadStream, lstatSync } from "node:fs";
import { realpath } from "node:fs/promises";
import nodePath from "node:path";
import { git, gitStream, gitNulRecords } from "./source-read-git";
import { safeSourcePath } from "./source-path";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export interface PreparedSourceFile {
  mode: "100644" | "100755";
  objectId: string;
  path: string;
  sha256: string;
}
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting.
async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    if (!(chunk instanceof Uint8Array)) {
      throw new Error("The development source returned non-byte file content.");
    }
    hash.update(chunk);
  }
  return hash.digest("hex");
}
const within = function within(root: string, candidate: string): boolean {
  const relativePath = nodePath.relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${nodePath.sep}`) &&
      !nodePath.isAbsolute(relativePath))
  );
};
export const inspectDevelopmentSourceGeneration = async (sourcePathInput: string) => {
  const sourcePath = await realpath(nodePath.resolve(sourcePathInput));
  const sourceSha = git(sourcePath, ["rev-parse", "HEAD"]);
  const eligibilityDigest = sha256(sourceSha);

  const listedNames: string[] = [];
  for await (const name of gitNulRecords(
    gitStream(sourcePath, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
  )) {
    listedNames.push(name);
  }
  const names = listedNames.toSorted().filter((path) => {
    if (!safeSourcePath(path)) {
      throw new Error("The development source contains an unsafe path.");
    }
    const absolutePath = nodePath.resolve(sourcePath, path);
    if (!within(sourcePath, absolutePath)) {
      throw new Error("The development source escapes its root.");
    }
    // `git ls-files --cached` keeps a deleted tracked path until it is
    // staged. Development follows the working tree, so that path is a
    // managed deletion rather than a failed source snapshot.
    try {
      lstatSync(absolutePath);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  });
  const sourceFiles: PreparedSourceFile[] = [];
  for (const path of names) {
    const absolutePath = nodePath.resolve(sourcePath, path);
    const info = lstatSync(absolutePath);
    // Tar carries symlinks, submodule directories, and other ordinary Git
    // working-tree entries. They do not need to fit the old regular-file
    // receipt shape in order for the repository to run.
    if (!info.isFile() || info.isSymbolicLink()) {
      continue;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Hash source files sequentially to bound memory across large source trees.
    const digest = await hashFile(absolutePath);
    sourceFiles.push({
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional executable-mode bitmask.
      mode: (info.mode & 0o111) === 0 ? "100644" : "100755",
      // The live working tree has no stable Git object for edited/untracked
      // files. Its byte digest is the development-generation identity.
      objectId: digest.slice(0, 40),
      path,
      sha256: digest,
    });
  }
  if (sourceFiles.length === 0) {
    throw new Error("The development source contains no files.");
  }
  const workspaceDigest = sha256(JSON.stringify(sourceFiles));
  const generation = workspaceDigest.slice(0, 40);

  return {
    eligibilityDigest,
    generation,
    names,
    sourceFiles,
    sourcePath,
    sourceSha,
    workspaceDigest,
  };
};
