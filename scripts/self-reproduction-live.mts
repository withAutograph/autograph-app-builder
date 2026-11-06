import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { z } from "zod";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const required = (name: string) => {
  const value = process.env[name];
  if (value === undefined || value === null || value.length === 0) {
    throw new Error(`${name} was required for the live self-reproduction run.`);
  }
  return value;
};

const root = path.resolve(import.meta.dirname, "..");
const mise = path.resolve(root, "node_modules/.bin/mise");
const answersSchema = z.object({ responses: z.record(z.string(), z.string()) });
const eveResultSchema = z.object({
  result: z.union([
    z.record(z.string(), z.unknown()),
    z.array(z.unknown()),
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
  ]),
});
const candidateRoot = required("SELF_REPRODUCTION_CANDIDATE_ROOT");
const arrustedRoot = required("SELF_REPRODUCTION_ARRUSTED_ROOT");
const briefPath = required("SELF_REPRODUCTION_BRIEF_PATH");
const answersPath = required("SELF_REPRODUCTION_ANSWERS_PATH");
const transcriptPath = required("SELF_REPRODUCTION_TRANSCRIPT_PATH");
const stateRoot = path.resolve(
  process.env.SELF_REPRODUCTION_STATE_ROOT ?? path.join(candidateRoot, "..", "runtime"),
);
const configuredNextPort = process.env.SELF_REPRODUCTION_NEXT_PORT;
const configuredEvePort = process.env.SELF_REPRODUCTION_EVE_PORT;
const generationTimeoutMs = Number(process.env.SELF_REPRODUCTION_GENERATION_TIMEOUT_MS ?? "600000");
const providerRequestTimeoutMs = Number(
  process.env.SELF_REPRODUCTION_PROVIDER_REQUEST_TIMEOUT_MS ?? "30000",
);

const availableLoopbackPort = async (configured: string | undefined): Promise<number> => {
  if (configured !== undefined) {
    const port = Number(configured);
    if (Number.isInteger(port) && port > 0 && port < 65_536) {
      return port;
    }
    throw new Error("Configured self-reproduction ports must be valid TCP ports.");
  }
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const closed = once(server, "close");
  server.close();
  await closed;
  if (address === null || !("port" in address)) {
    throw new Error("A loopback port was unavailable.");
  }
  return address.port;
};

const run = async (
  command: string,
  args: string[],
  options: { input?: string; timeoutMs?: number } = {},
) => {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    stdio: "pipe",
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let spawnError: unknown;
  let forceStop: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    void child.kill("SIGTERM");
    forceStop = setTimeout(() => {
      void child.kill("SIGKILL");
    }, 5000);
  }, options.timeoutMs ?? 0);
  timer.unref();
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += String(chunk);
  });
  if (options.input !== undefined && options.input.length > 0) {
    child.stdin.end(options.input);
  } else {
    child.stdin.end();
  }
  let code: number | null = null;
  try {
    const closed = await once(child, "close");
    const exit = z.tuple([z.number().nullable(), z.string().nullable()]).parse(closed);
    [code] = exit;
  } catch (error: unknown) {
    spawnError = error;
  }
  clearTimeout(timer);
  if (forceStop !== undefined) {
    clearTimeout(forceStop);
  }
  let capturedStderr = stderr;
  if (spawnError !== undefined) {
    const processError = spawnError instanceof Error ? spawnError.message : "Unknown process error";
    capturedStderr += processError;
  }
  return {
    code: spawnError === undefined ? code : null,
    stderr: capturedStderr,
    stdout,
    timedOut,
  };
};

const waitForEveAttempt = async (
  url: string,
  signal: AbortSignal,
  deadline: number,
): Promise<void> => {
  if (Date.now() >= deadline || signal.aborted) {
    throw new Error("The local Eve agent did not become ready within two minutes.");
  }
  try {
    const response = await fetch(url, { signal });
    if (response.status < 500) {
      return;
    }
  } catch {
    // The development process is expected to take time while it prepares its isolated runtime.
  }
  await delay(500);
  await waitForEveAttempt(url, signal, deadline);
};

const waitForEve = async (url: string, signal: AbortSignal) => {
  await waitForEveAttempt(url, signal, Date.now() + 120_000);
};

