import { createHash } from "node:crypto";

import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";

import type { CanonicalTemplateSnapshot } from "./source-receipt";
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

const sandboxFailureDetail = (value: string): string =>
  value
    .replaceAll(/https?:\/\/[^\s]+/giu, "[URL REDACTED]")
    .replaceAll(/Bearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replaceAll(
      /\b(?:gh[oprsu]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/gu,
      "[REDACTED]",
    )
    .replaceAll(
      /\b(?<key>authorization|cookie|password|passwd|secret|token|api[-_]?key)\s*[:=]\s*[^\s,;]+/giu,
      "$<key>=[REDACTED]",
    )
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, 350);

const sandboxCommandFailure = (
  operation: string,
  result: { exitCode: number; stderr: string; stdout: string },
  recovery: string,
): Error => {
  const detail = sandboxFailureDetail(`${result.stderr}\n${result.stdout}`);
  return new Error(
    `Builder could not ${operation} (exit ${result.exitCode}). ${recovery} Cause: ${detail || "The sandbox command returned no diagnostic output."}`,
  );
};

const runSourceSandboxCommand = async (
  sandbox: SandboxSession,
  operation: string,
  command: string,
) => {
  try {
    return await sandbox.run({ command, workingDirectory: "/workspace" });
  } catch (error) {
    const cause = sandboxFailureDetail(error instanceof Error ? error.message : String(error));
    throw new Error(
      `Builder could not ${operation} in the sandbox. Check the sandbox connection and checkout, then retry this session. Cause: ${cause || "The sandbox provider returned no diagnostic output."}`,
      { cause: error },
    );
  }
};

const shellQuote = function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
};

