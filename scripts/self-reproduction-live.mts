/* oxlint-disable eslint/no-await-in-loop -- readiness retries and model turns must remain sequential. */
import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve as pathResolve } from "node:path";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} was required for the live self-reproduction run.`);
  return value;
}

const root = pathResolve(import.meta.dirname, "..");
const candidateRoot = required("SELF_REPRODUCTION_CANDIDATE_ROOT");
const arrustedRoot = required("SELF_REPRODUCTION_ARRUSTED_ROOT");
const briefPath = required("SELF_REPRODUCTION_BRIEF_PATH");
const answersPath = required("SELF_REPRODUCTION_ANSWERS_PATH");
const transcriptPath = required("SELF_REPRODUCTION_TRANSCRIPT_PATH");
const stateRoot = pathResolve(
  process.env.SELF_REPRODUCTION_STATE_ROOT ?? join(candidateRoot, "..", "runtime"),
);
const configuredNextPort = process.env.SELF_REPRODUCTION_NEXT_PORT;
const configuredEvePort = process.env.SELF_REPRODUCTION_EVE_PORT;
const generationTimeoutMs = Number(process.env.SELF_REPRODUCTION_GENERATION_TIMEOUT_MS ?? "600000");
const providerRequestTimeoutMs = Number(
  process.env.SELF_REPRODUCTION_PROVIDER_REQUEST_TIMEOUT_MS ?? "30000",
);

async function availableLoopbackPort(configured: string | undefined): Promise<number> {
  if (configured !== undefined) {
    const port = Number(configured);
    if (Number.isInteger(port) && port > 0 && port < 65_536) return port;
    throw new Error("Configured self-reproduction ports must be valid TCP ports.");
  }
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  if (address === null || typeof address === "string")
    throw new Error("A loopback port was unavailable.");
  return address.port;
}

function run(
  command: string,
  args: string[],
  options: { input?: string; timeoutMs?: number } = {},
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>(
    (resolve) => {
      const child = spawn(command, args, { cwd: root, stdio: "pipe", env: process.env });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let forceStop: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        forceStop = setTimeout(() => child.kill("SIGKILL"), 5000);
      }, options.timeoutMs ?? 0);
      timer.unref();
      child.stdout.on("data", (chunk: Buffer) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk: Buffer) => (stderr += String(chunk)));
      if (options.input) child.stdin.end(options.input);
      else child.stdin.end();
      child.on("close", (code) => {
        clearTimeout(timer);
        if (forceStop !== undefined) clearTimeout(forceStop);
        resolve({ code, stdout, stderr, timedOut });
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        if (forceStop !== undefined) clearTimeout(forceStop);
        resolve({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
      });
    },
  );
}

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

async function waitForEveAttempt(
  url: string,
  signal: AbortSignal,
  deadline: number,
): Promise<void> {
  if (Date.now() >= deadline || signal.aborted)
    throw new Error("The local Eve agent did not become ready within two minutes.");
  try {
    const response = await fetch(url, { signal });
    if (response.status < 500) return;
  } catch {
    // The development process is expected to take time while it prepares its isolated runtime.
  }
  await delay(500);
  return waitForEveAttempt(url, signal, deadline);
}

const waitForEve = (url: string, signal: AbortSignal) =>
  waitForEveAttempt(url, signal, Date.now() + 120_000);

async function availableDistinctLoopbackPort(
  excludedPort: number,
  configured: string | undefined,
): Promise<number> {
  const port = await availableLoopbackPort(configured);
  return port === excludedPort ? availableDistinctLoopbackPort(excludedPort, undefined) : port;
}

function answerFor(result: unknown, answers: Record<string, string>) {
  const serialized = JSON.stringify(result).toLowerCase();
  if (serialized.includes("approve")) return "approve";
  for (const [key, value] of Object.entries(answers)) if (serialized.includes(key)) return value;
  return "continue with the benchmark defaults";
}

type Invocation = Awaited<ReturnType<typeof run>>;

async function resumeInvocation(
  invocation: Invocation,
  remainingTurns: number,
  url: string,
  answers: Record<string, string>,
): Promise<Invocation> {
  if (remainingTurns === 0 || invocation.code !== 3) return invocation;
  let result: unknown;
  try {
    result = JSON.parse(invocation.stdout);
  } catch {
    throw new Error("Eve paused without a parseable resumable result.");
  }
  const resumed = await run(
    process.execPath,
    ["node_modules/eve/bin/eve.js", "invoke", "--url", url, "--resume", answerFor(result, answers)],
    { input: invocation.stdout, timeoutMs: generationTimeoutMs },
  );
  await appendFile(transcriptPath, `${resumed.stdout}\n${resumed.stderr}\n`);
  return resumeInvocation(resumed, remainingTurns - 1, url, answers);
}

async function main() {
  await mkdir(candidateRoot, { recursive: true, mode: 0o700 });
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const brief = await readFile(briefPath, "utf-8");
  const answers = (
    JSON.parse(await readFile(answersPath, "utf-8")) as { responses: Record<string, string> }
  ).responses;
  const controller = new AbortController();
  const nextPort = await availableLoopbackPort(configuredNextPort);
  const evePort = await availableDistinctLoopbackPort(nextPort, configuredEvePort);
  const url = `http://127.0.0.1:${evePort}`;
  const development = spawn(
    "mise",
    [
      "run",
      "dev",
      "--",
      "--arrusted-root",
      arrustedRoot,
      "--state-root",
      stateRoot,
      "--destination-root",
      candidateRoot,
      "--next-port",
      String(nextPort),
      "--eve-port",
      String(evePort),
    ],
    {
      cwd: root,
      detached: true,
      stdio: "pipe",
      env: {
        ...process.env,
        APP_BUILDER_SANDBOX_REQUEST_TIMEOUT_MS: String(providerRequestTimeoutMs),
      },
    },
  );
  const developmentExited = new Promise<void>((resolve) => {
    development.once("close", () => resolve());
  });
  development.once("close", () => controller.abort());
  development.stdout.on("data", async (chunk: Buffer) => {
    await appendFile(transcriptPath, String(chunk));
  });
  development.stderr.on("data", async (chunk: Buffer) => {
    await appendFile(transcriptPath, String(chunk));
  });
  const stop = () => {
    controller.abort();
    if (development.pid !== undefined) {
      try {
        process.kill(-development.pid, "SIGTERM");
        return;
      } catch {
        // The child may have already left its process group.
      }
    }
    development.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await waitForEve(url, controller.signal);
    let invocation = await run(
      process.execPath,
      ["node_modules/eve/bin/eve.js", "invoke", "--url", url, brief],
      { timeoutMs: generationTimeoutMs },
    );
    await appendFile(transcriptPath, `${invocation.stdout}\n${invocation.stderr}\n`);
    invocation = await resumeInvocation(invocation, 8, url, answers);
    await writeFile(
      join(candidateRoot, "self-reproduction.workflow-results.json"),
      JSON.stringify(
        {
          "independent-creation": {
            status:
              invocation.code === 0 ? "unassessed" : invocation.timedOut ? "blocked" : "failed",
            evidence: invocation.timedOut
              ? `The Vercel Sandbox-backed invocation exceeded its ${generationTimeoutMs}ms deadline.`
              : "Live Eve invocation completed; inspect the recorded transcript and generated files for workflow-level acceptance.",
          },
        },
        null,
        2,
      ),
    );
    if (invocation.timedOut) {
      process.exitCode = 75;
      return;
    }
    if (invocation.code !== 0)
      throw new Error(`Live Eve invocation exited ${invocation.code ?? "without a status"}.`);
  } finally {
    stop();
    if (development.exitCode === null) await developmentExited;
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `Self-reproduction live generation failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
}
