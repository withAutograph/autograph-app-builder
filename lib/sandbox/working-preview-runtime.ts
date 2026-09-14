import type { Command, Sandbox } from "@vercel/sandbox";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { PublicWorkingPreview } from "../mcp/contracts";
import { createWorkingPreviewAccess } from "./working-preview-access";

export interface WorkingPreviewCommand {
  executable: string;
  args: string[];
}

export interface WorkingPreviewRuntime {
  sandboxId: string;
  providerSessionId: string;
  commandId: string;
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
}): string => `${input.gatewaySource}
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
const launch = ${JSON.stringify({ ...input, gatewaySource: undefined })};
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
  if (!existsSync(launch.configurationPath)) return;
  clearInterval(activation);
  child = spawn(launch.command.executable, launch.command.args, { cwd: launch.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => process.stdout.write(chunk));
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-8192); process.stderr.write(chunk); });
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
  check: (observe: (observation: string) => void) => Promise<boolean>;
  phase: "listener startup" | "application HTTP readiness";
  failurePath: string;
  signal?: AbortSignal;
  readinessTimeoutMs: number;
}) => {
  const deadline = Date.now() + input.readinessTimeoutMs;
  let observation = "No readiness observation completed";
  const observe = (value: string) => {
    observation = value;
  };
  while (Date.now() < deadline) {
    input.signal?.throwIfAborted();
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Observe one startup; never rerun it on a polling timeout.
      if (await input.check(observe)) {
        return;
      }
    } catch (error) {
      input.signal?.throwIfAborted();
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
        signal: input.signal,
      })
      .catch(missingRuntimeFile);
    if (failure) {
      throw new Error(`The application server failed to start: ${failure}`);
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- Wait for the current startup without launching a new one.
    await delay(500, undefined, { signal: input.signal });
  }
  throw new Error(
    `The application preview timed out during ${input.phase}. Last observation: ${observation}.`,
  );
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
  previous?: WorkingPreviewRuntime | null;
  fetch?: typeof fetch;
  readinessTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<WorkingPreviewRuntime> => {
  input.signal?.throwIfAborted();
  const { provider, signal } = input;
  const providerSessionId = provider.currentSession().sessionId;
  const gatewayPort = input.port === 3001 ? 3002 : 3001;
  let command: Command | undefined;
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
    const supervisorPath = `${directory}/server.mjs`;
    const configurationPath = `${directory}/access.json`;
    const expiresAt = Date.now() + previewLifetimeMs;
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
        expiresAt,
        failurePath,
        gatewaySource: inactive.source,
        readyPath,
      }),
      { signal },
    );
    command = await provider.runCommand({
      args: [supervisorPath],
      cmd: "node",
      detached: true,
      signal,
    });
    const waitOptions = {
      failurePath,
      provider,
      readinessTimeoutMs: input.readinessTimeoutMs ?? 120_000,
      signal,
    };
    await waitForPreview({
      ...waitOptions,
      check: async (observe) => {
        const ready =
          (await provider.fs
            .readFile(readyPath, { encoding: "utf-8", signal })
            .catch(missingRuntimeFile)) === "ready";
        observe(ready ? "Listener ready" : "Listener readiness marker absent");
        return ready;
      },
      phase: "listener startup",
    });
    signal?.throwIfAborted();
    await provider.update({ ports: [gatewayPort] }, { signal });
    const access = createWorkingPreviewAccess({
      ...accessInput,
      origin: provider.domain(gatewayPort),
    });
    await provider.fs.writeFile(configurationPath, access.configuration, { signal });
    await waitForPreview({
      ...waitOptions,
      check: (observe) =>
        openApp({ fetch: input.fetch ?? fetch, launchUrl: access.launchUrl, observe, signal }),
      phase: "application HTTP readiness",
    });
    signal?.throwIfAborted();
    return {
      commandId: command.cmdId,
      providerSessionId,
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
    const cleanup = await Promise.allSettled([
      command?.kill("SIGTERM", { abortSignal: AbortSignal.timeout(10_000) }),
      provider.update({ ports: [] }, { signal: AbortSignal.timeout(10_000) }),
    ]);
    const failed = cleanup.filter((result) => result.status === "rejected");
    if (failed.length > 0) {
      throw new AggregateError(
        [error, ...failed.map((result) => result.reason)],
        "Preview startup failed and its cleanup was incomplete.",
        { cause: error },
      );
    }
    throw error;
  }
};
