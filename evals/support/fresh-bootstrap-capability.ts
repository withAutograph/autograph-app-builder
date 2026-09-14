import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

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

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function withFreshBootstrapEvalCapability<T>(
  capability: FreshBootstrapCapability,
  operation: () => Promise<T>,
  hooks?: FreshBootstrapFaultHooks,
): Promise<T> {
  if (capability.authority === "structural-test-injection")
    {return withFreshBootstrapTestCapability(capability, operation, hooks);}
  if (hooks !== undefined)
    {throw new Error("Configured-production eval capability cannot inject faults.");}
  return operation();
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function identity(path: string): Promise<PathIdentity> {
  const canonical = await realpath(path);
  const value = await lstat(canonical);
  return {
    device: String(value.dev),
    inode: String(value.ino),
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    mode: (value.mode & 0o777).toString(8),
    nlink: String(value.nlink),
    path: canonical,
    uid: String(value.uid),
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function executableIdentity(path: string): Promise<ExecutableIdentity> {
  return {
    ...(await identity(path)),
    sha256: createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function createFreshBootstrapEvalCapability(): Promise<{
  capability: FreshBootstrapCapability;
  allowedRoot: string;
  cleanup: () => Promise<void>;
}> {
  if (
    process.env.APP_BUILDER_FRESH_BOOTSTRAP_ENABLED === "1" &&
    process.env.APP_BUILDER_FRESH_BOOTSTRAP_ALLOWED_ROOT !== undefined
  ) {
    const capability = await productionFreshBootstrapCapability();
    return {
      allowedRoot: capability.allowedRoot.path,
      capability,
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test callback
      cleanup: async () => {
        // The production capability owns no local resources.
      },
    };
  }
  const owner = await realpath(await mkdtemp(nodePath.join(tmpdir(), "app-builder-fresh-eval-")));
  await chmod(owner, 0o700);
  const stateRoot = nodePath.join(owner, "state");
  const allowedRoot = nodePath.join(owner, "destinations");
  await mkdir(stateRoot, { mode: 0o700 });
  await mkdir(allowedRoot, { mode: 0o700 });
  const selectedLock = existsSync("/usr/bin/flock")
    ? ({ path: "/usr/bin/flock", strategy: "flock" } as const)
    : ({ path: "/usr/bin/lockf", strategy: "lockf" } as const);
  const [systemGit, systemPython, systemNode, lockHelper] = await Promise.all([
    canonicalFreshBootstrapHelperPath(existsSync("/usr/bin/git") ? "/usr/bin/git" : "/bin/git"),
    canonicalFreshBootstrapHelperPath(
      existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "/bin/python3",
    ),
    canonicalFreshBootstrapHelperPath(process.execPath),
    canonicalFreshBootstrapHelperPath(selectedLock.path),
  ]);
  return {
    allowedRoot,
    capability: {
      allowedRoot: await identity(allowedRoot),
      authority: "structural-test-injection",
      kind: "fresh-bootstrap-local-v1",
      lockHelper,
      lockHelperIdentity: await executableIdentity(lockHelper),
      lockStrategy: selectedLock.strategy,
      stateRoot: await identity(stateRoot),
      systemGit,
      systemGitIdentity: await executableIdentity(systemGit),
      systemNode,
      systemNodeIdentity: await executableIdentity(systemNode),
      systemPython,
      systemPythonIdentity: await executableIdentity(systemPython),
    },
    cleanup: () => rm(owner, { force: true, recursive: true }),
  };
}
