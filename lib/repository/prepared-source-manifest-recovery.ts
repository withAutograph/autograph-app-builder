import type { SandboxSession } from "eve/sandbox";
import { getBuilderSandboxId } from "../sandbox/builder-sandbox";
import type { PreparedSandboxWorkspace } from "./supported-template";

// Git writes potentially large source bytes to temporary files. Hashing and
// parsing use fixed-size reads; neither stdout nor a blob is buffered in memory.
export const preparedSourceManifestRecoveryProgram = String.raw`
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { tmpdir } = require("node:os");
const expected = JSON.parse(process.argv[1]);
const directory = expected.manifestDirectory ?? path.resolve(expected.workspacePath, "../.app-builder");
const manifestTarget = path.join(directory, "source-files.json");
if (expected.manifestDigest === undefined && fs.existsSync(manifestTarget)) process.exit(0);
const temporary = fs.mkdtempSync(path.join(tmpdir(), "builder-source-baseline-"));
const gitArguments = ["--no-replace-objects", "-c", "protocol.allow=never", "-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", expected.workspacePath];
const git = (arguments_, target, input) => {
  const descriptor = fs.openSync(target, "w");
  try {
    const result = spawnSync("git", [...gitArguments, ...arguments_], {
      input, stdio: [input === undefined ? "ignore" : "pipe", descriptor, "inherit"],
      env: {...process.env, GIT_NO_LAZY_FETCH:"1", GIT_TERMINAL_PROMPT:"0", GIT_CONFIG_NOSYSTEM:"1", GIT_CONFIG_GLOBAL:"/dev/null"},
    });
    if (result.error || result.status !== 0) throw new Error("The original Git source objects are unavailable.");
  } finally { fs.closeSync(descriptor); }
};
const readRecords = (file, delimiter, visit) => {
  const descriptor = fs.openSync(file, "r");
  const chunk = Buffer.alloc(64 * 1024);
  let pending = Buffer.alloc(0);
  try {
    for (;;) {
      const length = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (length === 0) break;
      const bytes = Buffer.concat([pending, chunk.subarray(0, length)]);
      let start = 0;
      for (let end = bytes.indexOf(delimiter); end !== -1; end = bytes.indexOf(delimiter, start)) {
        visit(bytes.subarray(start, end).toString("utf8"));
        start = end + 1;
      }
      pending = Buffer.from(bytes.subarray(start));
    }
    if (pending.length !== 0) throw new Error("The original Git tree is incomplete.");
  } finally { fs.closeSync(descriptor); }
};
try {
  const treeFile = path.join(temporary, "tree");
  git(["rev-parse", expected.sourceSha + "^{tree}"], treeFile);
  if (fs.readFileSync(treeFile, "utf8").trim() !== expected.sourceTree) throw new Error("The original Git tree does not match the saved source.");
  git(["ls-tree", "-r", "-t", "-z", "--full-tree", expected.sourceSha], treeFile);
  const objects = [{type:"tree", objectId:expected.sourceTree}];
  readRecords(treeFile, 0, (entry) => {
    const match = /^(040000|100644|100755) (tree|blob) ([0-9a-f]{40})\t([^\r\n]+)$/.exec(entry);
    if (!match) {
      if (/^(120000 blob|160000 commit) [0-9a-f]{40}\t[^\r\n]+$/.test(entry)) return;
      throw new Error("The original Git tree contains an unsupported entry.");
    }
    const name = match[4];
    if (path.isAbsolute(name) || name.includes("\\") || name.split("/").some(part => part === "." || part === "..")) throw new Error("The original Git tree contains an unsafe path.");
    if ((match[1] === "040000") !== (match[2] === "tree")) throw new Error("The original Git tree contains an unsupported entry.");
    objects.push({type:match[2], objectId:match[3], ...(match[2] === "blob" ? {entry:{mode:match[1],objectId:match[3],path:name}} : {})});
  });
  const blobFile = path.join(temporary, "blobs");
  git(["cat-file", "--batch"], blobFile, objects.map(object => object.objectId + "\n").join(""));
  const descriptor = fs.openSync(blobFile, "r");
  const chunk = Buffer.alloc(64 * 1024);
  const files = [];
  try {
    for (const object of objects) {
      let header = "";
      for (;;) {
        if (fs.readSync(descriptor, chunk, 0, 1, null) !== 1) throw new Error("The original Git blob is incomplete.");
        if (chunk[0] === 10) break;
        header += String.fromCharCode(chunk[0]);
      }
      const match = /^([0-9a-f]{40}) (tree|blob) ([0-9]+)$/.exec(header);
      if (!match || match[1] !== object.objectId || match[2] !== object.type) throw new Error("The original Git object is unavailable.");
      let remaining = Number(match[3]);
      if (!Number.isSafeInteger(remaining)) throw new Error("The original Git blob size is invalid.");
      const hash = createHash("sha256");
      const objectHash = createHash("sha1").update(object.type + " " + remaining + "\0");
      while (remaining > 0) {
        const length = fs.readSync(descriptor, chunk, 0, Math.min(chunk.length, remaining), null);
        if (length === 0) throw new Error("The original Git blob is incomplete.");
        hash.update(chunk.subarray(0, length));
        objectHash.update(chunk.subarray(0, length));
        remaining -= length;
      }
      if (fs.readSync(descriptor, chunk, 0, 1, null) !== 1 || chunk[0] !== 10) throw new Error("The original Git blob separator is invalid.");
      if (objectHash.digest("hex") !== object.objectId) throw new Error("The original Git object's bytes do not match its identity.");
      if (object.entry) files.push({...object.entry, sha256:hash.digest("hex")});
    }
  } finally { fs.closeSync(descriptor); }
  const digest = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  const sourceIdentityDigest = createHash("sha256").update(JSON.stringify({sourceSha:expected.sourceSha,sourceTree:expected.sourceTree})).digest("hex");
  const sourceIdentity = expected.workspaceDigest === sourceIdentityDigest && expected.eligibilityDigest === sourceIdentityDigest;
  if (files.length === 0 || (digest !== expected.workspaceDigest && !sourceIdentity)) throw new Error("The original Git baseline does not match the saved source metadata.");
  if (expected.manifestDigest !== undefined && digest !== expected.manifestDigest) throw new Error("The prepared manifest does not match its original Git baseline.");
  fs.mkdirSync(directory, {recursive:true});
  // Exclusive links publish complete metadata without replacing a preparation
  // that won the race after the original null read. The caller validates it.
  const publishAbsent = (source, destination) => {
    try { fs.linkSync(source, destination); return true; }
    catch (error) { if (error.code === "EEXIST") return false; throw error; }
  };
  const staging = fs.mkdtempSync(path.join(directory, ".source-files-recovery-"));
  try {
    const checksums = files.map(file => file.sha256 + "  repository/" + file.path).join("\n") + "\n";
    const stagedChecksums = path.join(staging, "checksums");
    const checksumTarget = path.join(directory, "source-checksums.sha256");
    fs.writeFileSync(stagedChecksums, checksums);
    fs.writeFileSync(path.join(staging, "manifest"), JSON.stringify(files, null, 2) + "\n");
    if (expected.manifestDigest !== undefined) {
      const current = JSON.parse(fs.readFileSync(manifestTarget, "utf8"));
      if (createHash("sha256").update(JSON.stringify(current)).digest("hex") !== digest) throw new Error("Another preparation's source manifest is already present.");
      if (!publishAbsent(stagedChecksums, checksumTarget) && fs.readFileSync(checksumTarget, "utf8") !== checksums) throw new Error("The prepared workspace checksum receipt drifted.");
    } else if (!fs.existsSync(manifestTarget)) {
      const createdChecksum = publishAbsent(stagedChecksums, checksumTarget);
      if (!createdChecksum && fs.readFileSync(checksumTarget, "utf8") !== checksums) {
        if (!fs.existsSync(manifestTarget)) throw new Error("Another preparation's checksum metadata is already present.");
      } else if (!publishAbsent(path.join(staging, "manifest"), manifestTarget) && createdChecksum) {
        let winnerMatches = false;
        try {
          const winner = JSON.parse(fs.readFileSync(manifestTarget, "utf8"));
          winnerMatches = createHash("sha256").update(JSON.stringify(winner)).digest("hex") === digest;
        } catch { /* The caller will report an unreadable or invalid winning manifest. */ }
        if (!winnerMatches) {
          const owned = fs.statSync(stagedChecksums);
          const current = fs.lstatSync(checksumTarget);
          if (owned.dev === current.dev && owned.ino === current.ino && fs.readFileSync(checksumTarget, "utf8") === checksums) fs.unlinkSync(checksumTarget);
        }
      }
    }
  } finally { fs.rmSync(staging, {recursive:true, force:true}); }
} catch (error) {
  // A concurrent preparation may already have repaired the missing metadata.
  // Do not discard its result because our reconstruction lost its source race.
  if (expected.manifestDigest !== undefined || !fs.existsSync(manifestTarget)) throw error;
} finally { fs.rmSync(temporary, {recursive:true, force:true}); }
`;

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Rebuild only lost metadata from the exact original Git objects, preserving app edits. */
const runPreparedSourceManifestProof = async (
  sandbox: SandboxSession,
  workspace: PreparedSandboxWorkspace,
  manifestDigest?: string,
): Promise<void> => {
  if (getBuilderSandboxId(sandbox) !== workspace.workspaceId) {
    throw new Error("Builder cannot recover source metadata in a different app workspace.");
  }
  const result = await sandbox.run({
    command: `node -e ${shellQuote(preparedSourceManifestRecoveryProgram)} ${shellQuote(JSON.stringify({ ...workspace, manifestDigest }))}`,
    workingDirectory: workspace.workspacePath,
  });
  if (result.exitCode !== 0) {
    if (manifestDigest !== undefined) {
      throw new Error(
        "The prepared workspace manifest no longer matches its receipt or original Git baseline.",
      );
    }
    throw new Error(
      "Builder could not recover this app's original source metadata from its retained Git objects. The app and session are preserved; Builder service recovery is required before publication can continue.",
    );
  }
};

export const recoverPreparedSourceManifest = async (
  sandbox: SandboxSession,
  workspace: PreparedSandboxWorkspace,
): Promise<void> => {
  await runPreparedSourceManifestProof(sandbox, workspace);
};

/** Identity receipts bind Git objects, so an existing file list also needs the original tree proof. */
export const verifyPreparedSourceManifestAgainstGit = async (
  sandbox: SandboxSession,
  workspace: PreparedSandboxWorkspace,
  manifestDigest: string,
): Promise<void> => {
  await runPreparedSourceManifestProof(sandbox, workspace, manifestDigest);
};
