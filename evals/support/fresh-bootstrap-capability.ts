import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExecutableIdentity,
  FreshBootstrapCapability,
  PathIdentity,
} from "@/lib/repository/fresh-bootstrap";
import {
  canonicalFreshBootstrapHelperPath,
  productionFreshBootstrapCapability,
} from "@/lib/repository/node-fresh-bootstrap";
import { withFreshBootstrapTestCapability } from "@/lib/agent/fresh-bootstrap-capability";
import type { FreshBootstrapFaultHooks } from "@/lib/repository/node-fresh-bootstrap";

export function withFreshBootstrapEvalCapability<T>(
  capability: FreshBootstrapCapability,
  operation: () => Promise<T>,
  hooks?: FreshBootstrapFaultHooks,
): Promise<T> {
  if (capability.authority === "structural-test-injection")
    return withFreshBootstrapTestCapability(capability, operation, hooks);
  if (hooks !== undefined)
    throw new Error(
      "Configured-production eval capability cannot inject faults.",
    );
  return operation();
}

async function identity(path: string): Promise<PathIdentity> {
  const canonical = await realpath(path);
  const value = await lstat(canonical);
  return {
    path: canonical,
    device: String(value.dev),
    inode: String(value.ino),
    uid: String(value.uid),
    mode: (value.mode & 0o777).toString(8),
    nlink: String(value.nlink),
  };
}

async function executableIdentity(path: string): Promise<ExecutableIdentity> {
  return {
    ...(await identity(path)),
    sha256: createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
  };
}

export async function createFreshBootstrapEvalCapability(): Promise<{
  capability: FreshBootstrapCapability;
  allowedRoot: string;
  cleanup(): Promise<void>;
}> {
  if (
    process.env.APP_BUILDER_FRESH_BOOTSTRAP_ENABLED === "1" &&
    process.env.APP_BUILDER_FRESH_BOOTSTRAP_ALLOWED_ROOT !== undefined
  ) {
    const capability = await productionFreshBootstrapCapability();
    return {
      capability,
      allowedRoot: capability.allowedRoot.path,
      cleanup: async () => undefined,
    };
  }
  const owner = await realpath(
    await mkdtemp(join(tmpdir(), "app-builder-fresh-eval-")),
  );
  await chmod(owner, 0o700);
  const stateRoot = join(owner, "state");
  const allowedRoot = join(owner, "destinations");
  await mkdir(stateRoot, { mode: 0o700 });
  await mkdir(allowedRoot, { mode: 0o700 });
  const selectedLock = existsSync("/usr/bin/flock")
    ? ({ strategy: "flock", path: "/usr/bin/flock" } as const)
    : ({ strategy: "lockf", path: "/usr/bin/lockf" } as const);
  const [systemGit, systemPython, systemNode, lockHelper] = await Promise.all([
    canonicalFreshBootstrapHelperPath(
      existsSync("/usr/bin/git") ? "/usr/bin/git" : "/bin/git",
    ),
    canonicalFreshBootstrapHelperPath(
      existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "/bin/python3",
    ),
    canonicalFreshBootstrapHelperPath(process.execPath),
    canonicalFreshBootstrapHelperPath(selectedLock.path),
  ]);
  return {
    allowedRoot,
    capability: {
      kind: "fresh-bootstrap-local-v1",
      stateRoot: await identity(stateRoot),
      allowedRoot: await identity(allowedRoot),
      systemGit,
      systemPython,
      systemGitIdentity: await executableIdentity(systemGit),
      systemPythonIdentity: await executableIdentity(systemPython),
      systemNode,
      systemNodeIdentity: await executableIdentity(systemNode),
      lockStrategy: selectedLock.strategy,
      lockHelper,
      lockHelperIdentity: await executableIdentity(lockHelper),
      authority: "structural-test-injection",
    },
    cleanup: () => rm(owner, { recursive: true, force: true }),
  };
}
