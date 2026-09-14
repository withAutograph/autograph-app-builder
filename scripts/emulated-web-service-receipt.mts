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
await writeFile(path.join(root, "environment.pending"), JSON.stringify(environment), {
  mode: 0o600,
});
await rename(path.join(root, "environment.pending"), path.join(root, "environment.json"));
// Owned by the existing task's signal/cleanup lifecycle.
setInterval(() => {
  // Keep owned services alive until the supervisor stops this process.
}, 60_000);
