import { createHash } from "node:crypto";

import type { SandboxSession } from "eve/sandbox";

import { createGitHubTokenOctokit } from "../github/octokit";
import { canAutoSelectDevelopmentSource } from "./development-source";
import { githubSandboxCredentialPolicy } from "./github-sandbox-credentials";

import {
  ARRUSTED_TEMPLATE_REF,
  ARRUSTED_TEMPLATE_REPOSITORY,
  inspectCanonicalTemplateSnapshotReceipt,
  parseCanonicalTemplateSnapshot,
  parseSourceReceipt,
  SOURCE_RECEIPT_VERSION,
  type SourceReceipt,
} from "./source-receipt";
import {
  inspectPreparedSandboxWorkspace,
  readPreparedSandboxWorkspaceRecord,
  recordPreparedSandboxWorkspace,
  SUPPORTED_TEMPLATE_INPUT_PATHS,
  type PreparedSandboxWorkspace,
} from "./supported-template";
import {
  deploymentArrustedTemplateReader,
  type ArrustedTemplateReader,
} from "./arrusted-template-reader";
import { inspectGitHubSourceSandboxWorkspace } from "./sandbox-github-source";
import type { ImmutableGitHubSourceReceipt } from "./github-publication";

const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const TEMPLATE_READINESS_CHECK = "Template readiness";
const SANDBOX_WORKSPACE = "/workspace/repository";
const SANDBOX_OPERATION_TIMEOUT_MS = 120_000;
const SANDBOX_OPERATION_OUTPUT_BYTES = 262_144;
const SANDBOX_INSPECTION_BYTES = 2 * 1024 * 1024;
const SANDBOX_CLONE_INSPECTION = ".app-builder/canonical-clone-inspection.json";
const SANDBOX_CLONE_INSPECTOR = ".arrusted-template-inspect.cjs";
const SANDBOX_REINSPECTOR = ".arrusted-template-reinspect.cjs";

export { ARRUSTED_TEMPLATE_REF, ARRUSTED_TEMPLATE_REPOSITORY };

type ClonedTemplateReceipt = Extract<SourceReceipt, { version: 4 }>;

type TemplateAcquisitionFailureStage =
  "reader" | "sandbox_clone" | "readiness" | "workspace_record";

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

