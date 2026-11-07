/* oxlint-disable eslint/no-bitwise, eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Exact ordered Git streams and owner-only filesystem publication are deliberate. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { localSourceBaselineManifestSchema } from "./local-source-baseline-contract";
import type { LocalSourceBaselineManifest } from "./local-source-baseline-contract";
import type { LocalOperatorArtifactAuthority } from "../provisioning/hosted-operator-artifact-store";

// oxlint-disable-next-line promise/avoid-new -- Convert the concrete child-process close/error callbacks into one typed completion value.
export const localBaselineProcessExit = async (child: ChildProcess): Promise<number> =>
  // oxlint-disable-next-line promise/avoid-new -- Typed adaptation of native child-process lifecycle callbacks.
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      resolve(code ?? -1);
    });
  });
const ensureDirectory = async (directory: string) => {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
  }
};

export const localBaselineGit = (root: string, args: string[], input?: Uint8Array | string) =>
  execFileSync(
    "/usr/bin/git",
    ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "--git-dir", root, ...args],
    {
      env: {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_TERMINAL_PROMPT: "0",
        HOME: path.dirname(root),
        NODE_ENV: "test",
        PATH: "/usr/bin:/bin",
      },
      input,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
const ownedDirectory = async (root: string, uid: number) => {
  const info = await lstat(root);
  const canonical = (await realpath(root)) === root;
  const ownerPrivate = info.uid === uid && (info.mode & 0o077) === 0;
  if (!info.isDirectory() || info.isSymbolicLink() || !ownerPrivate || !canonical) {
    throw new Error("source_baseline_authority_unavailable");
  }
};

/** Hash actual committed blobs in the existing development inventory format. No source executes. */
// oxlint-disable-next-line sonarjs/cognitive-complexity -- One ordered Git blob framing state machine validates headers, lengths and delimiters before accepting each digest.
export const committedDevelopmentInventory = async (gitRoot: string, sourceSha: string) => {
  const entries = localBaselineGit(gitRoot, ["ls-tree", "-rz", "--full-tree", sourceSha])
    .toString("utf-8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = /^(?<mode>100644|100755|120000) blob (?<oid>[a-f0-9]{40})\t(?<path>.+)$/su.exec(
        entry,
      );
      if (!match?.groups) {
        throw new Error("source_baseline_unsupported_tree");
      }
      return { mode: match.groups.mode, oid: match.groups.oid, path: match.groups.path };
    })
    .filter((entry) => entry.mode !== "120000")
    .toSorted((a, b) => {
      if (a.path < b.path) {
        return -1;
      }
      if (a.path > b.path) {
        return 1;
      }
      return 0;
    });
  const child = spawn("/usr/bin/git", ["--git-dir", gitRoot, "cat-file", "--batch"], {
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      NODE_ENV: "test",
      PATH: "/usr/bin:/bin",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = localBaselineProcessExit(child);
  child.stdin.end(entries.map((entry) => `${entry.oid}\n`).join(""));
  child.stderr.resume();
  let buffer = Buffer.alloc(0);
  let remaining = -1;
  let index = 0;
  let hash = createHash("sha256");
  const files: { mode: string; objectId: string; path: string; sha256: string }[] = [];
  for await (const data of child.stdout) {
    buffer = Buffer.concat([buffer, Buffer.from(data)]);
    while (buffer.length > 0) {
      if (remaining === -1) {
        const newline = buffer.indexOf(10);
        if (newline === -1) {
          break;
        }
        const header = buffer.subarray(0, newline).toString("utf-8").split(" ");
        if (
          header[0] !== entries[index]?.oid ||
          header[1] !== "blob" ||
          !/^\d+$/u.test(header[2] ?? "")
        ) {
          throw new Error("source_baseline_blob_unavailable");
        }
        remaining = Number(header[2]);
        hash = createHash("sha256");
        buffer = buffer.subarray(newline + 1);
      }
      const take = Math.min(remaining, buffer.length);
      hash.update(buffer.subarray(0, take));
      remaining -= take;
      buffer = buffer.subarray(take);
      if (remaining !== 0 || buffer.length === 0) {
        break;
      }
      if (buffer[0] !== 10) {
        throw new Error("source_baseline_blob_stream_invalid");
      }
      buffer = buffer.subarray(1);
      const entry = entries[index];
      if (entry === undefined) {
        throw new Error("source_baseline_blob_stream_invalid");
      }
      const digest = hash.digest("hex");
      files.push({
        mode: entry.mode ?? "",
        objectId: digest.slice(0, 40),
        path: entry.path ?? "",
        sha256: digest,
      });
      index += 1;
      remaining = -1;
    }
  }
  const code = await closed;
  if (code !== 0 || index !== entries.length || remaining !== -1 || buffer.length !== 0) {
    throw new Error("source_baseline_blob_stream_incomplete");
  }
  return {
    files,
    workspaceDigest: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
  };
};
const fsyncTree = async (root: string) => {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await chmod(file, 0o700);
      await fsyncTree(file);
    } else if (entry.isFile()) {
      await chmod(file, 0o600);
      const handle = await open(file, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else {
      throw new Error("source_baseline_unsafe_storage_entry");
    }
  }
  const handle = await open(root, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};
const readOwnedManifest = async (root: string, uid: number) => {
  await ownedDirectory(root, uid);
  const handle = await open(
    path.join(root, "manifest.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== uid || (info.mode & 0o077) !== 0) {
      throw new Error("source_baseline_manifest_unavailable");
    }
    return localSourceBaselineManifestSchema.parse(JSON.parse(await handle.readFile("utf-8")));
  } finally {
    await handle.close();
  }
};
const validateStored = async (root: string, manifest: LocalSourceBaselineManifest, uid: number) => {
  await ownedDirectory(root, uid);
  await ownedDirectory(path.join(root, "source.git"), uid);
  const stored = await readOwnedManifest(root, uid);
  if (
    stored.originalSourceSha !== manifest.originalSourceSha ||
    stored.workspaceDigest !== manifest.workspaceDigest ||
    stored.sourceSha !== manifest.sourceSha ||
    stored.sourceTree !== manifest.sourceTree
  ) {
    throw new Error("source_baseline_conflict");
  }
  const gitRoot = path.join(root, "source.git");
  if (
    localBaselineGit(gitRoot, ["rev-parse", "HEAD"]).toString().trim() !== manifest.sourceSha ||
    localBaselineGit(gitRoot, ["rev-parse", "HEAD^{tree}"]).toString().trim() !==
      manifest.sourceTree
  ) {
    throw new Error("source_baseline_identity_mismatch");
  }
  if (
    localBaselineGit(gitRoot, ["rev-parse", `${manifest.originalSourceSha}^{commit}`])
      .toString()
      .trim() !== manifest.originalSourceSha
  ) {
    throw new Error("source_baseline_original_identity_mismatch");
  }
  const observed = await committedDevelopmentInventory(gitRoot, manifest.sourceSha);
  if (observed.workspaceDigest !== manifest.workspaceDigest) {
    throw new Error("source_baseline_inventory_mismatch");
  }
};

/** Distinct source custody only. This never changes a session, approval, journal or provider. */
export const retainLocalSourceBaseline = async (input: {
  authority: LocalOperatorArtifactAuthority;
  manifest: LocalSourceBaselineManifest;
  pack: ReadableStream<Uint8Array>;
}) => {
  const manifest = localSourceBaselineManifestSchema.parse(input.manifest);
  if (input.authority.kind !== "local" || input.authority.ownerUid !== process.getuid?.()) {
    throw new Error("source_baseline_authority_unavailable");
  }
  await ownedDirectory(input.authority.stateRoot, input.authority.ownerUid);
  const namespace = path.join(input.authority.stateRoot, "source-baselines");
  await ensureDirectory(namespace);
  await ownedDirectory(namespace, input.authority.ownerUid);
  const parent = path.join(namespace, manifest.originalSourceSha);
  await ensureDirectory(parent);
  await ownedDirectory(parent, input.authority.ownerUid);
  const root = path.join(parent, manifest.workspaceDigest);
  try {
    await lstat(root);
    const stored = await readOwnedManifest(root, input.authority.ownerUid);
    if (
      stored.originalSourceSha !== manifest.originalSourceSha ||
      stored.workspaceDigest !== manifest.workspaceDigest ||
      stored.sourceTree !== manifest.sourceTree
    ) {
      throw new Error("source_baseline_conflict");
    }
    await validateStored(root, stored, input.authority.ownerUid);
    await input.pack.cancel();
    return { manifest: stored, root };
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  const temporary = await mkdtemp(path.join(parent, ".capture-"));
  const gitRoot = path.join(temporary, "source.git");
  await mkdir(gitRoot, { mode: 0o700 });
  localBaselineGit(gitRoot, ["init", "--bare", "--quiet"]);
  await writeFile(
    path.join(gitRoot, "shallow"),
    `${[...new Set([manifest.originalSourceSha, manifest.sourceSha])].join("\n")}\n`,
    { flag: "wx", mode: 0o600 },
  );
  const child = spawn("/usr/bin/git", ["--git-dir", gitRoot, "index-pack", "--stdin", "--strict"], {
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      NODE_ENV: "test",
      PATH: "/usr/bin:/bin",
    },
    stdio: ["pipe", "ignore", "pipe"],
  });
  child.stderr.resume();
  const closed = localBaselineProcessExit(child);
  const reader = input.pack.getReader();
  await pipeline(
    Readable.from(
      (async function* sourcePackChunks() {
        try {
          while (true) {
            const item = await reader.read();
            if (item.done) {
              break;
            }
            yield item.value;
          }
        } finally {
          reader.releaseLock();
        }
      })(),
    ),
    child.stdin,
  );
  if ((await closed) !== 0) {
    throw new Error("source_baseline_pack_invalid");
  }
  localBaselineGit(gitRoot, ["update-ref", "refs/heads/source", manifest.sourceSha]);
  localBaselineGit(gitRoot, ["symbolic-ref", "HEAD", "refs/heads/source"]);
  await writeFile(path.join(temporary, "manifest.json"), `${JSON.stringify(manifest)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await fsyncTree(temporary);
  await validateStored(temporary, manifest, input.authority.ownerUid);
  await rename(temporary, root);
  const directory = await open(parent, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  await validateStored(root, manifest, input.authority.ownerUid);
  return { manifest, root };
};
