import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { delimiter, isAbsolute, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import type { SandboxSession } from "eve/sandbox";
import { parse as parseYaml } from "yaml";

import { ensureSandboxDirectories } from "./sandbox-filesystem";
import { safeSourcePath } from "./source-path";
import { hasTestCapability } from "../testing/test-capability";

export const SUPPORTED_TEMPLATE_ADAPTER = "arrusted-development-v0";

export const SUPPORTED_TEMPLATE_INPUT_PATHS = [
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
] as const;

/**
 * Closed repository-owned dependency set for the non-executing source
 * inspection entrypoint. Node built-ins are platform inputs; package.json,
 * pnpm-lock.yaml, and the mise lock bind all external packages and tools.
 */
export const SUPPORTED_TEMPLATE_DEPENDENCY_PATHS = [
  ".config/mise/config.toml",
  ".config/mise/mise.lock",
  ".config/mise/scripts/trusted-node-launcher",
  ".config/mise/tasks/source/inspect",
  "lib/repository/sandbox-filesystem.ts",
  "lib/repository/source-path.ts",
  "lib/repository/source-receipt.ts",
  "lib/repository/supported-template.ts",
  "lib/testing/test-capability.ts",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/inspect-source-receipt.mts",
  "tsconfig.json",
] as const;

const expectedCommands = {
  appIdentity: "mise run repository:exec -- app-identity.ts --app <app-id>",
  planning:
    "mise run repository:exec -- app-contract.ts --contract <contract-file>",
  scaffold: "mise run generate:app <app-id>",
  apply: "mise run create:app -- --proposal <proposal-file>",
  preflight: "mise run repository:preflight",
  validation: [
    "mise run app:check-build <app-id>",
    "mise run app:test <app-id> <shard>",
  ],
} as const;

export const SUPPORTED_VALIDATION_COMMAND_TEMPLATES =
  expectedCommands.validation;
export const SUPPORTED_VALIDATION_TEST_SHARDS = ["1/1"] as const;

export function supportedValidationCommands(
  appId: string,
  testShards: readonly string[] = SUPPORTED_VALIDATION_TEST_SHARDS,
) {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(appId))
    throw new Error("The validation application id is invalid.");
  if (
    testShards.length === 0 ||
    testShards.some((shard) => !/^[1-9][0-9]*\/[1-9][0-9]*$/u.test(shard))
  )
    throw new Error("The validation test shard set is invalid.");
  return [
    {
      name: "check-build" as const,
      command: `mise run app:check-build ${appId}` as const,
    },
    ...testShards.map((shard) => ({
      name: "test" as const,
      command: `mise run app:test ${appId} ${shard}` as const,
    })),
  ];
}

export type EligibilityResult = {
  adapter: typeof SUPPORTED_TEMPLATE_ADAPTER;
  eligible: boolean;
  sourcePath: string;
  sourceSha?: string;
  dirtyPaths: string[];
  failures: string[];
  observed: {
    runtime: "nextjs" | "unsupported";
    packageScope: "@autograph" | "unsupported";
    appIdentityCommand: string;
    planningCommand: string;
    scaffoldCommand: string;
    applyCommand: string;
    repositoryPreflightCommand: string;
    topologyOwner: string;
    validationCommands: readonly string[];
    releaseGate: string;
  };
  digest: string;
};

/**
 * Git metadata and the small, closed set of source files the V0 adapter
 * needs to determine eligibility.  It lets a canonical sandbox clone be
 * inspected without creating a second host-side checkout.
 */
