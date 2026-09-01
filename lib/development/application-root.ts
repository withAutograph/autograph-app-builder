import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  readdir,
  chmod,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";

import {
  createDevelopmentSnapshot,
  removeDevelopmentSnapshot,
  type DevelopmentSnapshot,
} from "./local-mode";

async function makeWritable(path: string, preserveRuntime = false): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path)) {
      if (preserveRuntime && (entry === ".eve" || entry === "node_modules"))
        continue;
      await makeWritable(join(path, entry), preserveRuntime);
    }
    return;
  }
  await chmod(path, info.mode & 0o111 ? 0o700 : 0o600);
}

/**
 * Materializes the App Builder code used by one local development supervisor.
 * The supervisor deliberately retains this directory across Eve restarts so
 * Eve can resume its supported local session state without recovering turns.
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

/**
 * Replaces only the application code that Eve executes for the current local
 * cycle.  Eve's own `.eve` state and the checkout-owned dependency symlink are
 * deliberately retained: they are runtime state, not live application code.
 *
 * The staging snapshot makes a runtime restart observe the current checkout
 * without ever letting a watcher see a partially copied application tree.
 */
export async function refreshDevelopmentApplication(input: {
  repositoryRoot: string;
  applicationRoot: string;
  runRoot: string;
}): Promise<void> {
  const applicationRoot = await realpath(input.applicationRoot);
  const runRoot = await realpath(input.runRoot);
  const stageRoot = await mkdtemp(join(runRoot, "eve-application-stage-"));
  try {
    const snapshot = await createDevelopmentSnapshot({
      sourceRoot: input.repositoryRoot,
      runRoot: await realpath(stageRoot),
    });
    try {
      await lstat(join(snapshot.root, ".eve"));
      throw new Error("A live development checkout cannot supply Eve state.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await makeWritable(applicationRoot, true);
    for (const entry of await readdir(applicationRoot)) {
      if (entry === ".eve" || entry === "node_modules") continue;
      await rm(join(applicationRoot, entry), { recursive: true, force: true });
    }
    for (const entry of await readdir(snapshot.root))
      await rename(join(snapshot.root, entry), join(applicationRoot, entry));
  } finally {
    await removeDevelopmentSnapshot(stageRoot);
  }
}
