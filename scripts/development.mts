import { assertDevelopmentApplicationDependencies } from "../lib/development/application-dependencies";
import { prepareDevelopmentEveWrapperEnvironment } from "../lib/development/eve-wrapper-environment";
import { maintainLocalDevelopmentOidcLease } from "../lib/development/local-oidc-lease";
import { prepareDevelopmentEmulatedWeb } from "../lib/development/emulated-web";
import { spawn } from "node:child_process";
import type { HostedSessionConnection } from "../lib/development/dev-package";
import type { ChildProcess } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath } from "node:fs/promises";
import nodePath from "node:path";

import { createDevelopmentCycle } from "../lib/development/application-root";
import {
  createDevelopmentPackage,
  developmentPackageFingerprint,
  developmentLaunchEnvironment,
  registerDevelopmentPackage,
} from "../lib/development/dev-package";
import {
  createDevelopmentSnapshot,
  developmentDependencyKey,
  developmentNextBundlerArguments,
  parseDevelopmentArguments,
  removeDevelopmentSnapshot,
} from "../lib/development/local-mode";
import type { DevelopmentSnapshot } from "../lib/development/local-mode";
import { waitForDevelopmentMcp } from "../lib/development/mcp-readiness";
import {
  createDevelopmentShutdown,
  developmentChildExit,
  stopDevelopmentChild,
  waitForDevelopmentPortRelease,
  waitForDevelopmentShutdown,
} from "../lib/development/process-supervisor";
import {
  fingerprintDevelopmentRuntime,
  observeDevelopmentRuntimeChanges,
} from "../lib/development/runtime-watch";
import {
  HOSTED_BUN_VERSION,
  HOSTED_MISE_VERSION,
  HOSTED_NODE_VERSION,
  HOSTED_RUST_VERSION,
} from "../lib/sandbox/hosted-toolchain";
import { loopbackDevelopmentOrigin } from "../lib/mcp/browser-preview";
import { rotateLocalEveCycleBinding } from "../lib/eve/local-cycle-binding";
import { ensureLocalDevelopmentOidc } from "../lib/development/local-oidc-startup";

import { resumeDevelopmentCycle } from "../lib/development/resume-cycle";

const repositoryRoot = nodePath.resolve(".");
const developmentTools = {
  bun: HOSTED_BUN_VERSION,
  mise: HOSTED_MISE_VERSION,
  node: HOSTED_NODE_VERSION,
  rust: HOSTED_RUST_VERSION,
} as const;

interface DevelopmentSupervisorState {
  fingerprint?: string;
  result?: Awaited<ReturnType<typeof createDevelopmentPackage>>;
  dependencyKey?: string;
  snapshot?: DevelopmentSnapshot;
}

const exitOutcome = async (exit: Promise<number>, kind: "eve-exit" | "next-exit" | "web-exit") => ({
  code: await exit,
  kind,
});

function requiredEnvironment(name: string, description = "executable") {
  const value = process.env[name];
  if (value === undefined || !value.startsWith("/")) {
    throw new Error(`mise must supply the absolute ${name} ${description}.`);
  }
  return value;
}

async function privateRoot(path: string) {
  await mkdir(path, { mode: 0o700, recursive: true });
  const canonical = await realpath(path);
  const info = await lstat(canonical);
  const isNotPrivateDirectory = !info.isDirectory() || info.isSymbolicLink();
  const permissionMode = info.mode.toString(8).slice(-3);
  const isNotOwnedOrPrivate = info.uid !== process.getuid?.() || /[1-7]/u.test(permissionMode);
  const isNotCanonical = canonical !== path;
  if (isNotCanonical || isNotPrivateDirectory || isNotOwnedOrPrivate) {
    throw new Error(`Development root must be canonical, owner-only, and mode 0700: ${path}`);
  }
  return canonical;
}

