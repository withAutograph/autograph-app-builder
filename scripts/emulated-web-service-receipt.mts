import { setTimeout as delay } from "node:timers/promises";
import {
  waitForOwnedProviders,
  assertOwnedProviders,
} from "../lib/development/emulated-provider-lifecycle";
import { writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { emulatedWebEnvironmentKeys } from "../lib/development/emulated-web";

const root = process.env.APP_BUILDER_EMULATED_STATE_ROOT;
if (root === undefined) {
  throw new Error("External emulated state root is required.");
}
const environment = Object.fromEntries(
  emulatedWebEnvironmentKeys.map((key) => {
    const value = process.env[key];
    if (value === undefined) {
      throw new Error(`Emulated configuration missing ${key}.`);
    }
    return [key, value];
  }),
);
const pid = Number(process.env.APP_BUILDER_EMULATED_PROVIDER_PID);
const ports = [
  Number(new URL(environment.VERCEL_EMULATOR_URL).port),
  Number(new URL(environment.GITHUB_EMULATOR_URL).port),
];
if (!Number.isSafeInteger(pid) || pid <= 0) {
  throw new Error("Owned emulator process is unavailable.");
}
await waitForOwnedProviders({ pid, ports });
await writeFile(path.join(root, "environment.pending"), JSON.stringify(environment), {
  mode: 0o600,
});
await rename(path.join(root, "environment.pending"), path.join(root, "environment.json"));
// The task waits on this child. A lost provider stops the shared supervisor too.
while (true) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- Observe the same owned services over time.
  await delay(1000);
  // oxlint-disable-next-line eslint/no-await-in-loop -- Observe the same owned services over time.
  await assertOwnedProviders(pid, ports);
}