export type SupportedTemplateSnapshot = {
  sourcePath: string;
  sourceSha?: string;
  dirtyPaths: string[];
  failures?: string[];
  contents: Partial<Record<string, string>>;
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

type DependencyFile = {
  path: (typeof SUPPORTED_TEMPLATE_DEPENDENCY_PATHS)[number];
  mode: "100644" | "100755";
  objectId: string;
  sha256: string;
};

export type SupportedTemplateDependencyClosure = {
  commit: string;
  tree: string;
  files: DependencyFile[];
  digest: string;
};

function git(path: string, args: string[]): string {
  const executable = existsSync("/usr/bin/git") ? "/usr/bin/git" : "/bin/git";
  return execFileSync(
    executable,
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.attributesfile=/dev/null",
      "-C",
      path,
      ...args,
    ],
    {
      encoding: "utf8",
      env: {
        NODE_ENV: process.env.NODE_ENV ?? "production",
        PATH: "/usr/bin:/bin",
        TMPDIR: "/tmp",
        HOME: "/dev/null",
        XDG_CONFIG_HOME: "/dev/null",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_ATTR_NOSYSTEM: "1",
      },
    },
  ).trim();
}

function gitBytes(path: string, args: string[]): Buffer {
  const executable = existsSync("/usr/bin/git") ? "/usr/bin/git" : "/bin/git";
  return execFileSync(
    executable,
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.attributesfile=/dev/null",
      "-c",
      "credential.helper=",
      "-c",
      "protocol.allow=never",
      "-C",
      path,
      ...args,
    ],
    {
      encoding: "buffer",
      env: {
        NODE_ENV: process.env.NODE_ENV ?? "production",
        PATH: "/usr/bin:/bin",
        TMPDIR: "/tmp",
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
      },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    },
  );
}

export function inspectSupportedTemplateDependencyClosure(
  repositoryRoot: string,
  commit = "HEAD",
): SupportedTemplateDependencyClosure {
  const resolvedCommit = git(repositoryRoot, [
    "rev-parse",
    `${commit}^{commit}`,
  ]);
  const tree = git(repositoryRoot, ["rev-parse", `${resolvedCommit}^{tree}`]);
  const files = SUPPORTED_TEMPLATE_DEPENDENCY_PATHS.map((path) => {
    const entry = git(repositoryRoot, ["ls-tree", resolvedCommit, "--", path]);
    const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t(.+)$/u.exec(entry);
    if (match === null || match[3] !== path)
      throw new Error(`Adapter dependency is not a regular Git blob: ${path}`);
    return {
      path,
      mode: match[1] as DependencyFile["mode"],
      objectId: match[2],
      sha256: sha256(
        gitBytes(repositoryRoot, ["show", `${resolvedCommit}:${path}`]),
      ),
    };
  });
  return {
    commit: resolvedCommit,
    tree,
    files,
    digest: sha256(JSON.stringify(files)),
  };
}

function configurationRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const checkoutFreeReleaseGate = `set -euo pipefail
value="$REPOSITORY_RELEASE_ENABLED"
enabled=false
if [[ "$value" == "true" ]]; then
  enabled=true
fi
echo "enabled=$enabled" >> "$GITHUB_OUTPUT"
`;

function supportsReleaseGate(workflowSource: string): boolean {
  let workflow: Record<string, unknown>;
  try {
    workflow = configurationRecord(parseYaml(workflowSource));
  } catch {
    return false;
  }
  const jobs = configurationRecord(workflow.jobs);
  const templateSafety = configurationRecord(jobs["template-safety"]);
  const scope = configurationRecord(jobs.scope);
  const steps = Array.isArray(templateSafety.steps) ? templateSafety.steps : [];
  const safety = configurationRecord(steps[0]);
  const expectedScopeCondition =
    "needs.template-safety.outputs.enabled == 'true' && github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == github.event.repository.default_branch && github.event.workflow_run.head_repository.full_name == github.repository";
  return (
    templateSafety.name === "Authorize (Template instance safety)" &&
    JSON.stringify(templateSafety.permissions) === JSON.stringify({}) &&
    JSON.stringify(templateSafety.outputs) ===
      JSON.stringify({ enabled: "${{ steps.safety.outputs.enabled }}" }) &&
    steps.length === 1 &&
    safety.id === "safety" &&
    safety.name === "Read active repository safety flag" &&
    JSON.stringify(safety.env) ===
      JSON.stringify({
        REPOSITORY_RELEASE_ENABLED: "${{ vars.REPOSITORY_RELEASE_ENABLED }}",
      }) &&
    safety.run === checkoutFreeReleaseGate &&
    scope.needs === "template-safety" &&
    scope.if === expectedScopeCondition
  );
}

