import type { Command, Sandbox } from "@vercel/sandbox";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { PublicWorkingPreview } from "../mcp/contracts";
import { previewOwnershipOperation, previewOwnershipSource } from "./working-preview-ownership";
import type { PreviewAttempt } from "./working-preview-ownership";
import {
  workingPreviewDiagnosticCollectorSource,
  workingPreviewDiagnosticExcerpt,
} from "./working-preview-diagnostics";
import { createWorkingPreviewAccess } from "./working-preview-access";

export interface WorkingPreviewCommand {
  executable: string;
  args: string[];
}

export interface WorkingPreviewRuntime {
  sandboxId: string;
  providerSessionId: string;
  commandId: string;
  /** Hash of the accepted app build and launch settings; avoids restarting the same live preview. */
  requestDigest?: string;
  receipt: PublicWorkingPreview;
}

const previewLifetimeMs = 10 * 60_000;

const missingRuntimeFile = (error: unknown): null => {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return null;
  }
  throw error;
};

export const workingPreviewSupervisorSource = (input: {
  gatewaySource: string;
  command: WorkingPreviewCommand;
  cwd: string;
  expiresAt: number;
  failurePath: string;
  readyPath: string;
  configurationPath: string;
  ownership?: PreviewAttempt;
  diagnosticsPath?: string;
}): string => `${
  input.ownership === undefined
    ? ""
    : `${previewOwnershipSource}
const supervisorOwnership = ${JSON.stringify(input.ownership)};
await ownershipOperation({kind:"assert", ...supervisorOwnership});
await ownershipOperation({kind:"update", attemptId:supervisorOwnership.attemptId, providerSessionId:supervisorOwnership.providerSessionId, patch:{supervisorPid:process.pid, supervisorPath:process.argv[1]}});
`
}${input.gatewaySource}
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
const launch = ${JSON.stringify({ ...input, gatewaySource: undefined })};
${workingPreviewDiagnosticCollectorSource}
let stderr = "";
let closing = false;
let child;
const close = () => {
  if (closing) return;
  closing = true;
  clearInterval(activation);
  if (child?.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
  server.close();
  setTimeout(() => { if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } process.exit(); }, 1000);
};
const fail = message => { writeFileSync(launch.failurePath, JSON.stringify({ message, stderr })); close(); };
const activation = setInterval(() => {
  if (launch.ownership !== undefined) {
    const owner = ownershipRead();
    if (owner?.attemptId !== launch.ownership.attemptId || owner.providerSessionId !== launch.ownership.providerSessionId || owner.expiresAt <= Date.now() || owner.status !== "starting") { close(); return; }
  }
  if (!existsSync(launch.configurationPath)) return;
  clearInterval(activation);
  child = spawn(launch.command.executable, launch.command.args, { cwd: launch.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => { if (launch.diagnosticsPath) appendPreviewDiagnostic("stdout", chunk); process.stdout.write(chunk); });
  child.stderr.on("data", chunk => { if (launch.diagnosticsPath) appendPreviewDiagnostic("stderr", chunk); stderr = (stderr + chunk.toString()).slice(-8192); process.stderr.write(chunk); });
  child.on("error", error => fail(error.message));
  child.on("exit", (code, signal) => { if (!closing) fail("Application server exited: " + (signal ?? code)); });
}, 50);
server.on("listening", () => writeFileSync(launch.readyPath, "ready"));
server.on("error", error => fail(error.message));
process.on("SIGTERM", close);
process.on("SIGINT", close);
setTimeout(close, Math.max(0, launch.expiresAt - Date.now()));
`;

const requestSignal = (signal?: AbortSignal) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);

// This jar follows same-origin HTTP readiness redirects. Browser authentication
// and cookie behavior still require the separate product acceptance walkthrough.
const absorbCookies = (cookies: Map<string, string>, response: Response) => {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    const separator = pair.indexOf("=");
    if (separator > 0) {
      cookies.set(pair.slice(0, separator), pair);
    }
  }
};