const availableDistinctLoopbackPort = async (
  excludedPort: number,
  configured: string | undefined,
): Promise<number> => {
  const port = await availableLoopbackPort(configured);
  return port === excludedPort ? await availableDistinctLoopbackPort(excludedPort) : port;
};

type EveResult = z.infer<typeof eveResultSchema>;

const answerFor = (result: EveResult, answers: Record<string, string>) => {
  const serialized = JSON.stringify(result).toLowerCase();
  if (serialized.includes("approve")) {
    return "approve";
  }
  for (const [key, value] of Object.entries(answers)) {
    if (serialized.includes(key)) {
      return value;
    }
  }
  return "continue with the benchmark defaults";
};

type Invocation = Awaited<ReturnType<typeof run>>;

const resumeInvocation = async (
  invocation: Invocation,
  remainingTurns: number,
  url: string,
  answers: Record<string, string>,
): Promise<Invocation> => {
  if (remainingTurns === 0 || invocation.code !== 3) {
    return invocation;
  }
  let result: EveResult;
  try {
    result = eveResultSchema.parse(JSON.parse(invocation.stdout));
  } catch {
    throw new Error("Eve paused without a parseable resumable result.");
  }
  const resumed = await run(
    process.execPath,
    ["node_modules/eve/bin/eve.js", "invoke", "--url", url, "--resume", answerFor(result, answers)],
    { input: invocation.stdout, timeoutMs: generationTimeoutMs },
  );
  await appendFile(transcriptPath, `${resumed.stdout}\n${resumed.stderr}\n`);
  return await resumeInvocation(resumed, remainingTurns - 1, url, answers);
};

const main = async () => {
  await mkdir(candidateRoot, { mode: 0o700, recursive: true });
  await mkdir(stateRoot, { mode: 0o700, recursive: true });
  const brief = await readFile(briefPath, "utf-8");
  const answers = answersSchema.parse(JSON.parse(await readFile(answersPath, "utf-8"))).responses;
  const controller = new AbortController();
  const nextPort = await availableLoopbackPort(configuredNextPort);
  const evePort = await availableDistinctLoopbackPort(nextPort, configuredEvePort);
  const url = `http://127.0.0.1:${evePort}`;
  const development = spawn(
    mise,
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
      env: {
        ...process.env,
        APP_BUILDER_SANDBOX_REQUEST_TIMEOUT_MS: String(providerRequestTimeoutMs),
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      },
      stdio: "pipe",
    },
  );
  const developmentExited = once(development, "close");
  const transcriptWriteFailure = "Transcript write failed:";
  const transcriptChunks: string[] = [];
  const queueTranscriptWrite = (chunk: Buffer) => {
    transcriptChunks.push(String(chunk));
  };
  development.once("close", () => {
    controller.abort();
  });
  development.stdout.on("data", queueTranscriptWrite);
  development.stderr.on("data", queueTranscriptWrite);
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
    let status = "failed";
    if (invocation.code === 0) {
      status = "unassessed";
    } else if (invocation.timedOut) {
      status = "blocked";
    }
    await writeFile(
      path.join(candidateRoot, "self-reproduction.workflow-results.json"),
      JSON.stringify(
        {
          "independent-creation": {
            evidence: invocation.timedOut
              ? `The Vercel Sandbox-backed invocation exceeded its ${generationTimeoutMs}ms deadline.`
              : "Live Eve invocation completed; inspect the recorded transcript and generated files for workflow-level acceptance.",
            status,
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
    if (invocation.code !== 0) {
      throw new Error(`Live Eve invocation exited ${invocation.code ?? "without a status"}.`);
    }
  } finally {
    stop();
    if (development.exitCode === null) {
      await developmentExited;
    }
    try {
      await appendFile(transcriptPath, transcriptChunks.join(""));
    } catch (error) {
      const writeError = error instanceof Error ? error : new Error("unknown error");
      process.stderr.write(`${transcriptWriteFailure} ${writeError.message}\n`);
    }
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
};

try {
  await main();
} catch (error) {
  process.stderr.write(
    `Self-reproduction live generation failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
}
