import { createHash } from "node:crypto";

import type { SandboxSession } from "eve/sandbox";

import { createGitHubTokenOctokit } from "../github/octokit";
import { canAutoSelectDevelopmentSource } from "./development-source";

import {
  ARRUSTED_TEMPLATE_REF,
  ARRUSTED_TEMPLATE_REPOSITORY,
  inspectCanonicalTemplateSnapshotReceipt,
  parseCanonicalTemplateSnapshot,
  parseSourceReceipt,
  SOURCE_RECEIPT_VERSION,
} from "./source-receipt";
import type { SourceReceipt } from "./source-receipt";
import {
  inspectPreparedSandboxWorkspace,
  readPreparedSandboxWorkspaceRecord,
  recordPreparedSandboxWorkspace,
  SUPPORTED_TEMPLATE_INPUT_PATHS,
} from "./supported-template";
import type { PreparedSandboxWorkspace } from "./supported-template";
import { deploymentArrustedTemplateReader } from "./arrusted-template-reader";
import type { ArrustedTemplateReader } from "./arrusted-template-reader";
import {
  inspectGitHubSourceSandboxWorkspace,
  readSandboxGitHubSourceSnapshot,
} from "./sandbox-github-source";
import type { ImmutableGitHubSourceReceipt } from "./github-publication";
import { configureVercelSessionGitSource } from "../sandbox/vercel-session-source";

const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const TEMPLATE_READINESS_CHECK = "Template readiness";
const SANDBOX_WORKSPACE = "/workspace/repository";
const SANDBOX_CLONE_INSPECTION = ".app-builder/canonical-clone-inspection.json";
const SANDBOX_CLONE_INSPECTOR = ".arrusted-template-inspect.cjs";

export { ARRUSTED_TEMPLATE_REF, ARRUSTED_TEMPLATE_REPOSITORY } from "./source-receipt";

type ClonedTemplateReceipt = Extract<SourceReceipt, { version: 4 }>;

