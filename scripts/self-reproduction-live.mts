import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const candidateRoot = required("SELF_REPRODUCTION_CANDIDATE_ROOT");
const arrustedRoot = required("SELF_REPRODUCTION_ARRUSTED_ROOT");
const briefPath = required("SELF_REPRODUCTION_BRIEF_PATH");
const answersPath = required("SELF_REPRODUCTION_ANSWERS_PATH");
const transcriptPath = required("SELF_REPRODUCTION_TRANSCRIPT_PATH");
const stateRoot = resolve(
  process.env.SELF_REPRODUCTION_STATE_ROOT ?? join(candidateRoot, "..", "runtime"),
);
const configuredNextPort = process.env.SELF_REPRODUCTION_NEXT_PORT;
const configuredEvePort = process.env.SELF_REPRODUCTION_EVE_PORT;
const generationTimeoutMs = Number(process.env.SELF_REPRODUCTION_GENERATION_TIMEOUT_MS ?? "600000");
const providerRequestTimeoutMs = Number(
  process.env.SELF_REPRODUCTION_PROVIDER_REQUEST_TIMEOUT_MS ?? "30000",
);

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} was required for the live self-reproduction run.`);
  return value;
}

async function availableLoopbackPort(configured: string | undefined): Promise<number> {
  if (configured !== undefined) {
    const port = Number(configured);
    if (Number.isInteger(port) && port > 0 && port < 65_536) return port;
    throw new Error("Configured self-reproduction ports must be valid TCP ports.");
  }
  const server = createServer();
  await new Promise<void>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePort());
  });
  const address = server.address();
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  if (address === null || typeof address === "string") throw new Error("A loopback port was unavailable.");
  return address.port;
}

function run(
  command: string,
  args: string[],
  options: { input?: string; timeoutMs?: number } = {},
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((done) => {
    const child = spawn(command, args, { cwd: root, stdio: "pipe", env: process.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let forceStop: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceStop = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, options.timeoutMs ?? 0);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk: Buffer) => (stderr += String(chunk)));
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
    child.on("close", (code) => {
      clearTimeout(timer);
      if (forceStop !== undefined) clearTimeout(forceStop);
      done({ code, stdout, stderr, timedOut });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (forceStop !== undefined) clearTimeout(forceStop);
      done({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
  });
}

async function waitForEve(url: string, signal: AbortSignal) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && !signal.aborted) {
    try {
      const response = await fetch(url, { signal });
      if (response.status < 500) return;
    } catch {
      // The development process is expected to take time while it prepares its isolated runtime.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The local Eve agent did not become ready within two minutes.");
}

function answerFor(result: unknown, answers: Record<string, string>) {
  const serialized = JSON.stringify(result).toLowerCase();
  if (serialized.includes("approve")) return "approve";
  for (const [key, value] of Object.entries(answers)) if (serialized.includes(key)) return value;
  return "continue with the benchmark defaults";
}

async function main() {
  await mkdir(candidateRoot, { recursive: true, mode: 0o700 });
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const brief = await readFile(briefPath, "utf8");
  const answers = (
    JSON.parse(await readFile(answersPath, "utf8")) as { responses: Record<string, string> }
  ).responses;
  const controller = new AbortController();
  const nextPort = await availableLoopbackPort(configuredNextPort);
  let evePort = await availableLoopbackPort(configuredEvePort);
  while (evePort === nextPort) evePort = await availableLoopbackPort(undefined);
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
  const developmentExited = new Promise<void>((resolve) =>
    development.once("close", () => resolve()),
  );
  development.once("close", () => controller.abort());
  development.stdout.on("data", (chunk: Buffer) => void appendFile(transcriptPath, String(chunk)));
  development.stderr.on("data", (chunk: Buffer) => void appendFile(transcriptPath, String(chunk)));
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
    let invocation = await run(process.execPath, [
      "node_modules/eve/bin/eve.js",
      "invoke",
      "--url",
      url,
      brief,
    ], { timeoutMs: generationTimeoutMs });
    await appendFile(transcriptPath, `${invocation.stdout}\n${invocation.stderr}\n`);
    for (let turn = 0; turn < 8 && invocation.code === 3; turn += 1) {
      let result: unknown;
      try {
        result = JSON.parse(invocation.stdout);
      } catch {
        throw new Error("Eve paused without a parseable resumable result.");
      }
      invocation = await run(
        process.execPath,
        [
          "node_modules/eve/bin/eve.js",
          "invoke",
          "--url",
          url,
          "--resume",
          answerFor(result, answers),
        ],
        { input: invocation.stdout, timeoutMs: generationTimeoutMs },
      );
      await appendFile(transcriptPath, `${invocation.stdout}\n${invocation.stderr}\n`);
    }
    await writeFile(
      join(candidateRoot, "self-reproduction.workflow-results.json"),
      JSON.stringify(
        {
          "independent-creation": {
            status: invocation.code === 0 ? "unassessed" : invocation.timedOut ? "blocked" : "failed",
            evidence:
              invocation.timedOut
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

main().catch((error) => {
  process.stderr.write(
    `Self-reproduction live generation failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
});
