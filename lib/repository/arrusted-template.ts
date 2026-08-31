import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type { SandboxSession } from "eve/sandbox";

import {
  ARRUSTED_TEMPLATE_REF,
  ARRUSTED_TEMPLATE_REPOSITORY,
  inspectClonedTemplateSourceReceipt,
  type SourceReceipt,
} from "./source-receipt";
import {
  inspectPreparedSandboxWorkspace,
  recordPreparedSandboxWorkspace,
} from "./supported-template";

const execFileAsync = promisify(execFile);
const git = existsSync("/usr/bin/git") ? "/usr/bin/git" : "/bin/git";
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const TEMPLATE_READINESS_CHECK = "Template readiness";
const SANDBOX_WORKSPACE = "/workspace/repository";
const SANDBOX_OPERATION_TIMEOUT_MS = 120_000;
const SANDBOX_OPERATION_OUTPUT_BYTES = 262_144;
const SANDBOX_CLONE_HOSTS = ["github.com"] as const;

export { ARRUSTED_TEMPLATE_REF, ARRUSTED_TEMPLATE_REPOSITORY };

export type ArrustedTemplateClone = {
  receipt: SourceReceipt;
  dispose(): Promise<void>;
};

type ClonedTemplateReceipt = Extract<SourceReceipt, { version: 4 }>;

function environment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: process.env.NODE_ENV ?? "production",
    PATH: "/usr/bin:/bin",
    HOME: "/dev/null",
    XDG_CONFIG_HOME: "/dev/null",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false",
  };
}

async function command(args: readonly string[], cwd?: string) {
  return execFileAsync(
    git,
    [
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.https.allow=always",
      "-c",
      "credential.helper=",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      ...args,
    ],
    { cwd, env: environment(), encoding: "utf8", timeout: 60_000 },
  );
}

