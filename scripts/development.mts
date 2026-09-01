import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { createDevelopmentApplication } from "../lib/development/application-root";
import {
  createDevelopmentPackage,
  developmentLaunchEnvironment,
  registerDevelopmentPackage,
} from "../lib/development/dev-package";
import {
  createDevelopmentSnapshot,
  developmentDependencyKey,
  parseDevelopmentArguments,
  removeDevelopmentSnapshot,
  waitForDevelopmentSourceChange,
} from "../lib/development/local-mode";
import { waitForDevelopmentMcp } from "../lib/development/mcp-readiness";
import {
  createDevelopmentShutdown,
  developmentChildExit,
  stopDevelopmentChild,
  waitForDevelopmentShutdown,
} from "../lib/development/process-supervisor";
import {
  fingerprintDevelopmentRuntime,
  waitForDevelopmentRuntimeChange,
} from "../lib/development/runtime-watch";
import {
  HOSTED_BUN_VERSION,
  HOSTED_MISE_VERSION,
  HOSTED_NODE_VERSION,
  HOSTED_RUST_VERSION,
} from "../lib/sandbox/hosted-toolchain";
import { loopbackDevelopmentOrigin } from "../lib/mcp/browser-preview";
import { rotateLocalEveCycleBinding } from "../lib/eve/local-cycle-binding";

const repositoryRoot = resolve(".");
const developmentTools = {
  node: HOSTED_NODE_VERSION,
  bun: HOSTED_BUN_VERSION,
  mise: HOSTED_MISE_VERSION,
  rust: HOSTED_RUST_VERSION,
} as const;

function requiredEnvironment(name: string, description = "executable") {
  const value = process.env[name];
  if (value === undefined || !value.startsWith("/"))
    throw new Error(`mise must supply the absolute ${name} ${description}.`);
  return value;
}

