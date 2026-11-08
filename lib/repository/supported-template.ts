import { git, gitByteInvocation, gitNulRecords } from "./source-read-git";
import { inspectDevelopmentSourceGeneration } from "./development-source-generation";
import type { PreparedSourceFile } from "./development-source-generation";

import { retainPreparedLocalSourceBaseline } from "./local-source-baseline-retention";
import { getBuilderSandboxId } from "../sandbox/builder-sandbox";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";
import nodePath from "node:path";
import { tmpdir } from "node:os";

import type { SandboxSession } from "eve/sandbox";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { ensureSandboxDirectories } from "./sandbox-filesystem";
import {
  captureProcessStdout,
  digestProcessStdout,
  digestProcessStdoutSync,
  processStdoutByteStream,
} from "./captured-process-output";
import { safeSourcePath } from "./source-path";
import { hasTestCapability } from "../testing/test-capability";
import { runSequentially } from "../async-sequential";

export { inspectDevelopmentSourceGeneration } from "./development-source-generation";
export type { PreparedSourceFile } from "./development-source-generation";

const microfrontendsConfigFile = "microfrontends.json";
const invalidWorkspaceRecordMessage = "The prepared workspace record is invalid.";
const sandboxRepositoryPath = "/workspace/repository";
const invalidWorkspaceManifestMessage = "The prepared workspace manifest is invalid.";
const sandboxWorkspacePath = "/workspace";
const appBuilderDirectory = ".app-builder";
const prepareIntentFile = ".app-builder/prepare-intent.json";

export const SUPPORTED_TEMPLATE_ADAPTER = "arrusted-development-v0";

export const SUPPORTED_REPOSITORY_CONTRACT = {
  commands: {
    appIdentity: "mise run repository:exec -- app-identity.ts --app <app-id>",
    apply: "mise run create:app <app-id>",
    repositoryPreflight: "mise run repository:preflight",
  },
  requiredPaths: [
    ".config/mise/config.toml",
    ".config/mise/tasks/repository/exec",
    ".config/mise/scripts/repository/resolved-app-creation.ts",
    ".config/mise/scripts/repository/app-identity.ts",
    ".config/mise/scripts/repository/app-validation.ts",
    ".config/mise/scripts/repository/repository-preflight.ts",
    microfrontendsConfigFile,
    "package.json",
  ],
  runtime: "nextjs",
  topologyOwner: microfrontendsConfigFile,
  validationCommands: [
    "mise run --no-deps --skip-tools app:check <app-id>",
    "mise run --no-deps --skip-tools app:test <app-id> <shard>",
  ],
  version: 4,
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
  "scripts/inspect_source-receipt.mts",
  "tsconfig.json",
] as const;

export const SUPPORTED_VALIDATION_COMMAND_TEMPLATES =
  SUPPORTED_REPOSITORY_CONTRACT.validationCommands;
export const SUPPORTED_VALIDATION_TEST_SHARDS = ["1/1"] as const;

/** Match repository discovery without executing source-provided command text. */
export const supportedValidationTestShards = (manifestContent: string): readonly string[] => {
  const object = z.record(z.string(), z.unknown());
  const manifest = object.parse(JSON.parse(manifestContent));
  const scripts = object.safeParse(manifest.scripts);
  const test = scripts.success ? scripts.data.test : undefined;
  if (test === undefined) {
    return [];
  }
  if (typeof test !== "string" || test.trim() === "") {
    throw new Error("The selected app's declared test command must be a non-empty string.");
  }
  const autograph = object.safeParse(manifest.autograph);
  const ci = object.safeParse(autograph.success ? autograph.data.ci : undefined);
  const declared = ci.success ? ci.data.testShards : undefined;
  const shards = declared === undefined ? 1 : declared;
  if (typeof shards !== "number" || !Number.isInteger(shards) || shards < 1) {
    throw new Error("The selected app's declared test shard count must be a positive integer.");
  }
  return Array.from({ length: shards }, (_, index) => `${index + 1}/${shards}`);
};

const expectedCommands = {
  appIdentity: SUPPORTED_REPOSITORY_CONTRACT.commands.appIdentity,
  apply: SUPPORTED_REPOSITORY_CONTRACT.commands.apply,
  preflight: SUPPORTED_REPOSITORY_CONTRACT.commands.repositoryPreflight,
  scaffold: "mise run generate:app <app-id>",
  validation: SUPPORTED_REPOSITORY_CONTRACT.validationCommands,
} as const;

// The runner resolves the selected app's native build and verifies its output. The
// older app:check task always runs lint before build, even with the delivery flag.
const deliveryBuildProgram = `
const appId = process.argv[1];
const stateDirectory = process.env.APP_RUNTIME_STATE_DIR;
delete process.env.APP_RUNTIME_STATE_DIR;
if (stateDirectory) {
  const file = Bun.file(stateDirectory + "/environment.json");
  if (await file.exists()) {
    const runtime = await file.json().catch(() => {
      throw new Error("Could not read the prepared local app environment.");
    });
    const names = [
      appId.toUpperCase().replaceAll("-", "_") + "_DATABASE_URL",
      "DATABASE_URL",
      "DATABASE_URL_UNPOOLED",
      "PLATFORM_AUTH_DATABASE_URL",
      "PLATFORM_AUTH_TRUSTED_ORIGINS",
      "BETTER_AUTH_APP_NAME",
      "BETTER_AUTH_URL",
      "BETTER_AUTH_SECRET",
    ];
    for (const name of names) {
      if (typeof runtime?.[name] === "string") process.env[name] = runtime[name];
    }
  }
}
const root = process.cwd();
const validation = await import("./.config/mise/scripts/repository/app-validation.ts");
if (typeof validation.runApplicationTasks === "function") {
  await validation.runApplicationTasks(root, appId, ["build"]);
} else {
  // Older Arrusted kept its build runner private and exported its selection helpers.
  const { spawnSync } = await import("node:child_process");
  const path = await import("node:path");
  const app = validation.discoverApplications(root).find((candidate) => candidate.id === appId);
  if (!app) throw new Error("Unknown convention-discovered application: " + appId);
  const run = (command, args, env = process.env) => {
    const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  };
  run("bun", [".config/mise/scripts/repository/generate-microfrontends.ts"]);
  const environment = validation.applicationTaskEnvironment?.(root) ?? {
    ...process.env,
    TURBO_TELEMETRY_DISABLED: "1",
    VC_MICROFRONTENDS_CONFIG: path.join(root, ".scratch", "microfrontends", "microfrontends.json"),
  };
  const turbo = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "turbo.exe" : "turbo");
  const taskArguments = validation.applicationTaskArguments ?? validation.lifecycleTaskArguments;
  run(turbo, taskArguments(root, app, "build"), environment);
  if (app.framework === "next") {
    const { assertNativeNextBuild } = await import("./packages/platform-microfrontends/src/hosting/vercel/next-build-output");
    const appRoot = path.join(root, app.directory);
    if (assertNativeNextBuild.length < 3) {
      await assertNativeNextBuild(appRoot, appId);
    } else {
      const { readMicrofrontendsConfig } = await import("@autograph/microfrontends/config");
      const { platformCatalogApplication } = await import("./packages/platform-microfrontends/src/policy/application-identity");
      const selected = platformCatalogApplication(readMicrofrontendsConfig({ cwd: root, environment }), appId);
      await assertNativeNextBuild(appRoot, appId, selected.assetPrefix === null ? "" : "/" + selected.assetPrefix);
    }
  }
}
`.trim();

const repositoryDeliveryBuild = (appId: string) =>
  `BUN_OPTIONS="\${BUN_OPTIONS:+$BUN_OPTIONS }--conditions=source" mise exec --no-deps -- bun -e '${deliveryBuildProgram}' ${appId}` as const;

