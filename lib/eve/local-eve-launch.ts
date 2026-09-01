import { spawn, type ChildProcess } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  parseLinkedVercelProject,
  parseLocalVercelOidcToken,
  readOwnerBoundLocalFile,
  resolveInstalledEveCli,
  validateLocalVercelOidcToken,
} from "./local-vercel-oidc";

const sha256 = /^[0-9a-f]{64}$/u;
const gitObject = /^[0-9a-f]{40}$/u;

type Environment = Readonly<Record<string, string | undefined>>;

export type LocalEveInvocation = Readonly<{
  command: string;
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
}>;

type ForwardedSignal = "SIGINT" | "SIGTERM";

type SignalTarget = Readonly<{
  once(signal: ForwardedSignal, listener: () => void): unknown;
  off(signal: ForwardedSignal, listener: () => void): unknown;
}>;

function required(environment: Environment, name: string) {
  const value = environment[name];
  if (value === undefined || value.length === 0)
    throw new Error(`Local Eve ${name} binding was unavailable.`);
  return value;
}

function ownerDirectory(path: string, label: string, ownerOnly = false) {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    realpathSync(path) !== path
  )
    throw new Error(`${label} was not an absolute canonical directory.`);
  const info = lstatSync(path);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & (ownerOnly ? 0o777 : 0o022)) !== (ownerOnly ? 0o700 : 0)
  )
    throw new Error(`${label} was not owner-bound.`);
  return path;
}

function contained(root: string, path: string) {
  const candidate = relative(root, path);
  return (
    candidate !== "" &&
    candidate !== ".." &&
    !candidate.startsWith(`..${sep}`) &&
    !isAbsolute(candidate)
  );
}

function exactRoots(repositoryRoot: string, environment: Environment) {
  const runsRoot = ownerDirectory(
    required(environment, "APP_BUILDER_DEV_RUNS_ROOT"),
    "Development runs root",
    true,
  );
  const applicationRoot = ownerDirectory(
    required(environment, "APP_BUILDER_DEV_EVE_ROOT"),
    "Development Eve application root",
    true,
  );
  const supervisorRoot = ownerDirectory(
    required(environment, "APP_BUILDER_DEV_SUPERVISOR_ROOT"),
    "Development Eve supervisor root",
    true,
  );
  if (!contained(runsRoot, supervisorRoot) || dirname(supervisorRoot) !== runsRoot)
    throw new Error("Development Eve supervisor was outside the runs root.");
  if (applicationRoot !== join(supervisorRoot, "eve-application/source"))
    throw new Error("Development Eve application root was not supervisor-bound.");
  const sourceRoot = ownerDirectory(
    required(environment, "REPOSITORY_LOCAL_ROOTS"),
    "Development Arrusted source root",
  );
  const activeRun = dirname(sourceRoot);
  if (!contained(runsRoot, activeRun) || dirname(activeRun) !== runsRoot)
    throw new Error("Development Arrusted source was outside the active run.");
  if (sourceRoot !== join(activeRun, "source"))
    throw new Error("Development Arrusted source was outside the active run.");
  const runtimeHome = ownerDirectory(
    required(environment, "APP_BUILDER_DEV_RUNTIME_HOME"),
    "Development runtime home",
    true,
  );
  if (runtimeHome !== join(supervisorRoot, "home"))
    throw new Error("Development runtime home was not supervisor-bound.");
  const workflowData = ownerDirectory(
    required(environment, "WORKFLOW_LOCAL_DATA_DIR"),
    "Development workflow data root",
    true,
  );
  if (workflowData !== join(supervisorRoot, "workflow-data"))
    throw new Error("Development workflow data was not supervisor-bound.");
  const destinationRoot = ownerDirectory(
    required(environment, "REPOSITORY_WORKSPACE_ROOT"),
    "Development destination root",
    true,
  );
  if (repositoryRoot === applicationRoot)
    throw new Error("Development Eve cannot reuse the live checkout root.");
  return {
    activeRun,
    applicationRoot,
    destinationRoot,
    runtimeHome,
    sourceRoot,
    supervisorRoot,
    workflowData,
  };
}