function allowedRoots(): string[] {
  const value = process.env.REPOSITORY_LOCAL_ROOTS;
  if (value === undefined || value.trim() === "") {
    if (hasTestCapability("simulated-target")) return [tmpdir()];
    throw new Error(
      "REPOSITORY_LOCAL_ROOTS must name at least one allowed local source root.",
    );
  }
  return value
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolve(entry));
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

export async function resolveAllowedRepository(input: string): Promise<string> {
  const candidate = await realpath(resolve(input));
  const roots = await Promise.all(
    allowedRoots().map(async (root) => realpath(root)),
  );
  if (!roots.some((root) => within(root, candidate))) {
    throw new Error("The repository path is outside REPOSITORY_LOCAL_ROOTS.");
  }
  return candidate;
}

export async function inspectSupportedRepository(
  input: string,
): Promise<EligibilityResult> {
  const sourcePath = await resolveAllowedRepository(input);
  return inspectSupportedRepositoryAtPath(sourcePath);
}

/**
 * Inspects a path that was created by the builder's canonical template-clone
 * transport. It is deliberately not exported through a tool boundary: callers
 * must first prove the fixed remote/ref/SHA transport contract.
 */
export async function inspectBuilderOwnedSupportedRepository(
  input: string,
): Promise<EligibilityResult> {
  return inspectSupportedRepositoryAtPath(await realpath(resolve(input)));
}

async function inspectSupportedRepositoryAtPath(
  sourcePath: string,
): Promise<EligibilityResult> {
  const failures: string[] = [];
  let sourceSha: string | undefined;
  let dirtyPaths: string[] = [];
  try {
    sourceSha = git(sourcePath, ["rev-parse", "HEAD"]);
    dirtyPaths = git(sourcePath, ["status", "--porcelain=v1"])
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3));
  } catch {
    failures.push("source is not a readable Git worktree");
  }

  const contents = Object.fromEntries(
    [...SUPPORTED_TEMPLATE_INPUT_PATHS, ".config/repository-template.json"].map(
      (path) => {
        const file = resolve(sourcePath, path);
        return [
          path,
          existsSync(file) ? readFileSync(file, "utf8") : undefined,
        ];
      },
    ),
  );
  return inspectSupportedTemplateSnapshot({
    sourcePath,
    sourceSha,
    dirtyPaths,
    failures,
    contents,
  });
}

/**
 * Evaluate the repository-owned adapter contract from an already captured
 * snapshot.  The same function is used for ordinary local repositories and
 * for the fixed canonical clone inside an Eve session.
 */