function receiptReadinessDigest(input: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function classifySandboxCloneFailure(stderr: string) {
  if (
    /authentication failed|could not read username|repository not found/u.test(
      stderr,
    )
  )
    return "github-auth" as const;
  if (
    /could not resolve host|failed to connect|network is unreachable/u.test(
      stderr,
    )
  )
    return "network" as const;
  if (/timed? out|operation timeout/u.test(stderr)) return "timeout" as const;
  return "git-command" as const;
}

export function sandboxCloneFailureStage(stderr: string) {
  return stderr.match(
    /AUTOGRAPH_CLONE_STAGE=(prepare-directory|initialize|configure-remote|credential|clone|verify-remote|resolve-ref|checkout|clean-worktree|gitmodules|gitlinks|inspect)/u,
  )?.[1];
}

export function sanitizeSandboxCloneError(stderr: string, token: string) {
  return stderr
    .replaceAll(token, "[redacted]")
    .replaceAll(/https?:\/\/[^\s]+/gu, "[url]")
    .replaceAll(/[\r\n]+/gu, " ")
    .replaceAll(/[^\x20-\x7e]/gu, "?")
    .trim()
    .slice(0, 512);
}

const sandboxCloneInspectionProgram = String.raw`
process.on("uncaughtException", (error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    "AUTOGRAPH_CLONE_INSPECT_ERROR=" +
      message.replace(/[\r\n]/g, " ").slice(0, 512) +
      "\\n",
  );
  process.exit(1);
});
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

const sandboxCloneReinspectionProgram = String.raw`
const { execFileSync, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync, readFileSync } = require("node:fs");
const { isAbsolute, resolve } = require("node:path");

const root = "/workspace/repository";
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
if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error("invalid source SHA");
const sourceTree = git(["rev-parse", sourceSha + "^{tree}"]).trim();
if (!/^[0-9a-f]{40}$/.test(sourceTree)) throw new Error("invalid source tree");
const remote = git(["config", "--get", "remote.origin.url"]).trim();
const resolvedRef = git(["rev-parse", "refs/remotes/origin/main"]).trim();
const symbolicRef = spawnSync(
  "git",
  [...gitArgs, "symbolic-ref", "-q", "HEAD"],
  { encoding: "utf8", maxBuffer: 1024 * 1024 },
);
if (symbolicRef.error || ![0, 1].includes(symbolicRef.status))
  throw new Error("invalid checkout state");
const detached = symbolicRef.status === 1 && symbolicRef.stdout.trim() === "";
const output = git(["ls-tree", "-r", "-z", "--full-tree", sourceSha], "buffer");
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
    if (!file.startsWith(root + "/"))
      throw new Error("cloned source path escaped its workspace");
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
    `git -C ${SANDBOX_WORKSPACE} -c credential.helper= fetch --depth 1 --no-recurse-submodules origin ${ARRUSTED_TEMPLATE_REF}`,
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
    `if mkdir -p /workspace/.app-builder && node /workspace/${SANDBOX_CLONE_INSPECTOR} > /workspace/.app-builder/clone-inspection.stdout 2> /workspace/.app-builder/clone-inspection.stderr; then`,
    "  cat /workspace/.app-builder/clone-inspection.stdout",
    "else",
    "  status=$?",
    '  printf "AUTOGRAPH_CLONE_INSPECT_ERROR=" >&2',
    "  if [ -r /workspace/.app-builder/clone-inspection.stderr ]; then",
    '    tr "\\r\\n" "  " < /workspace/.app-builder/clone-inspection.stderr | head -c 512 >&2 || true',
    "  else",
    '    printf "inspection setup failed before stderr capture" >&2',
    "  fi",
    '  printf "\\n" >&2',
    '  exit "$status"',
    "fi",
  ].join("\n");
  return `GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 GIT_NO_LAZY_FETCH=1 GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/usr/bin/false SSH_ASKPASS=/usr/bin/false GIT_LFS_SKIP_SMUDGE=1 /bin/sh -ceu ${shellQuote(script)}`;
}

function sandboxCloneReinspectionCommand() {
  return `exec env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/dev/null XDG_CONFIG_HOME=/dev/null LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=dumb GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 GIT_NO_LAZY_FETCH=1 GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/usr/bin/false SSH_ASKPASS=/usr/bin/false GIT_LFS_SKIP_SMUDGE=1 node /workspace/${SANDBOX_REINSPECTOR}`;
}

