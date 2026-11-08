import { realpathSync } from "node:fs";
import path from "node:path";

import {
  ensureLocalDevelopmentOidc,
  LocalOidcRefreshFailedError,
} from "../../../../lib/development/local-oidc-startup";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../../");
if (
  process.cwd() !== repositoryRoot ||
  realpathSync(process.cwd()) !== repositoryRoot ||
  process.argv.length !== 4
) {
  throw new Error("The local Development OIDC startup invocation was invalid.");
}

try {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/require-safety-comment-for-type-assertion -- Preserve the existing assertion at this boundary.
  const [vercelExecutable, miseExecutable] = process.argv.slice(2) as [string, string];

  ensureLocalDevelopmentOidc({
    miseExecutable,
    repositoryRoot,
    vercelExecutable,
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