function nextEnvironment(input: {
  cycleFile: string;
  evePort: number;
  nextPort: number;
  runtimeHome: string;
  web?: Awaited<ReturnType<typeof prepareDevelopmentEmulatedWeb>>;
}) {
  return {
    AI_GATEWAY_API_KEY: "",
    ...input.web?.environment,
    APP_BUILDER_DEVELOPMENT_ORIGIN: input.web?.origin ?? loopbackDevelopmentOrigin(input.nextPort),
    APP_BUILDER_EXECUTION_BUNDLE: "local-development",
    APP_BUILDER_EXECUTION_MODE: "development",
    APP_BUILDER_LOCAL_ADAPTER: "1",
    APP_BUILDER_LOCAL_AUTH_EMULATION: input.web === undefined ? "0" : "1",
    APP_BUILDER_LOCAL_EVE_CYCLE_FILE: input.cycleFile,
    APP_BUILDER_SANDBOX_PROVIDER: "vercel",
    EVE_AGENT_HOST: `http://127.0.0.1:${input.evePort}`,
    EVE_HOSTED_ADAPTER: "0",
    HOME: input.runtimeHome,
    LANG: process.env.LANG ?? "C",
    LC_ALL: process.env.LC_ALL ?? "C",
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_ENV: "development" as const,
    PATH: `${nodePath.dirname(requiredEnvironment("APP_BUILDER_DEV_NODE_BIN"))}:/usr/bin:/bin`,
    TMPDIR: input.runtimeHome,
    TZ: process.env.TZ ?? "UTC",
    // Next's env loader preserves explicitly supplied values. Empty values
    // prevent .env.local from projecting provider credentials into this child.
    VERCEL_OIDC_TOKEN: "",
    VERCEL_TOKEN: "",
  } satisfies NodeJS.ProcessEnv;
}

