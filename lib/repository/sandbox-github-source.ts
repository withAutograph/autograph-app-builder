import { createHash } from "node:crypto";

import type { SandboxSession } from "eve/sandbox";

import type {
  CanonicalTemplateSnapshot,
  SourceReceipt,
} from "./source-receipt";
import {
  inspectPreparedSandboxWorkspace,
  SUPPORTED_REPOSITORY_CONTRACT,
  SUPPORTED_TEMPLATE_INPUT_PATHS,
  type PreparedSandboxWorkspace,
} from "./supported-template";
import { parseCanonicalTemplateSnapshot } from "./source-receipt";
import { type ImmutableGitHubSourceReceipt } from "./github-publication";

const SHA = /^[0-9a-f]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}$/u;
const BRANCH =
  /^(?![./])(?!.*(?:\.\.|@\{))(?!.*(?:[/.]|\.lock)$)[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u;
const SANDBOX_WORKSPACE = "/workspace/repository";
const SANDBOX_OPERATION_TIMEOUT_MS = 120_000;
const SANDBOX_OPERATION_OUTPUT_BYTES = 262_144;
const SANDBOX_INSPECTION_BYTES = 2 * 1024 * 1024;
export const SANDBOX_GITHUB_SOURCE_INSPECTION =
  ".app-builder/canonical-clone-inspection.json";

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function parseRemote(input: string) {
  let remote: URL;
  try {
    remote = new URL(input);
  } catch {
    throw new Error("The GitHub source remote is invalid.");
  }
  const match =
    /^\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\.git$/u.exec(
      remote.pathname,
    );
  if (
    remote.origin !== "https://github.com" ||
    remote.username !== "" ||
    remote.password !== "" ||
    remote.search !== "" ||
    remote.hash !== "" ||
    match === null ||
    !REPOSITORY.test(match[1] ?? "") ||
    !REPOSITORY.test(match[2] ?? "")
  )
    throw new Error("The GitHub source remote is invalid.");
  return remote.toString();
}

function parseBranch(input: string) {
  if (
    !BRANCH.test(input) ||
    input.split("/").some((part) => part.startsWith("."))
  )
    throw new Error("The GitHub source branch is invalid.");
  return input;
}

// Kept temporarily for stored receipt parsing while the legacy inspection
// writer is removed from the active source path.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const sandboxCloneInspectionProgram = String.raw`
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { isAbsolute, resolve } = require("node:path");

const root = "/workspace/repository";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const git = (args, encoding = "utf8") => execFileSync(
  "git",
  [
    "-c", "protocol.allow=never",
    "-c", "credential.helper=",
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-C", root,
    ...args,
  ],
  { encoding, maxBuffer: 32 * 1024 * 1024 },
);
const safeSourcePath = (value) =>
  value !== "" &&
  !isAbsolute(value) &&
  !value.includes("\\") &&
  !/[\r\n]/.test(value) &&
  !value.split("/").some((segment) => segment === "." || segment === "..");
const sourceSha = git(["rev-parse", "HEAD"]).trim();
if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error("invalid source SHA");
const sourceTree = git(["rev-parse", sourceSha + "^{tree}"]).trim();
if (!/^[0-9a-f]{40}$/.test(sourceTree)) throw new Error("invalid source tree");
const output = git(["ls-tree", "-r", "-z", "--full-tree", sourceSha], "buffer");
const files = output
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .map((entry) => {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t([^\r\n]+)$/.exec(entry);
    if (match === null || !safeSourcePath(match[3]))
      throw new Error("unsupported cloned source entry");
    const path = match[3];
    const file = resolve(root, path);
    if (!file.startsWith(root + "/"))
      throw new Error("cloned source path escaped its workspace");
    return {
      mode: match[1],
      objectId: match[2],
      path,
      sha256: sha256(readFileSync(file)),
    };
  });
if (files.length === 0) throw new Error("cloned source tree is empty");
const appBuilder = "/workspace/.app-builder";
mkdirSync(appBuilder, { recursive: true });
writeFileSync(
  appBuilder + "/source-files.json",
  JSON.stringify(files, null, 2) + "\n",
);
writeFileSync(
  appBuilder + "/source-checksums.sha256",
  files.map((file) => file.sha256 + "  repository/" + file.path).join("\n") + "\n",
);
const inputPaths = ${JSON.stringify(SUPPORTED_TEMPLATE_INPUT_PATHS)};
const contents = {};
for (const path of [...inputPaths, ".config/repository-template.json"]) {
  const file = resolve(root, path);
  try {
    contents[path] = readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
const filesByPath = new Map(files.map((file) => [file.path, file]));
const contractPaths = ${JSON.stringify(SUPPORTED_REPOSITORY_CONTRACT.requiredPaths)};
const contract = contractPaths.map((path) => {
  const file = filesByPath.get(path);
  if (file === undefined)
    throw new Error("source contract path is not a regular blob");
  return {
    path,
    mode: file.mode,
    objectId: file.objectId,
    sha256: sha256(git(["show", sourceSha + ":" + path], "buffer")),
  };
});
const dirtyPaths = git(["status", "--porcelain=v1"])
  .split("\n")
  .filter(Boolean)
  .map((line) => line.slice(3));
writeFileSync(
  appBuilder + "/canonical-clone-inspection.json",
  JSON.stringify({
    sourcePath: root,
    sourceSha,
    sourceTree,
    dirtyPaths,
    contents,
    contract,
  }),
);
console.log(JSON.stringify({ sourceSha, sourceTree, workspaceDigest: sha256(JSON.stringify(files)) }));
`;

const sandboxGitHubSourceReinspectionProgram = String.raw`
const { execFileSync, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync, lstatSync, readFileSync, realpathSync } = require("node:fs");
const { isAbsolute, resolve } = require("node:path");

const root = "/workspace/repository";
const expected = JSON.parse(process.argv[1]);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const gitArgs = [
  "-c", "protocol.allow=never",
  "-c", "credential.helper=",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-C", root,
];
const git = (args, encoding = "utf8") => execFileSync(
  "git",
  [...gitArgs, ...args],
  { encoding, maxBuffer: 32 * 1024 * 1024 },
);
const safeSourcePath = (value) =>
  value !== "" &&
  !isAbsolute(value) &&
  !value.includes("\\") &&
  !/[\r\n]/.test(value) &&
  !value.split("/").some((segment) => segment === "." || segment === "..");
const sourceSha = git(["rev-parse", "HEAD"]).trim();
const sourceTree = git(["rev-parse", sourceSha + "^{tree}"]).trim();
const remote = git(["config", "--get", "remote.origin.url"]).trim();
const resolvedRef = git(["rev-parse", expected.ref]).trim();
const symbolicRef = spawnSync(
  "git",
  [...gitArgs, "symbolic-ref", "-q", "HEAD"],
  { encoding: "utf8", maxBuffer: 1024 * 1024 },
);
if (symbolicRef.error || ![0, 1].includes(symbolicRef.status))
  throw new Error("invalid checkout state");
const detached = symbolicRef.status === 1 && symbolicRef.stdout.trim() === "";
const output = git(["ls-tree", "-rz", "--full-tree", sourceSha], "buffer");
const gitlinks = [];
const files = output
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .flatMap((entry) => {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t([^\r\n]+)$/.exec(entry);
    if (match === null) {
      const gitlink = /^160000 commit [0-9a-f]{40}\t([^\r\n]+)$/.exec(entry);
      if (gitlink !== null && safeSourcePath(gitlink[1])) {
        gitlinks.push(gitlink[1]);
        return [];
      }
      throw new Error("unsupported cloned source entry");
    }
    if (!safeSourcePath(match[3])) throw new Error("unsafe cloned source entry");
    const path = match[3];
    const file = resolve(root, path);
    const stat = lstatSync(file);
    if (
      !file.startsWith(root + "/") ||
      !stat.isFile() ||
      !realpathSync(file).startsWith(root + "/") ||
      (stat.mode & 0o777) !== (match[1] === "100755" ? 0o755 : 0o644)
    ) throw new Error("cloned source file mode or containment drifted");
    return [{
      mode: match[1],
      objectId: match[2],
      path,
      sha256: sha256(readFileSync(file)),
    }];
  });
if (files.length === 0) throw new Error("cloned source tree is empty");
const appBuilder = "/workspace/.app-builder";
const manifestMatches = readFileSync(appBuilder + "/source-files.json", "utf8") ===
  JSON.stringify(files, null, 2) + "\n";
const checksumsMatch = readFileSync(appBuilder + "/source-checksums.sha256", "utf8") ===
  files.map((file) => file.sha256 + "  repository/" + file.path).join("\n") + "\n";
const inputPaths = ${JSON.stringify(SUPPORTED_TEMPLATE_INPUT_PATHS)};
const contents = {};
for (const path of [...inputPaths, ".config/repository-template.json"]) {
  const file = resolve(root, path);
  try {
    contents[path] = readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
const filesByPath = new Map(files.map((file) => [file.path, file]));
const contractPaths = ${JSON.stringify(SUPPORTED_REPOSITORY_CONTRACT.requiredPaths)};
const contract = contractPaths.map((path) => {
  const file = filesByPath.get(path);
  if (file === undefined) throw new Error("source contract path is not a regular blob");
  return {
    path,
    mode: file.mode,
    objectId: file.objectId,
    sha256: sha256(git(["show", sourceSha + ":" + path], "buffer")),
  };
});
const dirtyPaths = git(["status", "--porcelain=v1", "--untracked-files=all"])
  .split("\n")
  .filter(Boolean)
  .map((line) => line.slice(3));
console.log(JSON.stringify({
  remote,
  resolvedRef,
  detached,
  hasGitmodules: existsSync(root + "/.gitmodules"),
  gitlinks,
  manifestMatches,
  checksumsMatch,
  workspaceDigest: sha256(JSON.stringify(files)),
  snapshot: {
    sourcePath: root,
    sourceSha,
    sourceTree,
    dirtyPaths,
    contents,
    contract,
  },
}));
`;

function sandboxGitHubSourceReinspectionCommand(input: {
  remote: string;
  branch: string;
}) {
  const expected = JSON.stringify({
    remote: parseRemote(input.remote),
    ref: `refs/remotes/origin/${parseBranch(input.branch)}`,
  });
  return `env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/dev/null XDG_CONFIG_HOME=/dev/null LANG=C.UTF-8 LC_ALL=C.UTF-8 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 GIT_NO_LAZY_FETCH=1 GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/usr/bin/false SSH_ASKPASS=/usr/bin/false GIT_LFS_SKIP_SMUDGE=1 node -e ${shellQuote(sandboxGitHubSourceReinspectionProgram)} ${shellQuote(expected)}`;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function reinspectGitHubSourceWorkspace(input: {
  sandbox: SandboxSession;
  remote: string;
  branch: string;
  expectedSha: string;
  expectedTree: string;
}): Promise<{
  snapshot: CanonicalTemplateSnapshot;
  workspace: PreparedSandboxWorkspace;
}> {
  const prepared = await inspectPreparedSandboxWorkspace(input.sandbox);
  if (prepared.state !== "prepared")
    throw new Error("The prepared GitHub source workspace is missing.");
  const storedSnapshot = await readSandboxGitHubSourceSnapshot(input.sandbox);
  if (
    storedSnapshot.sourceSha !== input.expectedSha ||
    storedSnapshot.sourceTree !== input.expectedTree
  )
    throw new Error("The stored GitHub source inspection drifted.");
  const result = await input.sandbox.run({
    command: sandboxGitHubSourceReinspectionCommand(input),
    workingDirectory: "/workspace",
    abortSignal: AbortSignal.timeout(SANDBOX_OPERATION_TIMEOUT_MS),
  });
  if (
    Buffer.byteLength(result.stdout) > SANDBOX_INSPECTION_BYTES ||
    Buffer.byteLength(result.stderr) > SANDBOX_OPERATION_OUTPUT_BYTES ||
    result.exitCode !== 0
  )
    throw new Error("The GitHub source workspace could not be verified.");
  const inspection = JSON.parse(result.stdout) as {
    remote?: unknown;
    resolvedRef?: unknown;
    detached?: unknown;
    hasGitmodules?: unknown;
    gitlinks?: unknown;
    manifestMatches?: unknown;
    checksumsMatch?: unknown;
    workspaceDigest?: unknown;
    snapshot?: unknown;
  };
  const snapshot = parseCanonicalTemplateSnapshot(inspection.snapshot);
  if (
    inspection.remote !== parseRemote(input.remote) ||
    inspection.resolvedRef !== input.expectedSha ||
    inspection.detached !== true ||
    inspection.hasGitmodules !== false ||
    !Array.isArray(inspection.gitlinks) ||
    inspection.gitlinks.length !== 0 ||
    inspection.manifestMatches !== true ||
    inspection.checksumsMatch !== true ||
    inspection.workspaceDigest !== prepared.workspace.workspaceDigest ||
    snapshot.sourceSha !== input.expectedSha ||
    snapshot.sourceTree !== input.expectedTree ||
    snapshot.dirtyPaths.length !== 0 ||
    JSON.stringify(snapshot) !== JSON.stringify(storedSnapshot)
  )
    throw new Error("The GitHub source workspace drifted.");
  return { snapshot, workspace: prepared.workspace };
}

export async function inspectGitHubSourceSandboxWorkspace(input: {
  sandbox: SandboxSession;
  receipt: SourceReceipt;
  githubSource: ImmutableGitHubSourceReceipt;
  expectedWorkspace?: PreparedSandboxWorkspace;
}): Promise<PreparedSandboxWorkspace> {
  // A sandbox checkout is deliberately writable. Inspecting it is best-effort
  // discovery for the next repository command, not a second authorization
  // boundary over source shape, file modes, receipts, or normal edits.
  const snapshot = await readSandboxGitHubSourceSnapshot(input.sandbox);
  const workspaceDigest = createHash("sha256")
    .update(`${snapshot.sourceSha}:${snapshot.sourceTree}`)
    .digest("hex");
  return {
    workspaceId: input.sandbox.id,
    workspacePath: SANDBOX_WORKSPACE,
    sourcePath: SANDBOX_WORKSPACE,
    sourceSha: snapshot.sourceSha,
    sourceTree: snapshot.sourceTree,
    workspaceDigest,
    adapter: "arrusted-development-v0",
    // Compatibility remains repository-command-owned. This value is only
    // diagnostic state retained for legacy callers, never a runtime gate.
    eligibilityDigest: workspaceDigest,
  };
}

export async function readSandboxGitHubSourceSnapshot(
  sandbox: SandboxSession,
): Promise<CanonicalTemplateSnapshot> {
  const result = await sandbox.run({
    command:
      "git -C /workspace/repository rev-parse HEAD && git -C /workspace/repository rev-parse HEAD^{tree}",
    workingDirectory: "/workspace",
  });
  if (result.exitCode !== 0)
    throw new Error(
      result.stderr.trim() || "The GitHub checkout is not available.",
    );
  const [sourceSha, sourceTree] = result.stdout.trim().split(/\s+/u);
  if (
    sourceSha === undefined ||
    sourceTree === undefined ||
    !SHA.test(sourceSha) ||
    !SHA.test(sourceTree)
  )
    throw new Error("GitHub did not return a repository revision.");
  return {
    sourcePath: SANDBOX_WORKSPACE,
    sourceSha,
    sourceTree,
    dirtyPaths: [],
    contents: {},
    contract: [],
  };
}