function exactBinding(environment: Environment) {
  if (
    environment.APP_BUILDER_EXECUTION_MODE !== "development" ||
    environment.APP_BUILDER_EXECUTION_BUNDLE !== "local-development" ||
    environment.APP_BUILDER_SANDBOX_PROVIDER !== "vercel" ||
    environment.APP_BUILDER_LOCAL_ADAPTER !== "1" ||
    environment.APP_BUILDER_LOCAL_PUBLICATION !== "0" ||
    environment.APP_BUILDER_BRANCH_WORKTREE_PUBLICATION !== "0" ||
    environment.APP_BUILDER_GITHUB_PUBLICATION_ENABLED !== "0" ||
    environment.APP_BUILDER_FRESH_BOOTSTRAP_ENABLED !== "0" ||
    environment.APP_BUILDER_LOCAL_PROVIDER_EMULATION !== "0" ||
    environment.APP_BUILDER_LOCAL_AUTH_EMULATION !== "0" ||
    environment.EVE_HOSTED_ADAPTER !== "0" ||
    environment.WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS !== "0" ||
    environment.APP_BUILDER_SANDBOX_IMAGE !== undefined ||
    environment.MSB_HOME !== undefined ||
    environment.MSB_PATH !== undefined ||
    environment.MSB_LIBKRUNFW_PATH !== undefined ||
    environment.VERCEL_TOKEN !== undefined ||
    environment.AI_GATEWAY_API_KEY !== undefined
  )
    throw new Error("Local Eve execution authority was not closed.");
  const port = required(environment, "APP_BUILDER_EVE_PORT");
  if (!/^\d{4,5}$/u.test(port) || Number(port) < 1024 || Number(port) > 65535)
    throw new Error("Local Eve port was invalid.");
  if (environment.EVE_AGENT_HOST !== `http://127.0.0.1:${port}`)
    throw new Error("Local Eve loopback binding was invalid.");
  const sourceSha = required(environment, "APP_BUILDER_DEVELOPMENT_SOURCE_SHA");
  const sourceTree = required(
    environment,
    "APP_BUILDER_DEVELOPMENT_SOURCE_TREE",
  );
  const fingerprint = required(
    environment,
    "APP_BUILDER_DEVELOPMENT_SOURCE_FINGERPRINT",
  );
  const dependencyKey = required(
    environment,
    "APP_BUILDER_DEVELOPMENT_DEPENDENCY_KEY",
  );
  if (
    !gitObject.test(sourceSha) ||
    !gitObject.test(sourceTree) ||
    !sha256.test(fingerprint) ||
    !sha256.test(dependencyKey)
  )
    throw new Error("Local Eve development identity was invalid.");
  return { dependencyKey, fingerprint, port, sourceSha, sourceTree };
}

export function createLocalEveInvocation(input: {
  repositoryRoot: string;
  pinnedNode: string;
  eveCli: string;
  oidcToken: string;
  vercelProject: Readonly<{ projectId: string; orgId: string }>;
  environment: Environment;
}): LocalEveInvocation {
  const roots = exactRoots(input.repositoryRoot, input.environment);
  const binding = exactBinding(input.environment);
  return {
    command: input.pinnedNode,
    args: [
      input.eveCli,
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      binding.port,
      "--no-ui",
    ],
    cwd: roots.applicationRoot,
    environment: {
      PATH: `${dirname(input.pinnedNode)}:/usr/bin:/bin`,
      PWD: roots.applicationRoot,
      HOME: roots.runtimeHome,
      TMPDIR: "/tmp",
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
      NODE_ENV: "production",
      APP_BUILDER_DEV_RUNTIME_HOME: roots.runtimeHome,
      APP_BUILDER_EXECUTION_MODE: "development",
      APP_BUILDER_EXECUTION_BUNDLE: "local-development",
      APP_BUILDER_SANDBOX_PROVIDER: "vercel",
      APP_BUILDER_DEVELOPMENT_SOURCE_SHA: binding.sourceSha,
      APP_BUILDER_DEVELOPMENT_SOURCE_TREE: binding.sourceTree,
      APP_BUILDER_DEVELOPMENT_SOURCE_FINGERPRINT: binding.fingerprint,
      APP_BUILDER_DEVELOPMENT_DEPENDENCY_KEY: binding.dependencyKey,
      APP_BUILDER_LOCAL_ADAPTER: "1",
      APP_BUILDER_LOCAL_PUBLICATION: "0",
      APP_BUILDER_BRANCH_WORKTREE_PUBLICATION: "0",
      APP_BUILDER_GITHUB_PUBLICATION_ENABLED: "0",
      APP_BUILDER_FRESH_BOOTSTRAP_ENABLED: "0",
      APP_BUILDER_LOCAL_PROVIDER_EMULATION: "0",
      APP_BUILDER_LOCAL_AUTH_EMULATION: "0",
      APP_BUILDER_HOSTED_ARTIFACT_PROOF: "0",
      EVE_HOSTED_ADAPTER: "0",
      EVE_AGENT_HOST: `http://127.0.0.1:${binding.port}`,
      WORKFLOW_LOCAL_BODY_TIMEOUT_MS: "360000",
      WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS: "360000",
      WORKFLOW_LOCAL_DATA_DIR: roots.workflowData,
      WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS: "0",
      REPOSITORY_LOCAL_ROOTS: roots.sourceRoot,
      REPOSITORY_WORKSPACE_ROOT: roots.destinationRoot,
      VERCEL_OIDC_TOKEN: input.oidcToken,
      VERCEL_TEAM_ID: input.vercelProject.orgId,
      VERCEL_PROJECT_ID: input.vercelProject.projectId,
    },
  };
}

