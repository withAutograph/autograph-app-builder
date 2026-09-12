import type { SandboxSession } from "eve/sandbox";

export const HOSTED_BUN_RUNTIME_PREFIX = "/workspace/.app-builder/runtime";

export const HOSTED_BUN_RUNTIME_ENVIRONMENT = {
  PATH: `${HOSTED_BUN_RUNTIME_PREFIX}/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
} as const;

const hostedBunRuntimeInstallRequest = {
  command: `npm install --prefix ${HOSTED_BUN_RUNTIME_PREFIX} bun`,
  env: HOSTED_BUN_RUNTIME_ENVIRONMENT,
} as const;

/** Installs the builder-owned Bun runtime at most once for each live sandbox. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createHostedBunRuntimeInstaller() {
  const installs = new Map<string, Promise<void>>();

  return (sandbox: Pick<SandboxSession, "id" | "run">) => {
    const existing = installs.get(sandbox.id);
    if (existing !== undefined) return existing;

    // Promise composition preserves the shared install handle and cleanup identity.
    // oxlint-disable promise/prefer-await-to-callbacks
    // oxlint-disable promise/prefer-await-to-then
    // oxlint-disable-next-line promise/prefer-await-to-then
    const install: Promise<void> = Promise.resolve(sandbox.run(hostedBunRuntimeInstallRequest))
      .then((result) => {
        if (result.exitCode !== 0)
          throw new Error("The hosted Bun runtime could not be installed.");
      })
      // Preserve the shared lazy promise while clearing it after a failed install.
      // oxlint-disable-next-line promise/prefer-await-to-callbacks
      // oxlint-disable-next-line promise/prefer-await-to-then
      .catch((error: unknown) => {
        if (installs.get(sandbox.id) === install) installs.delete(sandbox.id);
        throw error;
      });
    // oxlint-enable promise/prefer-await-to-callbacks
    // oxlint-enable promise/prefer-await-to-then
    installs.set(sandbox.id, install);
    return install;
  };
}
