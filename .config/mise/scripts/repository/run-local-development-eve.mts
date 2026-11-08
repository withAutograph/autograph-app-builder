import path from "node:path";

import { runLocalEve } from "../../../../lib/eve/local-eve-launch";

const resume = process.argv.length === 3 && process.argv[2] === "--resume";
if (process.argv.length !== 2 && !resume) {
  throw new Error("The local development Eve entrypoint accepts only explicit --resume.");
}

// oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing assignment while its type remains unresolved.
process.exitCode = await runLocalEve({
  resume,

  repositoryRoot: path.resolve(import.meta.dirname, "../../../../"),
});