async function runEveCycle(input: {
  cycleFile: string;
  sourceRoot: string;
  runsRoot: string;
  resumeCycle?: string;
  codexRoot: string;
  supervisorRoot: string;
  packageState: DevelopmentSupervisorState;
  destinationRoot: string;
  installPlugin?: boolean;
  nextPort: number;
  hostedSession?: HostedSessionConnection;
  evePort: number;
  signal: AbortSignal;
  shutdownExitCode: () => number;
  web?: Awaited<ReturnType<typeof prepareDevelopmentEmulatedWeb>>;
  nextExited: Promise<{ kind: "next-exit" | "web-exit"; code: number }>;
}) {
  input.signal.throwIfAborted();
  // `mise run dev` refreshes once before the supervisor starts. Eve may be
  // restarted much later, so recheck the same owner-bound project token before
  // each child launch and refresh it only when the existing lifetime guard
  // requires it.
  ensureLocalDevelopmentOidc({
    miseExecutable: requiredEnvironment("APP_BUILDER_DEV_MISE_BIN"),
    repositoryRoot,
    vercelExecutable: requiredEnvironment("APP_BUILDER_DEV_VERCEL_BIN"),
  });
  // Every child gets a new restart generation. Next keeps its public local
  // session index, observes this marker on the next MCP request, and fences
  // any response stream owned by the child we are replacing.
  await rotateLocalEveCycleBinding(input.cycleFile);
  const cycleStartedAt = performance.now();
  const activeRunPath = await mkdtemp(nodePath.join(input.runsRoot, "run-"));
  const activeRun = await privateRoot(activeRunPath);
  const cycle =
    input.resumeCycle === undefined
      ? await createDevelopmentCycle({ repositoryRoot, supervisorRoot: input.supervisorRoot })
      : await resumeDevelopmentCycle({
          cycleRoot: input.resumeCycle,
          evePort: input.evePort,
          repositoryRoot,
          runsRoot: input.runsRoot,
        });
  try {
    const dependencyBinding = await assertDevelopmentApplicationDependencies({
      applicationRoot: cycle.application.root,
      repositoryRoot,
    });
    console.log("[builder:development:dependencies]", JSON.stringify(dependencyBinding));
    const snapshot = await createDevelopmentSnapshot({
      runRoot: activeRun,
      sourceRoot: input.sourceRoot,
    });
    const dependencyKey = await developmentDependencyKey({
      platform: "linux/amd64",
      sourceRoot: snapshot.root,
      tools: developmentTools,
    });
    const dependencyCacheHit = input.packageState.dependencyKey === dependencyKey;
    const previousEntries = new Map(
      input.packageState.snapshot?.entries.map((entry) => [entry.path, entry]),
    );
    const currentEntries = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
    const changedPaths = new Set([...previousEntries.keys(), ...currentEntries.keys()]);
    let snapshotDeltaFiles = 0;
    let snapshotDeltaBytes = 0;
    for (const path of changedPaths) {
      const previous = previousEntries.get(path);
      const current = currentEntries.get(path);
      if (previous?.digest === current?.digest) {
        continue;
      }
      snapshotDeltaFiles += 1;
      snapshotDeltaBytes += current?.bytes ?? previous?.bytes ?? 0;
    }
    const runtimeFingerprint = await fingerprintDevelopmentRuntime(repositoryRoot);
    const packageFingerprint = await developmentPackageFingerprint({
      hostedSession: input.hostedSession,
      origin: input.web?.origin,
      port: input.nextPort,
      repositoryRoot,
    });
    const packageReused =
      input.packageState.fingerprint === packageFingerprint &&
      input.packageState.result !== undefined;
    if (!packageReused) {
      input.packageState.result = await createDevelopmentPackage({
        hostedSession: input.hostedSession,
        origin: input.web?.origin,
        outputRoot: input.codexRoot,
        port: input.nextPort,
        repositoryRoot,
      });
      input.packageState.fingerprint = packageFingerprint;
    }
    const packageResult = input.packageState.result;
    if (packageResult === undefined) {
      throw new Error("Development package was unavailable.");
    }
    const closed = developmentLaunchEnvironment({
      dependencyKey,
      destinationRoot: input.destinationRoot,
      evePort: input.evePort,
      fingerprint: snapshot.fingerprint,
      snapshotRoot: snapshot.root,
      sourceRoot: input.sourceRoot,
      sourceSha: snapshot.commit,
      sourceTree: snapshot.tree,
    });
    const wrapperEnvironment = await prepareDevelopmentEveWrapperEnvironment({
      applicationRoot: cycle.application.root,
      closed,
      cycleFile: input.cycleFile,
      environment: process.env,
      nodeExecutable: requiredEnvironment("APP_BUILDER_DEV_NODE_BIN"),
      repositoryRoot,
      runsRoot: input.runsRoot,
      runtimeHome: cycle.runtimeHome,
      signal: input.signal,
      supervisorRoot: nodePath.dirname(cycle.root),
      vercelExecutable: requiredEnvironment("APP_BUILDER_DEV_VERCEL_BIN"),
      workflowData: cycle.workflowData,
    });
    input.signal.throwIfAborted();
    const stopOidcLease = maintainLocalDevelopmentOidcLease({
      applicationRoot: cycle.application.root,
      miseExecutable: requiredEnvironment("APP_BUILDER_DEV_MISE_BIN"),
      onUnavailable: () => {
        console.warn(
          "Builder model credential renewal is unavailable; saved work is preserved. Check the existing Vercel login.",
        );
      },
      repositoryRoot,
      runtimeHome: cycle.runtimeHome,
      vercelExecutable: requiredEnvironment("APP_BUILDER_DEV_VERCEL_BIN"),
    });
    const eve = spawn(
      requiredEnvironment("APP_BUILDER_DEV_NODE_BIN"),
      [
        "--import",
        "tsx",
        nodePath.join(
          repositoryRoot,
          ".config/mise/scripts/repository/run-local-development-eve.mts",
        ),
        ...(input.resumeCycle === undefined ? [] : ["--resume"]),
      ],
      {
        cwd: repositoryRoot,
        // Eve starts a local server child of its own.  Put this wrapper and
        // every descendant in a separate process group so Ctrl+C cleans up
        // the whole Eve cycle instead of leaving its listener on the port.
        detached: process.platform !== "win32",
        env: wrapperEnvironment,
        stdio: "inherit",
      },
    );
    const watchers = new AbortController();
    if (runtimeFingerprint === undefined) {
      throw new Error("Development runtime fingerprint is unavailable.");
    }
    // Eve reads the canonical Arrusted checkout directly. Its ordinary edits
    // are live planning input and must not replace the child or local queue.
    // Source edits must not end the process that owns active or waiting sessions.
    // A new runtime generation is an explicit separate instance, not a restart race.
    void (async () => {
      try {
        await observeDevelopmentRuntimeChanges({
          expectedFingerprint: runtimeFingerprint,
          onChanged: () => {
            console.info(
              "Builder runtime source changed; existing Eve sessions retain their pinned worker. Use a separate local instance to exercise the changed runtime.",
            );
          },
          repositoryRoot,
          signal: watchers.signal,
        });
      } catch {
        console.warn(
          "Builder runtime source observation is unavailable; the pinned Eve worker remains running.",
        );
      }
    })();
    const eveExited = exitOutcome(developmentChildExit(eve), "eve-exit");
    const stopping = waitForDevelopmentShutdown(input.signal, input.shutdownExitCode);
    try {
      const startup = await Promise.race([
        (async () => {
          await waitForDevelopmentMcp({
            endpoint: packageResult.receipt.endpoint,
            fetcher: input.web?.fetcher,
            signal: watchers.signal,
          });
          return { code: 0, kind: "ready" as const };
        })(),
        eveExited,
        input.nextExited,
        stopping,
      ]);
      if (startup.kind !== "ready") {
        return startup;
      }
      if (!packageReused) {
        await registerDevelopmentPackage({
          codexBin: process.env.APP_BUILDER_DEV_CODEX_BIN,
          codexHome: process.env.APP_BUILDER_DEV_CODEX_HOME,
          installPlugin: input.installPlugin,
          marketplaceRoot: packageResult.marketplaceRoot,
          version: packageResult.receipt.version,
        });
      }
      console.info(
        JSON.stringify({
          cycleRoot: cycle.root,
          dependencyCache: dependencyCacheHit ? "hit" : "miss",
          eveRestartMs: Math.round(performance.now() - cycleStartedAt),
          event: "autograph.local.eve-cycle",
          packageReused,
          persistentEveStateReused: input.resumeCycle !== undefined,
          snapshotDeltaBytes,
          snapshotDeltaFiles,
        }),
      );
      input.packageState.dependencyKey = dependencyKey;
      input.packageState.snapshot = snapshot;
      console.log("Autograph App Builder development is ready.");
      console.log(
        "Connect a client to the loopback endpoint below. If plugin installation is enabled, select Autograph App Builder (Development) in a fresh Codex task.",
      );
      console.log(`Loopback endpoint: ${packageResult.receipt.endpoint}`);
      if (input.hostedSession !== undefined) {
        console.log(
          `Existing-session connector: ${input.hostedSession.resourceUrl} (local native transport; hosted execution)`,
        );
      }
      return await Promise.race([eveExited, input.nextExited, stopping]);
    } finally {
      stopOidcLease();
      watchers.abort();
      await stopDevelopmentChild(eve, { processGroup: true });
      await waitForDevelopmentPortRelease(input.evePort);
    }
  } finally {
    await removeDevelopmentSnapshot(activeRun);
  }
}