export function localEveLaunchReceipt(invocation: LocalEveInvocation) {
  return {
    format: "autograph-local-eve-launch-v3",
    applicationRootFresh: invocation.cwd.includes("/eve-application/source"),
    sandboxProvider: invocation.environment.APP_BUILDER_SANDBOX_PROVIDER,
    executionBundle: invocation.environment.APP_BUILDER_EXECUTION_BUNDLE,
    sourceSha: invocation.environment.APP_BUILDER_DEVELOPMENT_SOURCE_SHA,
    sourceTree: invocation.environment.APP_BUILDER_DEVELOPMENT_SOURCE_TREE,
    publication: false,
    providerMutation: false,
    hosted: false,
  } as const;
}

/**
 * Keeps the wrapper alive until its Eve child has stopped. Without explicit
 * forwarding, SIGTERM exits the wrapper first and lets the development
 * supervisor remove the per-run application root while Eve is still watching
 * and writing beneath it.
 */
export function waitForForwardedEveChild(
  child: ChildProcess,
  signalTarget: SignalTarget = process,
) {
  return new Promise<number>((resolveExit, reject) => {
    const forwardInterrupt = () => child.kill("SIGINT");
    const forwardTerminate = () => child.kill("SIGTERM");
    const dispose = () => {
      signalTarget.off("SIGINT", forwardInterrupt);
      signalTarget.off("SIGTERM", forwardTerminate);
    };
    child.once("error", (error) => {
      dispose();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      dispose();
      resolveExit(code ?? (signal ? 1 : 0));
    });
    signalTarget.once("SIGINT", forwardInterrupt);
    signalTarget.once("SIGTERM", forwardTerminate);
  });
}

export async function runLocalEve(input: {
  repositoryRoot: string;
  environment?: Environment;
  nowEpochSeconds?: number;
}) {
  const environment = input.environment ?? process.env;
  const repositoryRoot = ownerDirectory(
    input.repositoryRoot,
    "App Builder repository root",
  );
  const token = parseLocalVercelOidcToken(
    readOwnerBoundLocalFile(join(repositoryRoot, ".env.local"), {
      confidential: true,
    }),
  );
  const project = parseLinkedVercelProject(
    readOwnerBoundLocalFile(join(repositoryRoot, ".vercel/project.json"), {
      confidential: false,
    }),
  );
  const oidcToken = validateLocalVercelOidcToken({
    token,
    project,
    nowEpochSeconds: input.nowEpochSeconds ?? Math.floor(Date.now() / 1000),
  });
  const invocation = createLocalEveInvocation({
    repositoryRoot,
    pinnedNode: process.execPath,
    eveCli: resolveInstalledEveCli(repositoryRoot),
    oidcToken,
    vercelProject: project,
    environment,
  });
  const child: ChildProcess = spawn(invocation.command, [...invocation.args], {
    cwd: invocation.cwd,
    env: { ...invocation.environment },
    stdio: "inherit",
  });
  return await waitForForwardedEveChild(child);
}
