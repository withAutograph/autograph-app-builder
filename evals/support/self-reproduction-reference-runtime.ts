/* oxlint-disable eslint/no-await-in-loop -- Sequential copying and readiness polling bound resource use. */
import { startSelfReproductionPostgres } from "./self-reproduction-postgres";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { get } from "node:https";
import { get as getHttp } from "node:http";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface ReferenceRuntimeReceipt {
  producer: "evaluator";
  status: "available" | "infrastructure-unavailable";
  reason: string;
  fixtureRoot: string;
  stateRoot: string;
  referenceUrl: string;
  databaseUrl: string;
  environment: Record<string, string>;
  logs: string[];
}

export function assertExternalReferenceRoot(sourceRoot: string, runtimeRoot: string): void {
  const path = relative(resolvePath(sourceRoot), resolvePath(runtimeRoot));
  if (path === "" || (path !== ".." && !path.startsWith("../") && !isAbsolute(path)))
    throw new Error("Reference runtime must be outside reference source.");
}

/** Copy tracked live bytes only; credentials, runtime state and dependencies stay out. */
export async function snapshotReferenceSource(
  sourceRoot: string,
  fixtureRoot: string,
): Promise<void> {
  assertExternalReferenceRoot(sourceRoot, fixtureRoot);
  const files = await new Promise<string[]>((resolve, reject) => {
    const child = spawn("git", ["ls-files", "-z"], { cwd: sourceRoot });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks).toString().split("\0").filter(Boolean))
        : reject(new Error("Cannot enumerate reference source.")),
    );
  });
  await mkdir(fixtureRoot, { recursive: true });
  for (const file of files) {
    const source = join(sourceRoot, file);
    try {
      // Materialize trusted tracked symlink targets as ordinary fixture files.
      const target = await realpath(source);
      if (!(await stat(target)).isFile()) continue;
      await mkdir(dirname(join(fixtureRoot, file)), { recursive: true });
      await copyFile(target, join(fixtureRoot, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function reserveReferencePort(requestedPort = 0) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Emulator listens on the dual-stack wildcard, not IPv4 loopback alone.
    server.listen({ port: requestedPort, host: "::", ipv6Only: false }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Port reservation unavailable.");
  return {
    port: address.port,
    release: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

export async function referenceEmulatorsReady(basePort: number): Promise<boolean> {
  const checks = await Promise.all(
    ["/v2/user", "/user"].map(
      (path, index) =>
        new Promise<boolean>((resolve) => {
          const request = getHttp(
            `http://localhost:${basePort + index}${path}`,
            {
              headers: { authorization: "Bearer emulate_local_provider_token" },
              timeout: 2000,
            },
            (response) => {
              response.resume();
              resolve(response.statusCode === 200);
            },
          );
          request.on("error", () => resolve(false));
          request.on("timeout", () => request.destroy());
        }),
    ),
  );
  return checks.every(Boolean);
}

function probe(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = get(url, { rejectUnauthorized: false, timeout: 2000 }, (response) => {
      response.resume();
      resolve(response.statusCode !== undefined && response.statusCode < 500);
    });
    request.on("error", () => resolve(false));
    request.on("timeout", () => request.destroy());
  });
}

export async function startSelfReproductionReferenceRuntime(input: {
  sourceRoot: string;
  runtimeRoot: string;
  miseExecutable: string;
  startupTimeoutMs?: number;
  databaseBackend?: "docker" | "process";
}): Promise<{ receipt: ReferenceRuntimeReceipt; stop: () => Promise<void> }> {
  const fixtureRoot = join(resolvePath(input.runtimeRoot), `reference-${randomUUID()}`);
  assertExternalReferenceRoot(input.sourceRoot, fixtureRoot);
  const reservations: Awaited<ReturnType<typeof reserveReferencePort>>[] = [];
  const reserve = async (port = 0) => {
    const reservation = await reserveReferencePort(port);
    reservations.push(reservation);
    return reservation.port;
  };
  const releaseReservations = async () => {
    await Promise.all(reservations.splice(0).map((reservation) => reservation.release()));
  };
  let appPort: number;
  let databasePort: number;
  let emulatorPort: number;
  try {
    appPort = await reserve();
    databasePort = await reserve();
    for (;;) {
      emulatorPort = await reserve();
      try {
        await reserve(emulatorPort + 1);
        break;
      } catch {
        await reservations.pop()!.release();
      }
    }
  } catch (error) {
    await releaseReservations();
    throw error;
  }
  const environment = {
    APP_BUILDER_LOCAL_PORT: String(appPort),
    APP_BUILDER_DATABASE_PORT: String(databasePort),
    APP_BUILDER_DATABASE_CONTAINER: `self-reproduction-${randomUUID()}`,
    APP_BUILDER_EXTERNAL_DATABASE: input.databaseBackend === "process" ? "1" : "0",
    EMULATE_BASE_PORT: String(emulatorPort),
  };
  const receipt: ReferenceRuntimeReceipt = {
    producer: "evaluator",
    status: "infrastructure-unavailable",
    reason: "Reference startup pending.",
    fixtureRoot,
    stateRoot: join(fixtureRoot, ".emulate"),
    referenceUrl: `https://localhost:${appPort}`,
    databaseUrl: `postgresql://postgres@127.0.0.1:${databasePort}/autograph_app_builder`,
    environment,
    logs: [],
  };
  let database: Awaited<ReturnType<typeof startSelfReproductionPostgres>> | undefined;
  let server: ReturnType<typeof spawn> | undefined;
  const run = async (args: string[], name: string): Promise<void> => {
    const log = join(fixtureRoot, `${name}.log`);
    receipt.logs.push(log);
    const output = createWriteStream(log);
    const child = spawn(input.miseExecutable, args, {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        ...environment,
        MISE_BIN_PATH: input.miseExecutable,
        PATH: `${dirname(input.miseExecutable)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(output, { end: false });
    child.stderr.pipe(output, { end: false });
    try {
      await new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`${name} failed; see ${log}`)),
        );
      });
    } finally {
      output.end();
    }
  };
  const stop = async (): Promise<void> => {
    if (server?.pid && server.exitCode === null) {
      try {
        process.kill(-server.pid, "SIGTERM");
      } catch {
        // Already stopped.
      }
    }
    if (server) {
      await run(["run", "auth-e2e:reset"], "reference-cleanup").catch(() => {
        // Cleanup is best effort after stopping the isolated server.
      });
      server = undefined;
    }
    await database?.stop();
  };
  try {
    await snapshotReferenceSource(input.sourceRoot, fixtureRoot);
    await run(["trust"], "reference-trust");
    await run(["run", "dependencies:install"], "reference-install");
    const log = join(fixtureRoot, "reference-server.log");
    receipt.logs.push(log);
    const output = createWriteStream(log);
    await releaseReservations();
    if (input.databaseBackend === "process") {
      database = await startSelfReproductionPostgres({
        stateRoot: join(input.runtimeRoot, `postgres-${randomUUID()}`),
        port: databasePort,
      });
      receipt.logs.push(database.log);
    }
    server = spawn(input.miseExecutable, ["run", "app:dev-emulated"], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        ...environment,
        MISE_BIN_PATH: input.miseExecutable,
        PATH: `${dirname(input.miseExecutable)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let startupError: Error | undefined;
    server.on("error", (error) => {
      startupError = error;
    });
    server.stdout?.pipe(output, { end: false });
    server.stderr?.pipe(output, { end: false });
    server.on("close", () => output.end());
    const deadline = Date.now() + (input.startupTimeoutMs ?? 300_000);
    while (Date.now() < deadline) {
      if (startupError || server.exitCode !== null)
        throw new Error("Reference server exited during startup.");
      if (
        (await probe(`${receipt.referenceUrl}/auth/sign-in`)) &&
        (await referenceEmulatorsReady(emulatorPort))
      ) {
        receipt.status = "available";
        receipt.reason =
          "Isolated reference authentication server and both provider emulators are ready.";
        break;
      }
      await delay(500);
    }
    if (receipt.status !== "available") throw new Error("Reference server readiness timed out.");
  } catch (error) {
    await releaseReservations();
    receipt.reason = error instanceof Error ? error.message : "Reference setup failed.";
    await stop();
  }
  await mkdir(fixtureRoot, { recursive: true });
  await writeFile(join(fixtureRoot, "reference-runtime.json"), JSON.stringify(receipt, null, 2));
  return { receipt, stop };
}
