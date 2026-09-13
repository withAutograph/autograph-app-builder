import path from "node:path";

import { exportAppCreationSkills } from "../lib/repository/app-creation-skill-export";

const args = process.argv.slice(2);
const outputPath = args[1] ?? "";
if (args.length !== 2 || args[0] !== "--output" || outputPath === "")
  throw new Error("Usage: --output <absent-external-destination>");

const manifest = await exportAppCreationSkills({
  outputRoot: path.resolve(outputPath),
  repositoryRoot: path.resolve(import.meta.dirname, ".."),
});
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
