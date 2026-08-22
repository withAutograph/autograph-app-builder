import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

export const SUPPORTED_TEMPLATE_ADAPTER = "arrusted-development-v0";

const requiredPaths = [
  ".config/mise/config.toml",
  ".github/workflows/cd.yml",
  "apps/shell/microfrontends.json",
  ".config/mise/scripts/repository/app-contract.ts",
  ".config/mise/scripts/repository/app-identity.ts",
  ".config/mise/scripts/repository/repository-preflight.ts",
  ".config/mise/scripts/repository/repository-release-gate.sh",
  ".config/turbo/generators/config.ts",
  ".config/turbo/generators/create-app.ts",
  ".config/turbo/generators/templates/app/next.config.ts.hbs",
] as const;

const expectedCommands = {
  appIdentity: "mise run repository:exec -- app-identity.ts --app <app-id>",
  planning:
    "mise run repository:exec -- app-contract.ts --contract <contract-file>",
  apply: "mise run create:app -- --proposal <proposal-file>",
  preflight: "mise run repository:preflight",
  validation: ["mise run check", "mise run test"],
} as const;

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
    applyCommand: string;
    repositoryPreflightCommand: string;
    topologyOwner: string;
    validationCommands: readonly string[];
    releaseGate: string;
  };
  digest: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function git(path: string, args: string[]): string {
  return execFileSync("git", ["-C", path, ...args], {
    encoding: "utf8",
  }).trim();
}

function allowedRoots(): string[] {
  const value = process.env.REPOSITORY_LOCAL_ROOTS;
  if (value === undefined || value.trim() === "") {
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

  for (const path of requiredPaths) {
    if (!existsSync(resolve(sourcePath, path)))
      failures.push(`missing required path ${path}`);
  }
  if (existsSync(resolve(sourcePath, ".config/repository-template.json"))) {
    failures.push("V0 does not accept a repository-template manifest");
  }

  const appContractPath = resolve(
    sourcePath,
    ".config/mise/scripts/repository/app-contract.ts",
  );
  const appContract = existsSync(appContractPath)
    ? readFileSync(appContractPath, "utf8")
    : "";
  const runtime = /runtime:\s*"nextjs"/u.test(appContract)
    ? "nextjs"
    : "unsupported";
  if (runtime === "unsupported")
    failures.push("app planner does not declare the Next.js runtime");

  const generatorPath = resolve(
    sourcePath,
    ".config/turbo/generators/config.ts",
  );
  const generator = existsSync(generatorPath)
    ? readFileSync(generatorPath, "utf8")
    : "";
  const packageScope = generator.includes("autograph")
    ? "@autograph"
    : "unsupported";
  if (packageScope === "unsupported")
    failures.push("workspace package scope is not @autograph");

  const misePath = resolve(sourcePath, ".config/mise/config.toml");
  const mise = existsSync(misePath) ? readFileSync(misePath, "utf8") : "";
  if (!mise.includes('[tasks."create:app"]'))
    failures.push("create:app command is missing");
  if (!mise.includes('[tasks."repository:preflight"]'))
    failures.push("repository:preflight command is missing");

  const preflightPath = resolve(
    sourcePath,
    ".config/mise/scripts/repository/repository-preflight.ts",
  );
  const preflight = existsSync(preflightPath)
    ? readFileSync(preflightPath, "utf8")
    : "";
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

  const cdPath = resolve(sourcePath, ".github/workflows/cd.yml");
  const cd = existsSync(cdPath) ? readFileSync(cdPath, "utf8") : "";
  const releaseGatePath = resolve(
    sourcePath,
    ".config/mise/scripts/repository/repository-release-gate.sh",
  );
  const releaseGate = existsSync(releaseGatePath)
    ? readFileSync(releaseGatePath, "utf8")
    : "";
  const declaresReleaseGate = [
    "name: Authorize (Repository release gate)",
    "actions: read",
    "REPOSITORY_RELEASE_ENABLED",
    "needs.release-gate.outputs.enabled == 'true'",
  ].every((expected) => cd.includes(expected));
  const hasCaseSensitiveRepositoryGate = [
    "repos/$GITHUB_REPOSITORY/actions/variables/REPOSITORY_RELEASE_ENABLED",
    '[[ "$value" == "true" ]]',
  ].every((expected) => releaseGate.includes(expected));
  if (!declaresReleaseGate || !hasCaseSensitiveRepositoryGate)
    failures.push(
      "REPOSITORY_RELEASE_ENABLED gate is not the supported CD gate",
    );

  const normalized = {
    adapter: SUPPORTED_TEMPLATE_ADAPTER,
    sourcePath,
    sourceSha,
    dirtyPaths: dirtyPaths.toSorted(),
    failures: failures.toSorted(),
    observed: {
      runtime,
      packageScope,
      appIdentityCommand: expectedCommands.appIdentity,
      planningCommand: expectedCommands.planning,
      applyCommand: expectedCommands.apply,
      repositoryPreflightCommand: expectedCommands.preflight,
      topologyOwner: "apps/shell/microfrontends.json",
      validationCommands: expectedCommands.validation,
      releaseGate: "REPOSITORY_RELEASE_ENABLED",
    },
  } as const;
  return {
    ...normalized,
    eligible: failures.length === 0,
    digest: sha256(JSON.stringify(normalized)),
  };
}

export type PreparedWorkspace = {
  workspaceId: string;
  workspacePath: string;
  sourcePath: string;
  sourceSha: string;
  adapter: typeof SUPPORTED_TEMPLATE_ADAPTER;
  eligibilityDigest: string;
};

export async function prepareSupportedWorkspace(
  sourcePathInput: string,
  expectedSha: string,
): Promise<PreparedWorkspace> {
  const eligibility = await inspectSupportedRepository(sourcePathInput);
  if (!eligibility.eligible || eligibility.sourceSha === undefined) {
    throw new Error(
      `Repository is not eligible: ${eligibility.failures.join("; ")}`,
    );
  }
  if (eligibility.sourceSha !== expectedSha)
    throw new Error("Source SHA changed after eligibility review.");

  const stateRoot = resolve(
    process.env.REPOSITORY_WORKSPACE_ROOT ?? tmpdir(),
    "repository-app-builder",
  );
  const workspaceId = randomUUID();
  const workspacePath = resolve(
    stateRoot,
    "workspaces",
    workspaceId,
    "repository",
  );
  await mkdir(resolve(workspacePath, ".."), { recursive: true });
  execFileSync(
    "git",
    [
      "-C",
      eligibility.sourcePath,
      "worktree",
      "add",
      "--detach",
      workspacePath,
      expectedSha,
    ],
    {
      stdio: "pipe",
    },
  );
  const record: PreparedWorkspace = {
    workspaceId,
    workspacePath,
    sourcePath: eligibility.sourcePath,
    sourceSha: expectedSha,
    adapter: SUPPORTED_TEMPLATE_ADAPTER,
    eligibilityDigest: eligibility.digest,
  };
  await writeFile(
    resolve(workspacePath, "..", "workspace.json"),
    `${JSON.stringify(record, null, 2)}\n`,
    {
      flag: "wx",
    },
  );
  return record;
}