const parseRemote = function parseRemote(input: string) {
  let remote: URL;
  try {
    remote = new URL(input);
  } catch {
    throw new Error(
      "The GitHub source remote is invalid. Select a GitHub repository with an HTTPS clone URL, then retry.",
    );
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
    throw new Error(
      "The GitHub source remote is invalid. Select a GitHub repository with an HTTPS clone URL, then retry.",
    );
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

const checkoutInspectionCommand = (path: string) =>
  `git -C ${shellQuote(path)} rev-parse HEAD && git -C ${shellQuote(path)} rev-parse HEAD^{tree} && git -C ${shellQuote(path)} remote get-url origin`;

const inspectSelectedCheckout = (
  stdout: string,
  expected: { repository: string; sourceSha?: string; sourceTree?: string },
) => {
  const [sourceSha, sourceTree, remote] = stdout.trim().split(/\s+/u);
  if (
    sourceSha === undefined ||
    sourceTree === undefined ||
    remote === undefined ||
    !SHA.test(sourceSha) ||
    !SHA.test(sourceTree)
  ) {
    throw new Error(
      "The selected GitHub checkout inspection did not return a commit and tree revision. Check that the provider created a complete Git checkout, then retry this session.",
    );
  }
  if (
    parseRemote(remote) !== parseRemote(expected.repository) ||
    (expected.sourceSha !== undefined && sourceSha !== expected.sourceSha) ||
    (expected.sourceTree !== undefined && sourceTree !== expected.sourceTree)
  ) {
    throw new Error(
      `The sandbox checkout does not match the selected GitHub source. Expected ${parseRemote(expected.repository)}${expected.sourceSha === undefined ? "" : ` at ${expected.sourceSha}`}; observed ${parseRemote(remote)} at ${sourceSha}. Select the intended repository or start a new Builder session for this checkout.`,
    );
  }
  return { sourceSha, sourceTree };
};

const findProviderCheckout = async (
  sandbox: SandboxSession,
  expected: { repository: string; sourceSha?: string; sourceTree?: string },
  paths: readonly string[],
): Promise<string> => {
  const failures: string[] = [];
  for (const candidate of paths) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- inspect provider locations in order.
    const result = await runSourceSandboxCommand(
      sandbox,
      `inspect the provider checkout at ${candidate}`,
      checkoutInspectionCommand(candidate),
    );
    if (result.exitCode === 0) {
      inspectSelectedCheckout(result.stdout, expected);
      return candidate;
    }
    failures.push(
      `${candidate}: ${sandboxFailureDetail(result.stderr || result.stdout) || `exit ${result.exitCode} with no diagnostic output`}`,
    );
  }
  throw new Error(
    `Vercel did not materialize the selected GitHub source in either provider location. Check the selected repository access and sandbox source configuration, then retry this session. Observed: ${failures.join(" | ")}`,
  );
};

export const readSandboxGitHubSourceSnapshot = async function readSandboxGitHubSourceSnapshot(
  sandbox: SandboxSession,
  expected: { repository: string; sourceSha?: string; sourceTree?: string },
): Promise<CanonicalTemplateSnapshot> {
  const canonical = await runSourceSandboxCommand(
    sandbox,
    "inspect the Builder checkout",
    checkoutInspectionCommand(SANDBOX_WORKSPACE),
  );
  let observed: ReturnType<typeof inspectSelectedCheckout>;
  if (canonical.exitCode === 0) {
    // Provider file uploads cannot traverse a linked checkout. An older
    // session may still have the previous link layout; leave it untouched.
    const linked = await runSourceSandboxCommand(
      sandbox,
      "inspect the Builder checkout layout",
      `test -L ${shellQuote(SANDBOX_WORKSPACE)}`,
    );
    if (linked.exitCode === 0) {
      throw new Error(
        "The selected GitHub checkout uses a linked workspace. Start a new Builder session.",
      );
    }
    observed = inspectSelectedCheckout(canonical.stdout, expected);
  } else {
    // Never replace an occupied workspace, even if it is not a valid Git
    // checkout. Vercel's Git source lives below its own working directory.
    const occupied = await runSourceSandboxCommand(
      sandbox,
      "check whether the Builder checkout is occupied",
      `test -e ${shellQuote(SANDBOX_WORKSPACE)} || test -L ${shellQuote(SANDBOX_WORKSPACE)}`,
    );
    if (occupied.exitCode === 0) {
      throw sandboxCommandFailure(
        "use the selected GitHub checkout because /workspace/repository is occupied by a non-Git directory",
        canonical,
        "Use the existing session bound to this workspace, or start a new Builder session; Builder will not replace the occupied directory.",
      );
    }
    const repositoryName = new URL(parseRemote(expected.repository)).pathname.split("/").at(-1);
    if (repositoryName === undefined) {
      throw new Error("The GitHub source remote is invalid.");
    }
    // The Eve image places Vercel's Git source below /workspace. The
    // standard Vercel image uses its working-directory root instead.
    const providerPaths = [`/workspace/${repositoryName.slice(0, -4)}`, "/vercel/sandbox"];
    const providerCheckout = await findProviderCheckout(sandbox, expected, providerPaths);
    // Keep the provider's one checkout, but put that directory at the
    // canonical working path. The sandbox file API rejects writes through a
    // symlink even when Git and shell reads through it succeed.
    const moved = await runSourceSandboxCommand(
      sandbox,
      "place the provider checkout in the Builder workspace",
      `node -e ${shellQuote('require("node:fs").renameSync(process.argv[1], process.argv[2])')} ${shellQuote(providerCheckout)} ${shellQuote(SANDBOX_WORKSPACE)}`,
    );
    const placed = await runSourceSandboxCommand(
      sandbox,
      "inspect the placed Builder checkout",
      checkoutInspectionCommand(SANDBOX_WORKSPACE),
    );
    if (placed.exitCode !== 0) {
      throw sandboxCommandFailure(
        moved.exitCode === 0
          ? "inspect the selected GitHub checkout after moving it into /workspace/repository"
          : "place the selected GitHub checkout in /workspace/repository",
        moved.exitCode === 0 ? placed : moved,
        "Check workspace permissions and the provider-created checkout, then retry this session.",
      );
    }
    observed = inspectSelectedCheckout(placed.stdout, expected);
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
  let result: Awaited<ReturnType<SandboxSession["run"]>>;
  try {
    result = await sandbox.run({
      abortSignal: AbortSignal.timeout(SANDBOX_OPERATION_TIMEOUT_MS),
      command: `env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/dev/null XDG_CONFIG_HOME=/dev/null LANG=C.UTF-8 LC_ALL=C.UTF-8 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 GIT_NO_LAZY_FETCH=1 GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/usr/bin/false SSH_ASKPASS=/usr/bin/false GIT_LFS_SKIP_SMUDGE=1 node -e ${shellQuote(sandboxGitHubSourceManifestProgram(SANDBOX_WORKSPACE, "/workspace/.app-builder"))}`,
      workingDirectory: "/workspace",
    });
  } catch (error) {
    const cause = sandboxFailureDetail(error instanceof Error ? error.message : String(error));
    throw new Error(
      `Builder could not run selected-source manifest generation in the sandbox. Check that the sandbox, Git, and Node are available, then retry this session. Cause: ${cause || "The sandbox provider returned no diagnostic output."}`,
      { cause: error },
    );
  }
  if (result.exitCode !== 0) {
    throw sandboxCommandFailure(
      "prepare the selected GitHub source manifest",
      result,
      "Check that Git and Node can read the selected checkout and that the sandbox has enough space, then retry this session.",
    );
  }
  if (
    Buffer.byteLength(result.stdout) > SANDBOX_INSPECTION_BYTES ||
    Buffer.byteLength(result.stderr) > SANDBOX_OPERATION_OUTPUT_BYTES
  ) {
    throw new Error(
      `Builder could not save the selected GitHub source manifest: command output exceeded its limit (${Buffer.byteLength(result.stdout)} stdout bytes, ${Buffer.byteLength(result.stderr)} stderr bytes). Inspect the checkout for unexpectedly large generated content or verbose tool output, then retry.`,
    );
  }
  let observation: unknown;
  try {
    observation = JSON.parse(result.stdout) as unknown;
  } catch (error) {
    throw new Error(
      `The selected GitHub source manifest is not valid JSON. Cause: ${sandboxFailureDetail(error instanceof Error ? error.message : String(error))} Check the manifest command output, then retry this session.`,
      { cause: error },
    );
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
    throw new Error(
      `The selected GitHub source manifest is missing a valid digest or no longer matches checkout revision ${expected.sourceSha}. Re-observe the current checkout and regenerate its manifest, then retry.`,
    );
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
    githubSource: ImmutableGitHubSourceReceipt;
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