export function inspectSupportedTemplateSnapshot(
  input: SupportedTemplateSnapshot,
): EligibilityResult {
  const failures = [...(input.failures ?? [])];
  const contents = input.contents;
  for (const path of SUPPORTED_TEMPLATE_INPUT_PATHS) {
    if (contents[path] === undefined)
      failures.push(`missing required path ${path}`);
  }
  if (contents[".config/repository-template.json"] !== undefined)
    failures.push("V0 does not accept a repository-template manifest");

  const appContract =
    contents[".config/mise/scripts/repository/app-contract.ts"] ?? "";
  const runtime = /runtime:\s*"nextjs"/u.test(appContract)
    ? "nextjs"
    : "unsupported";
  if (runtime === "unsupported")
    failures.push("app planner does not declare the Next.js runtime");

  const generator = contents[".config/turbo/generators/config.ts"] ?? "";
  const packageScope = generator.includes("autograph")
    ? "@autograph"
    : "unsupported";
  if (packageScope === "unsupported")
    failures.push("workspace package scope is not @autograph");

  const mise = contents[".config/mise/config.toml"] ?? "";
  if (!mise.includes('[tasks."create:app"]'))
    failures.push("create:app command is missing");
  if (!mise.includes('[tasks."repository:preflight"]'))
    failures.push("repository:preflight command is missing");
  if (
    !mise.includes('[tasks."app:check-build"]') ||
    !mise.includes('app-validation.ts check-build "$usage_app"')
  )
    failures.push("app:check-build validation command drifted");
  if (
    !mise.includes('[tasks."app:test"]') ||
    !mise.includes('app-validation.ts test "$usage_app" "$usage_shard"')
  )
    failures.push("app:test validation command drifted");
  if (
    !mise.includes('[tasks."generate:app"]') ||
    !mise.includes(
      "turbo gen --config .config/turbo/generators/config.ts app --args",
    )
  )
    failures.push("generate:app command drifted");

  const preflight =
    contents[".config/mise/scripts/repository/repository-preflight.ts"] ?? "";
  if (!preflight.includes('runtime: "nextjs"'))
    failures.push("repository preflight does not declare the Next.js runtime");
  for (const [name, command] of Object.entries({
    "app identity": expectedCommands.appIdentity,
    "app planning": expectedCommands.planning,
    "app apply": expectedCommands.apply,
    "repository preflight": expectedCommands.preflight,
  })) {
    if (!preflight.includes(command)) failures.push(`${name} command drifted`);
  }
  if (
    !expectedCommands.validation.every((command) => preflight.includes(command))
  )
    failures.push("repository preflight validation commands drifted");

  const cd = contents[".github/workflows/cd.yml"] ?? "";
  if (!supportsReleaseGate(cd))
    failures.push(
      "REPOSITORY_RELEASE_ENABLED gate is not the supported CD gate",
    );

  const normalized = {
    adapter: SUPPORTED_TEMPLATE_ADAPTER,
    sourceSha: input.sourceSha,
    dirtyPaths: input.dirtyPaths.toSorted(),
    failures: failures.toSorted(),
    observed: {
      runtime,
      packageScope,
      appIdentityCommand: expectedCommands.appIdentity,
      planningCommand: expectedCommands.planning,
      scaffoldCommand: expectedCommands.scaffold,
      applyCommand: expectedCommands.apply,
      repositoryPreflightCommand: expectedCommands.preflight,
      topologyOwner: "microfrontends.json",
      validationCommands: expectedCommands.validation,
      releaseGate: "REPOSITORY_RELEASE_ENABLED",
    },
  } as const;
  return {
    ...normalized,
    eligible: failures.length === 0,
    sourcePath: input.sourcePath,
    digest: sha256(JSON.stringify(normalized)),
  };
}

export type PreparedSandboxWorkspace = {
  workspaceId: string;
  workspacePath: "/workspace/repository";
  sourcePath: string;
  sourceSha: string;
  sourceTree: string;
  workspaceDigest: string;
  adapter: typeof SUPPORTED_TEMPLATE_ADAPTER;
  eligibilityDigest: string;
};

const sandboxRecordPath = ".app-builder/prepared-workspace.json";
const sandboxSourceFilesPath = ".app-builder/source-files.json";
const sandboxSourceChecksumsPath = ".app-builder/source-checksums.sha256";
const sandboxSourceArchivePath = ".app-builder/source-tree.tar.gz";
const sandboxOperationTimeoutMs = 120_000;
const sandboxOperationOutputBytes = 262_144;

const fixtureSandboxEnabled = () => hasTestCapability("simulated-target");

