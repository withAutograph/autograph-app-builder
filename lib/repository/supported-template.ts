import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { delimiter, isAbsolute, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import type { SandboxSession } from "eve/sandbox";
import { parse as parseYaml } from "yaml";

import { ensureSandboxDirectories } from "./sandbox-filesystem";
import { safeSourcePath } from "./source-path";
import { hasTestCapability } from "../testing/test-capability";

export const SUPPORTED_TEMPLATE_ADAPTER = "arrusted-development-v0";

export const SUPPORTED_REPOSITORY_CONTRACT = {
  version: 1,
  runtime: "nextjs",
  requiredPaths: [
    ".config/mise/config.toml",
    ".config/mise/tasks/repository/exec",
    ".config/mise/scripts/repository/app-contract.ts",
    ".config/mise/scripts/repository/app-identity.ts",
    ".config/mise/scripts/repository/app-validation.ts",
    ".config/mise/scripts/repository/repository-preflight.ts",
    "microfrontends.json",
    "package.json",
  ],
  commands: {
    appIdentity: "mise run repository:exec -- app-identity.ts --app <app-id>",
    planning:
      "mise run repository:exec -- app-contract.ts --contract <contract-file>",
    apply: "mise run create:app -- --proposal <proposal-file>",
    repositoryPreflight: "mise run repository:preflight",
  },
  topologyOwner: "microfrontends.json",
  validationCommands: [
    "mise run app:check-build <app-id>",
    "mise run app:test <app-id> <shard>",
  ],
} as const;

export const SUPPORTED_TEMPLATE_INPUT_PATHS = [
  ...SUPPORTED_REPOSITORY_CONTRACT.requiredPaths,
  ".github/workflows/cd.yml",
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

export const SUPPORTED_VALIDATION_COMMAND_TEMPLATES =
  SUPPORTED_REPOSITORY_CONTRACT.validationCommands;
export const SUPPORTED_VALIDATION_TEST_SHARDS = ["1/1"] as const;

const expectedCommands = {
  appIdentity: SUPPORTED_REPOSITORY_CONTRACT.commands.appIdentity,
  planning: SUPPORTED_REPOSITORY_CONTRACT.commands.planning,
  scaffold: "mise run generate:app <app-id>",
  apply: SUPPORTED_REPOSITORY_CONTRACT.commands.apply,
  preflight: SUPPORTED_REPOSITORY_CONTRACT.commands.repositoryPreflight,
  validation: SUPPORTED_REPOSITORY_CONTRACT.validationCommands,
} as const;

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
  planningEligible: boolean;
  sourcePath: string;
  sourceSha?: string;
  dirtyPaths: string[];
  failures: string[];
  planningFailures: string[];
  compatibilityDigest: string;
  releasePolicy: {
    gate: "REPOSITORY_RELEASE_ENABLED";
    eligible: boolean;
  };
  observed: {
    contractVersion: typeof SUPPORTED_REPOSITORY_CONTRACT.version;
    runtime: "nextjs" | "unsupported";
    requiredPaths: readonly string[];
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

const repositoryReleasePolicyPath = ".github/workflows/cd.yml" as const;

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

export type RepositoryReleasePolicyObservation = {
  gate: "REPOSITORY_RELEASE_ENABLED";
  eligible: boolean;
  sourceSha: string;
  sourceTree: string;
  workflow:
    | { status: "absent" }
    | {
        status: "present";
        path: typeof repositoryReleasePolicyPath;
        mode: "100644" | "100755";
        objectId: string;
        sha256: string;
      };
  digest: string;
};

function releasePolicyObservation(input: {
  sourceSha: string;
  sourceTree: string;
  workflow:
    | { status: "absent" }
    | {
        status: "present";
        mode: "100644" | "100755";
        objectId: string;
        bytes: Uint8Array;
      };
}): RepositoryReleasePolicyObservation {
  const workflow =
    input.workflow.status === "absent"
      ? input.workflow
      : {
          status: "present" as const,
          path: repositoryReleasePolicyPath,
          mode: input.workflow.mode,
          objectId: input.workflow.objectId,
          sha256: sha256(input.workflow.bytes),
        };
  const unsigned = {
    gate: "REPOSITORY_RELEASE_ENABLED" as const,
    eligible:
      input.workflow.status === "present" &&
      supportsReleaseGate(Buffer.from(input.workflow.bytes).toString("utf8")),
    sourceSha: input.sourceSha,
    sourceTree: input.sourceTree,
    workflow,
  };
  return { ...unsigned, digest: sha256(JSON.stringify(unsigned)) };
}

/**
 * Re-read the release policy from the reviewed commit, never from mutable
 * working-tree bytes. Outward existing-repository effects use this after
 * approval so planning compatibility can remain independent of CD layout.
 */
export function inspectRepositoryReleasePolicyAtGitSnapshot(input: {
  sourcePath: string;
  sourceSha: string;
  sourceTree: string;
}): RepositoryReleasePolicyObservation {
  const sourceSha = git(input.sourcePath, [
    "rev-parse",
    `${input.sourceSha}^{commit}`,
  ]);
  const sourceTree = git(input.sourcePath, [
    "rev-parse",
    `${sourceSha}^{tree}`,
  ]);
  if (sourceSha !== input.sourceSha || sourceTree !== input.sourceTree)
    throw new Error(
      "The existing-repository release policy is not bound to the reviewed Git snapshot.",
    );
  const entry = git(input.sourcePath, [
    "ls-tree",
    sourceSha,
    "--",
    repositoryReleasePolicyPath,
  ]);
  const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t(.+)$/u.exec(entry);
  if (match === null || match[3] !== repositoryReleasePolicyPath)
    return releasePolicyObservation({
      sourceSha,
      sourceTree,
      workflow: { status: "absent" },
    });
  return releasePolicyObservation({
    sourceSha,
    sourceTree,
    workflow: {
      status: "present",
      mode: match[1] as "100644" | "100755",
      objectId: match[2]!,
      bytes: gitBytes(input.sourcePath, [
        "show",
        `${sourceSha}:${repositoryReleasePolicyPath}`,
      ]),
    },
  });
}

export function assertRepositoryReleasePolicyAtGitSnapshot(input: {
  sourcePath: string;
  sourceSha: string;
  sourceTree: string;
}): RepositoryReleasePolicyObservation {
  const observation = inspectRepositoryReleasePolicyAtGitSnapshot(input);
  if (!observation.eligible)
    throw new Error(
      "The reviewed repository does not satisfy the release policy required for outward effects.",
    );
  return observation;
}

function declaredNextRuntime(packageSource: string): "nextjs" | "unsupported" {
  let packageManifest: Record<string, unknown>;
  try {
    packageManifest = configurationRecord(JSON.parse(packageSource) as unknown);
  } catch {
    return "unsupported";
  }
  const dependencies = configurationRecord(packageManifest.dependencies);
  const devDependencies = configurationRecord(packageManifest.devDependencies);
  const next = dependencies.next ?? devDependencies.next;
  return typeof next === "string" && next.trim() !== ""
    ? "nextjs"
    : "unsupported";
}

function declaredMiseTasks(source: string): Map<string, number> {
  const tasks = new Map<string, number>();
  for (const match of source.matchAll(/^\[tasks\."([^"]+)"\]\s*$/gmu)) {
    const name = match[1];
    if (name !== undefined) tasks.set(name, (tasks.get(name) ?? 0) + 1);
  }
  return tasks;
}

function hasOneTask(tasks: ReadonlyMap<string, number>, name: string): boolean {
  return tasks.get(name) === 1;
}

function inspectPlanningCompatibility(
  contents: SupportedTemplateSnapshot["contents"],
) {
  const failures: string[] = [];
  for (const path of SUPPORTED_REPOSITORY_CONTRACT.requiredPaths) {
    if (!safeSourcePath(path))
      throw new Error(
        "The supported repository contract contains an unsafe path.",
      );
    if (
      path !== SUPPORTED_REPOSITORY_CONTRACT.topologyOwner &&
      contents[path] === undefined
    )
      failures.push(`missing required path ${path}`);
  }

  const runtime = declaredNextRuntime(contents["package.json"] ?? "");
  if (runtime === "unsupported")
    failures.push("repository does not declare the Next.js runtime");

  const tasks = declaredMiseTasks(contents[".config/mise/config.toml"] ?? "");
  if (!hasOneTask(tasks, "repository:preflight"))
    failures.push("repository:preflight command is missing");
  if (
    contents[".config/mise/tasks/repository/exec"] === undefined ||
    contents[".config/mise/scripts/repository/app-identity.ts"] === undefined ||
    contents[".config/mise/scripts/repository/app-contract.ts"] === undefined
  )
    failures.push("repository:exec command is unavailable");
  // Topology ownership is advisory capability information for older
  // checkouts, not source-admission authority.

  const observed = {
    contractVersion: SUPPORTED_REPOSITORY_CONTRACT.version,
    runtime,
    requiredPaths: [...SUPPORTED_REPOSITORY_CONTRACT.requiredPaths],
    appIdentityCommand: SUPPORTED_REPOSITORY_CONTRACT.commands.appIdentity,
    planningCommand: SUPPORTED_REPOSITORY_CONTRACT.commands.planning,
    applyCommand: SUPPORTED_REPOSITORY_CONTRACT.commands.apply,
    repositoryPreflightCommand:
      SUPPORTED_REPOSITORY_CONTRACT.commands.repositoryPreflight,
    topologyOwner: SUPPORTED_REPOSITORY_CONTRACT.topologyOwner,
    validationCommands: SUPPORTED_REPOSITORY_CONTRACT.validationCommands,
  } as const;
  const sortedFailures = failures.toSorted();
  return {
    eligible: sortedFailures.length === 0,
    failures: sortedFailures,
    observed,
    digest: sha256(
      JSON.stringify({
        adapter: SUPPORTED_TEMPLATE_ADAPTER,
        failures: sortedFailures,
        observed,
      }),
    ),
  };
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
  const dirtyPaths: string[] = [];
  try {
    sourceSha = git(sourcePath, ["rev-parse", "HEAD"]);
    const statusRecords = gitBytes(sourcePath, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ])
      .toString("utf8")
      .split("\0");
    for (let index = 0; index < statusRecords.length; index += 1) {
      const record = statusRecords[index];
      if (record === undefined || record === "") continue;
      if (record.length < 4 || record[2] !== " ")
        throw new Error("Git returned a malformed worktree status record.");
      dirtyPaths.push(record.slice(3));
      if (/[RC]/u.test(record.slice(0, 2))) {
        const originalPath = statusRecords[index + 1];
        if (originalPath === undefined || originalPath === "")
          throw new Error("Git returned a malformed rename status record.");
        dirtyPaths.push(originalPath);
        index += 1;
      }
    }
  } catch {
    failures.push("source is not a readable Git worktree");
  }

  const contents = Object.fromEntries(
    [...SUPPORTED_TEMPLATE_INPUT_PATHS, ".config/repository-template.json"].map(
      (path) => {
        if (sourceSha === undefined) return [path, undefined];
        const entry = git(sourcePath, ["ls-tree", sourceSha, "--", path]);
        const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t(.+)$/u.exec(
          entry,
        );
        return [
          path,
          match !== null && match[3] === path
            ? gitBytes(sourcePath, ["show", `${sourceSha}:${path}`]).toString(
                "utf8",
              )
            : undefined,
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
  const planningCompatibility = inspectPlanningCompatibility(contents);
  for (const path of SUPPORTED_TEMPLATE_INPUT_PATHS) {
    if (
      path !== SUPPORTED_REPOSITORY_CONTRACT.topologyOwner &&
      contents[path] === undefined
    )
      failures.push(`missing required path ${path}`);
  }
  if (contents[".config/repository-template.json"] !== undefined)
    failures.push("V0 does not accept a repository-template manifest");

  const appContract =
    contents[".config/mise/scripts/repository/app-contract.ts"] ?? "";
  const adapterRuntime = /runtime:\s*"nextjs"/u.test(appContract)
    ? "nextjs"
    : "unsupported";
  if (adapterRuntime === "unsupported")
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
  // Validation command spellings are advisory and may differ in older
  // Arrusted checkouts.
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
  // Preflight command-list parity is advisory capability information.

  const cd = contents[".github/workflows/cd.yml"] ?? "";
  const releasePolicy = {
    gate: "REPOSITORY_RELEASE_ENABLED" as const,
    eligible: supportsReleaseGate(cd),
  };
  if (!releasePolicy.eligible)
    failures.push(
      "REPOSITORY_RELEASE_ENABLED gate is not the supported CD gate",
    );

  const normalized = {
    adapter: SUPPORTED_TEMPLATE_ADAPTER,
    sourceSha: input.sourceSha,
    dirtyPaths: input.dirtyPaths.toSorted(),
    failures: failures.toSorted(),
    observed: {
      contractVersion: planningCompatibility.observed.contractVersion,
      runtime: planningCompatibility.observed.runtime,
      requiredPaths: planningCompatibility.observed.requiredPaths,
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
    planningEligible: planningCompatibility.eligible,
    planningFailures: planningCompatibility.failures,
    sourcePath: input.sourcePath,
    compatibilityDigest: planningCompatibility.digest,
    releasePolicy,
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Development is deliberately a live working-tree transport.  The archive is
 * only a one-shot upload envelope for the first transfer; it is neither a
 * release artifact nor a source authority.  Subsequent transfers use the
 * manifest delta below, so ordinary edits do not rebuild or replace the
 * sandbox workspace.
 */
function developmentWorkingTreeArchive(
  sourcePath: string,
  paths: readonly string[],
): Buffer {
  return execFileSync(
    "tar",
    ["--create", "--gzip", "--file=-", "--null", "--files-from=-"],
    {
      cwd: sourcePath,
      input: `${paths.join("\0")}\0`,
      maxBuffer: 256 * 1024 * 1024,
    },
  );
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

const developmentWorkspaceInspectionProgram = [
  'const fs=require("node:fs");',
  'const path=require("node:path");',
  'const workspaceRoot=path.resolve(".");',
  'const repositoryInput=path.resolve("repository");',
  'if(repositoryInput!==path.join(workspaceRoot,"repository"))process.exit(1);',
  "const repositoryState=fs.lstatSync(repositoryInput);",
  "if(!repositoryState.isDirectory()||repositoryState.isSymbolicLink())process.exit(1);",
  'const realWorkspace=fs.realpathSync(".");',
  "const realRepository=fs.realpathSync(repositoryInput);",
  'if(realWorkspace!=="/workspace"||realRepository!=="/workspace/repository")process.exit(1);',
  "process.stdout.write(JSON.stringify({repositoryInput,realRepository,realWorkspace,workspaceRoot}));",
].join("");

const developmentWorkspaceInspectionReceipt = JSON.stringify({
  repositoryInput: "/workspace/repository",
  realRepository: "/workspace/repository",
  realWorkspace: "/workspace",
  workspaceRoot: "/workspace",
});

async function verifyDevelopmentSandboxWorkspace(
  sandbox: SandboxSession,
  record: PreparedSandboxWorkspace,
): Promise<void> {
  if (
    record.workspaceId !== sandbox.id ||
    record.workspacePath !== "/workspace/repository"
  )
    throw new Error(
      "The prepared development workspace does not belong to this session.",
    );
  const node = fixtureSandboxEnabled()
    ? JSON.stringify(process.execPath)
    : "node";
  const inspection = await sandbox.run({
    command: `cd /workspace && ${node} -e ${JSON.stringify(developmentWorkspaceInspectionProgram)}`,
    abortSignal: AbortSignal.timeout(sandboxOperationTimeoutMs),
  });
  const normalizedStdout = inspection.stdout
    .replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
    .trim();
  if (
    Buffer.byteLength(inspection.stdout) > sandboxOperationOutputBytes ||
    Buffer.byteLength(inspection.stderr) > sandboxOperationOutputBytes ||
    normalizedStdout !== developmentWorkspaceInspectionReceipt
  )
    throw new Error(
      "The prepared development workspace escaped its sandbox boundary.",
    );
}

export type PreparedSandboxWorkspaceStatus =
  | { state: "absent" }
  | { state: "prepared"; workspace: PreparedSandboxWorkspace };

export async function inspectPreparedSandboxWorkspace(
  sandbox: SandboxSession,
  mode: "exact" | "development-live" = "exact",
): Promise<PreparedSandboxWorkspaceStatus> {
  const record = await readPreparedSandboxWorkspaceRecord(sandbox);
  if (record === undefined) return { state: "absent" };
  if (mode === "development-live")
    await verifyDevelopmentSandboxWorkspace(sandbox, record);
  else await verifyPreparedSandboxWorkspace(sandbox, record);
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
 * Re-read and verify the full release policy from the exact prepared Git tree.
 * Hosted execution has no host checkout, so the prepared manifest is the
 * selected snapshot's object-id and byte-digest authority.
 */
export async function inspectPreparedSandboxReleasePolicy(input: {
  sandbox: SandboxSession;
  sourceSha: string;
  sourceTree: string;
  workspaceDigest: string;
}): Promise<RepositoryReleasePolicyObservation> {
  const prepared = await inspectPreparedSandboxWorkspace(input.sandbox);
  if (
    prepared.state !== "prepared" ||
    prepared.workspace.sourceSha !== input.sourceSha ||
    prepared.workspace.sourceTree !== input.sourceTree ||
    prepared.workspace.workspaceDigest !== input.workspaceDigest
  )
    throw new Error(
      "The hosted release policy is not bound to the reviewed Git snapshot.",
    );
  const files = await inspectPreparedSandboxSourceFiles(input.sandbox);
  const entry = files.find(({ path }) => path === repositoryReleasePolicyPath);
  if (entry === undefined)
    return releasePolicyObservation({
      sourceSha: input.sourceSha,
      sourceTree: input.sourceTree,
      workflow: { status: "absent" },
    });
  const bytes = await input.sandbox.readBinaryFile({
    path: `repository/${repositoryReleasePolicyPath}`,
  });
  if (bytes === null || sha256(bytes) !== entry.sha256)
    throw new Error("The hosted release-policy bytes changed after review.");
  return releasePolicyObservation({
    sourceSha: input.sourceSha,
    sourceTree: input.sourceTree,
    workflow: {
      status: "present",
      mode: entry.mode,
      objectId: entry.objectId,
      bytes,
    },
  });
}

export async function assertPreparedSandboxReleasePolicy(input: {
  sandbox: SandboxSession;
  sourceSha: string;
  sourceTree: string;
  workspaceDigest: string;
}): Promise<RepositoryReleasePolicyObservation> {
  const observation = await inspectPreparedSandboxReleasePolicy(input);
  if (!observation.eligible)
    throw new Error(
      "The reviewed repository does not satisfy the release policy required for outward effects.",
    );
  return observation;
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
    if (existing.workspaceId !== input.sandbox.id)
      throw new Error("This app build already owns a different workspace.");
    // Source changes and generated files are ordinary work inside the same
    // session-owned checkout. Refresh the diagnostic metadata below.
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
  compatibility: "full" | "planning" = "full",
): Promise<PreparedSandboxWorkspace> {
  const eligibility = builderOwned
    ? await inspectBuilderOwnedSupportedRepository(sourcePathInput)
    : await inspectSupportedRepository(sourcePathInput);
  const eligible =
    compatibility === "planning"
      ? eligibility.planningEligible
      : eligibility.eligible;
  const eligibilityDigest =
    compatibility === "planning"
      ? eligibility.compatibilityDigest
      : eligibility.digest;
  const failures =
    compatibility === "planning"
      ? eligibility.planningFailures
      : eligibility.failures;
  if (!eligible || eligibility.sourceSha === undefined) {
    throw new Error(
      `Repository is not ${compatibility === "planning" ? "planning-compatible" : "eligible"}: ${failures.join("; ")}`,
    );
  }
  if (eligibility.sourceSha !== expectedSha)
    throw new Error("Source SHA changed after eligibility review.");
  if (eligibilityDigest !== expectedEligibilityDigest)
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

/**
 * Synchronizes the tracked and non-ignored working tree for an explicit local
 * development run.  This is intentionally separate from the reviewed Git
 * snapshot transport above: normal edits are live planning input, while the
 * sandbox-owned repository remains the mutable execution overlay.
 */
export async function prepareDevelopmentSandboxWorkspace(
  sourcePathInput: string,
  sandbox: SandboxSession,
  callId: string,
  compatibility: "full" | "planning" = "full",
): Promise<PreparedSandboxWorkspace> {
  const eligibility = await inspectSupportedRepository(sourcePathInput);
  const eligible =
    compatibility === "planning"
      ? eligibility.planningEligible
      : eligibility.eligible;
  const eligibilityDigest =
    compatibility === "planning"
      ? eligibility.compatibilityDigest
      : eligibility.digest;
  const failures =
    compatibility === "planning"
      ? eligibility.planningFailures
      : eligibility.failures;
  if (!eligible || eligibility.sourceSha === undefined) {
    throw new Error(
      `Repository is not ${compatibility === "planning" ? "planning-compatible" : "eligible"}: ${failures.join("; ")}`,
    );
  }

  const names = gitBytes(eligibility.sourcePath, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .toSorted()
    .filter((path) => {
      if (!safeSourcePath(path))
        throw new Error("The development source contains an unsafe path.");
      const absolutePath = resolve(eligibility.sourcePath, path);
      if (!within(eligibility.sourcePath, absolutePath))
        throw new Error("The development source escapes its root.");
      // `git ls-files --cached` keeps a deleted tracked path until it is
      // staged. Development follows the working tree, so that path is a
      // managed deletion rather than a failed source snapshot.
      return existsSync(absolutePath);
    });
  const sourceFiles: PreparedSourceFile[] = names.map((path) => {
    const absolutePath = resolve(eligibility.sourcePath, path);
    const info = lstatSync(absolutePath);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("The development source contains a non-regular file.");
    const content = readFileSync(absolutePath);
    return {
      mode: (info.mode & 0o111) === 0 ? "100644" : "100755",
      // The live working tree has no stable Git object for edited/untracked
      // files. Its byte digest is the development-generation identity.
      objectId: sha256(content).slice(0, 40),
      path,
      sha256: sha256(content),
    };
  });
  if (sourceFiles.length === 0)
    throw new Error("The development source contains no files.");
  const workspaceDigest = sha256(JSON.stringify(sourceFiles));
  const generation = workspaceDigest.slice(0, 40);

  // The previous manifest describes only files managed by the live source
  // transport.  It must not turn sandbox-generated plans, caches, or other
  // builder-owned state into source files.  A missing/corrupt previous
  // manifest simply receives a complete first transfer.
  let previousFiles: PreparedSourceFile[] = [];
  const previousManifest = await sandbox.readTextFile({
    path: sandboxSourceFilesPath,
  });
  if (previousManifest !== null) {
    try {
      previousFiles = parsePreparedSourceFiles(
        JSON.parse(previousManifest) as unknown,
      );
    } catch {
      previousFiles = [];
    }
  }
  const previousByPath = new Map(
    previousFiles.map((file) => [file.path, file]),
  );
  const currentByPath = new Map(sourceFiles.map((file) => [file.path, file]));
  const deletedPaths = previousFiles
    .filter((file) => !currentByPath.has(file.path))
    .map((file) => file.path);
  const changedFiles = sourceFiles.filter((file) => {
    const previous = previousByPath.get(file.path);
    return (
      previous === undefined ||
      previous.sha256 !== file.sha256 ||
      previous.mode !== file.mode
    );
  });
  const firstTransfer = previousManifest === null || previousFiles.length === 0;

  await ensureSandboxDirectories(sandbox, [".app-builder"]);
  await sandbox.writeTextFile({
    path: ".app-builder/prepare-intent.json",
    content: `${JSON.stringify(
      {
        callId,
        sourcePath: eligibility.sourcePath,
        sourceSha: eligibility.sourceSha,
        sourceTree: generation,
        eligibilityDigest,
        mode: "development-live",
      },
      null,
      2,
    )}\n`,
  });
  if (firstTransfer) {
    await sandbox.removePath({
      path: "repository",
      recursive: true,
      force: true,
    });
    const archive = developmentWorkingTreeArchive(
      eligibility.sourcePath,
      sourceFiles.map(({ path }) => path),
    );
    await sandbox.writeBinaryFile({
      path: sandboxSourceArchivePath,
      content: archive,
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
        throw new Error("The development source could not be materialized.");
    } finally {
      await sandbox.removePath({ path: sandboxSourceArchivePath, force: true });
    }
  } else {
    await ensureSandboxDirectories(
      sandbox,
      changedFiles.map(({ path }) => {
        const parent = path.split("/").slice(0, -1).join("/");
        return parent === "" ? "repository" : `repository/${parent}`;
      }),
    );
    for (const path of deletedPaths)
      await sandbox.removePath({ path: `repository/${path}`, force: true });
    for (const file of changedFiles) {
      await sandbox.writeBinaryFile({
        path: `repository/${file.path}`,
        content: readFileSync(resolve(eligibility.sourcePath, file.path)),
      });
    }
  }
  const modeUpdates = firstTransfer ? sourceFiles : changedFiles;
  if (modeUpdates.length > 0) {
    // Keep the path list out of the shell command. Large working trees can
    // exceed argv limits, and source paths must be revalidated inside the
    // sandbox before their modes are changed.
    const modeListPath = ".app-builder/development-source-modes.json";
    await sandbox.writeTextFile({
      path: modeListPath,
      content: `${JSON.stringify(
        modeUpdates.map(({ mode, path }) => ({
          mode,
          path: `repository/${path}`,
        })),
      )}\n`,
    });
    const chmod = await sandbox.run({
      command: `node -e ${JSON.stringify(
        `const fs=require("node:fs");const path=require("node:path");const root=path.resolve("/workspace/repository");const entries=JSON.parse(fs.readFileSync("/workspace/${modeListPath}","utf8"));if(!Array.isArray(entries))throw new Error("invalid mode list");for(const entry of entries){if(!entry||typeof entry.path!=="string"||!entry.path.startsWith("repository/")||entry.path.includes("\\0")||(entry.mode!=="100644"&&entry.mode!=="100755"))throw new Error("invalid source mode");const target=path.resolve("/workspace",entry.path);if(target!==root&&!target.startsWith(root+path.sep))throw new Error("source path escapes repository");const info=fs.lstatSync(target);if(!info.isFile()||info.isSymbolicLink())throw new Error("source path is not a regular file");fs.chmodSync(target,entry.mode==="100755"?0o755:0o644);}`,
      )}`,
      workingDirectory: "/workspace",
      abortSignal: AbortSignal.timeout(sandboxOperationTimeoutMs),
    });
    if (chmod.exitCode !== 0)
      throw new Error(
        "The development source permissions could not be prepared.",
      );
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
    sourceSha: eligibility.sourceSha,
    sourceTree: generation,
    workspaceDigest,
    adapter: SUPPORTED_TEMPLATE_ADAPTER,
    eligibilityDigest,
  };
  await sandbox.writeTextFile({
    path: sandboxRecordPath,
    content: `${JSON.stringify(record, null, 2)}\n`,
  });
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
