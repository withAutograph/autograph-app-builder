import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

import {
  parseLinkedVercelProject,
  parseLocalVercelOidcToken,
  readOwnerBoundLocalFile,
  validateLocalVercelOidcClaims,
} from "../eve/local-vercel-oidc";

const MINIMUM_TOKEN_LIFETIME_SECONDS = 300;

export interface LocalOidcStartupInvocation {
  executable: string;
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  operation: "development-env-pull" | "owner-bind";
}

export type LocalOidcStartupCommandRunner = (invocation: LocalOidcStartupInvocation) => void;

export class LocalOidcRefreshFailedError extends Error {
  constructor() {
    super("Project Development OIDC refresh could not complete.");
    this.name = "LocalOidcRefreshFailedError";
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function requiredEnvironmentValue(environment: NodeJS.ProcessEnv, name: "HOME" | "PATH"): string {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Required ${name} was unavailable.`);
  }
  return value;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function commandEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    CI: environment.CI ?? "",
    HOME: requiredEnvironmentValue(environment, "HOME"),
    LANG: environment.LANG ?? "C",
    LC_ALL: environment.LC_ALL ?? "C",
    NODE_ENV: environment.NODE_ENV ?? "development",
    PATH: requiredEnvironmentValue(environment, "PATH"),
    TMPDIR: environment.TMPDIR ?? "/tmp",
    TZ: environment.TZ ?? "",
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function assertNoStaticCredential(environment: NodeJS.ProcessEnv): void {
  if (
    Object.hasOwn(environment, "VERCEL_TOKEN") ||
    Object.hasOwn(environment, "AI_GATEWAY_API_KEY")
  ) {
    throw new Error("Development OIDC startup refuses static provider credentials.");
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function sameProject(
  left: ReturnType<typeof parseLinkedVercelProject>,
  right: ReturnType<typeof parseLinkedVercelProject>,
): boolean {
  return (
    left.projectId === right.projectId &&
    left.orgId === right.orgId &&
    left.projectName === right.projectName
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function readLinkedProject(repositoryRoot: string) {
  return parseLinkedVercelProject(
    readOwnerBoundLocalFile(path.resolve(repositoryRoot, ".vercel/project.json"), {
      confidential: false,
    }),
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function installedOidcNeedsRefresh(input: {
  repositoryRoot: string;
  nowEpochSeconds: number;
  expectedProject: ReturnType<typeof parseLinkedVercelProject>;
}): boolean {
  const project = readLinkedProject(input.repositoryRoot);
  if (!sameProject(project, input.expectedProject)) {
    throw new Error("The linked Vercel project changed during OIDC startup.");
  }
  let environment: string;
  try {
    environment = readOwnerBoundLocalFile(path.resolve(input.repositoryRoot, ".env.local"), {
      confidential: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    const credentialPath = path.resolve(input.repositoryRoot, ".env.local");
    const stat = lstatSync(credentialPath);
    const ownerId = process.getuid?.();
    if (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      ownerId !== undefined &&
      stat.uid === ownerId &&
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
      (stat.mode & 0o077) !== 0
    ) {
      // `vercel link` and `vercel env pull` may create this owner-owned file
      // with ordinary permissions. Refresh it, then let local:install-oidc
      // atomically rewrite it owner-only before the token is consumed.
      return true;
    }
    throw error;
  }
  const token = parseLocalVercelOidcToken(environment);
  const claims = validateLocalVercelOidcClaims({
    allowExpired: true,
    nowEpochSeconds: input.nowEpochSeconds,
    project,
    token,
  });
  return claims.expiresAt <= input.nowEpochSeconds + MINIMUM_TOKEN_LIFETIME_SECONDS;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function validateInstalledOidc(input: {
  repositoryRoot: string;
  nowEpochSeconds: number;
  expectedProject: ReturnType<typeof parseLinkedVercelProject>;
}): void {
  if (installedOidcNeedsRefresh(input)) {
    throw new Error("OIDC token would expire during Development startup.");
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function runLocalOidcStartupCommand(invocation: LocalOidcStartupInvocation): void {
  const result = spawnSync(invocation.executable, [...invocation.args], {
    cwd: invocation.cwd,
    encoding: "utf-8",
    env: invocation.environment,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`Local OIDC ${invocation.operation} failed.`);
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function ensureLocalDevelopmentOidc(input: {
  repositoryRoot: string;
  vercelExecutable: string;
  miseExecutable: string;
  environment?: NodeJS.ProcessEnv;
  nowEpochSeconds?: number;
  runCommand?: LocalOidcStartupCommandRunner;
}): { refreshed: boolean } {
  const environment = input.environment ?? process.env;
  assertNoStaticCredential(environment);

  const repositoryRoot = realpathSync(input.repositoryRoot);
  if (repositoryRoot !== path.resolve(input.repositoryRoot)) {
    throw new Error("Repository root was not canonical.");
  }
  const expectedProject = readLinkedProject(repositoryRoot);
  const nowEpochSeconds = input.nowEpochSeconds ?? Math.floor(Date.now() / 1000);

  if (
    !installedOidcNeedsRefresh({
      expectedProject,
      nowEpochSeconds,
      repositoryRoot,
    })
  ) {
    return { refreshed: false };
  }

  const runCommand = input.runCommand ?? runLocalOidcStartupCommand;
  const childEnvironment = commandEnvironment(environment);
  try {
    runCommand({
      args: ["env", "pull", ".env.local", "--environment=development", "--yes"],
      cwd: repositoryRoot,
      environment: childEnvironment,
      executable: input.vercelExecutable,
      operation: "development-env-pull",
    });
    runCommand({
      args: ["run", "local:install-oidc"],
      cwd: repositoryRoot,
      environment: { ...childEnvironment, MISE_BIN_PATH: input.miseExecutable },
      executable: input.miseExecutable,
      operation: "owner-bind",
    });
  } catch {
    throw new LocalOidcRefreshFailedError();
  }

  validateInstalledOidc({
    expectedProject,
    nowEpochSeconds,
    repositoryRoot,
  });
  return { refreshed: true };
}
