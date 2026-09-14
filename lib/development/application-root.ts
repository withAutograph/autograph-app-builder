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
import nodePath from "node:path";

import { createDevelopmentSnapshot, removeDevelopmentSnapshot } from "./local-mode";
import type { DevelopmentSnapshot } from "./local-mode";

/**
 * A development snapshot records an immutable baseline commit/tree/fingerprint
 * but intentionally has a mutable filesystem.  `eve-application` is the
 * owner-only work area where Eve creates generated files and execution
 * overlays between targeted restarts.  Do not use this for hosted or release
 * paths.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function makeDevelopmentWorkAreaWritable(
  path: string,
  preserveRuntime = false,
): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {return;}
  if (info.uid !== process.getuid?.())
    {throw new Error("A local Eve application entry was not owner-bound.");}
  if (info.isDirectory()) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path)) {
      if (preserveRuntime && (entry === ".eve" || entry === "node_modules")) {continue;}
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      await makeDevelopmentWorkAreaWritable(nodePath.join(path, entry), preserveRuntime);
    }
    return;
  }
  // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
  await chmod(path, info.mode & 0o111 ? 0o700 : 0o600);
}

/**
 * Materializes the App Builder code used by one local Eve cycle. The parent
 * supervisor keeps reusable caches separately and creates a new application
 * for the next targeted restart.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function createDevelopmentApplication(input: {
  repositoryRoot: string;
  runRoot: string;
}): Promise<DevelopmentSnapshot> {
  const materializationRoot = nodePath.join(input.runRoot, "eve-application");
  await mkdir(materializationRoot, { mode: 0o700 });
  try {
    const application = await createDevelopmentSnapshot({
      runRoot: await realpath(materializationRoot),
      sourceRoot: input.repositoryRoot,
    });
    await makeDevelopmentWorkAreaWritable(application.root);
    const modules = await realpath(nodePath.join(input.repositoryRoot, "node_modules"));
    const modulesInfo = await lstat(modules);
    if (
      !modulesInfo.isDirectory() ||
      modulesInfo.isSymbolicLink() ||
      modulesInfo.uid !== process.getuid?.() ||
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
      (modulesInfo.mode & 0o022) !== 0
    )
      {throw new Error("App Builder node_modules was not owner-bound.");}
    await symlink(modules, nodePath.join(application.root, "node_modules"));
    try {
      await lstat(nodePath.join(application.root, ".eve"));
      throw new Error("A development Eve application inherited stale state.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {throw error;}
    }
    return application;
  } catch (error) {
    await removeDevelopmentSnapshot(materializationRoot);
    throw error;
  }
}

/**
 * Creates the private runtime roots for exactly one Eve/package cycle.
 * Reusable package and dependency caches deliberately live outside this tree;
 * workflow queues and application-local Eve state never do.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function createDevelopmentCycle(input: {
  repositoryRoot: string;
  supervisorRoot: string;
}): Promise<{
  root: string;
  application: DevelopmentSnapshot;
  runtimeHome: string;
  workflowData: string;
}> {
  const supervisorRoot = await realpath(input.supervisorRoot);
  const root = await realpath(await mkdtemp(nodePath.join(supervisorRoot, "cycle-")));
  try {
    const application = await createDevelopmentApplication({
      repositoryRoot: input.repositoryRoot,
      runRoot: root,
    });
    const runtimeHome = nodePath.join(root, "home");
    const workflowData = nodePath.join(root, "workflow-data");
    await mkdir(runtimeHome, { mode: 0o700 });
    await mkdir(workflowData, { mode: 0o700 });
    return {
      application,
      root,
      runtimeHome: await realpath(runtimeHome),
      workflowData: await realpath(workflowData),
    };
  } catch (error) {
    await removeDevelopmentSnapshot(root);
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
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function refreshDevelopmentApplication(input: {
  repositoryRoot: string;
  applicationRoot: string;
  runRoot: string;
}): Promise<void> {
  const applicationRoot = await realpath(input.applicationRoot);
  const runRoot = await realpath(input.runRoot);
  const stageRoot = await mkdtemp(nodePath.join(runRoot, "eve-application-stage-"));
  try {
    const snapshot = await createDevelopmentSnapshot({
      runRoot: await realpath(stageRoot),
      sourceRoot: input.repositoryRoot,
    });
    try {
      await lstat(nodePath.join(snapshot.root, ".eve"));
      throw new Error("A live development checkout cannot supply Eve state.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {throw error;}
    }
    // The stage's baseline identity is immutable, but its filesystem is a
    // mutable local work area. Normalize the whole incoming tree before
    // moving it. `.eve` and `node_modules` remain retained runtime state in
    // the destination.
    await makeDevelopmentWorkAreaWritable(snapshot.root);
    await makeDevelopmentWorkAreaWritable(applicationRoot, true);
    for (const entry of await readdir(applicationRoot)) {
      if (entry === ".eve" || entry === "node_modules") {continue;}
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      await rm(nodePath.join(applicationRoot, entry), { force: true, recursive: true });
    }
    for (const entry of await readdir(snapshot.root))
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      {await rename(nodePath.join(snapshot.root, entry), nodePath.join(applicationRoot, entry));}
    // `rename` preserves modes.  Reassert the work-area contract after the
    // refresh so every installed application file remains writable for live
    // generation and overlays, not merely the staging parent used by rename.
    await makeDevelopmentWorkAreaWritable(applicationRoot, true);
  } finally {
    await removeDevelopmentSnapshot(stageRoot);
  }
}
