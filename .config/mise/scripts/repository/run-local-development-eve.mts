import path from "node:path";

import { runLocalEve } from "../../../../lib/eve/local-eve-launch";

if (process.argv.length !== 2)
  throw new Error("The local development Eve entrypoint accepts no arguments.");

process.exitCode = await runLocalEve({
  repositoryRoot: path.resolve(import.meta.dirname, "../../../../"),
});