type TemplateAcquisitionFailureStage =
  | "reader"
  | "sandbox_clone"
  | "readiness"
  | "workspace_record";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function acquisitionStage<T>(
  stage: TemplateAcquisitionFailureStage,
  operation: () => Promise<T>,
) {
  try {
    return await operation();
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "autograph.template-acquisition.failed",
        stage,
      }),
    );
    throw error;
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function receiptReadinessDigest(input: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function classifySandboxCloneFailure(stderr: string) {
  if (/authentication failed|could not read username|repository not found/u.test(stderr)) {
    return "github-auth" as const;
  }
  if (/could not resolve host|failed to connect|network is unreachable/u.test(stderr)) {
    return "network" as const;
  }
  if (/timed? out|operation timeout/u.test(stderr)) {
    return "timeout" as const;
  }
  return "git-command" as const;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function sandboxCloneFailureStage(stderr: string) {
  return stderr.match(
    /AUTOGRAPH_CLONE_STAGE=(?<stage>prepare-directory|initialize|configure-remote|credential|clone|verify-remote|resolve-ref|checkout|clean-worktree|gitmodules|gitlinks|inspect)/u,
  )?.[1];
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function sanitizeSandboxCloneError(stderr: string, token: string) {
  const sanitized = stderr
    .replaceAll(token, "[redacted]")
    .replaceAll(/https?:\/\/[^\s]+/gu, "[url]")
    .replaceAll(/[\r\n]+/gu, " ")
    .replaceAll(/[^\u0020-\u007E]/gu, "?")
    .trim();
  return sanitized;
}

const sandboxCloneInspectionProgram = String.raw`
process.on("uncaughtException", (error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    "AUTOGRAPH_CLONE_INSPECT_ERROR=" +
      message.replace(/[\r\n]/g, " ") +
      "\\n",
  );
  process.exit(1);
});
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { isAbsolute, join, resolve } = require("node:path");

const root = "/workspace/repository";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sha256File = (path) => {
  const descriptor = openSync(path, "r");
  const chunk = Buffer.alloc(64 * 1024);
  const hash = createHash("sha256");
  try {
    for (;;) {
      const length = readSync(descriptor, chunk, 0, chunk.length, null);
      if (length === 0) break;
      hash.update(chunk.subarray(0, length));
    }
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
};
const readNulRecords = (path) => {
  const descriptor = openSync(path, "r");
  const chunk = Buffer.alloc(64 * 1024);
  const records = [];
  let pending = Buffer.alloc(0);
  try {
    for (;;) {
      const length = readSync(descriptor, chunk, 0, chunk.length, null);
      if (length === 0) break;
      const bytes = pending.length === 0 ? chunk.subarray(0, length) : Buffer.concat([pending, chunk.subarray(0, length)]);
      let start = 0;
      for (let index = bytes.indexOf(0); index !== -1; index = bytes.indexOf(0, start)) {
        records.push(bytes.subarray(start, index).toString("utf-8"));
        start = index + 1;
      }
      pending = Buffer.from(bytes.subarray(start));
    }
    if (pending.length > 0) throw new Error("incomplete Git tree record");
    return records;
  } finally {
    closeSync(descriptor);
  }
};
const git = (args, encoding = "utf-8") => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "app-builder-source-git-"));
  const outputPath = join(outputDirectory, "stdout");
  const outputDescriptor = openSync(outputPath, "w");
  try {
    execFileSync(
      "git",
      [
    "-c", "protocol.allow=never",
    "-c", "credential.helper=",
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-C", root,
        ...args,
      ],
      { encoding: "buffer", stdio: ["ignore", outputDescriptor, "inherit"] },
    );
    if (encoding === "records") return readNulRecords(outputPath);
    const output = readFileSync(outputPath);
    return encoding === "buffer" ? output : output.toString("utf-8");
  } finally {
    closeSync(outputDescriptor);
    rmSync(outputDirectory, { force: true, recursive: true });
  }
};
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
const files = git(["ls-tree", "-r", "-z", "--full-tree", sourceSha], "records")
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
      sha256: sha256File(file),
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
    contents[path] = readFileSync(file, "utf-8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
const filesByPath = new Map(files.map((file) => [file.path, file]));
const contract = inputPaths.map((path) => {
  const file = filesByPath.get(path);
  if (file === undefined)
    throw new Error("canonical template contract path is not a regular blob");
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

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function sandboxCloneCommand() {
  const script = [
    "set -eu",
    'echo "AUTOGRAPH_CLONE_STAGE=prepare-directory" >&2',
    `mkdir -p ${SANDBOX_WORKSPACE}`,
    'echo "AUTOGRAPH_CLONE_STAGE=initialize" >&2',
    `git -C ${SANDBOX_WORKSPACE} init --quiet`,
    'echo "AUTOGRAPH_CLONE_STAGE=configure-remote" >&2',
    `git -C ${SANDBOX_WORKSPACE} remote add origin ${ARRUSTED_TEMPLATE_REPOSITORY}`,
    'echo "AUTOGRAPH_CLONE_STAGE=clone" >&2',
    `git -C ${SANDBOX_WORKSPACE} -c credential.helper= fetch --quiet --depth 1 --no-recurse-submodules origin ${ARRUSTED_TEMPLATE_REF}`,
    'echo "AUTOGRAPH_CLONE_STAGE=resolve-ref" >&2',
    `resolved_sha="$(git -C ${SANDBOX_WORKSPACE} rev-parse FETCH_HEAD)"`,
    'echo "AUTOGRAPH_CLONE_STAGE=checkout" >&2',
    `git -C ${SANDBOX_WORKSPACE} checkout --detach --quiet "$resolved_sha"`,
    'echo "AUTOGRAPH_CLONE_STAGE=clean-worktree" >&2',
    `test -z "$(git -C ${SANDBOX_WORKSPACE} status --porcelain=v1)"`,
    'echo "AUTOGRAPH_CLONE_STAGE=gitmodules" >&2',
    `test ! -e ${SANDBOX_WORKSPACE}/.gitmodules`,
    'echo "AUTOGRAPH_CLONE_STAGE=gitlinks" >&2',
    `! git -C ${SANDBOX_WORKSPACE} ls-tree -r --full-tree "$resolved_sha" | awk '$1 == "160000" { found = 1 } END { exit !found }'`,
    'echo "AUTOGRAPH_CLONE_STAGE=inspect" >&2',
    `if node /workspace/${SANDBOX_CLONE_INSPECTOR}; then`,
    "  :",
    "else",
    "  status=$?",
    '  printf "AUTOGRAPH_CLONE_INSPECTION_COMMAND_FAILED\\n" >&2',
    '  exit "$status"',
    "fi",
  ].join("\n");
  return `GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 GIT_NO_LAZY_FETCH=1 GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/usr/bin/false SSH_ASKPASS=/usr/bin/false GIT_LFS_SKIP_SMUDGE=1 /bin/sh -ceu ${shellQuote(script)}`;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function readCanonicalTemplateSnapshot(sandbox: SandboxSession) {
  const raw = await sandbox.readTextFile({ path: SANDBOX_CLONE_INSPECTION });
  if (raw === null) {
    throw new Error("The canonical Arrusted workspace inspection is missing.");
  }
  try {
    return parseCanonicalTemplateSnapshot(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new Error("The canonical Arrusted workspace inspection is invalid.", {
      cause: error,
    });
  }
}

// Legacy clone implementation retained only while callers finish moving to
// the direct Vercel source API.
// eslint-disable-next-line @typescript-eslint/no-unused-vars, eslint/func-style
async function cloneCanonicalArrustedWorkspace(input: { sandbox: SandboxSession; token: string }) {
  const existing = await inspectPreparedSandboxWorkspace(input.sandbox);
  if (existing.state === "prepared") {
    if (existing.workspace.sourcePath !== SANDBOX_WORKSPACE) {
      throw new Error("This app build already owns a different workspace.");
    }
    return {
      snapshot: await readCanonicalTemplateSnapshot(input.sandbox),
      workspaceDigest: existing.workspace.workspaceDigest,
    };
  }

  let result = { exitCode: 1, stderr: "", stdout: "" };
  let cloneError: unknown;
  try {
    await input.sandbox.writeTextFile({
      content: sandboxCloneInspectionProgram,
      path: SANDBOX_CLONE_INSPECTOR,
    });
    // This is a builder-owned working checkout. Recreate it through the
    // sandbox filesystem API so a stale file, symlink, or partial checkout
    // cannot make `mkdir -p` fail before ordinary Git initialization begins.
    await input.sandbox.removePath({
      force: true,
      path: "repository",
      recursive: true,
    });
    await input.sandbox.setNetworkPolicy("allow-all");
    result = await input.sandbox.run({
      command: sandboxCloneCommand(),
      env: { TERM: "dumb" },
      workingDirectory: "/workspace",
    });
    // A provider-side command status is not a source-identity boundary. The
    // receipt below is the productive observation: it must still parse and
    // bind the checked-out commit/tree and declared template contract. Vercel
    // Sandbox can report a nonzero terminal status after a command has
    // completed and written that receipt, so do not discard valid work solely
    // because of that auxiliary status.
  } catch (error) {
    cloneError = error;
  }
  const cleanup = await Promise.allSettled(
    [SANDBOX_CLONE_INSPECTOR].map((path) => input.sandbox.removePath({ force: true, path })),
  );
  const failures = cleanup.filter((cleanupResult) => cleanupResult.status === "rejected");
  if (failures.length > 0) {
    throw new AggregateError(failures, "Sandbox clone cleanup failed.");
  }
  if (cloneError !== undefined) {
    throw cloneError;
  }
  let observation: {
    sourceSha?: unknown;
    sourceTree?: unknown;
    workspaceDigest?: unknown;
  };
  try {
    observation = JSON.parse(result.stdout) as {
      sourceTree?: unknown;
      workspaceDigest?: unknown;
    };
  } catch {
    if (result.exitCode !== 0) {
      throw new Error("The canonical Arrusted workspace clone could not be prepared.");
    }
    throw new Error("The canonical Arrusted workspace clone receipt is invalid.");
  }
  const { workspaceDigest } = observation;
  if (
    typeof observation.sourceSha !== "string" ||
    !SHA.test(observation.sourceSha) ||
    typeof observation.sourceTree !== "string" ||
    !SHA.test(observation.sourceTree) ||
    typeof workspaceDigest !== "string" ||
    !DIGEST.test(workspaceDigest)
  ) {
    throw new Error("The canonical Arrusted workspace clone drifted.");
  }
  const snapshot = await readCanonicalTemplateSnapshot(input.sandbox);
  if (
    snapshot.sourceSha !== observation.sourceSha ||
    snapshot.sourceTree !== observation.sourceTree ||
    snapshot.dirtyPaths.length !== 0
  ) {
    throw new Error("The canonical Arrusted workspace clone drifted.");
  }
  return { snapshot, workspaceDigest };
}

/**
 * The fresh-template transport: exactly one detached clone, directly in the
 * session workspace. Its closed inspection snapshot produces the V4 receipt
 * and the same checkout is sealed for later target commands.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function acquireCanonicalArrustedTemplate(input: {
  sandbox: SandboxSession | (() => Promise<SandboxSession>);
  sessionId?: string;
  callId: string;
  reader?: ArrustedTemplateReader;
}): Promise<SourceReceipt> {
  const reader = input.reader ?? deploymentArrustedTemplateReader();
  const access = await acquisitionStage("reader", () => reader.acquire());
  if (typeof input.sandbox === "function") {
    if (input.sessionId === undefined) {
      throw new Error("The App Builder session is unavailable.");
    }
    configureVercelSessionGitSource({
      sessionId: input.sessionId,
      source: { token: access.token, url: ARRUSTED_TEMPLATE_REPOSITORY },
    });
  }
  const sandbox = typeof input.sandbox === "function" ? await input.sandbox() : input.sandbox;
  const snapshot = await acquisitionStage("sandbox_clone", () =>
    readSandboxGitHubSourceSnapshot(sandbox, {
      repository: ARRUSTED_TEMPLATE_REPOSITORY,
    }),
  );
  const workspaceDigest = receiptReadinessDigest({
    sourceSha: snapshot.sourceSha,
    sourceTree: snapshot.sourceTree,
  });
  const receipt = inspectCanonicalTemplateSnapshotReceipt({
    readinessDigest: workspaceDigest,
    snapshot,
  });
  await acquisitionStage("workspace_record", () =>
    recordPreparedSandboxWorkspace({
      callId: input.callId,
      eligibilityDigest: receipt.eligibilityDigest,
      sandbox,
      sourcePath: SANDBOX_WORKSPACE,
      sourceSha: receipt.sourceSha,
      sourceTree: receipt.sourceTree,
      workspaceDigest,
    }),
  );
  return receipt;
}

/** Re-inspect the already-cloned workspace without fetching or cloning. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function inspectCanonicalArrustedSandboxWorkspace(input: {
  sandbox: SandboxSession;
  receipt: ClonedTemplateReceipt;
}) {
  let receipt: ClonedTemplateReceipt;
  try {
    const parsed = parseSourceReceipt(input.receipt);
    if (parsed.version !== 4) {
      throw new Error("not a cloned receipt");
    }
    receipt = parsed;
  } catch (error) {
    throw new Error("Canonical Arrusted clone receipt is invalid.", {
      cause: error,
    });
  }
  if (
    receipt.sourcePath !== SANDBOX_WORKSPACE ||
    receipt.provenance.repository !== ARRUSTED_TEMPLATE_REPOSITORY ||
    receipt.provenance.ref !== ARRUSTED_TEMPLATE_REF ||
    !SHA.test(receipt.sourceSha) ||
    !SHA.test(receipt.sourceTree) ||
    !DIGEST.test(receipt.eligibilityDigest) ||
    !DIGEST.test(receipt.provenance.readinessDigest)
  ) {
    throw new Error("Canonical Arrusted clone receipt is invalid.");
  }
  const observed = await readPreparedSandboxWorkspaceRecord(input.sandbox);
  if (observed === undefined) {
    throw new Error("The canonical Arrusted workspace is missing.");
  }
  if (
    observed.workspaceId !== input.sandbox.id ||
    observed.sourcePath !== SANDBOX_WORKSPACE ||
    observed.sourceSha !== receipt.sourceSha ||
    observed.sourceTree !== receipt.sourceTree ||
    observed.eligibilityDigest !== receipt.eligibilityDigest
  ) {
    throw new Error("The canonical Arrusted workspace drifted.");
  }
  return observed;
}

/**
 * Re-inspect the active source workspace. Development uses the writable live
 * workspace as current planning input; hosted release adapters retain their
 * closed receipt checks until the moving-source policy reaches those paths.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function inspectSourceBoundSandboxWorkspace(input: {
  sandbox: SandboxSession;
  receipt: SourceReceipt;
  expectedWorkspace?: PreparedSandboxWorkspace;
  githubSource?: ImmutableGitHubSourceReceipt;
}): Promise<PreparedSandboxWorkspace> {
  if (canAutoSelectDevelopmentSource()) {
    const status = await inspectPreparedSandboxWorkspace(input.sandbox, "development-live");
    if (status.state !== "prepared") {
      throw new Error("The prepared development workspace is missing.");
    }
    const observed = status.workspace;
    if (observed.workspaceId !== input.sandbox.id) {
      throw new Error("The prepared development workspace does not match the active workflow.");
    }
    return observed;
  }
  if (input.githubSource !== undefined) {
    // The selected repository stays bound to this session, while its checkout
    // is normal writable planning input. Re-observe that checkout on every
    // call instead of comparing it with the source-selection snapshot.
    return await inspectGitHubSourceSandboxWorkspace({
      githubSource: input.githubSource,
      sandbox: input.sandbox,
    });
  }
  const receipt = parseSourceReceipt(input.receipt);
  let observed: PreparedSandboxWorkspace;
  if (receipt.version === SOURCE_RECEIPT_VERSION) {
    observed = await inspectCanonicalArrustedSandboxWorkspace({
      receipt,
      sandbox: input.sandbox,
    });
  } else {
    const status = await inspectPreparedSandboxWorkspace(input.sandbox);
    if (status.state !== "prepared") {
      throw new Error("The prepared source workspace is missing.");
    }
    observed = status.workspace;
  }
  if (
    observed.workspaceId !== input.sandbox.id ||
    observed.sourcePath !== receipt.sourcePath ||
    observed.sourceSha !== receipt.sourceSha ||
    observed.sourceTree !== receipt.sourceTree ||
    observed.eligibilityDigest !== receipt.eligibilityDigest ||
    (input.expectedWorkspace !== undefined &&
      JSON.stringify(observed) !== JSON.stringify(input.expectedWorkspace))
  ) {
    throw new Error("The prepared workspace no longer matches its durable source receipt.");
  }
  return observed;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function templateReadinessAttestationDigest(input: {
  sha: string;
  tree: string;
  token: string;
  fetch?: typeof fetch;
}) {
  const { sha, tree } = input;
  let body: unknown;
  try {
    const response = await createGitHubTokenOctokit({
      fetch: input.fetch,
      token: input.token,
    }).request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
      owner: "withAutograph",
      per_page: 100,
      ref: sha,
      repo: "arrusted-development",
    });
    body = response.data;
  } catch {
    throw new Error("Template-readiness evidence is unavailable.");
  }
  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as { check_runs?: unknown }).check_runs)
  ) {
    throw new Error("Template-readiness evidence is invalid.");
  }
  const checks = (body as { check_runs: unknown[] }).check_runs;
  const [readiness] = checks
    .filter(
      (check): check is Record<string, unknown> =>
        typeof check === "object" &&
        check !== null &&
        !Array.isArray(check) &&
        (check as Record<string, unknown>)["name"] === TEMPLATE_READINESS_CHECK &&
        (check as Record<string, unknown>)["head_sha"] === sha,
    )
    .toSorted((left, right) => Number(right.id) - Number(left.id));
  if (
    readiness === undefined ||
    readiness.status !== "completed" ||
    readiness.conclusion !== "success" ||
    typeof readiness.id !== "number" ||
    !Number.isSafeInteger(readiness.id) ||
    readiness.id <= 0 ||
    typeof readiness.completed_at !== "string" ||
    !Number.isFinite(Date.parse(readiness.completed_at))
  ) {
    throw new Error("The resolved Arrusted commit has no successful template-readiness evidence.");
  }
  return receiptReadinessDigest({
    check: {
      completedAt: readiness.completed_at,
      conclusion: readiness.conclusion,
      id: readiness.id,
      name: TEMPLATE_READINESS_CHECK,
    },
    ref: ARRUSTED_TEMPLATE_REF,
    repository: ARRUSTED_TEMPLATE_REPOSITORY,
    sha,
    tree,
    version: 1,
  });
}
