import { resolve } from "node:path";

import { TEST_CAPABILITIES } from "../lib/testing/test-capability";
import { runWithTestCapability } from "./run-with-test-capability.mts";

const repositoryRoot = resolve(import.meta.dirname, "..");
const vitest = resolve(repositoryRoot, "node_modules/vitest/vitest.mjs");
process.exitCode = await runWithTestCapability({
  profile: "vitest",
  command: process.execPath,
  args: [vitest, ...process.argv.slice(2)],
  capabilities: TEST_CAPABILITIES,
});
