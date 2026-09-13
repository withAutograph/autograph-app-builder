import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const sandboxPostgresInstall = {
  cmd: "sudo",
  args: ["dnf", "install", "-y", "postgresql16-server"],
};

type Command = (command: string, args: string[]) => Promise<void>;

/** Ephemeral cluster owned by the current non-root Sandbox user, outside source. */
export async function startSelfReproductionPostgres(input: {
  stateRoot: string;
  port: number;
  run?: Command;
}) {
  const run: Command =
    input.run ??
    (async (command, args) => {
      await execute(command, args, { timeout: 60_000 });
    });
  await mkdir(input.stateRoot, { recursive: true });
  const data = join(input.stateRoot, "data");
  const log = join(input.stateRoot, "postgres.log");
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    await run("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
    stopped = true;
  };
  await run("initdb", [
    "-D",
    data,
    "-U",
    "postgres",
    "--auth-local=trust",
    "--auth-host=trust",
    "--no-locale",
    "--encoding=UTF8",
  ]);
  try {
    await run("pg_ctl", [
      "-D",
      data,
      "-l",
      log,
      "-o",
      `-h 127.0.0.1 -p ${input.port}`,
      "-w",
      "start",
    ]);
    await run("createdb", [
      "-h",
      "127.0.0.1",
      "-p",
      String(input.port),
      "-U",
      "postgres",
      "autograph_app_builder",
    ]);
    await run("psql", [
      "-h",
      "127.0.0.1",
      "-p",
      String(input.port),
      "-U",
      "postgres",
      "-d",
      "autograph_app_builder",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "SELECT 1",
    ]);
  } catch (error) {
    await stop().catch(() => {
      // Retain the original startup error; Sandbox lifetime still bounds failed cleanup.
    });
    throw error;
  }
  return {
    stop,
    log,
    databaseUrl: `postgresql://postgres@127.0.0.1:${input.port}/autograph_app_builder`,
  };
}
