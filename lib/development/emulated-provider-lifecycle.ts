/* oxlint-disable eslint/no-await-in-loop -- Probe both owned provider listeners before publishing readiness and monitor their lifecycle. */
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

// oxlint-disable-next-line typescript/strict-void-return -- Adapt Node's overloaded callback API.
const execute = promisify(execFile);
const resolver = fileURLToPath(new URL("../../.config/mise/scripts/resolve-lsof", import.meta.url));
const resolveLsof = async () => {
  const result = await execute(resolver);
  return result.stdout.trim();
};
export const ownsProviderListener = async (pid: number, port: number) => {
  try {
    const result = await execute(await resolveLsof(), [
      "-t",
      "-nP",
      "-a",
      "-p",
      String(pid),
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
    ]);
    return result.stdout.split(/\s+/u).includes(String(pid));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === 1) {
      return false;
    }
    throw error;
  }
};

export const waitForOwnedProviders = async (input: {
  pid: number;
  ports: readonly number[];
  timeoutMs?: number;
  ownsListener?: typeof ownsProviderListener;
}) => {
  const deadline = Date.now() + (input.timeoutMs ?? 30_000);
  while (true) {
    const ready = await Promise.all(
      input.ports.map(
        async (port) => await (input.ownsListener ?? ownsProviderListener)(input.pid, port),
      ),
    );
    if (ready.every(Boolean)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        "Owned GitHub and Vercel emulator listeners are not ready; no web readiness receipt was published.",
      );
    }
    await delay(100);
  }
};

export const assertOwnedProviders = async (
  pid: number,
  ports: readonly number[],
  ownsListener = ownsProviderListener,
) => {
  const ready = await Promise.all(ports.map(async (port) => await ownsListener(pid, port)));
  if (!ready.every(Boolean)) {
    throw new Error(
      "An owned provider emulator listener stopped; emulated web is no longer ready.",
    );
  }
};
