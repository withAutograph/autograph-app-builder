import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";

const appIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);

/** Server-owned path; never accepts a path or credentials from the model. */
export const localRuntimeEnvironmentPath = (root: string, appId: string): string =>
  path.posix.join(
    // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Reads server-derived owner-only state created by app:runtime.
    "/tmp/autograph-app-runtime",
    createHash("sha256").update(path.posix.resolve("/workspace", root)).digest("hex").slice(0, 16),
    appIdSchema.parse(appId),
    "environment.json",
  );

/** Isolate disposable validation from the selected app's retained private Preview. */
export const validationRuntimeStateDirectory = (
  root: string,
  appId: string,
  applyDigest: string,
  release: { artifactHash: string; id: string },
): string => {
  const selectedState = path.posix.dirname(localRuntimeEnvironmentPath(root, appId));
  const revision = createHash("sha256")
    .update(JSON.stringify([appId, applyDigest, release.id, release.artifactHash]))
    .digest("hex")
    .slice(0, 24);
  // PostgreSQL places its Unix socket in this directory; keep the path independent of slug length.
  return path.posix.join(path.posix.dirname(selectedState), `.validation-${revision}`);
};
