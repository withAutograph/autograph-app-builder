/* oxlint-disable eslint/no-await-in-loop -- Sequential copying and readiness polling bound resource use. */
import { startSelfReproductionPostgres } from "./self-reproduction-postgres";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { get } from "node:https";
import { get as getHttp } from "node:http";
import { createServer } from "node:net";
import path from "node:path";
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

export const assertExternalReferenceRoot = (sourceRoot: string, runtimeRoot: string): void => {
  const relativePath = path.relative(path.resolve(sourceRoot), path.resolve(runtimeRoot));
  if (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith("../") && !path.isAbsolute(relativePath))
  )
    throw new Error("Reference runtime must be outside reference source.");
};

/** Copy tracked live bytes only; credentials, runtime state and dependencies stay out. */
export const snapshotReferenceSource = async (
  sourceRoot: string,
  fixtureRoot: string,
): Promise<void> => {
  assertExternalReferenceRoot(sourceRoot, fixtureRoot);
  const filesDeferred = Promise.withResolvers<string[]>();
  const child = spawn("git", ["ls-files", "-z"], { cwd: sourceRoot });
  {
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", filesDeferred.reject);
    child.on("close", (code) =>
      code === 0
        ? filesDeferred.resolve(Buffer.concat(chunks).toString().split("\0").filter(Boolean))
        : filesDeferred.reject(new Error("Cannot enumerate reference source.")),
    );
  }
  const files = await filesDeferred.promise;
  await mkdir(fixtureRoot, { recursive: true });
  for (const file of files) {
    const source = path.join(sourceRoot, file);
    try {
      // Materialize trusted tracked symlink targets as ordinary fixture files.
      const target = await realpath(source);
      const targetStat = await stat(target);
      if (!targetStat.isFile()) continue;
      await mkdir(path.dirname(path.join(fixtureRoot, file)), { recursive: true });
      await copyFile(target, path.join(fixtureRoot, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
};

export const reserveReferencePort = async (requestedPort = 0) => {
  const server = createServer();
  const listening = Promise.withResolvers<null>();
  {
    server.once("error", listening.reject);
    // Emulator listens on the dual-stack wildcard, not IPv4 loopback alone.
    server.listen({ host: "::", ipv6Only: false, port: requestedPort }, () =>
      listening.resolve(null),
    );
  }
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Port reservation unavailable.");
  return {
    port: address.port,
    release: () => {
      const closed = Promise.withResolvers<null>();
      server.close(() => closed.resolve(null));
      return closed.promise;
    },
  };
};

export const referenceEmulatorsReady = async (basePort: number): Promise<boolean> => {
  const checks = await Promise.all(
    ["/v2/user", "/user"].map((routePath, index) => {
      const result = Promise.withResolvers<boolean>();
      const request = getHttp(
        `http://localhost:${basePort + index}${routePath}`,
        {
          headers: { authorization: "Bearer emulate_local_provider_token" },
          timeout: 2000,
        },
        (response) => {
          response.resume();
          result.resolve(response.statusCode === 200);
        },
      );
      request.on("error", () => result.resolve(false));
      request.on("timeout", () => request.destroy());
      return result.promise;
    }),
  );
  return checks.every(Boolean);
};

const probe = (url: string): Promise<boolean> => {
  const deferred = Promise.withResolvers<boolean>();
  {
    const request = get(url, { rejectUnauthorized: false, timeout: 2000 }, (response) => {
      response.resume();
      deferred.resolve(response.statusCode !== undefined && response.statusCode < 500);
    });
    request.on("error", () => deferred.resolve(false));
    request.on("timeout", () => request.destroy());
  }
  return deferred.promise;
};

export const startSelfReproductionReferenceRuntime = async (input: {
  sourceRoot: string;
  runtimeRoot: string;
  miseExecutable: string;
  startupTimeoutMs?: number;
  databaseBackend?: "docker" | "process";
}): Promise<{ receipt: ReferenceRuntimeReceipt; stop: () => Promise<void> }> => {
  const fixtureRoot = path.join(path.resolve(input.runtimeRoot), `reference-${randomUUID()}`);
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
        await reservations.pop()?.release();
      }
    }
  } catch (error) {
    await releaseReservations();
    throw error;
  }
  const environment = {
    APP_BUILDER_DATABASE_CONTAINER: `self-reproduction-${randomUUID()}`,
    APP_BUILDER_DATABASE_PORT: String(databasePort),
    APP_BUILDER_EXTERNAL_DATABASE: input.databaseBackend === "process" ? "1" : "0",
    APP_BUILDER_LOCAL_PORT: String(appPort),
    EMULATE_BASE_PORT: String(emulatorPort),
  };
  const receipt: ReferenceRuntimeReceipt = {
    databaseUrl: `postgresql://postgres@127.0.0.1:${databasePort}/autograph_app_builder`,
    environment,
    fixtureRoot,
    logs: [],
    producer: "evaluator",
    reason: "Reference startup pending.",
    referenceUrl: `https://localhost:${appPort}`,
    stateRoot: path.join(fixtureRoot, ".emulate"),
    status: "infrastructure-unavailable",
  };
  let database: Awaited<ReturnType<typeof startSelfReproductionPostgres>> | undefined;
  let server: ReturnType<typeof spawn> | undefined;
  const run = async (args: string[], name: string): Promise<void> => {
    const log = path.join(fixtureRoot, `${name}.log`);
    receipt.logs.push(log);
    const output = createWriteStream(log);
    const child = spawn(input.miseExecutable, args, {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        ...environment,
        MISE_BIN_PATH: input.miseExecutable,
        PATH: `${path.dirname(input.miseExecutable)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(output, { end: false });
    child.stderr.pipe(output, { end: false });
    try {
      const childDeferred = Promise.withResolvers<null>();
      child.on("error", childDeferred.reject);
      child.on("close", (code) =>
        code === 0
          ? childDeferred.resolve(null)
          : childDeferred.reject(new Error(`${name} failed; see ${log}`)),
      );
      await childDeferred.promise;
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
    const log = path.join(fixtureRoot, "reference-server.log");
    receipt.logs.push(log);
    const output = createWriteStream(log);
    await releaseReservations();
    if (input.databaseBackend === "process") {
      database = await startSelfReproductionPostgres({
        port: databasePort,
        stateRoot: path.join(input.runtimeRoot, `postgres-${randomUUID()}`),
      });
      receipt.logs.push(database.log);
    }
    server = spawn(input.miseExecutable, ["run", "app:dev-emulated"], {
      cwd: fixtureRoot,
      detached: true,
      env: {
        ...process.env,
        ...environment,
        MISE_BIN_PATH: input.miseExecutable,
        PATH: `${path.dirname(input.miseExecutable)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      },
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
  await writeFile(
    path.join(fixtureRoot, "reference-runtime.json"),
    JSON.stringify(receipt, null, 2),
  );
  return { receipt, stop };
};
