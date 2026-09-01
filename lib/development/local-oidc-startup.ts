import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import {
  parseLinkedVercelProject,
  parseLocalVercelOidcToken,
  readOwnerBoundLocalFile,
  validateLocalVercelOidcClaims,
} from "../eve/local-vercel-oidc";

const MINIMUM_TOKEN_LIFETIME_SECONDS = 300;

export type LocalOidcStartupInvocation = {
  executable: string;
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  operation: "development-env-pull" | "owner-bind";
};

export type LocalOidcStartupCommandRunner = (
  invocation: LocalOidcStartupInvocation,
) => void;

function requiredEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: "HOME" | "PATH",
): string {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Required ${name} was unavailable.`);
  }
  return value;
}

function commandEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    NODE_ENV: environment.NODE_ENV ?? "development",
    HOME: requiredEnvironmentValue(environment, "HOME"),
    PATH: requiredEnvironmentValue(environment, "PATH"),
    TMPDIR: environment.TMPDIR ?? "/tmp",
    LANG: environment.LANG ?? "C",
    LC_ALL: environment.LC_ALL ?? "C",
    TZ: environment.TZ ?? "",
    CI: environment.CI ?? "",
  };
}

function assertNoStaticCredential(environment: NodeJS.ProcessEnv): void {
  if (
    Object.hasOwn(environment, "VERCEL_TOKEN") ||
    Object.hasOwn(environment, "AI_GATEWAY_API_KEY")
  ) {
    throw new Error(
      "Development OIDC startup refuses static provider credentials.",
    );
  }
}

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

function readLinkedProject(repositoryRoot: string) {
  return parseLinkedVercelProject(
    readOwnerBoundLocalFile(resolve(repositoryRoot, ".vercel/project.json"), {
      confidential: false,
    }),
  );
}

function validateInstalledOidc(input: {
  repositoryRoot: string;
  nowEpochSeconds: number;
  expectedProject: ReturnType<typeof parseLinkedVercelProject>;
}): void {
  const project = readLinkedProject(input.repositoryRoot);
  if (!sameProject(project, input.expectedProject)) {
    throw new Error("The linked Vercel project changed during OIDC startup.");
  }
  const environment = readOwnerBoundLocalFile(
    resolve(input.repositoryRoot, ".env.local"),
    { confidential: true },
  );
  const token = parseLocalVercelOidcToken(environment);
  const claims = validateLocalVercelOidcClaims({
    token,
    project,
    nowEpochSeconds: input.nowEpochSeconds,
  });
  if (
    claims.expiresAt <=
    input.nowEpochSeconds + MINIMUM_TOKEN_LIFETIME_SECONDS
  ) {
    throw new Error("OIDC token would expire during Development startup.");
  }
}

export function runLocalOidcStartupCommand(
  invocation: LocalOidcStartupInvocation,
): void {
  const result = spawnSync(invocation.executable, [...invocation.args], {
    cwd: invocation.cwd,
    env: invocation.environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`Local OIDC ${invocation.operation} failed.`);
  }
}

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
  if (repositoryRoot !== resolve(input.repositoryRoot)) {
    throw new Error("Repository root was not canonical.");
  }
  const expectedProject = readLinkedProject(repositoryRoot);
  const nowEpochSeconds =
    input.nowEpochSeconds ?? Math.floor(Date.now() / 1000);

  try {
    validateInstalledOidc({
      repositoryRoot,
      nowEpochSeconds,
      expectedProject,
    });
    return { refreshed: false };
  } catch {
    // A missing, permissive, malformed, or expiring local token is replaced once.
  }

  const runCommand = input.runCommand ?? runLocalOidcStartupCommand;
  const childEnvironment = commandEnvironment(environment);
  runCommand({
    executable: input.vercelExecutable,
    args: ["env", "pull", ".env.local", "--environment=development", "--yes"],
    cwd: repositoryRoot,
    environment: childEnvironment,
    operation: "development-env-pull",
  });
  runCommand({
    executable: input.miseExecutable,
    args: ["run", "local:install-oidc"],
    cwd: repositoryRoot,
    environment: childEnvironment,
    operation: "owner-bind",
  });

  validateInstalledOidc({
    repositoryRoot,
    nowEpochSeconds,
    expectedProject,
  });
  return { refreshed: true };
}