const shutdown = createDevelopmentShutdown();
let next: ChildProcess | undefined;
let web: Awaited<ReturnType<typeof prepareDevelopmentEmulatedWeb>> | undefined;
try {
  const args = parseDevelopmentArguments(process.argv.slice(2));
  const sourceRoot = await realpath(args.arrustedRoot);
  const artifactRoot = await privateRoot(
    args.stateRoot ?? nodePath.join(repositoryRoot, ".artifacts/development"),
  );
  const stateRoot = await privateRoot(nodePath.join(artifactRoot, "state"));
  const cycleFile = nodePath.join(stateRoot, "eve-cycle");
  await rotateLocalEveCycleBinding(cycleFile);
  const cacheRoot = await privateRoot(nodePath.join(artifactRoot, "cache"));
  const runsRoot = await privateRoot(nodePath.join(stateRoot, "runs"));
  // A completed invocation leaves its Eve runtime behind for diagnosis.  Give
  // every new `mise run dev` invocation a private supervisor root so starting
  // again never collides with that finished application tree. Each targeted
  // Eve restart receives a separate cycle root below this supervisor.
  const supervisorRoot = await privateRoot(
    await realpath(await mkdtemp(nodePath.join(runsRoot, "supervisor-"))),
  );
  const packageState: DevelopmentSupervisorState = {};
  const hostedSession: HostedSessionConnection | undefined =
    args.hostedSessionResource === undefined
      ? undefined
      : {
          codexBin: args.hostedSessionCodexBin ?? requiredEnvironment("APP_BUILDER_DEV_CODEX_BIN"),
          cwd: await privateRoot(nodePath.join(stateRoot, "native-session-client")),
          nodeBin: requiredEnvironment("APP_BUILDER_DEV_NODE_BIN"),
          resourceUrl: args.hostedSessionResource,
        };
  const nextHome = await privateRoot(nodePath.join(stateRoot, "next-home"));
  const destinationRoot = await privateRoot(
    args.destinationRoot ?? nodePath.join(artifactRoot, "destination"),
  );
  if (args.emulatedWeb === true) {
    web = await prepareDevelopmentEmulatedWeb({
      args,
      repositoryRoot,
      signal: shutdown.signal,
      stateRoot,
    });
  }
  next = spawn(
    requiredEnvironment("APP_BUILDER_DEV_NODE_BIN"),
    [
      await realpath(nodePath.join(repositoryRoot, "node_modules/next/dist/bin/next")),
      "dev",
      ...developmentNextBundlerArguments(args),
      ...(web?.nextArgs ?? []),
      "--hostname",
      web === undefined ? "127.0.0.1" : "localhost",
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
        web,
      }),
      stdio: "inherit",
    },
  );
  const nextProcessExited = exitOutcome(developmentChildExit(next), "next-exit");
  const webExited = web === undefined ? undefined : exitOutcome(web.exited, "web-exit");
  const nextExited =
    webExited === undefined ? nextProcessExited : Promise.race([nextProcessExited, webExited]);
  const supervise = async (): Promise<void> => {
    if (shutdown.signal.aborted) return;
    const codexRoot = await privateRoot(nodePath.join(cacheRoot, "codex"));
    const outcome = await runEveCycle({
      codexRoot,
      cycleFile,
      destinationRoot,
      evePort: args.evePort,
      hostedSession,
      installPlugin: args.installPlugin,
      nextExited,
      nextPort: args.nextPort,
      packageState,
      resumeCycle: args.resumeCycle,
      runsRoot,
      shutdownExitCode: shutdown.exitCode,
      signal: shutdown.signal,
      sourceRoot,
      supervisorRoot,
      web,
    });
    if (
      outcome.kind === "next-exit" ||
      outcome.kind === "eve-exit" ||
      outcome.kind === "web-exit" ||
      outcome.kind === "stop"
    ) {
      process.exitCode = outcome.code;
      return;
    }
    await supervise();
  };
  await supervise();
} catch (error) {
  if (!shutdown.signal.aborted) {
    throw error;
  }
  process.exitCode = shutdown.exitCode();
} finally {
  if (next !== undefined) {
    await stopDevelopmentChild(next);
  }
  await web?.stop();
  shutdown.dispose();
}
