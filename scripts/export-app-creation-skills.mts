import { resolve } from "node:path";

import { exportAppCreationSkills } from "../lib/repository/app-creation-skill-export";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--output" || args[1] === "")
  throw new Error("Usage: --output <absent-external-destination>");

const manifest = await exportAppCreationSkills({
  repositoryRoot: resolve(import.meta.dirname, ".."),
  outputRoot: resolve(args[1]!),
});
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
