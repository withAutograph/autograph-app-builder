import { resolve } from "node:path";

import { runWithTestCapability } from "./run-with-test-capability.mts";

const repositoryRoot = resolve(import.meta.dirname, "..");
const eveEntry = resolve(repositoryRoot, "node_modules/eve/bin/eve.js");
const realSandbox = process.env.APP_BUILDER_REAL_SANDBOX === "1";
const capabilities = realSandbox
  ? ["mock-model"]
  : ["mock-model", "simulated-target", "simulated-publication"];

const exitCode = await runWithTestCapability({
  profile: "eve",
  command: process.execPath,
  args: [eveEntry, "eval", ...process.argv.slice(2)],
  capabilities,
});
process.exitCode = exitCode;