async function privateRoot(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const canonical = await realpath(path);
  const info = await lstat(canonical);
  if (
    canonical !== path ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error(
      `Development root must be canonical, owner-only, and mode 0700: ${path}`,
    );
  return canonical;
}

function nextEnvironment(input: {
  cycleFile: string;
  evePort: number;
  nextPort: number;
  runtimeHome: string;
}) {
  return {
    PATH: `${dirname(requiredEnvironment("APP_BUILDER_DEV_NODE_BIN"))}:/usr/bin:/bin`,
    HOME: input.runtimeHome,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: process.env.LANG ?? "C",
    LC_ALL: process.env.LC_ALL ?? "C",
    TZ: process.env.TZ ?? "UTC",
    NODE_ENV: "development",
    NEXT_TELEMETRY_DISABLED: "1",
    APP_BUILDER_EXECUTION_MODE: "development",
    APP_BUILDER_EXECUTION_BUNDLE: "local-development",
    APP_BUILDER_SANDBOX_PROVIDER: "vercel",
    APP_BUILDER_LOCAL_ADAPTER: "1",
    APP_BUILDER_LOCAL_AUTH_EMULATION: "0",
    APP_BUILDER_LOCAL_EVE_CYCLE_FILE: input.cycleFile,
    APP_BUILDER_DEVELOPMENT_ORIGIN: loopbackDevelopmentOrigin(input.nextPort),
    EVE_HOSTED_ADAPTER: "0",
    EVE_AGENT_HOST: `http://127.0.0.1:${input.evePort}`,
    // Next's env loader preserves explicitly supplied values. Empty values
    // prevent .env.local from projecting provider credentials into this child.
    VERCEL_OIDC_TOKEN: "",
    VERCEL_TOKEN: "",
    AI_GATEWAY_API_KEY: "",
  } satisfies NodeJS.ProcessEnv;
}

function eveWrapperEnvironment(input: {
  closed: Readonly<Record<string, string>>;
  applicationRoot: string;
  runsRoot: string;
  runtimeHome: string;
  workflowData: string;
}) {
  return {
    PATH: `${dirname(requiredEnvironment("APP_BUILDER_DEV_NODE_BIN"))}:/usr/bin:/bin`,
    HOME: input.runtimeHome,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: process.env.LANG ?? "C",
    LC_ALL: process.env.LC_ALL ?? "C",
    TZ: process.env.TZ ?? "UTC",
    NODE_ENV: "production",
    ...input.closed,
    APP_BUILDER_DEV_RUNS_ROOT: input.runsRoot,
    APP_BUILDER_DEV_RUNTIME_HOME: input.runtimeHome,
    APP_BUILDER_DEV_EVE_ROOT: input.applicationRoot,
    APP_BUILDER_EVE_PORT: new URL(input.closed.EVE_AGENT_HOST).port,
    WORKFLOW_LOCAL_DATA_DIR: input.workflowData,
    WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS: "0",
  } satisfies NodeJS.ProcessEnv;
}

async function runEveCycle(input: {
  cycleFile: string;
  sourceRoot: string;
  runsRoot: string;
  codexRoot: string;
  destinationRoot: string;
  nextPort: number;
  evePort: number;
  signal: AbortSignal;
  shutdownExitCode: () => number;
  nextExited: Promise<{ kind: "next-exit"; code: number }>;
}) {
  input.signal.throwIfAborted();
  await rotateLocalEveCycleBinding(input.cycleFile);
  const activeRun = await realpath(await mkdtemp(join(input.runsRoot, "run-")));
  const runtimeHome = await privateRoot(join(activeRun, "home"));
  const workflowData = await privateRoot(join(activeRun, "workflow-data"));
  try {
    const snapshot = await createDevelopmentSnapshot({
      sourceRoot: input.sourceRoot,
      runRoot: activeRun,
    });
    const application = await createDevelopmentApplication({
      repositoryRoot,
      runRoot: activeRun,
    });
    const dependencyKey = await developmentDependencyKey({
      sourceRoot: snapshot.root,
      platform: "linux/amd64",
      tools: developmentTools,
    });
    const runtimeFingerprint =
      await fingerprintDevelopmentRuntime(repositoryRoot);
    const packageResult = await createDevelopmentPackage({
      repositoryRoot,
      outputRoot: input.codexRoot,
      port: input.nextPort,
    });
    const closed = developmentLaunchEnvironment({
      snapshotRoot: snapshot.root,
      destinationRoot: input.destinationRoot,
      sourceSha: snapshot.commit,
      sourceTree: snapshot.tree,
      fingerprint: snapshot.fingerprint,
      dependencyKey,
      evePort: input.evePort,
    });
    const eve = spawn(
      requiredEnvironment("APP_BUILDER_DEV_NODE_BIN"),
      [
        "--import",
        "tsx",
        join(
          repositoryRoot,
          ".config/mise/scripts/repository/run-local-development-eve.mts",
        ),
      ],
      {
        cwd: repositoryRoot,
        env: eveWrapperEnvironment({
          closed,
          applicationRoot: application.root,
          runsRoot: input.runsRoot,
          runtimeHome,
          workflowData,
        }),
        stdio: "inherit",
      },
    );
    const watchers = new AbortController();
    const sourceChanged = waitForDevelopmentSourceChange({
      sourceRoot: input.sourceRoot,
      expectedFingerprint: snapshot.fingerprint,
      signal: watchers.signal,
    }).then(() => ({ kind: "restart" as const, code: 0 }));
    const runtimeChanged = waitForDevelopmentRuntimeChange({
      repositoryRoot,
      expectedFingerprint: runtimeFingerprint,
      signal: watchers.signal,
    }).then(() => ({ kind: "restart" as const, code: 0 }));
    const eveExited = developmentChildExit(eve).then((code) => ({
      kind: "eve-exit" as const,
      code,
    }));
    const stopping = waitForDevelopmentShutdown(
      input.signal,
      input.shutdownExitCode,
    );
    try {
      const startup = await Promise.race([
        waitForDevelopmentMcp({
          endpoint: packageResult.receipt.endpoint,
          signal: watchers.signal,
        }).then(() => ({ kind: "ready" as const, code: 0 })),
        sourceChanged,
        runtimeChanged,
        eveExited,
        input.nextExited,
        stopping,
      ]);
      if (startup.kind !== "ready") return startup;
      await registerDevelopmentPackage({
        codexBin: requiredEnvironment("APP_BUILDER_DEV_CODEX_BIN"),
        codexHome: requiredEnvironment(
          "APP_BUILDER_DEV_CODEX_HOME",
          "profile root",
        ),
        marketplaceRoot: packageResult.marketplaceRoot,
      });
      console.log("Autograph App Builder development is ready.");
      console.log(
        "Open a fresh Codex task and select Autograph App Builder (Development).",
      );
      console.log(`Loopback endpoint: ${packageResult.receipt.endpoint}`);
      return await Promise.race([
        sourceChanged,
        runtimeChanged,
        eveExited,
        input.nextExited,
        stopping,
      ]);
    } finally {
      watchers.abort();
      await stopDevelopmentChild(eve);
    }
  } finally {
    await removeDevelopmentSnapshot(activeRun);
  }
}

const shutdown = createDevelopmentShutdown();
let next: ChildProcess | undefined;
try {
  const args = parseDevelopmentArguments(process.argv.slice(2));
  const sourceRoot = await realpath(args.arrustedRoot);
  const artifactRoot = await privateRoot(
    args.stateRoot ?? join(repositoryRoot, ".artifacts/development"),
  );
  const stateRoot = await privateRoot(join(artifactRoot, "state"));
  const cycleFile = join(stateRoot, "eve-cycle");
  await rotateLocalEveCycleBinding(cycleFile);
  const cacheRoot = await privateRoot(join(artifactRoot, "cache"));
  const runsRoot = await privateRoot(join(stateRoot, "runs"));
  const nextHome = await privateRoot(join(stateRoot, "next-home"));
  const destinationRoot = await privateRoot(
    args.destinationRoot ?? join(artifactRoot, "destination"),
  );
  next = spawn(
    requiredEnvironment("APP_BUILDER_DEV_NODE_BIN"),
    [
      join(repositoryRoot, "node_modules/next/dist/bin/next"),
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(args.nextPort),
    ],
    {
      cwd: repositoryRoot,
      env: nextEnvironment({
        cycleFile,
        evePort: args.evePort,
        nextPort: args.nextPort,
        runtimeHome: nextHome,
      }),
      stdio: "inherit",
    },
  );
  const nextExited = developmentChildExit(next).then((code) => ({
    kind: "next-exit" as const,
    code,
  }));
  while (!shutdown.signal.aborted) {
    const outcome = await runEveCycle({
      cycleFile,
      sourceRoot,
      runsRoot,
      codexRoot: await privateRoot(join(cacheRoot, "codex")),
      destinationRoot,
      nextPort: args.nextPort,
      evePort: args.evePort,
      signal: shutdown.signal,
      shutdownExitCode: shutdown.exitCode,
      nextExited,
    });
    if (
      outcome.kind === "next-exit" ||
      outcome.kind === "eve-exit" ||
      outcome.kind === "stop"
    ) {
      process.exitCode = outcome.code;
      break;
    }
    console.log(
      "Development runtime changed; Eve and the local package are restarting while Next stays live.",
    );
  }
} catch (error) {
  if (!shutdown.signal.aborted) throw error;
  process.exitCode = shutdown.exitCode();
} finally {
  if (next !== undefined) await stopDevelopmentChild(next);
  shutdown.dispose();
}