export const repositoryDeliveryBuildCommand = (appId: string, alreadyCompiled?: true) => {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(appId)) {
    throw new Error("The validation application id is invalid.");
  }
  return alreadyCompiled === true
    ? repositoryDeliveryBuild(appId)
    : (`mise run --no-deps --skip-tools app:compile ${appId} && ${repositoryDeliveryBuild(appId)}` as const);
};

export const supportedValidationCommands = function supportedValidationCommands(
  appId: string,
  testShards: readonly string[] = SUPPORTED_VALIDATION_TEST_SHARDS,
  options?: { alreadyCompiled?: true },
) {
  if (testShards.some((shard) => !/^[1-9][0-9]*\/[1-9][0-9]*$/u.test(shard))) {
    throw new Error("The validation test shard set is invalid.");
  }
  const compileDependency = options?.alreadyCompiled === true ? "--skip-deps " : "";
  return [
    {
      command: repositoryDeliveryBuildCommand(appId, options?.alreadyCompiled),
      name: "check-build" as const,
    },
    ...testShards.map((shard) => ({
      command:
        `mise run --no-deps ${compileDependency}--skip-tools app:test ${appId} ${shard}` as const,
      name: "test" as const,
    })),
  ];
};

export interface EligibilityResult {
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
    scaffoldCommand: string;
    applyCommand: string;
    repositoryPreflightCommand: string;
    topologyOwner: string;
    validationCommands: readonly string[];
    releaseGate: string;
  };
  digest: string;
}

/**
 * Git metadata and the small, closed set of source files the V0 adapter
 * needs to determine eligibility.  It lets a canonical sandbox clone be
 * inspected without creating a second host-side checkout.
 */
export interface SupportedTemplateSnapshot {
  sourcePath: string;
  sourceSha?: string;
  dirtyPaths: string[];
  failures?: string[];
  contents: Partial<Record<string, string>>;
}

const sha256 = function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting.
function fileReadableStream(filePath: string): ReadableStream<Uint8Array> {
  const file = createReadStream(filePath);
  const iterator = file[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    cancel() {
      file.destroy();
    },
    async pull(controller) {
      const next = await iterator.next();
      if (next.done === true) {
        controller.close();
      } else if (next.value instanceof Uint8Array) {
        controller.enqueue(next.value);
      } else {
        controller.error(new Error("The development source returned non-byte file content."));
      }
    },
  });
}

interface DependencyFile {
  path: (typeof SUPPORTED_TEMPLATE_DEPENDENCY_PATHS)[number];
  mode: "100644" | "100755";
  objectId: string;
  sha256: string;
}

export interface SupportedTemplateDependencyClosure {
  commit: string;
  tree: string;
  files: DependencyFile[];
  digest: string;
}

const gitBytes = function gitBytes(path: string, args: string[]): Buffer {
  const command = gitByteInvocation(path, args);
  return captureProcessStdout(command.command, command.args, command.options);
};

export const inspectSupportedTemplateDependencyClosure =
  function inspectSupportedTemplateDependencyClosure(
    repositoryRoot: string,
    commit = "HEAD",
  ): SupportedTemplateDependencyClosure {
    const resolvedCommit = git(repositoryRoot, ["rev-parse", `${commit}^{commit}`]);
    const tree = git(repositoryRoot, ["rev-parse", `${resolvedCommit}^{tree}`]);
    const files = SUPPORTED_TEMPLATE_DEPENDENCY_PATHS.map((path) => {
      const entry = git(repositoryRoot, ["ls-tree", resolvedCommit, "--", path]);
      const match = /^(?<mode>100644|100755) blob (?<objectId>[0-9a-f]{40,64})\t(?<path>.+)$/u.exec(
        entry,
      );
      if (match === null || match.groups?.path !== path) {
        throw new Error(`Adapter dependency is not a regular Git blob: ${path}`);
      }
      return {
        mode: match.groups.mode as DependencyFile["mode"],
        objectId: match.groups.objectId,
        path,
        sha256: (() => {
          const command = gitByteInvocation(repositoryRoot, ["show", `${resolvedCommit}:${path}`]);
          return digestProcessStdoutSync(command.command, command.args, command.options);
        })(),
      };
    });
    return {
      commit: resolvedCommit,
      digest: sha256(JSON.stringify(files)),
      files,
      tree,
    };
  };

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Preserve the existing open-ended value contract.
const configurationRecord = function configurationRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Preserve the existing open-ended value contract.
      (value as Record<string, unknown>)
    : {};
};

const checkoutFreeReleaseGate = `set -euo pipefail
value="$REPOSITORY_RELEASE_ENABLED"
enabled=false
if [[ "$value" == "true" ]]; then
  enabled=true
fi
echo "enabled=$enabled" >> "$GITHUB_OUTPUT"
`;

const repositoryReleasePolicyPath = ".github/workflows/cd.yml" as const;

const supportsReleaseGate = function supportsReleaseGate(workflowSource: string): boolean {
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Preserve the existing open-ended value contract.
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
  if (
    templateSafety.name !== "Authorize (Template instance safety)" ||
    JSON.stringify(templateSafety.permissions) !== JSON.stringify({}) ||
    JSON.stringify(templateSafety.outputs) !==
      JSON.stringify({ enabled: `\${{ steps.safety.outputs.enabled }}` }) ||
    steps.length !== 1
  ) {
    return false;
  }
  if (
    safety.id !== "safety" ||
    safety.name !== "Read active repository safety flag" ||
    JSON.stringify(safety.env) !==
      JSON.stringify({
        REPOSITORY_RELEASE_ENABLED: `\${{ vars.REPOSITORY_RELEASE_ENABLED }}`,
      })
  ) {
    return false;
  }
  return (
    safety.run === checkoutFreeReleaseGate &&
    scope.needs === "template-safety" &&
    scope.if === expectedScopeCondition
  );
};

export interface RepositoryReleasePolicyObservation {
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
}

const releasePolicyObservation = function releasePolicyObservation(input: {
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
          mode: input.workflow.mode,
          objectId: input.workflow.objectId,
          path: repositoryReleasePolicyPath,
          sha256: sha256(input.workflow.bytes),
          status: "present" as const,
        };
  const unsigned = {
    eligible:
      input.workflow.status === "present" &&
      supportsReleaseGate(Buffer.from(input.workflow.bytes).toString("utf-8")),
    gate: "REPOSITORY_RELEASE_ENABLED" as const,
    sourceSha: input.sourceSha,
    sourceTree: input.sourceTree,
    workflow,
  };
  return { ...unsigned, digest: sha256(JSON.stringify(unsigned)) };
};

/**
 * Re-read the release policy from the reviewed commit, never from mutable
 * working-tree bytes. Outward existing-repository effects use this after
 * approval so planning compatibility can remain independent of CD layout.
 */
export const inspectRepositoryReleasePolicyAtGitSnapshot =
  function inspectRepositoryReleasePolicyAtGitSnapshot(input: {
    sourcePath: string;
    sourceSha: string;
    sourceTree: string;
  }): RepositoryReleasePolicyObservation {
    const sourceSha = git(input.sourcePath, ["rev-parse", `${input.sourceSha}^{commit}`]);
    const sourceTree = git(input.sourcePath, ["rev-parse", `${sourceSha}^{tree}`]);
    if (sourceSha !== input.sourceSha || sourceTree !== input.sourceTree) {
      throw new Error(
        "The existing-repository release policy is not bound to the reviewed Git snapshot.",
      );
    }
    const entry = git(input.sourcePath, ["ls-tree", sourceSha, "--", repositoryReleasePolicyPath]);
    const match = /^(?<mode>100644|100755) blob (?<objectId>[0-9a-f]{40,64})\t(?<path>.+)$/u.exec(
      entry,
    );
    if (match === null || match.groups?.path !== repositoryReleasePolicyPath) {
      return releasePolicyObservation({
        sourceSha,
        sourceTree,
        workflow: { status: "absent" },
      });
    }
    return releasePolicyObservation({
      sourceSha,
      sourceTree,
      workflow: {
        bytes: gitBytes(input.sourcePath, ["show", `${sourceSha}:${repositoryReleasePolicyPath}`]),
        mode: match.groups.mode as "100644" | "100755",
        objectId: match.groups.objectId,
        status: "present",
      },
    });
  };