const openApp = async (input: {
  launchUrl: string;
  observe: (observation: string) => void;
  fetch: typeof fetch;
  signal?: AbortSignal;
}): Promise<boolean> => {
  const launch = await input.fetch(input.launchUrl, {
    redirect: "manual",
    signal: requestSignal(input.signal),
  });
  input.observe(`Launch HTTP ${launch.status}`);
  const cookies = new Map<string, string>();
  absorbCookies(cookies, launch);
  const location = launch.headers.get("location");
  await launch.body?.cancel();
  if (launch.status !== 303 || cookies.size === 0 || !location) {
    input.observe(`Launch HTTP ${launch.status}; expected redirect with access cookie`);
    return false;
  }
  const { origin } = new URL(input.launchUrl);
  let url = new URL(location, origin);
  for (let redirects = 0; redirects < 5; redirects += 1) {
    if (url.origin !== origin) {
      input.observe("Application redirected outside the preview origin");
      return false;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- Follow the application's actual navigation sequentially.
    const response = await input.fetch(url, {
      headers: { cookie: [...cookies.values()].join("; ") },
      redirect: "manual",
      signal: requestSignal(input.signal),
    });
    input.observe(`Application HTTP ${response.status}`);
    absorbCookies(cookies, response);
    const next = response.headers.get("location");
    const ready = response.ok && response.headers.get("content-type")?.includes("text/html");
    // oxlint-disable-next-line eslint/no-await-in-loop -- Release the current response before following its redirect.
    await response.body?.cancel();
    if (ready) {
      return true;
    }
    if (response.status < 300 || response.status >= 400 || !next) {
      return false;
    }
    url = new URL(next, url);
  }
  input.observe("Application exceeded the readiness redirect limit");
  return false;
};

const waitForPreview = async (input: {
  provider: Sandbox;
  check: (observe: (observation: string) => void, signal: AbortSignal) => Promise<boolean>;
  phase: "listener startup" | "application HTTP readiness";
  failurePath: string;
  signal?: AbortSignal;
  readinessTimeoutMs: number;
}) => {
  const deadline = Date.now() + input.readinessTimeoutMs;
  const stageSignal = AbortSignal.any([
    AbortSignal.timeout(input.readinessTimeoutMs),
    ...(input.signal === undefined ? [] : [input.signal]),
  ]);
  let observation = "No readiness observation completed";
  const observe = (value: string) => {
    observation = value;
  };
  while (!stageSignal.aborted && Date.now() < deadline) {
    input.signal?.throwIfAborted();
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Observe one startup; never rerun it on a polling timeout.
      if (await input.check(observe, stageSignal)) {
        stageSignal.throwIfAborted();
        return;
      }
    } catch (error) {
      input.signal?.throwIfAborted();
      if (stageSignal.aborted) {
        break;
      }
      // Report only known classes, never messages, URLs, headers, or custom names.
      observe(
        error instanceof TypeError ? "Readiness transport TypeError" : "Readiness check Error",
      );
      // Connection refusal is normal during startup. Check its actual diagnostics below.
    }
    input.signal?.throwIfAborted();
    // oxlint-disable-next-line eslint/no-await-in-loop -- Read this same attempt's startup diagnostics.
    const failure = await input.provider.fs
      .readFile(input.failurePath, {
        encoding: "utf-8",
        signal: stageSignal,
      })
      .catch((error: unknown) => {
        input.signal?.throwIfAborted();
        if (stageSignal.aborted) {
          return null;
        }
        return missingRuntimeFile(error);
      });
    if (failure) {
      throw new Error(
        `The application server failed to start. ${workingPreviewDiagnosticExcerpt(failure) || "No safe process diagnostic was available."}`,
      );
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- Wait for the current startup without launching a new one.
    await delay(500, undefined, { signal: stageSignal }).catch((error: unknown) => {
      if (!stageSignal.aborted) {
        throw error;
      }
    });
    input.signal?.throwIfAborted();
  }
  throw new Error(
    `The application preview timed out during ${input.phase}. Last observation: ${observation}.`,
  );
};

/** A successful signal request is not evidence that its listener has terminated. */
export const stopWorkingPreviewCommand = async (command: Command): Promise<void> => {
  const signal = AbortSignal.timeout(10_000);
  await command.kill("SIGTERM", { abortSignal: signal });
  await command.wait({ signal });
};

const attemptIdentity = (attempt: PreviewAttempt) => ({
  attemptId: attempt.attemptId,
  providerSessionId: attempt.providerSessionId,
});

const reconcilePreviewAttempt = async (
  provider: Sandbox,
  attempt: PreviewAttempt,
): Promise<void> => {
  const signal = AbortSignal.timeout(15_000);
  if (
    attempt.providerSessionId === provider.currentSession().sessionId &&
    (attempt.status === "starting" || attempt.commandId === undefined)
  ) {
    if (attempt.expiresAt > Date.now()) {
      throw new Error(
        "The previous preview startup is still pending. Wait for it to finish before starting another preview.",
      );
    }
    if (attempt.commandId !== undefined) {
      const prior = await provider.getCommand(attempt.commandId, { signal });
      if (prior.exitCode === null) {
        throw new Error(
          "The previous preview supervisor is still running; its startup must settle before retrying.",
        );
      }
    }
    if (attempt.supervisorPid !== undefined) {
      const check = await provider.runCommand({
        args: [
          "-e",
          `try { process.kill(${attempt.supervisorPid}, 0); process.exitCode=1; } catch (error) { if (error.code !== "ESRCH") throw error; }`,
        ],
        cmd: "node",
        signal,
      });
      if (check.exitCode !== 0) {
        throw new Error(
          "The previous preview supervisor is still running; its startup must settle before retrying.",
        );
      }
    }
  }
  try {
    if (
      attempt.providerSessionId === provider.currentSession().sessionId &&
      attempt.commandId !== undefined
    ) {
      const command = await provider.getCommand(attempt.commandId, { signal });
      await (command.exitCode === null
        ? stopWorkingPreviewCommand(command)
        : command.wait({ signal }));
    }
    await previewOwnershipOperation(
      provider,
      { kind: "release", ...attemptIdentity(attempt) },
      signal,
    );
  } catch (error) {
    await previewOwnershipOperation(
      provider,
      { kind: "update", ...attemptIdentity(attempt), patch: { status: "cleanup-required" } },
      AbortSignal.timeout(5000),
    );
    throw error;
  }
};

const claimPreviewAttempt = async (
  provider: Sandbox,
  attempt: PreviewAttempt,
  signal?: AbortSignal,
) => {
  const current = await previewOwnershipOperation<PreviewAttempt | null>(
    provider,
    { kind: "read" },
    signal,
  );
  if (current !== null) {
    await reconcilePreviewAttempt(provider, current);
  }
  const result = await previewOwnershipOperation<{ claimed: boolean }>(
    provider,
    { attempt, kind: "claim" },
    signal,
  );
  if (!result.claimed) {
    throw new Error("Another preview startup owns this sandbox. Wait for that attempt to settle.");
  }
};

const cleanupPreviewAttempt = async (input: {
  provider: Sandbox;
  attempt: PreviewAttempt;
  command?: Command;
  diagnosticsPath?: string;
  expiresAt: number;
  launchDispatched: boolean;
  error: unknown;
  onAttempt?: (attempt: PreviewAttempt | null) => void;
}): Promise<never> => {
  const {
    provider,
    attempt,
    command,
    diagnosticsPath,
    expiresAt,
    launchDispatched,
    error,
    onAttempt,
  } = input;
  // Keep ownership until both ingress closure and process termination settle.
  // An expired/stale controller must never alter a replacement's ingress.
  let diagnostic = "";
  if (diagnosticsPath !== undefined) {
    try {
      diagnostic = workingPreviewDiagnosticExcerpt(
        await provider.fs.readFile(diagnosticsPath, {
          encoding: "utf-8",
          signal: AbortSignal.timeout(5000),
        }),
      );
    } catch {
      /* Diagnostic access must not prevent cleanup. */
    }
  }
  const failure =
    diagnostic && error instanceof Error
      ? new Error(`${error.message}\n${diagnostic}`, { cause: error })
      : error;
  const current = await previewOwnershipOperation<PreviewAttempt | null>(
    provider,
    { kind: "read" },
    AbortSignal.timeout(5000),
  ).catch(() => null);
  const owned =
    current?.attemptId === attempt.attemptId &&
    current.providerSessionId === attempt.providerSessionId &&
    current.status === "starting";
  const cleanup = await Promise.allSettled([
    command === undefined ? undefined : stopWorkingPreviewCommand(command),
    owned && Date.now() < expiresAt
      ? provider.update({ ports: [] }, { signal: AbortSignal.timeout(10_000) })
      : undefined,
  ]);
  const failed = cleanup.filter((result) => result.status === "rejected");
  if (launchDispatched && command === undefined) {
    failed.push({
      reason: new Error(
        "Preview command dispatch did not return its identity; cleanup remains pending.",
      ),
      status: "rejected",
    });
  }
  try {
    if (owned) {
      if (failed.length === 0) {
        await previewOwnershipOperation(
          provider,
          { kind: "release", ...attemptIdentity(attempt) },
          AbortSignal.timeout(5000),
        );
        onAttempt?.(null);
      } else {
        const pending = { ...attempt, status: "cleanup-required" as const };
        await previewOwnershipOperation(
          provider,
          { kind: "update", ...attemptIdentity(attempt), patch: { status: "cleanup-required" } },
          AbortSignal.timeout(5000),
        );
        onAttempt?.(pending);
      }
    }
  } catch (journalError) {
    failed.push({ reason: journalError, status: "rejected" });
  }
  if (failed.length > 0) {
    throw new AggregateError(
      [failure, ...failed.map((result) => result.reason)],
      `Preview startup failed and its cleanup was incomplete. ${failure instanceof Error ? failure.message : "Startup did not complete."}`,
      { cause: failure },
    );
  }
  throw failure;
};

/** Runs only in the already-approved user sandbox. A ready receipt is HTTP evidence, not product verification. */
export const startWorkingPreview = async (input: {
  provider: Sandbox;
  sandboxId: string;
  appId: string;
  cwd: string;
  command: WorkingPreviewCommand;
  port: number;
  landingPath: string;
  requestDigest?: string;
  previous?: WorkingPreviewRuntime | null;
  fetch?: typeof fetch;
  readinessTimeoutMs?: number;
  signal?: AbortSignal;
  onAttempt?: (attempt: PreviewAttempt | null) => void;
}): Promise<WorkingPreviewRuntime> => {
  input.signal?.throwIfAborted();
  const { provider } = input;
  const expiresAt = Date.now() + previewLifetimeMs;
  const signal = AbortSignal.any([
    AbortSignal.timeout(previewLifetimeMs),
    ...(input.signal === undefined ? [] : [input.signal]),
  ]);
  const providerSessionId = provider.currentSession().sessionId;
  const gatewayPort = input.port === 3001 ? 3002 : 3001;
  const attempt: PreviewAttempt = {
    attemptId: randomUUID(),
    expiresAt,
    providerSessionId,
    status: "starting",
  };
  await claimPreviewAttempt(provider, attempt, signal);
  input.onAttempt?.(attempt);
  let command: Command | undefined;
  let launchDispatched = false;
  let diagnosticsPath: string | undefined;
  try {
    // Bind a deny-by-default listener before exposing any inbound port.
    await provider.update({ networkPolicy: "allow-all", ports: [] }, { signal });
    if (input.previous?.providerSessionId === providerSessionId) {
      const previous = await provider.getCommand(input.previous.commandId, { signal });
      if (previous.exitCode === null) {
        await previous.kill("SIGTERM", { abortSignal: signal });
      }
      await previous.wait({ signal });
    }

    const directory = `/workspace/.autograph-working-preview/${randomUUID()}`;
    const failurePath = `${directory}/startup-error.json`;
    const readyPath = `${directory}/listener-ready`;
    diagnosticsPath = `${directory}/diagnostics.json`;
    const supervisorPath = `${directory}/server.mjs`;
    const configurationPath = `${directory}/access.json`;
    const remaining = (provider.expiresAt?.getTime() ?? Date.now()) - Date.now();
    if (remaining < previewLifetimeMs + 120_000) {
      await provider.extendTimeout(previewLifetimeMs + 120_000 - remaining, { signal });
    }
    const accessInput = {
      appPort: input.port,
      configurationPath,
      expiresAt,
      gatewayPort,
      landingPath: input.landingPath,
    };
    const inactive = createWorkingPreviewAccess({
      ...accessInput,
      origin: "https://pending.invalid",
    });
    signal?.throwIfAborted();
    await provider.fs.mkdir(directory, { recursive: true, signal });
    await provider.fs.writeFile(
      supervisorPath,
      workingPreviewSupervisorSource({
        command: input.command,
        configurationPath,
        cwd: input.cwd,
        diagnosticsPath,
        expiresAt,
        failurePath,
        gatewaySource: inactive.source,
        ownership: attempt,
        readyPath,
      }),
      { signal },
    );
    launchDispatched = true;
    command = await provider.runCommand({
      args: [supervisorPath],
      cmd: "node",
      detached: true,
      signal,
    });
    attempt.commandId = command.cmdId;
    await previewOwnershipOperation(
      provider,
      { kind: "update", ...attemptIdentity(attempt), patch: { commandId: command.cmdId } },
      signal,
    );
    input.onAttempt?.(attempt);
    const waitOptions = {
      failurePath,
      provider,
      readinessTimeoutMs: input.readinessTimeoutMs ?? 120_000,
      signal,
    };
    await waitForPreview({
      ...waitOptions,
      check: async (observe, readinessSignal) => {
        const ready =
          (await provider.fs
            .readFile(readyPath, { encoding: "utf-8", signal: readinessSignal })
            .catch(missingRuntimeFile)) === "ready";
        observe(ready ? "Listener ready" : "Listener readiness marker absent");
        return ready;
      },
      phase: "listener startup",
    });
    signal?.throwIfAborted();
    await previewOwnershipOperation(
      provider,
      { kind: "assert", ...attemptIdentity(attempt) },
      signal,
    );
    await provider.update({ ports: [gatewayPort] }, { signal });
    const access = createWorkingPreviewAccess({
      ...accessInput,
      origin: provider.domain(gatewayPort),
    });
    await provider.fs.writeFile(configurationPath, access.configuration, { signal });
    await waitForPreview({
      ...waitOptions,
      check: (observe, readinessSignal) =>
        openApp({
          fetch: input.fetch ?? fetch,
          launchUrl: access.launchUrl,
          observe,
          signal: readinessSignal,
        }),
      phase: "application HTTP readiness",
    });
    signal?.throwIfAborted();
    await previewOwnershipOperation(
      provider,
      { kind: "update", ...attemptIdentity(attempt), patch: { status: "ready" } },
      signal,
    );
    input.onAttempt?.(null);
    return {
      commandId: command.cmdId,
      providerSessionId,
      ...(input.requestDigest === undefined ? {} : { requestDigest: input.requestDigest }),
      receipt: {
        appId: input.appId,
        expiresAt: new Date(expiresAt).toISOString(),
        status: "ready",
        url: access.launchUrl,
        verifiedAt: new Date().toISOString(),
      },
      sandboxId: input.sandboxId,
    };
  } catch (error) {
    return cleanupPreviewAttempt({
      attempt,
      command,
      diagnosticsPath: input.signal?.aborted ? undefined : diagnosticsPath,
      error,
      expiresAt,
      launchDispatched,
      onAttempt: input.onAttempt,
      provider,
    });
  }
};