export type PreparedSourceFile = {
  mode: "100644" | "100755";
  objectId: string;
  path: string;
  sha256: string;
};

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  const allowed = new Set(expected);
  return (
    actual.length === allowed.size && actual.every((key) => allowed.has(key))
  );
}

function preparedSourceChecksums(files: readonly PreparedSourceFile[]): string {
  return `${files
    .map(({ path, sha256: digest }) => `${digest}  repository/${path}`)
    .join("\n")}\n`;
}

function parsePreparedWorkspace(input: unknown): PreparedSandboxWorkspace {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    !exactKeys(input as Record<string, unknown>, [
      "workspaceId",
      "workspacePath",
      "sourcePath",
      "sourceSha",
      "sourceTree",
      "workspaceDigest",
      "adapter",
      "eligibilityDigest",
    ])
  )
    throw new Error("The prepared workspace record is invalid.");
  const record = input as Partial<PreparedSandboxWorkspace>;
  if (
    typeof record.workspaceId !== "string" ||
    record.workspaceId === "" ||
    record.workspacePath !== "/workspace/repository" ||
    typeof record.sourcePath !== "string" ||
    !isAbsolute(record.sourcePath) ||
    typeof record.sourceSha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(record.sourceSha) ||
    typeof record.sourceTree !== "string" ||
    !/^[0-9a-f]{40}$/u.test(record.sourceTree) ||
    typeof record.workspaceDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.workspaceDigest) ||
    record.adapter !== SUPPORTED_TEMPLATE_ADAPTER ||
    typeof record.eligibilityDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.eligibilityDigest)
  )
    throw new Error("The prepared workspace record is invalid.");
  return record as PreparedSandboxWorkspace;
}

function parsePreparedSourceFiles(input: unknown): PreparedSourceFile[] {
  if (!Array.isArray(input) || input.length === 0)
    throw new Error("The prepared workspace manifest is invalid.");
  const paths = new Set<string>();
  return input.map((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      !exactKeys(candidate as Record<string, unknown>, [
        "mode",
        "objectId",
        "path",
        "sha256",
      ])
    )
      throw new Error("The prepared workspace manifest is invalid.");
    const file = candidate as Partial<PreparedSourceFile>;
    if (
      !["100644", "100755"].includes(file.mode ?? "") ||
      typeof file.objectId !== "string" ||
      !/^[0-9a-f]{40}$/u.test(file.objectId) ||
      typeof file.path !== "string" ||
      !safeSourcePath(file.path) ||
      paths.has(file.path) ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(file.sha256)
    )
      throw new Error("The prepared workspace manifest is invalid.");
    paths.add(file.path);
    return file as PreparedSourceFile;
  });
}

/** Reads and validates prepared-workspace metadata without inspecting source bytes. */
export async function readPreparedSandboxWorkspaceRecord(
  sandbox: SandboxSession,
): Promise<PreparedSandboxWorkspace | undefined> {
  const content = await sandbox.readTextFile({ path: sandboxRecordPath });
  if (content === null) return undefined;
  try {
    return parsePreparedWorkspace(JSON.parse(content) as unknown);
  } catch (error) {
    throw new Error("The prepared workspace record is invalid.", {
      cause: error,
    });
  }
}

/**
 * Reads the exact prepared manifest and binds it to validated workspace
 * metadata. Callers remain responsible for independently verifying or
 * reading the referenced source bytes.
 */
export async function readPreparedSandboxSourceManifest(
  sandbox: SandboxSession,
  workspace: PreparedSandboxWorkspace,
): Promise<PreparedSourceFile[]> {
  const manifestContent = await sandbox.readTextFile({
    path: sandboxSourceFilesPath,
  });
  if (manifestContent === null)
    throw new Error("The prepared workspace manifest is missing.");
  let files: PreparedSourceFile[];
  try {
    files = parsePreparedSourceFiles(JSON.parse(manifestContent) as unknown);
  } catch (error) {
    throw new Error("The prepared workspace manifest is invalid.", {
      cause: error,
    });
  }
  if (sha256(JSON.stringify(files)) !== workspace.workspaceDigest)
    throw new Error(
      "The prepared workspace manifest no longer matches its receipt.",
    );
  return files;
}