export const assertRepositoryReleasePolicyAtGitSnapshot =
  function assertRepositoryReleasePolicyAtGitSnapshot(input: {
    sourcePath: string;
    sourceSha: string;
    sourceTree: string;
  }): RepositoryReleasePolicyObservation {
    const observation = inspectRepositoryReleasePolicyAtGitSnapshot(input);
    if (!observation.eligible) {
      throw new Error(
        "The reviewed repository does not satisfy the release policy required for outward effects.",
      );
    }
    return observation;
  };

const declaredNextRuntime = function declaredNextRuntime(
  packageSource: string,
): "nextjs" | "unsupported" {
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Preserve the existing open-ended value contract.
  let packageManifest: Record<string, unknown>;
  try {
    packageManifest = configurationRecord(JSON.parse(packageSource) as unknown);
  } catch {
    return "unsupported";
  }
  const dependencies = configurationRecord(packageManifest.dependencies);
  const devDependencies = configurationRecord(packageManifest.devDependencies);
  const next = dependencies.next ?? devDependencies.next;
  return typeof next === "string" && next.trim() !== "" ? "nextjs" : "unsupported";
};

const declaredMiseTasks = function declaredMiseTasks(source: string): Map<string, number> {
  const tasks = new Map<string, number>();
  for (const match of source.matchAll(/^\[tasks\."(?<name>[^"]+)"\]\s*$/gmu)) {
    const name = match.groups?.name;
    if (name !== undefined) {
      tasks.set(name, (tasks.get(name) ?? 0) + 1);
    }
  }
  return tasks;
};

const hasOneTask = function hasOneTask(tasks: ReadonlyMap<string, number>, name: string): boolean {
  return tasks.get(name) === 1;
};

const inspectPlanningCompatibility = function inspectPlanningCompatibility(
  contents: SupportedTemplateSnapshot["contents"],
) {
  const failures: string[] = [];
  for (const path of SUPPORTED_REPOSITORY_CONTRACT.requiredPaths) {
    if (!safeSourcePath(path)) {
      throw new Error("The supported repository contract contains an unsafe path.");
    }
    if (path !== SUPPORTED_REPOSITORY_CONTRACT.topologyOwner && contents[path] === undefined) {
      failures.push(`missing required path ${path}`);
    }
  }

  const runtime = declaredNextRuntime(contents["package.json"] ?? "");
  if (runtime === "unsupported") {
    failures.push("repository does not declare the Next.js runtime");
  }

  const tasks = declaredMiseTasks(contents[".config/mise/config.toml"] ?? "");
  if (!hasOneTask(tasks, "repository:preflight")) {
    failures.push("repository:preflight command is missing");
  }
  if (
    contents[".config/mise/tasks/repository/exec"] === undefined ||
    contents[".config/mise/scripts/repository/app-identity.ts"] === undefined ||
    contents[".config/mise/scripts/repository/resolved-app-creation.ts"] === undefined
  ) {
    failures.push("repository:exec command is unavailable");
  }
  // Topology ownership is advisory capability information for older
  // checkouts, not source-admission authority.

  const observed = {
    appIdentityCommand: SUPPORTED_REPOSITORY_CONTRACT.commands.appIdentity,
    applyCommand: SUPPORTED_REPOSITORY_CONTRACT.commands.apply,
    contractVersion: SUPPORTED_REPOSITORY_CONTRACT.version,
    repositoryPreflightCommand: SUPPORTED_REPOSITORY_CONTRACT.commands.repositoryPreflight,
    requiredPaths: [...SUPPORTED_REPOSITORY_CONTRACT.requiredPaths],
    runtime,
    topologyOwner: SUPPORTED_REPOSITORY_CONTRACT.topologyOwner,
    validationCommands: SUPPORTED_REPOSITORY_CONTRACT.validationCommands,
  } as const;
  const sortedFailures = failures.toSorted();
  return {
    digest: sha256(
      JSON.stringify({
        adapter: SUPPORTED_TEMPLATE_ADAPTER,
        failures: sortedFailures,
        observed,
      }),
    ),
    eligible: sortedFailures.length === 0,
    failures: sortedFailures,
    observed,
  };
};

export const inspectSupportedTemplateSnapshot = function inspectSupportedTemplateSnapshot(
  input: SupportedTemplateSnapshot,
): EligibilityResult {
  const failures = [...(input.failures ?? [])];
  const { contents } = input;
  const planningCompatibility = inspectPlanningCompatibility(contents);
  for (const path of SUPPORTED_TEMPLATE_INPUT_PATHS) {
    if (path !== SUPPORTED_REPOSITORY_CONTRACT.topologyOwner && contents[path] === undefined) {
      failures.push(`missing required path ${path}`);
    }
  }
  if (contents[".config/repository-template.json"] !== undefined) {
    failures.push("V0 does not accept a repository-template manifest");
  }

  const resolvedCreation =
    contents[".config/mise/scripts/repository/resolved-app-creation.ts"] ?? "";
  const adapterRuntime = /runtime:\s*"nextjs"/u.test(resolvedCreation) ? "nextjs" : "unsupported";
  if (adapterRuntime === "unsupported") {
    failures.push("app generator does not declare the Next.js runtime");
  }

  const generator = contents[".config/turbo/generators/config.ts"] ?? "";
  const packageScope = generator.includes("autograph") ? "@autograph" : "unsupported";
  if (packageScope === "unsupported") {
    failures.push("workspace package scope is not @autograph");
  }

  const mise = contents[".config/mise/config.toml"] ?? "";
  if (!mise.includes('[tasks."create:app"]')) {
    failures.push("create:app command is missing");
  }
  if (!mise.includes('[tasks."repository:preflight"]')) {
    failures.push("repository:preflight command is missing");
  }
  // Validation command spellings are advisory and may differ in older
  // Arrusted checkouts.
  if (
    !mise.includes('[tasks."generate:app"]') ||
    !mise.includes("turbo gen --config .config/turbo/generators/config.ts app --args")
  ) {
    failures.push("generate:app command drifted");
  }

  const preflight = contents[".config/mise/scripts/repository/repository-preflight.ts"] ?? "";
  if (!preflight.includes('runtime: "nextjs"')) {
    failures.push("repository preflight does not declare the Next.js runtime");
  }
  // Preflight command-list parity is advisory capability information.

  const cd = contents[".github/workflows/cd.yml"] ?? "";
  const releasePolicy = {
    eligible: supportsReleaseGate(cd),
    gate: "REPOSITORY_RELEASE_ENABLED" as const,
  };
  if (!releasePolicy.eligible) {
    failures.push("REPOSITORY_RELEASE_ENABLED gate is not the supported CD gate");
  }

  const normalized = {
    adapter: SUPPORTED_TEMPLATE_ADAPTER,
    dirtyPaths: input.dirtyPaths.toSorted(),
    failures: failures.toSorted(),
    observed: {
      appIdentityCommand: expectedCommands.appIdentity,
      applyCommand: expectedCommands.apply,
      contractVersion: planningCompatibility.observed.contractVersion,
      packageScope,
      releaseGate: "REPOSITORY_RELEASE_ENABLED",
      repositoryPreflightCommand: expectedCommands.preflight,
      requiredPaths: planningCompatibility.observed.requiredPaths,
      runtime: planningCompatibility.observed.runtime,
      scaffoldCommand: expectedCommands.scaffold,
      topologyOwner: microfrontendsConfigFile,
      validationCommands: expectedCommands.validation,
    },
    sourceSha: input.sourceSha,
  } as const;
  return {
    ...normalized,
    compatibilityDigest: planningCompatibility.digest,
    digest: sha256(JSON.stringify(normalized)),
    eligible: failures.length === 0,
    planningEligible: planningCompatibility.eligible,
    planningFailures: planningCompatibility.failures,
    releasePolicy,
    sourcePath: input.sourcePath,
  };
};

