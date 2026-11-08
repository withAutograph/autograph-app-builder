/* oxlint-disable anti-slop/no-unknown-parameters -- Parse an OS error code at the filesystem exception boundary. */
/* oxlint-disable eslint/no-bitwise -- POSIX owner/write permission bits protect the selected dependency directory and link. */
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { execFileSync } from "node:child_process";
import { lstat, readFile, realpath, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const absent = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const optionalRead = async (file: string) => {
  try {
    return await readFile(file);
  } catch (error) {
    if (absent(error)) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Preserve the optional filesystem absence result separately from read failures.
      return undefined;
    }
    throw error;
  }
};
export interface DevelopmentDependencyBinding {
  modulesRoot: string;
  sourceLockSha256?: string;
  installedLockSha256?: string;
  evePackagePath: string;
}
// A resumed cycle keeps its filesystem path. A fresh process avoids Node's
// old symlink-resolution cache and observes the same lookup as the real child.
const resolveDevelopmentEve = (root: string) => {
  try {
    return execFileSync(
      process.execPath,
      [
        "-e",
        'const {createRequire}=require("node:module");const{realpathSync}=require("node:fs");process.stdout.write(realpathSync(createRequire(process.cwd()+"/package.json").resolve("eve/package.json")));',
      ],
      {
        cwd: root,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH, NODE_ENV: "development" },
        maxBuffer: 64 * 1024,
      },
    ).trim();
  } catch {
    throw new Error(
      "Install Eve with pnpm install --frozen-lockfile in the selected Builder checkout before starting its local runtime.",
    );
  }
};
/** Dependencies belong to the selected Builder checkout, independently of retained native session state. */
export const readSelectedDevelopmentDependencies = async (
  repositoryRoot: string,
): Promise<DevelopmentDependencyBinding> => {
  const root = await realpath(repositoryRoot);
  const modulesRoot = await realpath(path.join(root, "node_modules"));
  const modules = await lstat(modulesRoot);
  if (
    ![
      modules.isDirectory(),
      !modules.isSymbolicLink(),
      modules.uid === process.getuid?.(),
      (modules.mode & 0o022) === 0,
      (await realpath(modulesRoot)) === modulesRoot,
    ].every(Boolean)
  ) {
    throw new Error(
      "Install this selected Builder checkout's own dependencies; node_modules must be an owner-bound directory with no group or world write access.",
    );
  }
  const [sourceLock, installedLock] = await Promise.all([
    optionalRead(path.join(root, "pnpm-lock.yaml")),
    optionalRead(path.join(modulesRoot, ".pnpm/lock.yaml")),
  ]);
  if (
    sourceLock !== undefined &&
    (installedLock === undefined || !installedLock.equals(sourceLock))
  ) {
    throw new Error(
      "The selected Builder checkout's installed dependencies do not match pnpm-lock.yaml. Run pnpm install --frozen-lockfile in that checkout, then resume the stopped cycle.",
    );
  }
  const evePackagePath = resolveDevelopmentEve(root);
  const relativeEve = path.relative(modulesRoot, evePackagePath);
  if (
    relativeEve === ".." ||
    relativeEve.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeEve)
  ) {
    throw new Error(
      "The selected Builder resolves Eve outside its selected dependency tree. Run pnpm install --frozen-lockfile in that checkout to remove stale per-package or ancestor resolution before resuming.",
    );
  }
  const binding: Pick<
    DevelopmentDependencyBinding,
    "modulesRoot" | "sourceLockSha256" | "installedLockSha256"
  > = { modulesRoot };
  if (sourceLock !== undefined) {
    binding.sourceLockSha256 = digest(sourceLock);
  }
  if (installedLock !== undefined) {
    binding.installedLockSha256 = digest(installedLock);
  }
  return { ...binding, evePackagePath };
};
/** Actual resolution readback, not an authored-source or READY claim. */
export const assertDevelopmentApplicationDependencies = async (input: {
  repositoryRoot: string;
  applicationRoot: string;
}): Promise<DevelopmentDependencyBinding> => {
  const selected = await readSelectedDevelopmentDependencies(input.repositoryRoot);
  if ((await realpath(path.join(input.applicationRoot, "node_modules"))) !== selected.modulesRoot) {
    throw new Error("The local Eve dependency binding changed before launch.");
  }
  if (resolveDevelopmentEve(input.applicationRoot) !== selected.evePackagePath) {
    throw new Error(
      "The local Eve application and selected Builder resolve different Eve packages; stop and repair the dependency binding before launch.",
    );
  }
  return selected;
};

/** Preflight the retained link before authored files or dependency selection change. */
export const assertOwnedDevelopmentDependencyLink = async (
  applicationRoot: string,
): Promise<void> => {
  const target = path.join(applicationRoot, "node_modules");
  let existing;
  try {
    existing = await lstat(target);
  } catch (error) {
    if (!absent(error)) {
      throw error;
    }
  }
  if (
    existing !== undefined &&
    (!existing.isSymbolicLink() || existing.uid !== process.getuid?.())
  ) {
    throw new Error(
      "The stopped cycle's node_modules is not its owned dependency link; preserve it and repair the local dependency binding before launch.",
    );
  }
};

/** Caller owns the stopped local cycle and its state-root lock; .eve is never touched. */
export const bindDevelopmentApplicationDependencies = async (input: {
  repositoryRoot: string;
  applicationRoot: string;
}): Promise<DevelopmentDependencyBinding> => {
  const selected = await readSelectedDevelopmentDependencies(input.repositoryRoot);
  await assertOwnedDevelopmentDependencyLink(input.applicationRoot);
  const target = path.join(input.applicationRoot, "node_modules");
  const stage = path.join(input.applicationRoot, `.node_modules-rebind-${randomUUID()}`);
  try {
    await symlink(selected.modulesRoot, stage);
    await rename(stage, target);
  } finally {
    await rm(stage, { force: true });
  }
  const observed = await assertDevelopmentApplicationDependencies(input);
  const after = await readSelectedDevelopmentDependencies(input.repositoryRoot);
  if (!isDeepStrictEqual(after, selected)) {
    throw new Error(
      "The selected Builder dependencies changed while binding this stopped cycle; resume again after installation finishes.",
    );
  }
  return observed;
};
