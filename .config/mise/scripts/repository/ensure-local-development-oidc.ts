import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import {
  ensureLocalDevelopmentOidc,
  LocalOidcRefreshFailedError,
} from "../../../../lib/development/local-oidc-startup";

const repositoryRoot = resolve(import.meta.dirname, "../../../../");
if (
  process.cwd() !== repositoryRoot ||
  realpathSync(process.cwd()) !== repositoryRoot ||
  process.argv.length !== 4
) {
  throw new Error("The local Development OIDC startup invocation was invalid.");
}

try {
  ensureLocalDevelopmentOidc({
    repositoryRoot,
    vercelExecutable: process.argv[2]!,
    miseExecutable: process.argv[3]!,
  });
} catch (error) {
  if (error instanceof LocalOidcRefreshFailedError) {
    process.stderr.write(
      "dev: project OIDC is missing or near expiry and could not be refreshed. Allow this checkout's Vercel OIDC refresh, then rerun `mise run dev`; static credentials are unsupported.\n",
    );
    process.exitCode = 78;
  } else {
    throw error;
  }
}