const allowedRoots = function allowedRoots(): string[] {
  const value = process.env.REPOSITORY_LOCAL_ROOTS;
  if (value === undefined || value.trim() === "") {
    if (hasTestCapability("simulated-target")) {
      return [tmpdir()];
    }
    throw new Error("REPOSITORY_LOCAL_ROOTS must name at least one allowed local source root.");
  }
  return value
    .split(nodePath.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => nodePath.resolve(entry));
};

const within = function within(root: string, candidate: string): boolean {
  const relativePath = nodePath.relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${nodePath.sep}`) &&
      !nodePath.isAbsolute(relativePath))
  );
};

export const resolveAllowedRepository = async function resolveAllowedRepository(
  input: string,
): Promise<string> {
  const candidate = await realpath(nodePath.resolve(input));
  // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Keep source and filesystem observations in their established order.
  const roots = await Promise.all(allowedRoots().map((root) => realpath(root)));
  if (!roots.some((root) => within(root, candidate))) {
    throw new Error("The repository path is outside REPOSITORY_LOCAL_ROOTS.");
  }
  return candidate;
};

const inspectSupportedRepositoryAtPath = function inspectSupportedRepositoryAtPath(
  sourcePath: string,
): EligibilityResult {
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
      .toString("utf-8")
      .split("\0");
    for (let index = 0; index < statusRecords.length; index += 1) {
      const record = statusRecords[index];
      if (record === undefined || record === "") {
        continue;
      }
      if (record.length < 4 || record[2] !== " ") {
        throw new Error("Git returned a malformed worktree status record.");
      }
      dirtyPaths.push(record.slice(3));
      if (/[RC]/u.test(record.slice(0, 2))) {
        const originalPath = statusRecords[index + 1];
        if (originalPath === undefined || originalPath === "") {
          throw new Error("Git returned a malformed rename status record.");
        }
        dirtyPaths.push(originalPath);
        index += 1;
      }
    }
  } catch {
    failures.push("source is not a readable Git worktree");
  }

  const contents = Object.fromEntries(
    [...SUPPORTED_TEMPLATE_INPUT_PATHS, ".config/repository-template.json"].map((path) => {
      if (sourceSha === undefined) {
        return [path, undefined];
      }
      const entry = git(sourcePath, ["ls-tree", sourceSha, "--", path]);
      const match = /^(?<mode>100644|100755) blob (?<objectId>[0-9a-f]{40,64})\t(?<path>.+)$/u.exec(
        entry,
      );
      return [
        path,
        match !== null && match.groups?.path === path
          ? gitBytes(sourcePath, ["show", `${sourceSha}:${path}`]).toString("utf-8")
          : undefined,
      ];
    }),
  );
  return inspectSupportedTemplateSnapshot({
    contents,
    dirtyPaths,
    failures,
    sourcePath,
    sourceSha,
  });
};

export const inspectSupportedRepository = async function inspectSupportedRepository(
  input: string,
): Promise<EligibilityResult> {
  const sourcePath = await resolveAllowedRepository(input);
  return inspectSupportedRepositoryAtPath(sourcePath);
};

/**
 * Inspects a path that was created by the builder's canonical template-clone
 * transport. It is deliberately not exported through a tool boundary: callers
 * must first prove the fixed remote/ref/SHA transport contract.
 */
export const inspectBuilderOwnedSupportedRepository =
  async function inspectBuilderOwnedSupportedRepository(input: string): Promise<EligibilityResult> {
    return inspectSupportedRepositoryAtPath(await realpath(nodePath.resolve(input)));
  };

/**
 * Evaluate the repository-owned adapter contract from an already captured
 * snapshot.  The same function is used for ordinary local repositories and
 * for the fixed canonical clone inside an Eve session.
 */

export interface PreparedSandboxWorkspace {
  workspaceId: string;
  workspacePath: "/workspace/repository";
  sourcePath: string;
  sourceSha: string;
  sourceTree: string;
  workspaceDigest: string;
  adapter: typeof SUPPORTED_TEMPLATE_ADAPTER;
  eligibilityDigest: string;
}

const sandboxRecordPath = ".app-builder/prepared-workspace.json";
const sandboxSourceFilesPath = ".app-builder/source-files.json";
const sandboxSourceChecksumsPath = ".app-builder/source-checksums.sha256";
const sandboxSourceArchivePath = ".app-builder/source-tree.tar.gz";

const fixtureSandboxEnabled = () => hasTestCapability("simulated-target");

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Preserve the existing open-ended value contract.
const isPreparedRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = function exactKeys(
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Preserve the existing open-ended value contract.
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  const allowed = new Set(expected);
  return actual.length === allowed.size && actual.every((key) => allowed.has(key));
};

const preparedSourceChecksums = function preparedSourceChecksums(
  files: readonly PreparedSourceFile[],
): string {
  const checksums = files.map(({ path, sha256: digest }) => `${digest}  repository/${path}`);
  return `${checksums.join("\n")}\n`;
};

/**
 * Development is deliberately a live working-tree transport. The archive is
 * only a first-transfer transport; subsequent transfers use the manifest
 * delta below so ordinary edits do not replace the sandbox workspace.
 */
const developmentWorkingTreeArchive = async function developmentWorkingTreeArchive(
  sandbox: SandboxSession,
  sourcePath: string,
  paths: readonly string[],
): Promise<void> {
  const archiveProcess = spawn(
    // oxlint-disable-next-line sonarjs/no-os-command-from-path -- This operation invokes the environment-provided tar executable.
    "tar",
    ["--create", "--gzip", "--file=-", "--null", "--files-from=-"],
    {
      cwd: sourcePath,
      env: {
        ...process.env,
        COPYFILE_DISABLE: "1",
        COPY_EXTENDED_ATTRIBUTES_DISABLE: "1",
      },
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  if (archiveProcess.stdout === null || archiveProcess.stdin === null) {
    throw new Error("The development source archive could not be streamed.");
  }
  const archiveOutputIterator = archiveProcess.stdout[Symbol.asyncIterator]();
  const archiveStream = new ReadableStream<Uint8Array>({
    cancel() {
      archiveProcess.kill();
    },
    async pull(controller) {
      const next = await archiveOutputIterator.next();
      if (next.done === true) {
        controller.close();
        return;
      }
      if (!(next.value instanceof Uint8Array)) {
        controller.error(new Error("tar emitted a non-byte archive chunk."));
        return;
      }
      controller.enqueue(next.value);
    },
  });
  const archiveCompletion = once(archiveProcess, "close");
  try {
    const transfer = sandbox.writeFile({ content: archiveStream, path: sandboxSourceArchivePath });
    for (const path of paths) {
      if (!archiveProcess.stdin.write(`${path}\0`)) {
        // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Process the archive or source entries in order.
        await once(archiveProcess.stdin, "drain");
      }
    }
    archiveProcess.stdin.end();
    await transfer;
    await archiveCompletion;
    if (archiveProcess.exitCode !== 0) {
      throw new Error("The development source archive could not be created.");
    }
  } catch (error) {
    archiveProcess.kill();
    throw error;
  }
};

export const parsePreparedWorkspace = function parsePreparedWorkspace(
  input: unknown,
): PreparedSandboxWorkspace {
  if (
    !isPreparedRecord(input) ||
    !exactKeys(input, [
      "workspaceId",
      "workspacePath",
      "sourcePath",
      "sourceSha",
      "sourceTree",
      "workspaceDigest",
      "adapter",
      "eligibilityDigest",
    ])
  ) {
    throw new Error(invalidWorkspaceRecordMessage);
  }
  const record = input as Partial<PreparedSandboxWorkspace>;
  if (
    typeof record.workspaceId !== "string" ||
    record.workspaceId === "" ||
    record.workspacePath !== sandboxRepositoryPath ||
    typeof record.sourcePath !== "string"
  ) {
    throw new Error(invalidWorkspaceRecordMessage);
  }
  if (
    !nodePath.isAbsolute(record.sourcePath) ||
    typeof record.sourceSha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(record.sourceSha)
  ) {
    throw new Error(invalidWorkspaceRecordMessage);
  }
  if (typeof record.sourceTree !== "string" || !/^[0-9a-f]{40}$/u.test(record.sourceTree)) {
    throw new Error(invalidWorkspaceRecordMessage);
  }
  if (
    typeof record.workspaceDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.workspaceDigest) ||
    record.adapter !== SUPPORTED_TEMPLATE_ADAPTER
  ) {
    throw new Error(invalidWorkspaceRecordMessage);
  }
  if (
    typeof record.eligibilityDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.eligibilityDigest)
  ) {
    throw new Error(invalidWorkspaceRecordMessage);
  }
  return record as PreparedSandboxWorkspace;
};

const parsePreparedSourceFiles = function parsePreparedSourceFiles(
  input: unknown,
): PreparedSourceFile[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error(invalidWorkspaceManifestMessage);
  }
  const paths = new Set<string>();
  return input.map((candidate) => {
    if (
      !isPreparedRecord(candidate) ||
      !exactKeys(candidate, ["mode", "objectId", "path", "sha256"])
    ) {
      throw new Error(invalidWorkspaceManifestMessage);
    }
    const file = candidate as Partial<PreparedSourceFile>;
    if (
      !["100644", "100755"].includes(file.mode ?? "") ||
      typeof file.objectId !== "string" ||
      !/^[0-9a-f]{40}$/u.test(file.objectId) ||
      typeof file.path !== "string"
    ) {
      throw new Error(invalidWorkspaceManifestMessage);
    }
    if (
      !safeSourcePath(file.path) ||
      paths.has(file.path) ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(file.sha256)
    ) {
      throw new Error(invalidWorkspaceManifestMessage);
    }
    paths.add(file.path);
    return file as PreparedSourceFile;
  });
};

/** Reads and validates prepared-workspace metadata without inspecting source bytes. */
export const readPreparedSandboxWorkspaceRecord = async function readPreparedSandboxWorkspaceRecord(
  sandbox: SandboxSession,
): Promise<PreparedSandboxWorkspace | undefined> {
  const content = await sandbox.readTextFile({ path: sandboxRecordPath });
  if (content === null) {
    return undefined;
  }
  try {
    return parsePreparedWorkspace(JSON.parse(content) as unknown);
  } catch (error) {
    throw new Error(invalidWorkspaceRecordMessage, {
      cause: error,
    });
  }
};

/**
 * Reads the exact prepared manifest and binds it to validated workspace
 * metadata. Callers remain responsible for independently verifying or
 * reading the referenced source bytes.
 */
export const readPreparedSandboxSourceManifest = async function readPreparedSandboxSourceManifest(
  sandbox: SandboxSession,
  workspace: PreparedSandboxWorkspace,
): Promise<PreparedSourceFile[]> {
  const manifestContent = await sandbox.readTextFile({
    path: sandboxSourceFilesPath,
  });
  if (manifestContent === null) {
    throw new Error("The prepared workspace manifest is missing.");
  }
  let files: PreparedSourceFile[];
  try {
    files = parsePreparedSourceFiles(JSON.parse(manifestContent) as unknown);
  } catch (error) {
    throw new Error(invalidWorkspaceManifestMessage, {
      cause: error,
    });
  }
  if (sha256(JSON.stringify(files)) !== workspace.workspaceDigest) {
    throw new Error("The prepared workspace manifest no longer matches its receipt.");
  }
  return files;
};

const readVerifiedPreparedSandboxBaseline = async function readVerifiedPreparedSandboxBaseline(
  sandbox: SandboxSession,
  record: PreparedSandboxWorkspace,
): Promise<PreparedSourceFile[]> {
  const files = await readPreparedSandboxSourceManifest(sandbox, record);
  // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Keep source and filesystem observations in their established order.
  const checksums = await sandbox.readTextFile({
    path: sandboxSourceChecksumsPath,
  });
  if (checksums !== preparedSourceChecksums(files)) {
    throw new Error("The prepared workspace checksum receipt drifted.");
  }
  return files;
};

const verifyPreparedSandboxFiles = async (
  sandbox: SandboxSession,
  files: readonly PreparedSourceFile[],
  checksumsPath: string,
): Promise<void> => {
  if (files.length === 0) {
    return;
  }
  if (fixtureSandboxEnabled()) {
    for (const file of files) {
      // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Process the archive or source entries in order.
      const content = await sandbox.readBinaryFile({
        path: `repository/${file.path}`,
      });
      if (content === null || sha256(content) !== file.sha256) {
        throw new Error("A prepared workspace file drifted or is missing.");
      }
    }
    return;
  }
  const verification = await sandbox.run({
    command: `sha256sum -c ${checksumsPath} >/dev/null 2>&1`,
    workingDirectory: sandboxWorkspacePath,
  });
  if (verification.exitCode !== 0) {
    throw new Error("A prepared workspace file drifted or is missing.");
  }
};

const verifyPreparedSandboxWorkspace = async (
  sandbox: SandboxSession,
  record: PreparedSandboxWorkspace,
): Promise<void> => {
  const files = await readVerifiedPreparedSandboxBaseline(sandbox, record);
  await verifyPreparedSandboxFiles(sandbox, files, sandboxSourceChecksumsPath);
};

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

const developmentWorkspaceInspectionReceipt = {
  realRepository: sandboxRepositoryPath,
  realWorkspace: sandboxWorkspacePath,
  repositoryInput: sandboxRepositoryPath,
  workspaceRoot: sandboxWorkspacePath,
} as const;

const verifySandboxWorkspaceBoundary = async function verifySandboxWorkspaceBoundary(
  sandbox: SandboxSession,
  record: PreparedSandboxWorkspace,
  kind: "development" | "legacy" = "development",
): Promise<void> {
  if (
    record.workspaceId !== getBuilderSandboxId(sandbox) ||
    record.workspacePath !== sandboxRepositoryPath
  ) {
    throw new Error(`The prepared ${kind} workspace does not belong to this session.`);
  }
  const node = fixtureSandboxEnabled() ? JSON.stringify(process.execPath) : "node";
  const inspection = await sandbox.run({
    command: `cd /workspace && ${node} -e ${JSON.stringify(developmentWorkspaceInspectionProgram)}`,
  });
  const normalizedStdout = inspection.stdout
    .replaceAll(new RegExp(`${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`, "gu"), "")
    .trim();
  if (inspection.exitCode !== 0) {
    throw new Error(`The prepared ${kind} workspace inspection command failed.`);
  }
  let observed: unknown;
  try {
    observed = JSON.parse(normalizedStdout) as unknown;
  } catch {
    throw new Error(`The prepared ${kind} workspace escaped its sandbox boundary.`);
  }
  if (
    !isPreparedRecord(observed) ||
    !exactKeys(observed, Object.keys(developmentWorkspaceInspectionReceipt))
  ) {
    throw new Error(`The prepared ${kind} workspace escaped its sandbox boundary.`);
  }
  if (
    Object.entries(developmentWorkspaceInspectionReceipt).some(
      ([key, expected]) => observed[key] !== expected,
    )
  ) {
    throw new Error(`The prepared ${kind} workspace escaped its sandbox boundary.`);
  }
};

/** Compare selected source and baseline provenance, excluding eligibility diagnostics. */
export const samePreparedWorkspaceSourceContext = function samePreparedWorkspaceSourceContext(
  observed: PreparedSandboxWorkspace,
  expected: PreparedSandboxWorkspace,
): boolean {
  if (
    observed.workspaceId !== expected.workspaceId ||
    observed.workspacePath !== expected.workspacePath ||
    observed.sourcePath !== expected.sourcePath ||
    observed.sourceSha !== expected.sourceSha
  ) {
    return false;
  }
  return (
    observed.sourceTree === expected.sourceTree &&
    observed.workspaceDigest === expected.workspaceDigest &&
    observed.adapter === expected.adapter
  );
};

const verifyLegacyLiveSandboxWorkspace = async function verifyLegacyLiveSandboxWorkspace(
  sandbox: SandboxSession,
  record: PreparedSandboxWorkspace,
): Promise<void> {
  await verifySandboxWorkspaceBoundary(sandbox, record, "legacy");
  // The manifest describes the selected base, not the current writable app.
  await readVerifiedPreparedSandboxBaseline(sandbox, record);
};

export type PreparedSandboxWorkspaceStatus =
  | { state: "absent" }
  | { state: "prepared"; workspace: PreparedSandboxWorkspace };

export const inspectPreparedSandboxWorkspace = async function inspectPreparedSandboxWorkspace(
  sandbox: SandboxSession,
  mode: "exact" | "development-live" | "legacy-live" = "exact",
): Promise<PreparedSandboxWorkspaceStatus> {
  const record = await readPreparedSandboxWorkspaceRecord(sandbox);
  if (record === undefined) {
    return { state: "absent" };
  }
  if (mode === "legacy-live") {
    await verifyLegacyLiveSandboxWorkspace(sandbox, record);
  } else {
    await (mode === "development-live"
      ? verifySandboxWorkspaceBoundary(sandbox, record)
      : verifyPreparedSandboxWorkspace(sandbox, record));
  }
  return { state: "prepared", workspace: record };
};

/** Returns the exact prepared source manifest after verifying its receipt and bytes. */
export const inspectPreparedSandboxSourceFiles = async function inspectPreparedSandboxSourceFiles(
  sandbox: SandboxSession,
): Promise<PreparedSourceFile[]> {
  const prepared = await inspectPreparedSandboxWorkspace(sandbox);
  if (prepared.state !== "prepared") {
    throw new Error("The prepared source workspace is missing.");
  }
  return await readPreparedSandboxSourceManifest(sandbox, prepared.workspace);
};

/**
 * Re-read and verify the full release policy from the exact prepared Git tree.
 * Hosted execution has no host checkout, so the prepared manifest is the
 * selected snapshot's object-id and byte-digest authority.
 */
export const inspectPreparedSandboxReleasePolicy =
  async function inspectPreparedSandboxReleasePolicy(input: {
    sandbox: SandboxSession;
    sourceSha: string;
    sourceTree: string;
    workspaceDigest: string;
  }): Promise<RepositoryReleasePolicyObservation> {
    const prepared = await inspectPreparedSandboxWorkspace(input.sandbox, "legacy-live");
    if (
      prepared.state !== "prepared" ||
      prepared.workspace.sourceSha !== input.sourceSha ||
      prepared.workspace.sourceTree !== input.sourceTree ||
      prepared.workspace.workspaceDigest !== input.workspaceDigest
    ) {
      throw new Error("The hosted release policy is not bound to the reviewed Git snapshot.");
    }
    const files = await readPreparedSandboxSourceManifest(input.sandbox, prepared.workspace);
    const entry = files.find(({ path }) => path === repositoryReleasePolicyPath);
    if (entry === undefined) {
      return releasePolicyObservation({
        sourceSha: input.sourceSha,
        sourceTree: input.sourceTree,
        workflow: { status: "absent" },
      });
    }
    const bytes = await input.sandbox.readBinaryFile({
      path: `repository/${repositoryReleasePolicyPath}`,
    });
    if (bytes === null || sha256(bytes) !== entry.sha256) {
      throw new Error("The hosted release-policy bytes changed after review.");
    }
    return releasePolicyObservation({
      sourceSha: input.sourceSha,
      sourceTree: input.sourceTree,
      workflow: {
        bytes,
        mode: entry.mode,
        objectId: entry.objectId,
        status: "present",
      },
    });
  };

export const assertPreparedSandboxReleasePolicy =
  async function assertPreparedSandboxReleasePolicy(input: {
    sandbox: SandboxSession;
    sourceSha: string;
    sourceTree: string;
    workspaceDigest: string;
  }): Promise<RepositoryReleasePolicyObservation> {
    const observation = await inspectPreparedSandboxReleasePolicy(input);
    if (!observation.eligible) {
      throw new Error(
        "The reviewed repository does not satisfy the release policy required for outward effects.",
      );
    }
    return observation;
  };

/**
 * Seal an already materialized workspace after the producer has written the
 * exact source manifest and checksum receipt.  Canonical remote clones use
 * this instead of serializing a host checkout into an archive.
 */
export const recordPreparedSandboxWorkspace = async function recordPreparedSandboxWorkspace(input: {
  sandbox: SandboxSession;
  callId: string;
  sourcePath: string;
  sourceSha: string;
  sourceTree: string;
  eligibilityDigest: string;
  workspaceDigest: string;
}): Promise<PreparedSandboxWorkspace> {
  const expected: Omit<PreparedSandboxWorkspace, "workspaceId"> = {
    adapter: SUPPORTED_TEMPLATE_ADAPTER,
    eligibilityDigest: input.eligibilityDigest,
    sourcePath: input.sourcePath,
    sourceSha: input.sourceSha,
    sourceTree: input.sourceTree,
    workspaceDigest: input.workspaceDigest,
    workspacePath: sandboxRepositoryPath,
  };
  const existing = await readPreparedSandboxWorkspaceRecord(input.sandbox);
  if (existing !== undefined && existing.workspaceId !== getBuilderSandboxId(input.sandbox)) {
    throw new Error("This app build already owns a different workspace.");
  }
  if (existing !== undefined) {
    // Source changes and generated files are ordinary work inside the same
    // session-owned checkout. Refresh the diagnostic metadata below.
  }

  await ensureSandboxDirectories(input.sandbox, [appBuilderDirectory]);
  await input.sandbox.writeTextFile({
    content: `${JSON.stringify(
      {
        callId: input.callId,
        eligibilityDigest: input.eligibilityDigest,
        sourcePath: input.sourcePath,
        sourceSha: input.sourceSha,
        sourceTree: input.sourceTree,
      },
      null,
      2,
    )}\n`,
    path: prepareIntentFile,
  });
  const record: PreparedSandboxWorkspace = {
    workspaceId: getBuilderSandboxId(input.sandbox),
    ...expected,
  };
  await input.sandbox.writeTextFile({
    content: `${JSON.stringify(record, null, 2)}\n`,
    path: sandboxRecordPath,
  });
  return record;
};

/**
 * Materialize the reviewed Git tree inside Eve's per-session sandbox.
 *
 * The fixed path is intentional: one Eve session owns one target workspace.
 * The intent file and deterministic path make an interrupted tool retry
 * converge on the same workspace instead of creating another host worktree.
 */
export const prepareSupportedSandboxWorkspace = async function prepareSupportedSandboxWorkspace(
  sourcePathInput: string,
  expectedSha: string,
  expectedEligibilityDigest: string,
  sandbox: SandboxSession,
  callId: string,
  builderOwned = false,
  _compatibility: "full" | "planning" = "full",
): Promise<PreparedSandboxWorkspace> {
  const eligibility = builderOwned
    ? await inspectBuilderOwnedSupportedRepository(sourcePathInput)
    : await inspectSupportedRepository(sourcePathInput);
  if (eligibility.sourceSha === undefined) {
    throw new Error("The selected repository is not a readable Git worktree.");
  }
  if (eligibility.sourceSha !== expectedSha) {
    throw new Error("Source SHA changed after eligibility review.");
  }
  // Compatibility metadata is diagnostic only. Repository contents are
  // expected to evolve between inspection and execution; the commands below
  // are the authority on whether the checkout can be used.

  const sourceTree = git(eligibility.sourcePath, ["rev-parse", `${expectedSha}^{tree}`]);
  const existing = await readPreparedSandboxWorkspaceRecord(sandbox);
  if (existing !== undefined) {
    if (
      existing.sourcePath !== eligibility.sourcePath ||
      existing.sourceSha !== expectedSha ||
      existing.sourceTree !== sourceTree ||
      existing.workspaceId !== getBuilderSandboxId(sandbox)
    ) {
      throw new Error("This app build already owns a different workspace.");
    }
    await verifyLegacyLiveSandboxWorkspace(sandbox, existing);
    return existing;
  }

  const treeProcess = spawn(
    // oxlint-disable-next-line sonarjs/no-os-command-from-path -- This operation invokes the environment-provided git executable.
    "git",
    ["-C", eligibility.sourcePath, "ls-tree", "-rz", "--full-tree", expectedSha],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  if (treeProcess.stdout === null) {
    throw new Error("The reviewed Git tree could not be streamed.");
  }
  const treeEntries: { mode: "100644" | "100755"; objectId: string; path: string }[] = [];
  try {
    for await (const entry of gitNulRecords(treeProcess.stdout)) {
      const match = /^(?<mode>\d+) (?<type>\w+) (?<objectId>[0-9a-f]{40})\t(?<path>.+)$/u.exec(
        entry,
      );
      if (match === null) {
        throw new Error("The reviewed Git tree contains an invalid entry.");
      }
      const { mode, type, objectId, path } = match.groups ?? {};
      if (type !== "blob" || (mode !== "100644" && mode !== "100755") || path === undefined) {
        throw new Error("The reviewed Git tree contains an unsupported entry.");
      }
      if (objectId === undefined || !safeSourcePath(path)) {
        throw new Error("The reviewed Git tree contains an unsupported entry.");
      }
      treeEntries.push({ mode, objectId, path });
    }
    await once(treeProcess, "close");
    if (treeProcess.exitCode !== 0) {
      throw new Error("The reviewed Git tree could not be enumerated.");
    }
  } catch (error) {
    treeProcess.kill();
    throw error;
  }
  const sourceFiles: PreparedSourceFile[] = [];
  for (const entry of treeEntries) {
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Process the archive or source entries in order.
    const fileDigest = await digestProcessStdout("git", [
      "-C",
      eligibility.sourcePath,
      "cat-file",
      "blob",
      entry.objectId,
    ]);
    sourceFiles.push({ ...entry, sha256: fileDigest });
  }
  const intent = {
    callId,
    eligibilityDigest: expectedEligibilityDigest,
    sourcePath: eligibility.sourcePath,
    sourceSha: expectedSha,
    sourceTree,
  };
  await ensureSandboxDirectories(sandbox, [appBuilderDirectory]);
  await sandbox.writeTextFile({
    content: `${JSON.stringify(intent, null, 2)}\n`,
    path: prepareIntentFile,
  });
  await sandbox.removePath({
    force: true,
    path: "repository",
    recursive: true,
  });
  if (fixtureSandboxEnabled()) {
    await ensureSandboxDirectories(
      sandbox,
      sourceFiles.map(({ path }) => `repository/${path.split("/").slice(0, -1).join("/")}`),
    );
    for (const entry of sourceFiles) {
      const command = gitByteInvocation(eligibility.sourcePath, [
        "cat-file",
        "blob",
        entry.objectId,
      ]);
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      await sandbox.writeFile({
        content: processStdoutByteStream(command.command, command.args, command.options),
        path: `repository/${entry.path}`,
      });
    }
  } else {
    const archiveProcess = spawn(
      // oxlint-disable-next-line sonarjs/no-os-command-from-path -- This operation invokes the environment-provided git executable.
      "git",
      ["-C", eligibility.sourcePath, "archive", "--format=tar.gz", expectedSha],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    if (archiveProcess.stdout === null) {
      throw new Error("The reviewed source archive could not be streamed.");
    }
    const archiveOutputIterator = archiveProcess.stdout[Symbol.asyncIterator]();
    const archiveStream = new ReadableStream<Uint8Array>({
      cancel() {
        archiveProcess.kill();
      },
      async pull(controller) {
        const next = await archiveOutputIterator.next();
        if (next.done === true) {
          controller.close();
          return;
        }
        if (next.value === undefined || !(next.value instanceof Uint8Array)) {
          controller.error(new Error("Git emitted a non-byte archive chunk."));
          return;
        }
        controller.enqueue(next.value);
      },
    });
    const archiveCompletion = once(archiveProcess, "close");
    try {
      await sandbox.writeFile({
        content: archiveStream,
        path: sandboxSourceArchivePath,
      });
      await archiveCompletion;
      if (archiveProcess.exitCode !== 0) {
        throw new Error("The reviewed source archive could not be created.");
      }
    } catch (error) {
      archiveProcess.kill();
      throw error;
    }
    try {
      const extraction = await sandbox.run({
        command: `mkdir -p repository && tar --extract --gzip --file ${sandboxSourceArchivePath} --directory repository --no-same-owner --no-same-permissions`,
        workingDirectory: sandboxWorkspacePath,
      });
      if (extraction.exitCode !== 0) {
        throw new Error("The reviewed source archive could not be materialized.");
      }
    } finally {
      await sandbox.removePath({ force: true, path: sandboxSourceArchivePath });
    }
  }
  await sandbox.writeTextFile({
    content: `${JSON.stringify(sourceFiles, null, 2)}\n`,
    path: sandboxSourceFilesPath,
  });
  await sandbox.writeTextFile({
    content: preparedSourceChecksums(sourceFiles),
    path: sandboxSourceChecksumsPath,
  });
  const record: PreparedSandboxWorkspace = {
    adapter: SUPPORTED_TEMPLATE_ADAPTER,
    eligibilityDigest: expectedEligibilityDigest,
    sourcePath: eligibility.sourcePath,
    sourceSha: expectedSha,
    sourceTree,
    workspaceDigest: sha256(JSON.stringify(sourceFiles)),
    workspaceId: getBuilderSandboxId(sandbox),
    workspacePath: sandboxRepositoryPath,
  };
  // Only a newly transferred source has its current bytes verified here.
  // Later planning reads retain this baseline while allowing ordinary edits.
  await verifyPreparedSandboxWorkspace(sandbox, record);
  await sandbox.writeTextFile({
    content: `${JSON.stringify(record, null, 2)}\n`,
    path: sandboxRecordPath,
  });
  return record;
};

/**
 * Observes the tracked and non-ignored working tree for an explicit local
 * development run.  This is intentionally separate from the reviewed Git
 * snapshot transport above: normal edits are live planning input, while the
 * sandbox-owned repository remains the mutable execution overlay.
 */

export const prepareDevelopmentSandboxWorkspace = async function prepareDevelopmentSandboxWorkspace(
  sourcePathInput: string,
  sandbox: SandboxSession,
  callId: string,
  _compatibility: "full" | "planning" = "full",
): Promise<PreparedSandboxWorkspace> {
  void _compatibility;
  // Development snapshots are inputs, not candidates for a template
  // certification gate. Run the repository and react to its real command
  // failures instead of predicting compatibility from an expected shape.
  const {
    sourcePath,
    sourceSha,
    eligibilityDigest,
    names,
    sourceFiles,
    workspaceDigest,
    generation,
  } = await inspectDevelopmentSourceGeneration(sourcePathInput);
  // Retain actual selected live bytes before effects or an immutable workspace
  // receipt; the launcher's earlier snapshot can describe different input.
  await retainPreparedLocalSourceBaseline({
    sourcePath,
    sourceSha,
    eligibilityDigest,
    names,
    sourceFiles,
    workspaceDigest,
    generation,
  });

  // The previous manifest describes only files managed by the live source
  // transport.  It must not turn sandbox-generated plans, caches, or other
  // builder-owned state into source files.  A missing/corrupt previous
  // manifest simply receives a complete first transfer.
  let previousFiles: PreparedSourceFile[] = [];
  let previousManifestValid = false;
  const previousManifest = await sandbox.readTextFile({
    path: sandboxSourceFilesPath,
  });
  if (previousManifest !== null) {
    try {
      previousFiles = parsePreparedSourceFiles(JSON.parse(previousManifest) as unknown);
      previousManifestValid = true;
    } catch {
      previousFiles = [];
    }
  }
  const previousByPath = new Map(previousFiles.map((file) => [file.path, file]));
  const currentByPath = new Map(sourceFiles.map((file) => [file.path, file]));
  const deletedPaths: string[] = [];
  for (const file of previousFiles) {
    if (!currentByPath.has(file.path)) {
      deletedPaths.push(file.path);
    }
  }
  const changedFiles = sourceFiles.filter((file) => {
    const previous = previousByPath.get(file.path);
    return previous === undefined || previous.sha256 !== file.sha256 || previous.mode !== file.mode;
  });
  // Without a valid source manifest, overlay the full live source. Do not
  // replace the repository: it also owns generated app files and dependency
  // state that are intentionally outside the source transport.
  const fullTransfer = !previousManifestValid;

  await ensureSandboxDirectories(sandbox, [appBuilderDirectory]);
  await sandbox.writeTextFile({
    content: `${JSON.stringify(
      {
        callId,
        eligibilityDigest,
        mode: "development-live",
        sourcePath,
        sourceSha,
        sourceTree: generation,
      },
      null,
      2,
    )}\n`,
    path: prepareIntentFile,
  });
  if (fullTransfer) {
    await developmentWorkingTreeArchive(sandbox, sourcePath, names);
    try {
      const extraction = await sandbox.run({
        command: `mkdir -p repository && tar --extract --gzip --file ${sandboxSourceArchivePath} --directory repository --no-same-owner --no-same-permissions`,
        workingDirectory: sandboxWorkspacePath,
      });
      if (extraction.exitCode !== 0) {
        throw new Error("The development source could not be materialized.");
      }
    } finally {
      await sandbox.removePath({ force: true, path: sandboxSourceArchivePath });
    }
  } else {
    await ensureSandboxDirectories(
      sandbox,
      changedFiles.map(({ path }) => {
        const parent = path.split("/").slice(0, -1).join("/");
        return parent === "" ? "repository" : `repository/${parent}`;
      }),
    );
    await runSequentially(deletedPaths, async (path) => {
      await sandbox.removePath({ force: true, path: `repository/${path}` });
    });
    for (const file of changedFiles) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      await sandbox.writeFile({
        content: fileReadableStream(nodePath.resolve(sourcePath, file.path)),
        path: `repository/${file.path}`,
      });
    }
    const nonRegularPaths = names.filter((path) => !currentByPath.has(path));
    if (nonRegularPaths.length > 0) {
      await developmentWorkingTreeArchive(sandbox, sourcePath, nonRegularPaths);
      try {
        const extraction = await sandbox.run({
          command: `tar --extract --gzip --file ${sandboxSourceArchivePath} --directory repository --no-same-owner --no-same-permissions`,
          workingDirectory: sandboxWorkspacePath,
        });
        if (extraction.exitCode !== 0) {
          throw new Error("The development source could not be materialized.");
        }
      } finally {
        await sandbox.removePath({ force: true, path: sandboxSourceArchivePath });
      }
    }
  }
  const modeUpdates = fullTransfer ? sourceFiles : changedFiles;
  if (modeUpdates.length > 0) {
    // Keep the path list out of the shell command. Large working trees can
    // exceed argv limits, and source paths must be revalidated inside the
    // sandbox before their modes are changed.
    const modeListPath = ".app-builder/development-source-modes.json";
    await sandbox.writeTextFile({
      content: `${JSON.stringify(
        modeUpdates.map(({ mode, path }) => ({
          mode,
          path: `repository/${path}`,
        })),
      )}\n`,
      path: modeListPath,
    });
    const chmod = await sandbox.run({
      command: `node -e ${JSON.stringify(
        `const fs=require("node:fs");const path=require("node:path");const root=path.resolve("/workspace/repository");const entries=JSON.parse(fs.readFileSync("/workspace/${modeListPath}","utf-8"));if(!Array.isArray(entries))throw new Error("invalid mode list");for(const entry of entries){if(!entry||typeof entry.path!=="string"||!entry.path.startsWith("repository/")||entry.path.includes("\\0")||(entry.mode!=="100644"&&entry.mode!=="100755"))throw new Error("invalid source mode");const target=path.resolve("/workspace",entry.path);if(target!==root&&!target.startsWith(root+path.sep))throw new Error("source path escapes repository");const info=fs.lstatSync(target);if(!info.isFile()||info.isSymbolicLink())throw new Error("source path is not a regular file");fs.chmodSync(target,entry.mode==="100755"?0o755:0o644);}`,
      )}`,
      workingDirectory: sandboxWorkspacePath,
    });
    if (chmod.exitCode !== 0) {
      throw new Error("The development source permissions could not be prepared.");
    }
  }
  await sandbox.writeTextFile({
    content: `${JSON.stringify(sourceFiles, null, 2)}\n`,
    path: sandboxSourceFilesPath,
  });
  await sandbox.writeTextFile({
    content: preparedSourceChecksums(sourceFiles),
    path: sandboxSourceChecksumsPath,
  });
  const record: PreparedSandboxWorkspace = {
    adapter: SUPPORTED_TEMPLATE_ADAPTER,
    eligibilityDigest,
    sourcePath,
    sourceSha,
    sourceTree: generation,
    workspaceDigest,
    workspaceId: getBuilderSandboxId(sandbox),
    workspacePath: sandboxRepositoryPath,
  };
  // Independently prove the bytes that actually reached the Sandbox before a
  // workspace receipt freezes their digest; source can move during transport.
  if (fullTransfer) {
    await verifyPreparedSandboxWorkspace(sandbox, record);
  } else {
    // Unchanged baseline files can contain legitimate app-authored edits. Only
    // bytes actually transferred by this refresh are transfer readback inputs.
    const transferChecksumsPath = ".app-builder/development-transfer-checksums.sha256";
    await sandbox.writeTextFile({
      path: transferChecksumsPath,
      content: preparedSourceChecksums(changedFiles),
    });
    await verifyPreparedSandboxFiles(sandbox, changedFiles, transferChecksumsPath);
  }
  await sandbox.writeTextFile({
    content: `${JSON.stringify(record, null, 2)}\n`,
    path: sandboxRecordPath,
  });
  return record;
};

/** Materializes a source only after the canonical clone transport has proven it. */
export const prepareBuilderOwnedSupportedSandboxWorkspace =
  function prepareBuilderOwnedSupportedSandboxWorkspace(
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
  };
