import {
  lstat,
  mkdir,
  realpath,
  readdir,
  chmod,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";

import {
  createDevelopmentSnapshot,
  removeDevelopmentSnapshot,
  type DevelopmentSnapshot,
} from "./local-mode";

async function makeWritable(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path))
      await makeWritable(join(path, entry));
    return;
  }
  await chmod(path, info.mode & 0o111 ? 0o700 : 0o600);
}

/**
 * Materializes the App Builder code used by exactly one local Eve process.
 * Eve persists workflow state beneath its application root, so reusing this
 * directory across cycles would let a new proof resume stale sessions.
 */
export async function createDevelopmentApplication(input: {
  repositoryRoot: string;
  runRoot: string;
}): Promise<DevelopmentSnapshot> {
  const materializationRoot = join(input.runRoot, "eve-application");
  await mkdir(materializationRoot, { mode: 0o700 });
  try {
    const application = await createDevelopmentSnapshot({
      sourceRoot: input.repositoryRoot,
      runRoot: await realpath(materializationRoot),
    });
    await makeWritable(application.root);
    const modules = await realpath(join(input.repositoryRoot, "node_modules"));
    const modulesInfo = await lstat(modules);
    if (
      !modulesInfo.isDirectory() ||
      modulesInfo.isSymbolicLink() ||
      modulesInfo.uid !== process.getuid?.() ||
      (modulesInfo.mode & 0o022) !== 0
    )
      throw new Error("App Builder node_modules was not owner-bound.");
    await symlink(modules, join(application.root, "node_modules"));
    try {
      await lstat(join(application.root, ".eve"));
      throw new Error("A development Eve application inherited stale state.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return application;
  } catch (error) {
    await removeDevelopmentSnapshot(materializationRoot);
    throw error;
  }
}
