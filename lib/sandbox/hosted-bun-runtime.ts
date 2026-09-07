import type { SandboxSession } from "eve/sandbox";

export const HOSTED_BUN_RUNTIME_PREFIX = "/workspace/.app-builder/runtime";

export const HOSTED_BUN_RUNTIME_ENVIRONMENT = {
  PATH: `${HOSTED_BUN_RUNTIME_PREFIX}/node_modules/.bin:/usr/bin:/bin`,
} as const;

const hostedBunRuntimeInstallRequest = {
  command: `npm install --prefix ${HOSTED_BUN_RUNTIME_PREFIX} bun`,
  env: HOSTED_BUN_RUNTIME_ENVIRONMENT,
} as const;

/** Installs the builder-owned Bun runtime at most once for each live sandbox. */
export function createHostedBunRuntimeInstaller() {
  const installs = new Map<string, Promise<void>>();

  return (sandbox: Pick<SandboxSession, "id" | "run">) => {
    const existing = installs.get(sandbox.id);
    if (existing !== undefined) return existing;

    let install: Promise<void>;
    install = sandbox
      .run(hostedBunRuntimeInstallRequest)
      .then((result) => {
        if (result.exitCode !== 0)
          throw new Error("The hosted Bun runtime could not be installed.");
      })
      .catch((error: unknown) => {
        if (installs.get(sandbox.id) === install) installs.delete(sandbox.id);
        throw error;
      });
    installs.set(sandbox.id, install);
    return install;
  };
}
