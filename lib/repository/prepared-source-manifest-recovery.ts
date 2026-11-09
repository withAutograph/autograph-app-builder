import type { SandboxSession } from "eve/sandbox";
import { getBuilderSandboxId } from "../sandbox/builder-sandbox";
import type { PreparedSandboxWorkspace } from "./supported-template";

// Git writes potentially large source bytes to temporary files. Hashing and
// parsing use fixed-size reads; neither stdout nor a blob is buffered in memory.
const recoveryProgram = String.raw`
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { tmpdir } = require("node:os");
const expected = JSON.parse(process.argv[1]);
const temporary = fs.mkdtempSync(path.join(tmpdir(), "builder-source-baseline-"));
const gitArguments = ["-c", "protocol.allow=never", "-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", expected.workspacePath];
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
  git(["ls-tree", "-r", "-z", "--full-tree", expected.sourceSha], treeFile);
  const entries = [];
  readRecords(treeFile, 0, (entry) => {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t([^\r\n]+)$/.exec(entry);
    if (!match) {
      if (/^(120000 blob|160000 commit) [0-9a-f]{40}\t[^\r\n]+$/.test(entry)) return;
      throw new Error("The original Git tree contains an unsupported entry.");
    }
    const name = match[3];
    if (path.isAbsolute(name) || name.includes("\\") || name.split("/").some(part => part === "." || part === "..")) throw new Error("The original Git tree contains an unsafe path.");
    entries.push({mode:match[1], objectId:match[2], path:name});
  });
  const blobFile = path.join(temporary, "blobs");
  git(["cat-file", "--batch"], blobFile, entries.map(entry => entry.objectId + "\n").join(""));
  const descriptor = fs.openSync(blobFile, "r");
  const chunk = Buffer.alloc(64 * 1024);
  const files = [];
  try {
    for (const entry of entries) {
      let header = "";
      for (;;) {
        if (fs.readSync(descriptor, chunk, 0, 1, null) !== 1) throw new Error("The original Git blob is incomplete.");
        if (chunk[0] === 10) break;
        header += String.fromCharCode(chunk[0]);
      }
      const match = /^([0-9a-f]{40}) blob ([0-9]+)$/.exec(header);
      if (!match || match[1] !== entry.objectId) throw new Error("The original Git blob is unavailable.");
      let remaining = Number(match[2]);
      if (!Number.isSafeInteger(remaining)) throw new Error("The original Git blob size is invalid.");
      const hash = createHash("sha256");
      while (remaining > 0) {
        const length = fs.readSync(descriptor, chunk, 0, Math.min(chunk.length, remaining), null);
        if (length === 0) throw new Error("The original Git blob is incomplete.");
        hash.update(chunk.subarray(0, length));
        remaining -= length;
      }
      if (fs.readSync(descriptor, chunk, 0, 1, null) !== 1 || chunk[0] !== 10) throw new Error("The original Git blob separator is invalid.");
      files.push({...entry, sha256:hash.digest("hex")});
    }
  } finally { fs.closeSync(descriptor); }
  const digest = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  if (files.length === 0 || digest !== expected.workspaceDigest) throw new Error("The original Git baseline does not match the saved source metadata.");
  const directory = path.resolve(expected.workspacePath, "../.app-builder");
  fs.mkdirSync(directory, {recursive:true});
  // Checksum first, then atomically restore the missing manifest. App bytes and
  // Git checkout/index are never written by metadata recovery.
  const staging = fs.mkdtempSync(path.join(directory, ".source-files-recovery-"));
  try {
    fs.writeFileSync(path.join(staging, "checksums"), files.map(file => file.sha256 + "  repository/" + file.path).join("\n") + "\n");
    fs.writeFileSync(path.join(staging, "manifest"), JSON.stringify(files, null, 2) + "\n");
    fs.renameSync(path.join(staging, "checksums"), path.join(directory, "source-checksums.sha256"));
    fs.renameSync(path.join(staging, "manifest"), path.join(directory, "source-files.json"));
  } finally { fs.rmSync(staging, {recursive:true, force:true}); }
} finally { fs.rmSync(temporary, {recursive:true, force:true}); }
`;

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Rebuild only lost metadata from the exact original Git objects, preserving app edits. */
export const recoverPreparedSourceManifest = async (
  sandbox: SandboxSession,
  workspace: PreparedSandboxWorkspace,
): Promise<void> => {
  if (getBuilderSandboxId(sandbox) !== workspace.workspaceId) {
    throw new Error("Builder cannot recover source metadata in a different app workspace.");
  }
  const result = await sandbox.run({
    command: `node -e ${shellQuote(recoveryProgram)} ${shellQuote(JSON.stringify(workspace))}`,
    workingDirectory: workspace.workspacePath,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      "Builder could not recover this app's original source metadata from its retained Git objects. The app and session are preserved; Builder service recovery is required before publication can continue.",
    );
  }
};