async function verifyPreparedSandboxWorkspace(
  sandbox: SandboxSession,
  record: PreparedSandboxWorkspace,
): Promise<void> {
  const files = await readPreparedSandboxSourceManifest(sandbox, record);
  const checksums = await sandbox.readTextFile({
    path: sandboxSourceChecksumsPath,
  });
  if (checksums !== preparedSourceChecksums(files))
    throw new Error("The prepared workspace checksum receipt drifted.");
  if (fixtureSandboxEnabled()) {
    for (const file of files) {
      const content = await sandbox.readBinaryFile({
        path: `repository/${file.path}`,
      });
      if (content === null || sha256(content) !== file.sha256)
        throw new Error("A prepared workspace file drifted or is missing.");
    }
    return;
  }
  const verification = await sandbox.run({
    command: `sha256sum -c ${sandboxSourceChecksumsPath} >/dev/null 2>&1`,
    workingDirectory: "/workspace",
    abortSignal: AbortSignal.timeout(sandboxOperationTimeoutMs),
  });
  if (
    Buffer.byteLength(verification.stdout) > sandboxOperationOutputBytes ||
    Buffer.byteLength(verification.stderr) > sandboxOperationOutputBytes
  )
    throw new Error("Prepared workspace verification output was too large.");
  if (verification.exitCode !== 0)
    throw new Error("A prepared workspace file drifted or is missing.");
}

export type PreparedSandboxWorkspaceStatus =
  | { state: "absent" }
  | { state: "prepared"; workspace: PreparedSandboxWorkspace };

export async function inspectPreparedSandboxWorkspace(
  sandbox: SandboxSession,
): Promise<PreparedSandboxWorkspaceStatus> {
  const record = await readPreparedSandboxWorkspaceRecord(sandbox);
  if (record === undefined) return { state: "absent" };
  await verifyPreparedSandboxWorkspace(sandbox, record);
  return { state: "prepared", workspace: record };
}

/** Returns the exact prepared source manifest after verifying its receipt and bytes. */
export async function inspectPreparedSandboxSourceFiles(
  sandbox: SandboxSession,
): Promise<PreparedSourceFile[]> {
  const prepared = await inspectPreparedSandboxWorkspace(sandbox);
  if (prepared.state !== "prepared")
    throw new Error("The prepared source workspace is missing.");
  return await readPreparedSandboxSourceManifest(sandbox, prepared.workspace);
}

/**
 * Seal an already materialized workspace after the producer has written the
 * exact source manifest and checksum receipt.  Canonical remote clones use
 * this instead of serializing a host checkout into an archive.
 */
export async function recordPreparedSandboxWorkspace(input: {
  sandbox: SandboxSession;
  callId: string;
  sourcePath: string;
  sourceSha: string;
  sourceTree: string;
  eligibilityDigest: string;
  workspaceDigest: string;
}): Promise<PreparedSandboxWorkspace> {
  const expected: Omit<PreparedSandboxWorkspace, "workspaceId"> = {
    workspacePath: "/workspace/repository",
    sourcePath: input.sourcePath,
    sourceSha: input.sourceSha,
    sourceTree: input.sourceTree,
    workspaceDigest: input.workspaceDigest,
    adapter: SUPPORTED_TEMPLATE_ADAPTER,
    eligibilityDigest: input.eligibilityDigest,
  };
  const existing = await readPreparedSandboxWorkspaceRecord(input.sandbox);
  if (existing !== undefined) {
    const { workspaceId, ...observed } = existing;
    if (
      workspaceId !== input.sandbox.id ||
      JSON.stringify(observed) !== JSON.stringify(expected)
    )
      throw new Error("This app build already owns a different workspace.");
    await verifyPreparedSandboxWorkspace(input.sandbox, existing);
    return existing;
  }

  await ensureSandboxDirectories(input.sandbox, [".app-builder"]);
  await input.sandbox.writeTextFile({
    path: ".app-builder/prepare-intent.json",
    content: `${JSON.stringify(
      {
        callId: input.callId,
        sourcePath: input.sourcePath,
        sourceSha: input.sourceSha,
        sourceTree: input.sourceTree,
        eligibilityDigest: input.eligibilityDigest,
      },
      null,
      2,
    )}\n`,
  });
  const record: PreparedSandboxWorkspace = {
    workspaceId: input.sandbox.id,
    ...expected,
  };
  await input.sandbox.writeTextFile({
    path: sandboxRecordPath,
    content: `${JSON.stringify(record, null, 2)}\n`,
  });
  await verifyPreparedSandboxWorkspace(input.sandbox, record);
  return record;
}

