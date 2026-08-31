import { createHash } from "node:crypto";

import type { SandboxSession } from "eve/sandbox";

import {
  ARRUSTED_TEMPLATE_REF,
  ARRUSTED_TEMPLATE_REPOSITORY,
  inspectCanonicalTemplateSnapshotReceipt,
  parseCanonicalTemplateSnapshot,
  type SourceReceipt,
} from "./source-receipt";
import {
  inspectPreparedSandboxWorkspace,
  recordPreparedSandboxWorkspace,
} from "./supported-template";

const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const TEMPLATE_READINESS_CHECK = "Template readiness";
const SANDBOX_WORKSPACE = "/workspace/repository";
const SANDBOX_OPERATION_TIMEOUT_MS = 120_000;
const SANDBOX_OPERATION_OUTPUT_BYTES = 262_144;
const SANDBOX_INSPECTION_BYTES = 2 * 1024 * 1024;
const SANDBOX_CLONE_HOSTS = ["github.com"] as const;
const SANDBOX_CLONE_INSPECTION = ".app-builder/canonical-clone-inspection.json";

export { ARRUSTED_TEMPLATE_REF, ARRUSTED_TEMPLATE_REPOSITORY };

type ClonedTemplateReceipt = Extract<SourceReceipt, { version: 4 }>;

