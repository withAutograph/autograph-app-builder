import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { ensureLocalDevelopmentOidc } from "../../../../lib/development/local-oidc-startup";

const repositoryRoot = resolve(import.meta.dirname, "../../../../");
if (
  process.cwd() !== repositoryRoot ||
  realpathSync(process.cwd()) !== repositoryRoot ||
  process.argv.length !== 4
) {
  throw new Error("The local Development OIDC startup invocation was invalid.");
}

ensureLocalDevelopmentOidc({
  repositoryRoot,
  vercelExecutable: process.argv[2]!,
  miseExecutable: process.argv[3]!,
});