async function readCanonicalTemplateSnapshot(sandbox: SandboxSession) {
  const raw = await sandbox.readTextFile({ path: SANDBOX_CLONE_INSPECTION });
  if (raw === null || Buffer.byteLength(raw) > SANDBOX_INSPECTION_BYTES)
    throw new Error("The canonical Arrusted workspace inspection is missing.");
  try {
    return parseCanonicalTemplateSnapshot(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new Error("The canonical Arrusted workspace inspection is invalid.", {
      cause: error,
    });
  }
}

async function cloneCanonicalArrustedWorkspace(input: {
  sandbox: SandboxSession;
  token: string;
}) {
  const existing = await inspectPreparedSandboxWorkspace(input.sandbox);
  if (existing.state === "prepared") {
    if (existing.workspace.sourcePath !== SANDBOX_WORKSPACE)
      throw new Error("This app build already owns a different workspace.");
    return {
      snapshot: await readCanonicalTemplateSnapshot(input.sandbox),
      workspaceDigest: existing.workspace.workspaceDigest,
    };
  }

  let result = { exitCode: 1, stdout: "", stderr: "" };
  try {
    await input.sandbox.writeTextFile({
      path: SANDBOX_CLONE_INSPECTOR,
      content: sandboxCloneInspectionProgram,
    });
    // This is a builder-owned working checkout. Recreate it through the
    // sandbox filesystem API so a stale file, symlink, or partial checkout
    // cannot make `mkdir -p` fail before ordinary Git initialization begins.
    await input.sandbox.removePath({
      path: "repository",
      recursive: true,
      force: true,
    });
    await input.sandbox.setNetworkPolicy(
      githubSandboxCredentialPolicy(input.token),
    );
    result = await input.sandbox.run({
      command: sandboxCloneCommand(),
      workingDirectory: "/workspace",
      env: { TERM: "dumb" },
      abortSignal: AbortSignal.timeout(SANDBOX_OPERATION_TIMEOUT_MS),
    });
    if (
      Buffer.byteLength(result.stdout) > SANDBOX_OPERATION_OUTPUT_BYTES ||
      Buffer.byteLength(result.stderr) > SANDBOX_OPERATION_OUTPUT_BYTES ||
      result.exitCode !== 0
    ) {
      console.warn(
        JSON.stringify({
          event: "autograph.template-clone-command.failed",
          category: classifySandboxCloneFailure(result.stderr.toLowerCase()),
          exitCode: result.exitCode,
          outputWithinLimit:
            Buffer.byteLength(result.stdout) <=
              SANDBOX_OPERATION_OUTPUT_BYTES &&
            Buffer.byteLength(result.stderr) <= SANDBOX_OPERATION_OUTPUT_BYTES,
          errorSummary: sanitizeSandboxCloneError(result.stderr, input.token),
        }),
      );
      throw new Error(
        "The canonical Arrusted workspace clone could not be prepared.",
      );
    }
  } finally {
    try {
      const cleanup = await Promise.allSettled(
        [SANDBOX_CLONE_INSPECTOR].map((path) =>
          input.sandbox.removePath({ path, force: true }),
        ),
      );
      const failures = cleanup.filter((result) => result.status === "rejected");
      if (failures.length > 0)
        throw new AggregateError(failures, "Sandbox clone cleanup failed.");
    } finally {
      await input.sandbox.setNetworkPolicy("deny-all");
    }
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
    throw new Error(
      "The canonical Arrusted workspace clone receipt is invalid.",
    );
  }
  const workspaceDigest = observation.workspaceDigest;
  if (
    typeof observation.sourceSha !== "string" ||
    !SHA.test(observation.sourceSha) ||
    typeof observation.sourceTree !== "string" ||
    !SHA.test(observation.sourceTree) ||
    typeof workspaceDigest !== "string" ||
    !DIGEST.test(workspaceDigest)
  )
    throw new Error("The canonical Arrusted workspace clone drifted.");
  const snapshot = await readCanonicalTemplateSnapshot(input.sandbox);
  if (
    snapshot.sourceSha !== observation.sourceSha ||
    snapshot.sourceTree !== observation.sourceTree ||
    snapshot.dirtyPaths.length !== 0
  )
    throw new Error("The canonical Arrusted workspace clone drifted.");
  return { snapshot, workspaceDigest };
}

/**
 * The fresh-template transport: exactly one detached clone, directly in the
 * session workspace. Its closed inspection snapshot produces the V4 receipt
 * and the same checkout is sealed for later target commands.
 */
export async function acquireCanonicalArrustedTemplate(input: {
  sandbox: SandboxSession;
  callId: string;
  reader?: ArrustedTemplateReader;
}): Promise<SourceReceipt> {
  const reader = input.reader ?? deploymentArrustedTemplateReader();
  const access = await acquisitionStage("reader", () => reader.acquire());
  const cloned = await acquisitionStage("sandbox_clone", () =>
    cloneCanonicalArrustedWorkspace({
      sandbox: input.sandbox,
      token: access.token,
    }),
  );
  const readinessDigest = await acquisitionStage("readiness", () =>
    templateReadinessAttestationDigest({
      sha: cloned.snapshot.sourceSha,
      tree: cloned.snapshot.sourceTree,
      token: access.token,
    }),
  );
  const receipt = inspectCanonicalTemplateSnapshotReceipt({
    snapshot: cloned.snapshot,
    readinessDigest,
  });
  if (
    receipt.sourcePath !== SANDBOX_WORKSPACE ||
    receipt.sourceSha !== cloned.snapshot.sourceSha ||
    receipt.sourceTree !== cloned.snapshot.sourceTree
  )
    throw new Error("Canonical Arrusted workspace receipt drifted.");
  await acquisitionStage("workspace_record", () =>
    recordPreparedSandboxWorkspace({
      sandbox: input.sandbox,
      callId: input.callId,
      sourcePath: SANDBOX_WORKSPACE,
      sourceSha: receipt.sourceSha,
      sourceTree: receipt.sourceTree,
      eligibilityDigest: receipt.eligibilityDigest,
      workspaceDigest: cloned.workspaceDigest,
    }),
  );
  return receipt;
}

/** Re-inspect the already-cloned workspace without fetching or cloning. */
export async function inspectCanonicalArrustedSandboxWorkspace(input: {
  sandbox: SandboxSession;
  receipt: ClonedTemplateReceipt;
}) {
  let receipt: ClonedTemplateReceipt;
  try {
    const parsed = parseSourceReceipt(input.receipt);
    if (parsed.version !== 4) throw new Error("not a cloned receipt");
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
  )
    throw new Error("Canonical Arrusted clone receipt is invalid.");
  const observed = await readPreparedSandboxWorkspaceRecord(input.sandbox);
  if (observed === undefined)
    throw new Error("The canonical Arrusted workspace is missing.");
  if (
    observed.workspaceId !== input.sandbox.id ||
    observed.sourcePath !== SANDBOX_WORKSPACE ||
    observed.sourceSha !== receipt.sourceSha ||
    observed.sourceTree !== receipt.sourceTree ||
    observed.eligibilityDigest !== receipt.eligibilityDigest
  )
    throw new Error("The canonical Arrusted workspace drifted.");
  let result;
  try {
    await input.sandbox.writeTextFile({
      path: SANDBOX_REINSPECTOR,
      content: sandboxCloneReinspectionProgram,
    });
    result = await input.sandbox.run({
      command: sandboxCloneReinspectionCommand(),
      workingDirectory: "/workspace",
      env: { TERM: "dumb" },
      abortSignal: AbortSignal.timeout(SANDBOX_OPERATION_TIMEOUT_MS),
    });
  } finally {
    await input.sandbox.removePath({
      path: SANDBOX_REINSPECTOR,
      force: true,
    });
  }
  if (
    Buffer.byteLength(result.stdout) > SANDBOX_INSPECTION_BYTES ||
    Buffer.byteLength(result.stderr) > SANDBOX_OPERATION_OUTPUT_BYTES ||
    result.exitCode !== 0
  )
    throw new Error("The canonical Arrusted workspace could not be verified.");
  let inspection: {
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
  try {
    inspection = JSON.parse(result.stdout) as typeof inspection;
  } catch (error) {
    throw new Error("The canonical Arrusted workspace receipt is invalid.", {
      cause: error,
    });
  }
  const snapshot = parseCanonicalTemplateSnapshot(inspection.snapshot);
  if (
    inspection.remote !== ARRUSTED_TEMPLATE_REPOSITORY ||
    inspection.resolvedRef !== receipt.sourceSha ||
    inspection.detached !== true ||
    inspection.hasGitmodules !== false ||
    !Array.isArray(inspection.gitlinks) ||
    inspection.gitlinks.length !== 0 ||
    inspection.manifestMatches !== true ||
    inspection.checksumsMatch !== true ||
    inspection.workspaceDigest !== observed.workspaceDigest ||
    snapshot.sourceSha !== receipt.sourceSha ||
    snapshot.sourceTree !== receipt.sourceTree ||
    snapshot.dirtyPaths.length !== 0
  )
    throw new Error("The canonical Arrusted workspace drifted.");
  const currentReceipt = inspectCanonicalTemplateSnapshotReceipt({
    snapshot,
    readinessDigest: receipt.provenance.readinessDigest,
  });
  if (currentReceipt.digest !== receipt.digest)
    throw new Error("The canonical Arrusted source changed after review.");
  return observed;
}

/**
 * Re-inspect the active source workspace. Development uses the writable live
 * workspace as current planning input; hosted release adapters retain their
 * closed receipt checks until the moving-source policy reaches those paths.
 */
export async function inspectSourceBoundSandboxWorkspace(input: {
  sandbox: SandboxSession;
  receipt: SourceReceipt;
  expectedWorkspace?: PreparedSandboxWorkspace;
  githubSource?: ImmutableGitHubSourceReceipt;
}): Promise<PreparedSandboxWorkspace> {
  if (canAutoSelectDevelopmentSource()) {
    const status = await inspectPreparedSandboxWorkspace(
      input.sandbox,
      "development-live",
    );
    if (status.state !== "prepared")
      throw new Error("The prepared development workspace is missing.");
    const observed = status.workspace;
    if (observed.workspaceId !== input.sandbox.id)
      throw new Error(
        "The prepared development workspace does not match the active workflow.",
      );
    return observed;
  }
  const receipt = parseSourceReceipt(input.receipt);
  const observed =
    input.githubSource !== undefined
      ? await inspectGitHubSourceSandboxWorkspace({
          sandbox: input.sandbox,
          receipt,
          githubSource: input.githubSource,
          ...(input.expectedWorkspace === undefined
            ? {}
            : { expectedWorkspace: input.expectedWorkspace }),
        })
      : receipt.version === SOURCE_RECEIPT_VERSION
        ? await inspectCanonicalArrustedSandboxWorkspace({
            sandbox: input.sandbox,
            receipt,
          })
        : await inspectPreparedSandboxWorkspace(input.sandbox).then(
            (status) => {
              if (status.state !== "prepared")
                throw new Error("The prepared source workspace is missing.");
              return status.workspace;
            },
          );
  if (
    observed.workspaceId !== input.sandbox.id ||
    observed.sourcePath !== receipt.sourcePath ||
    observed.sourceSha !== receipt.sourceSha ||
    observed.sourceTree !== receipt.sourceTree ||
    observed.eligibilityDigest !== receipt.eligibilityDigest ||
    (input.expectedWorkspace !== undefined &&
      JSON.stringify(observed) !== JSON.stringify(input.expectedWorkspace))
  )
    throw new Error(
      "The prepared workspace no longer matches its durable source receipt.",
    );
  return observed;
}

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
      token: input.token,
      fetch: input.fetch,
    }).request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
      owner: "withAutograph",
      repo: "arrusted-development",
      ref: sha,
      per_page: 100,
    });
    body = response.data;
  } catch {
    throw new Error("Template-readiness evidence is unavailable.");
  }
  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as { check_runs?: unknown }).check_runs)
  )
    throw new Error("Template-readiness evidence is invalid.");
  const checks = (body as { check_runs: unknown[] }).check_runs;
  const readiness = checks
    .filter(
      (check): check is Record<string, unknown> =>
        typeof check === "object" &&
        check !== null &&
        !Array.isArray(check) &&
        (check as Record<string, unknown>)["name"] ===
          TEMPLATE_READINESS_CHECK &&
        (check as Record<string, unknown>)["head_sha"] === sha,
    )
    .toSorted((left, right) => Number(right.id) - Number(left.id))[0];
  if (
    readiness === undefined ||
    readiness.status !== "completed" ||
    readiness.conclusion !== "success" ||
    typeof readiness.id !== "number" ||
    !Number.isSafeInteger(readiness.id) ||
    readiness.id <= 0 ||
    typeof readiness.completed_at !== "string" ||
    !Number.isFinite(Date.parse(readiness.completed_at))
  )
    throw new Error(
      "The resolved Arrusted commit has no successful template-readiness evidence.",
    );
  return receiptReadinessDigest({
    version: 1,
    repository: ARRUSTED_TEMPLATE_REPOSITORY,
    ref: ARRUSTED_TEMPLATE_REF,
    sha,
    tree,
    check: {
      id: readiness.id,
      name: TEMPLATE_READINESS_CHECK,
      completedAt: readiness.completed_at,
      conclusion: readiness.conclusion,
    },
  });
}