function receiptReadinessDigest(input: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const sandboxManifestProgram = String.raw`
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { isAbsolute, resolve } = require("node:path");

const root = "/workspace/repository";
const sourceSha = process.argv[1];
if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error("invalid source SHA");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const safeSourcePath = (value) =>
  value !== "" &&
  !isAbsolute(value) &&
  !value.includes("\\") &&
  !/[\r\n]/.test(value) &&
  !value.split("/").some((segment) => segment === "." || segment === "..");
const output = execFileSync(
  "git",
  ["-C", root, "ls-tree", "-rz", "--full-tree", sourceSha],
  { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
);
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
const sourceTree = execFileSync(
  "git",
  ["-C", root, "rev-parse", sourceSha + "^{tree}"],
  { encoding: "utf8" },
).trim();
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
console.log(JSON.stringify({ sourceTree, workspaceDigest: sha256(JSON.stringify(files)) }));
`;

function sandboxCloneCommand(receipt: ClonedTemplateReceipt) {
  const sourceSha = shellQuote(receipt.sourceSha);
  const sourceTree = shellQuote(receipt.sourceTree);
  const remote = shellQuote(receipt.provenance.repository);
  const ref = shellQuote(receipt.provenance.ref);
  const script = [
    "set -eu",
    `rm -rf ${SANDBOX_WORKSPACE}`,
    `git -c protocol.allow=never -c protocol.https.allow=always -c credential.helper= -c core.hooksPath=/dev/null -c core.fsmonitor=false clone --no-checkout --no-recurse-submodules --single-branch --branch main ${remote} ${SANDBOX_WORKSPACE}`,
    `test "$(git -C ${SANDBOX_WORKSPACE} config --get remote.origin.url)" = ${remote}`,
    `git -c protocol.allow=never -c protocol.https.allow=always -c credential.helper= -c core.hooksPath=/dev/null -c core.fsmonitor=false -C ${SANDBOX_WORKSPACE} fetch --no-tags origin ${ref}`,
    `resolved_sha="$(git -C ${SANDBOX_WORKSPACE} rev-parse FETCH_HEAD)"`,
    `test "$resolved_sha" = ${sourceSha}`,
    `git -C ${SANDBOX_WORKSPACE} checkout --detach --quiet "$resolved_sha"`,
    `test "$(git -C ${SANDBOX_WORKSPACE} rev-parse "$resolved_sha^{tree}")" = ${sourceTree}`,
    `test -z "$(git -C ${SANDBOX_WORKSPACE} status --porcelain=v1)"`,
    `test ! -e ${SANDBOX_WORKSPACE}/.gitmodules`,
    `! git -C ${SANDBOX_WORKSPACE} ls-tree -r --full-tree "$resolved_sha" | awk '$1 == "160000" { found = 1 } END { exit !found }'`,
    `node -e ${shellQuote(sandboxManifestProgram)} ${sourceSha}`,
  ].join("\n");
  return `env -i PATH=/usr/bin:/bin HOME=/dev/null XDG_CONFIG_HOME=/dev/null LANG=C.UTF-8 LC_ALL=C.UTF-8 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 GIT_NO_LAZY_FETCH=1 GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/usr/bin/false SSH_ASKPASS=/usr/bin/false GIT_LFS_SKIP_SMUDGE=1 /bin/sh -ceu ${shellQuote(script)}`;
}

/**
 * Re-clones the already admitted canonical source directly into the session
 * workspace.  The earlier host clone resolves readiness and source receipt;
 * this independent checkout proves that target commands run in the pinned
 * detached clone rather than a reconstructed archive.
 */
export async function prepareCanonicalArrustedSandboxWorkspace(input: {
  sandbox: SandboxSession;
  receipt: ClonedTemplateReceipt;
  callId: string;
}) {
  const existing = await inspectPreparedSandboxWorkspace(input.sandbox);
  if (existing.state === "prepared") {
    const workspace = existing.workspace;
    if (
      workspace.workspaceId !== input.sandbox.id ||
      workspace.sourcePath !== SANDBOX_WORKSPACE ||
      workspace.sourceSha !== input.receipt.sourceSha ||
      workspace.sourceTree !== input.receipt.sourceTree ||
      workspace.eligibilityDigest !== input.receipt.eligibilityDigest
    )
      throw new Error("This app build already owns a different workspace.");
    return workspace;
  }
  if (
    input.receipt.provenance.repository !== ARRUSTED_TEMPLATE_REPOSITORY ||
    input.receipt.provenance.ref !== ARRUSTED_TEMPLATE_REF ||
    !SHA.test(input.receipt.sourceSha) ||
    !SHA.test(input.receipt.sourceTree) ||
    !DIGEST.test(input.receipt.eligibilityDigest) ||
    !DIGEST.test(input.receipt.provenance.readinessDigest)
  )
    throw new Error("Canonical Arrusted clone receipt is invalid.");

  await input.sandbox.setNetworkPolicy({ allow: [...SANDBOX_CLONE_HOSTS] });
  let result;
  try {
    result = await input.sandbox.run({
      command: sandboxCloneCommand(input.receipt),
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
  let observation: { sourceTree?: unknown; workspaceDigest?: unknown };
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
    observation.sourceTree !== input.receipt.sourceTree ||
    typeof workspaceDigest !== "string" ||
    !DIGEST.test(workspaceDigest)
  )
    throw new Error("The canonical Arrusted workspace clone drifted.");
  return recordPreparedSandboxWorkspace({
    sandbox: input.sandbox,
    callId: input.callId,
    sourcePath: SANDBOX_WORKSPACE,
    sourceSha: input.receipt.sourceSha,
    sourceTree: input.receipt.sourceTree,
    eligibilityDigest: input.receipt.eligibilityDigest,
    workspaceDigest,
  });
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

/**
 * The only runtime template transport. The remote and ref are constants rather
 * than tool input, and the returned checkout has no credentials or inherited
 * host Git configuration.
 */
export async function cloneArrustedTemplate(
  root = join(tmpdir(), "autograph-app-builder-template"),
): Promise<ArrustedTemplateClone> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const parent = await realpath(resolve(root));
  const checkout = await mkdtemp(join(parent, "clone-"));
  try {
    await command([
      "clone",
      "--no-checkout",
      "--no-recurse-submodules",
      "--single-branch",
      "--branch",
      "main",
      ARRUSTED_TEMPLATE_REPOSITORY,
      checkout,
    ]);
    const origin = (
      await command(["-C", checkout, "config", "--get", "remote.origin.url"])
    ).stdout.trim();
    if (origin !== ARRUSTED_TEMPLATE_REPOSITORY)
      throw new Error("Canonical Arrusted template origin drifted.");
    await command([
      "-C",
      checkout,
      "fetch",
      "--no-tags",
      "origin",
      ARRUSTED_TEMPLATE_REF,
    ]);
    const sha = (
      await command(["-C", checkout, "rev-parse", "FETCH_HEAD"])
    ).stdout.trim();
    if (!SHA.test(sha))
      throw new Error("Canonical Arrusted template ref is invalid.");
    await command(["-C", checkout, "checkout", "--detach", "--quiet", sha]);
    const tree = (
      await command(["-C", checkout, "rev-parse", `${sha}^{tree}`])
    ).stdout.trim();
    if (!SHA.test(tree))
      throw new Error("Canonical Arrusted template tree is invalid.");
    if (
      (await command(["-C", checkout, "status", "--porcelain=v1"])).stdout !==
      ""
    )
      throw new Error("Canonical Arrusted template clone is not clean.");
    if (existsSync(join(checkout, ".gitmodules")))
      throw new Error("Canonical Arrusted template contains submodules.");
    const readinessDigest = await templateReadinessAttestationDigest(sha, tree);
    const receipt = await inspectClonedTemplateSourceReceipt({
      path: checkout,
      readinessDigest,
    });
    if (receipt.sourceSha !== sha || receipt.sourceTree !== tree)
      throw new Error("Canonical Arrusted template receipt drifted.");
    return {
      receipt,
      dispose: () => rm(checkout, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(checkout, { recursive: true, force: true });
    throw error;
  }
}