/**
 * Materialize the reviewed Git tree inside Eve's per-session sandbox.
 *
 * The fixed path is intentional: one Eve session owns one target workspace.
 * The intent file and deterministic path make an interrupted tool retry
 * converge on the same workspace instead of creating another host worktree.
 */
export async function prepareSupportedSandboxWorkspace(
  sourcePathInput: string,
  expectedSha: string,
  expectedEligibilityDigest: string,
  sandbox: SandboxSession,
  callId: string,
  builderOwned = false,
): Promise<PreparedSandboxWorkspace> {
  const eligibility = builderOwned
    ? await inspectBuilderOwnedSupportedRepository(sourcePathInput)
    : await inspectSupportedRepository(sourcePathInput);
  if (!eligibility.eligible || eligibility.sourceSha === undefined) {
    throw new Error(
      `Repository is not eligible: ${eligibility.failures.join("; ")}`,
    );
  }
  if (eligibility.sourceSha !== expectedSha)
    throw new Error("Source SHA changed after eligibility review.");
  if (eligibility.digest !== expectedEligibilityDigest)
    throw new Error("Repository eligibility changed after review.");

  const sourceTree = git(eligibility.sourcePath, [
    "rev-parse",
    `${expectedSha}^{tree}`,
  ]);
  const existing = await readPreparedSandboxWorkspaceRecord(sandbox);
  if (existing !== undefined) {
    if (
      existing.sourcePath !== eligibility.sourcePath ||
      existing.sourceSha !== expectedSha ||
      existing.sourceTree !== sourceTree ||
      existing.eligibilityDigest !== expectedEligibilityDigest
    ) {
      throw new Error("This app build already owns a different workspace.");
    }
    await verifyPreparedSandboxWorkspace(sandbox, existing);
    return existing;
  }

  const treeEntries = execFileSync(
    "git",
    [
      "-C",
      eligibility.sourcePath,
      "ls-tree",
      "-rz",
      "--full-tree",
      expectedSha,
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = /^(\d+) (\w+) ([0-9a-f]{40})\t(.+)$/u.exec(entry);
      if (match === null)
        throw new Error("The reviewed Git tree contains an invalid entry.");
      const [, mode, type, objectId, path] = match;
      if (
        type !== "blob" ||
        !["100644", "100755"].includes(mode!) ||
        path === undefined ||
        objectId === undefined ||
        !safeSourcePath(path)
      ) {
        throw new Error("The reviewed Git tree contains an unsupported entry.");
      }
      return { mode: mode as "100644" | "100755", objectId, path };
    });
  const sourceFiles: PreparedSourceFile[] = treeEntries.map((entry) => {
    const content = execFileSync(
      "git",
      ["-C", eligibility.sourcePath, "cat-file", "blob", entry.objectId],
      { maxBuffer: 128 * 1024 * 1024 },
    );
    return { ...entry, sha256: sha256(content) };
  });
  const intent = {
    callId,
    sourcePath: eligibility.sourcePath,
    sourceSha: expectedSha,
    sourceTree,
    eligibilityDigest: expectedEligibilityDigest,
  };
  await ensureSandboxDirectories(sandbox, [".app-builder"]);
  await sandbox.writeTextFile({
    path: ".app-builder/prepare-intent.json",
    content: `${JSON.stringify(intent, null, 2)}\n`,
  });
  await sandbox.removePath({
    path: "repository",
    recursive: true,
    force: true,
  });
  if (fixtureSandboxEnabled()) {
    await ensureSandboxDirectories(
      sandbox,
      sourceFiles.map(
        ({ path }) => `repository/${path.split("/").slice(0, -1).join("/")}`,
      ),
    );
    for (const entry of sourceFiles) {
      await sandbox.writeBinaryFile({
        path: `repository/${entry.path}`,
        content: execFileSync(
          "git",
          ["-C", eligibility.sourcePath, "cat-file", "blob", entry.objectId],
          { maxBuffer: 128 * 1024 * 1024 },
        ),
      });
    }
  } else {
    // Microsandbox transfers the archive through a bounded file-write API. A
    // compressed archive keeps real template repositories within that bound.
    const sourceArchive = execFileSync(
      "git",
      ["-C", eligibility.sourcePath, "archive", "--format=tar.gz", expectedSha],
      { maxBuffer: 256 * 1024 * 1024 },
    );
    await sandbox.writeBinaryFile({
      path: sandboxSourceArchivePath,
      content: sourceArchive,
    });
    try {
      const extraction = await sandbox.run({
        command: `mkdir -p repository && tar --extract --gzip --file ${sandboxSourceArchivePath} --directory repository --no-same-owner --no-same-permissions`,
        workingDirectory: "/workspace",
        abortSignal: AbortSignal.timeout(sandboxOperationTimeoutMs),
      });
      if (
        Buffer.byteLength(extraction.stdout) > sandboxOperationOutputBytes ||
        Buffer.byteLength(extraction.stderr) > sandboxOperationOutputBytes ||
        extraction.exitCode !== 0
      )
        throw new Error(
          "The reviewed source archive could not be materialized.",
        );
    } finally {
      await sandbox.removePath({ path: sandboxSourceArchivePath, force: true });
    }
  }
  await sandbox.writeTextFile({
    path: sandboxSourceFilesPath,
    content: `${JSON.stringify(sourceFiles, null, 2)}\n`,
  });
  await sandbox.writeTextFile({
    path: sandboxSourceChecksumsPath,
    content: preparedSourceChecksums(sourceFiles),
  });
  const record: PreparedSandboxWorkspace = {
    workspaceId: sandbox.id,
    workspacePath: "/workspace/repository",
    sourcePath: eligibility.sourcePath,
    sourceSha: expectedSha,
    sourceTree,
    workspaceDigest: sha256(JSON.stringify(sourceFiles)),
    adapter: SUPPORTED_TEMPLATE_ADAPTER,
    eligibilityDigest: expectedEligibilityDigest,
  };
  await sandbox.writeTextFile({
    path: sandboxRecordPath,
    content: `${JSON.stringify(record, null, 2)}\n`,
  });
  await verifyPreparedSandboxWorkspace(sandbox, record);
  return record;
}

/** Materializes a source only after the canonical clone transport has proven it. */
export async function prepareBuilderOwnedSupportedSandboxWorkspace(
  sourcePathInput: string,
  expectedSha: string,
  expectedEligibilityDigest: string,
  sandbox: SandboxSession,
  callId: string,
): Promise<PreparedSandboxWorkspace> {
  return prepareSupportedSandboxWorkspace(
    sourcePathInput,
    expectedSha,
    expectedEligibilityDigest,
    sandbox,
    callId,
    true,
  );
}