function receiptReadinessDigest(input: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const sandboxCloneInspectionProgram = String.raw`
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
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
const output = git(["ls-tree", "-rz", "--full-tree", sourceSha], "buffer");
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
const inputPaths = [
  ".config/mise/config.toml",
  ".github/workflows/cd.yml",
  "microfrontends.json",
  ".config/mise/scripts/repository/app-contract.ts",
  ".config/mise/scripts/repository/app-identity.ts",
  ".config/mise/scripts/repository/app-validation.ts",
  ".config/mise/scripts/repository/repository-preflight.ts",
  ".config/turbo/generators/config.ts",
  ".config/turbo/generators/create-app.ts",
  ".config/turbo/generators/templates/app/next.config.ts.hbs",
];
const contents = {};
for (const path of [...inputPaths, ".config/repository-template.json"]) {
  const file = resolve(root, path);
  if (existsSync(file)) contents[path] = readFileSync(file, "utf8");
}
const contract = inputPaths.map((path) => {
  const entry = git(["ls-tree", sourceSha, "--", path]);
  const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t(.+)$/.exec(entry.trim());
  if (match === null || match[3] !== path)
    throw new Error("canonical template contract path is not a regular blob");
  return {
    path,
    mode: match[1],
    objectId: match[2],
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

function sandboxCloneCommand() {
  const remote = shellQuote(ARRUSTED_TEMPLATE_REPOSITORY);
  const script = [
    "set -eu",
    `rm -rf ${SANDBOX_WORKSPACE}`,
    `git -c protocol.allow=never -c protocol.https.allow=always -c credential.helper= -c core.hooksPath=/dev/null -c core.fsmonitor=false clone --no-checkout --no-recurse-submodules --single-branch --branch main ${remote} ${SANDBOX_WORKSPACE}`,
    `test "$(git -C ${SANDBOX_WORKSPACE} config --get remote.origin.url)" = ${remote}`,
    `resolved_sha="$(git -C ${SANDBOX_WORKSPACE} rev-parse refs/remotes/origin/main)"`,
    `git -C ${SANDBOX_WORKSPACE} checkout --detach --quiet "$resolved_sha"`,
    `test -z "$(git -C ${SANDBOX_WORKSPACE} status --porcelain=v1)"`,
    `test ! -e ${SANDBOX_WORKSPACE}/.gitmodules`,
    `! git -C ${SANDBOX_WORKSPACE} ls-tree -r --full-tree "$resolved_sha" | awk '$1 == "160000" { found = 1 } END { exit !found }'`,
    `node -e ${shellQuote(sandboxCloneInspectionProgram)}`,
  ].join("\n");
  return `env -i PATH=/usr/bin:/bin HOME=/dev/null XDG_CONFIG_HOME=/dev/null LANG=C.UTF-8 LC_ALL=C.UTF-8 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 GIT_NO_LAZY_FETCH=1 GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/usr/bin/false SSH_ASKPASS=/usr/bin/false GIT_LFS_SKIP_SMUDGE=1 /bin/sh -ceu ${shellQuote(script)}`;
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

  await input.sandbox.setNetworkPolicy({ allow: [...SANDBOX_CLONE_HOSTS] });
  let result;
  try {
    result = await input.sandbox.run({
      command: sandboxCloneCommand(),
      workingDirectory: "/workspace",
      abortSignal: AbortSignal.timeout(SANDBOX_OPERATION_TIMEOUT_MS),
    });
  } finally {
    await input.sandbox.setNetworkPolicy("deny-all");
  }
  if (
    Buffer.byteLength(result.stdout) > SANDBOX_OPERATION_OUTPUT_BYTES ||
    Buffer.byteLength(result.stderr) > SANDBOX_OPERATION_OUTPUT_BYTES ||
    result.exitCode !== 0
  )
    throw new Error(
      "The canonical Arrusted workspace clone could not be prepared.",
    );
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
}): Promise<SourceReceipt> {
  const cloned = await cloneCanonicalArrustedWorkspace(input);
  const readinessDigest = await templateReadinessAttestationDigest(
    cloned.snapshot.sourceSha,
    cloned.snapshot.sourceTree,
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
  await recordPreparedSandboxWorkspace({
    sandbox: input.sandbox,
    callId: input.callId,
    sourcePath: SANDBOX_WORKSPACE,
    sourceSha: receipt.sourceSha,
    sourceTree: receipt.sourceTree,
    eligibilityDigest: receipt.eligibilityDigest,
    workspaceDigest: cloned.workspaceDigest,
  });
  return receipt;
}

/** Re-inspect the already-cloned workspace without fetching or cloning. */
export async function inspectCanonicalArrustedSandboxWorkspace(input: {
  sandbox: SandboxSession;
  receipt: ClonedTemplateReceipt;
}) {
  if (
    input.receipt.sourcePath !== SANDBOX_WORKSPACE ||
    input.receipt.provenance.repository !== ARRUSTED_TEMPLATE_REPOSITORY ||
    input.receipt.provenance.ref !== ARRUSTED_TEMPLATE_REF ||
    !SHA.test(input.receipt.sourceSha) ||
    !SHA.test(input.receipt.sourceTree) ||
    !DIGEST.test(input.receipt.eligibilityDigest) ||
    !DIGEST.test(input.receipt.provenance.readinessDigest)
  )
    throw new Error("Canonical Arrusted clone receipt is invalid.");
  const prepared = await inspectPreparedSandboxWorkspace(input.sandbox);
  if (prepared.state !== "prepared")
    throw new Error("The canonical Arrusted workspace is missing.");
  const observed = prepared.workspace;
  if (
    observed.workspaceId !== input.sandbox.id ||
    observed.sourcePath !== SANDBOX_WORKSPACE ||
    observed.sourceSha !== input.receipt.sourceSha ||
    observed.sourceTree !== input.receipt.sourceTree ||
    observed.eligibilityDigest !== input.receipt.eligibilityDigest
  )
    throw new Error("The canonical Arrusted workspace drifted.");
  const receipt = inspectCanonicalTemplateSnapshotReceipt({
    snapshot: await readCanonicalTemplateSnapshot(input.sandbox),
    readinessDigest: input.receipt.provenance.readinessDigest,
  });
  if (receipt.digest !== input.receipt.digest)
    throw new Error("The canonical Arrusted source changed after review.");
  return observed;
}

export async function templateReadinessAttestationDigest(
  sha: string,
  tree: string,
) {
  const response = await fetch(
    `https://api.github.com/repos/withAutograph/arrusted-development/commits/${sha}/check-runs?per_page=100`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Autograph-App-Builder",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok)
    throw new Error("Template-readiness evidence is unavailable.");
  const body: unknown = await response.json();
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
        (check as Record<string, unknown>)["name"] === TEMPLATE_READINESS_CHECK,
    )
    .toSorted((left, right) =>
      String(right.started_at ?? "").localeCompare(
        String(left.started_at ?? ""),
      ),
    )[0];
  if (
    readiness === undefined ||
    readiness.status !== "completed" ||
    readiness.conclusion !== "success" ||
    typeof readiness.id !== "number" ||
    !Number.isSafeInteger(readiness.id) ||
    typeof readiness.completed_at !== "string"
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
