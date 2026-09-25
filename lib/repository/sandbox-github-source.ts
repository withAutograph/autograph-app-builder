import { createHash } from "node:crypto";

import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";

import type { CanonicalTemplateSnapshot, SourceReceipt } from "./source-receipt";
import {
  inspectPreparedSandboxWorkspace,
  SUPPORTED_REPOSITORY_CONTRACT,
  SUPPORTED_TEMPLATE_INPUT_PATHS,
} from "./supported-template";
import type { PreparedSandboxWorkspace } from "./supported-template";
import { parseCanonicalTemplateSnapshot } from "./source-receipt";
import type { ImmutableGitHubSourceReceipt } from "./github-publication";

const SHA = /^[0-9a-f]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}$/u;
const BRANCH =
  /^(?![./])(?!.*(?:\.\.|@\{))(?!.*(?:[/.]|\.lock)$)[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u;
const SANDBOX_WORKSPACE = "/workspace/repository";
const SANDBOX_OPERATION_TIMEOUT_MS = 120_000;
const SANDBOX_OPERATION_OUTPUT_BYTES = 262_144;
const SANDBOX_INSPECTION_BYTES = 2 * 1024 * 1024;
export const SANDBOX_GITHUB_SOURCE_INSPECTION = ".app-builder/canonical-clone-inspection.json";

const shellQuote = function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
};

const parseRemote = function parseRemote(input: string) {
  let remote: URL;
  try {
    remote = new URL(input);
  } catch {
    throw new Error("The GitHub source remote is invalid.");
  }
  const match = /^\/(?<owner>[A-Za-z0-9_.-]{1,100})\/(?<repo>[A-Za-z0-9_.-]{1,100})\.git$/u.exec(
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
  ) {
    throw new Error("The GitHub source remote is invalid.");
  }
  return remote.toString();
};

const parseBranch = function parseBranch(input: string) {
  if (!BRANCH.test(input) || input.split("/").some((part) => part.startsWith("."))) {
    throw new Error("The GitHub source branch is invalid.");
  }
  return input;
};

export const sandboxGitHubSourceManifestProgram = (
  rootPath: string,
  manifestDirectory: string,
) => String.raw`
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } = require("node:fs");
const { isAbsolute, resolve } = require("node:path");

const root = ${JSON.stringify(rootPath)};
const actualRoot = realpathSync(root);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const git = (args, encoding = "utf-8") => execFileSync(
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
  .toString("utf-8")
  .split("\0")
  .filter(Boolean)
  .flatMap((entry) => {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t([^\r\n]+)$/.exec(entry);
    if (match === null) {
      if (/^(120000 blob|160000 commit) [0-9a-f]{40}\t[^\r\n]+$/.test(entry)) return [];
      throw new Error("unsupported cloned source entry");
    }
    if (!safeSourcePath(match[3])) throw new Error("unsafe cloned source entry");
    const path = match[3];
    const file = resolve(root, path);
    if (
      !file.startsWith(root + "/") ||
      !lstatSync(file).isFile() ||
      !realpathSync(file).startsWith(actualRoot + "/")
    )
      throw new Error("cloned source path escaped its workspace");
    return [{
      mode: match[1],
      objectId: match[2],
      path,
      sha256: sha256(readFileSync(file)),
    }];
  });
if (files.length === 0) throw new Error("cloned source tree is empty");
const appBuilder = ${JSON.stringify(manifestDirectory)};
mkdirSync(appBuilder, { recursive: true });
writeFileSync(
  appBuilder + "/source-files.json",
  JSON.stringify(files, null, 2) + "\n",
);
writeFileSync(
  appBuilder + "/source-checksums.sha256",
  files.map((file) => file.sha256 + "  repository/" + file.path).join("\n") + "\n",
);
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
    contents: {},
    contract: [],
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
const git = (args, encoding = "utf-8") => execFileSync(
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
  { encoding: "utf-8", maxBuffer: 1024 * 1024 },
);
if (symbolicRef.error || ![0, 1].includes(symbolicRef.status))
  throw new Error("invalid checkout state");
const detached = symbolicRef.status === 1 && symbolicRef.stdout.trim() === "";
const output = git(["ls-tree", "-rz", "--full-tree", sourceSha], "buffer");
const gitlinks = [];
const files = output
  .toString("utf-8")
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
const manifestMatches = readFileSync(appBuilder + "/source-files.json", "utf-8") ===
  JSON.stringify(files, null, 2) + "\n";
const checksumsMatch = readFileSync(appBuilder + "/source-checksums.sha256", "utf-8") ===
  files.map((file) => file.sha256 + "  repository/" + file.path).join("\n") + "\n";
const inputPaths = ${JSON.stringify(SUPPORTED_TEMPLATE_INPUT_PATHS)};
const contents = {};
for (const path of [...inputPaths, ".config/repository-template.json"]) {
  const file = resolve(root, path);
  try {
    contents[path] = readFileSync(file, "utf-8");
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

const sandboxGitHubSourceReinspectionCommand =
  function sandboxGitHubSourceReinspectionCommand(input: { remote: string; branch: string }) {
    const expected = JSON.stringify({
      ref: `refs/remotes/origin/${parseBranch(input.branch)}`,
      remote: parseRemote(input.remote),
    });
    return `env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/dev/null XDG_CONFIG_HOME=/dev/null LANG=C.UTF-8 LC_ALL=C.UTF-8 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 GIT_NO_LAZY_FETCH=1 GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/usr/bin/false SSH_ASKPASS=/usr/bin/false GIT_LFS_SKIP_SMUDGE=1 node -e ${shellQuote(sandboxGitHubSourceReinspectionProgram)} ${shellQuote(expected)}`;
  };

export const readSandboxGitHubSourceSnapshot = async function readSandboxGitHubSourceSnapshot(
  sandbox: SandboxSession,
  expected: { repository: string; sourceSha?: string; sourceTree?: string },
): Promise<CanonicalTemplateSnapshot> {
  const checkoutCommand = (path: string) =>
    `git -C ${shellQuote(path)} rev-parse HEAD && git -C ${shellQuote(path)} rev-parse HEAD^{tree} && git -C ${shellQuote(path)} remote get-url origin`;
  const inspect = (stdout: string) => {
    const [sourceSha, sourceTree, remote] = stdout.trim().split(/\s+/u);
    if (
      sourceSha === undefined ||
      sourceTree === undefined ||
      remote === undefined ||
      !SHA.test(sourceSha) ||
      !SHA.test(sourceTree)
    ) {
      throw new Error("GitHub did not return a repository revision.");
    }
    if (
      parseRemote(remote) !== parseRemote(expected.repository) ||
      (expected.sourceSha !== undefined && sourceSha !== expected.sourceSha) ||
      (expected.sourceTree !== undefined && sourceTree !== expected.sourceTree)
    ) {
      throw new Error("The sandbox checkout does not match the selected GitHub source.");
    }
    return { sourceSha, sourceTree };
  };
  const canonical = await sandbox.run({
    command: checkoutCommand(SANDBOX_WORKSPACE),
    workingDirectory: "/workspace",
  });
  let observed: ReturnType<typeof inspect>;
  if (canonical.exitCode === 0) {
    observed = inspect(canonical.stdout);
  } else {
    // Never replace an occupied workspace, even if it is not a valid Git
    // checkout. Vercel's Git source lives below its own working directory.
    const occupied = await sandbox.run({
      command: `test -e ${shellQuote(SANDBOX_WORKSPACE)} || test -L ${shellQuote(SANDBOX_WORKSPACE)}`,
      workingDirectory: "/workspace",
    });
    if (occupied.exitCode === 0) {
      throw new Error("The selected GitHub checkout is not available.");
    }
    const repositoryName = new URL(parseRemote(expected.repository)).pathname.split("/").at(-1);
    if (repositoryName === undefined) {
      throw new Error("The GitHub source remote is invalid.");
    }
    // The Eve image places Vercel's Git source below /workspace. The
    // standard Vercel image uses its working-directory root instead.
    const providerPaths = [`/workspace/${repositoryName.slice(0, -4)}`, "/vercel/sandbox"];
    let providerCheckout: { path: string; observation: ReturnType<typeof inspect> } | undefined;
    for (const candidate of providerPaths) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- inspect provider locations in order.
      const result = await sandbox.run({
        command: checkoutCommand(candidate),
        workingDirectory: "/workspace",
      });
      if (result.exitCode === 0) {
        providerCheckout = { observation: inspect(result.stdout), path: candidate };
        break;
      }
    }
    if (providerCheckout === undefined) {
      throw new Error("Vercel did not materialize the selected GitHub source.");
    }
    observed = providerCheckout.observation;
    const linked = await sandbox.run({
      command: `mkdir -p /workspace && ln -s -- ${shellQuote(providerCheckout.path)} ${shellQuote(SANDBOX_WORKSPACE)}`,
      workingDirectory: "/workspace",
    });
    if (linked.exitCode !== 0) {
      const concurrent = await sandbox.run({
        command: checkoutCommand(SANDBOX_WORKSPACE),
        workingDirectory: "/workspace",
      });
      if (concurrent.exitCode !== 0) {
        throw new Error("The selected GitHub checkout is not available.");
      }
      observed = inspect(concurrent.stdout);
    }
  }
  return {
    contents: {},
    contract: [],
    dirtyPaths: [],
    sourcePath: SANDBOX_WORKSPACE,
    sourceSha: observed.sourceSha,
    sourceTree: observed.sourceTree,
  };
};

/** Record the provider checkout's regular tracked files for app inspection and dependency setup. */
export const writeSandboxGitHubSourceManifest = async function writeSandboxGitHubSourceManifest(
  sandbox: SandboxSession,
  expected: { sourceSha: string; sourceTree: string },
): Promise<string> {
  const result = await sandbox.run({
    abortSignal: AbortSignal.timeout(SANDBOX_OPERATION_TIMEOUT_MS),
    command: `env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/dev/null XDG_CONFIG_HOME=/dev/null LANG=C.UTF-8 LC_ALL=C.UTF-8 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 GIT_NO_LAZY_FETCH=1 GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/usr/bin/false SSH_ASKPASS=/usr/bin/false GIT_LFS_SKIP_SMUDGE=1 node -e ${shellQuote(sandboxGitHubSourceManifestProgram(SANDBOX_WORKSPACE, "/workspace/.app-builder"))}`,
    workingDirectory: "/workspace",
  });
  if (
    result.exitCode !== 0 ||
    Buffer.byteLength(result.stdout) > SANDBOX_INSPECTION_BYTES ||
    Buffer.byteLength(result.stderr) > SANDBOX_OPERATION_OUTPUT_BYTES
  ) {
    throw new Error("The selected GitHub source manifest could not be prepared.");
  }
  let observation: unknown;
  try {
    observation = JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error("The selected GitHub source manifest is invalid.");
  }
  const parsed = z
    .strictObject({
      sourceSha: z.string().regex(SHA),
      sourceTree: z.string().regex(SHA),
      workspaceDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    })
    .safeParse(observation);
  if (
    !parsed.success ||
    parsed.data.sourceSha !== expected.sourceSha ||
    parsed.data.sourceTree !== expected.sourceTree
  ) {
    throw new Error("The selected GitHub source manifest does not match its revision.");
  }
  return parsed.data.workspaceDigest;
};

// Kept temporarily for stored receipt parsing while the legacy inspection
// writer is removed from the active source path.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const reinspectGitHubSourceWorkspace = async function reinspectGitHubSourceWorkspace(input: {
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
  if (prepared.state !== "prepared") {
    throw new Error("The prepared GitHub source workspace is missing.");
  }
  const storedSnapshot = await readSandboxGitHubSourceSnapshot(input.sandbox, {
    repository: input.remote,
    sourceSha: input.expectedSha,
    sourceTree: input.expectedTree,
  });
  if (
    storedSnapshot.sourceSha !== input.expectedSha ||
    storedSnapshot.sourceTree !== input.expectedTree
  ) {
    throw new Error("The stored GitHub source inspection drifted.");
  }
  const result = await input.sandbox.run({
    abortSignal: AbortSignal.timeout(SANDBOX_OPERATION_TIMEOUT_MS),
    command: sandboxGitHubSourceReinspectionCommand(input),
    workingDirectory: "/workspace",
  });
  if (
    Buffer.byteLength(result.stdout) > SANDBOX_INSPECTION_BYTES ||
    Buffer.byteLength(result.stderr) > SANDBOX_OPERATION_OUTPUT_BYTES ||
    result.exitCode !== 0
  ) {
    throw new Error("The GitHub source workspace could not be verified.");
  }
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
  ) {
    throw new Error("The GitHub source workspace drifted.");
  }
  return { snapshot, workspace: prepared.workspace };
};

export const inspectGitHubSourceSandboxWorkspace =
  async function inspectGitHubSourceSandboxWorkspace(input: {
    sandbox: SandboxSession;
    receipt: SourceReceipt;
    githubSource: ImmutableGitHubSourceReceipt;
    expectedWorkspace?: PreparedSandboxWorkspace;
  }): Promise<PreparedSandboxWorkspace> {
    // A sandbox checkout is deliberately writable. Inspecting it is best-effort
    // discovery for the next repository command, not a second authorization
    // boundary over source shape, file modes, receipts, or normal edits.
    const snapshot = await readSandboxGitHubSourceSnapshot(input.sandbox, {
      repository: `https://github.com/${input.githubSource.repository.owner}/${input.githubSource.repository.name}.git`,
    });
    const workspaceDigest = createHash("sha256")
      .update(`${snapshot.sourceSha}:${snapshot.sourceTree}`)
      .digest("hex");
    return {
      adapter: "arrusted-development-v0",
      // Compatibility remains repository-command-owned. This value is only
      // diagnostic state retained for legacy callers, never a runtime gate.
      eligibilityDigest: workspaceDigest,
      sourcePath: SANDBOX_WORKSPACE,
      sourceSha: snapshot.sourceSha,
      sourceTree: snapshot.sourceTree,
      workspaceDigest,
      workspaceId: input.sandbox.id,
      workspacePath: SANDBOX_WORKSPACE,
    };
  };
