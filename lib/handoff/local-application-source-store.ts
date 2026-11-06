/* oxlint-disable eslint/no-bitwise, sonarjs/expression-complexity -- Explicit owner-only filesystem permissions protect local source custody. */
import { createHash } from "node:crypto";
import { constants, lstatSync, realpathSync } from "node:fs";
import { mkdir, open, link, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { readLocalEveCycleBinding } from "../eve/local-cycle-binding";
import { validateApplicationSourceArtifact } from "./application-source-bytes";
import type { ApplicationSourceArtifact } from "./application-source-contract";

const unavailable = () => new Error("Local application source artifact is unavailable");
const owned = (file: string, directory = false) => {
  const stat = lstatSync(file);
  if (
    realpathSync(file) !== file ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    (directory ? !stat.isDirectory() : !stat.isFile())
  ) {
    throw unavailable();
  }
};
export const createLocalApplicationSourceStore = (
  environment: Record<string, string | undefined>,
) => {
  const cycleFile = environment.APP_BUILDER_LOCAL_EVE_CYCLE_FILE;
  if (
    environment.APP_BUILDER_EXECUTION_MODE !== "development" ||
    environment.APP_BUILDER_EXECUTION_BUNDLE !== "local-development" ||
    environment.APP_BUILDER_LOCAL_ADAPTER !== "1" ||
    environment.EVE_HOSTED_ADAPTER !== "0" ||
    cycleFile === undefined ||
    cycleFile === ""
  ) {
    throw unavailable();
  }
  const cycle = readLocalEveCycleBinding(cycleFile);
  const root = path.join(path.dirname(cycleFile), "application-source", cycle);
  const key = (sessionId: string, digest: string) => {
    if (!/^[a-f0-9]{64}$/u.test(digest)) {
      throw unavailable();
    }
    return path.join(
      root,
      `${createHash("sha256").update(sessionId).digest("hex")}-${digest}.json`,
    );
  };
  const current = () => {
    if (readLocalEveCycleBinding(cycleFile) !== cycle) {
      throw unavailable();
    }
    owned(path.dirname(cycleFile), true);
  };
  return {
    async put(artifact: ApplicationSourceArtifact) {
      current();
      const verified = validateApplicationSourceArtifact(artifact);
      await mkdir(root, { mode: 0o700, recursive: true });
      owned(path.dirname(root), true);
      owned(root, true);
      const filename = key(artifact.manifest.sourceSessionId, verified.manifestDigest);
      const temporary = `${filename}.${process.pid}.tmp`;
      const bytes = Buffer.from(JSON.stringify(verified.artifact));
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        current();
        try {
          await link(temporary, filename);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
            throw error;
          }
        }
        owned(filename);
        const saved = await readFile(filename);
        if (!saved.equals(bytes)) {
          throw unavailable();
        }
        const directory = await open(root, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } finally {
        await rm(temporary, { force: true });
      }
      return { bytes: bytes.length, manifestDigest: verified.manifestDigest };
    },
    async read(sessionId: string, digest: string) {
      current();
      owned(root, true);
      const filename = key(sessionId, digest);
      owned(filename);
      const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes;
      try {
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
      const verified = validateApplicationSourceArtifact(JSON.parse(bytes.toString("utf-8")));
      current();
      if (
        verified.manifestDigest !== digest ||
        verified.artifact.manifest.sourceSessionId !== sessionId
      ) {
        throw unavailable();
      }
      return { bytes, manifest: verified.artifact.manifest };
    },
  };
};
