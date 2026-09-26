import type { SandboxSession } from "eve/sandbox";
import { HOSTED_BUN_VERSION, HOSTED_MISE_VERSION, HOSTED_RUST_VERSION } from "./hosted-toolchain";

export const HOSTED_BUN_RUNTIME_PREFIX = "/workspace/.app-builder/runtime";
const hostedMiseData = `${HOSTED_BUN_RUNTIME_PREFIX}/mise-data`;

export const HOSTED_BUN_RUNTIME_ENVIRONMENT = {
  MISE_DATA_DIR: hostedMiseData,
  PATH: `${HOSTED_BUN_RUNTIME_PREFIX}/node_modules/.bin:${hostedMiseData}/installs/rust/${HOSTED_RUST_VERSION}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
} as const;

const hostedBunRuntimeInstallRequest = {
  command: `npm install --prefix ${HOSTED_BUN_RUNTIME_PREFIX} bun@${HOSTED_BUN_VERSION} @jdxcode/mise@${HOSTED_MISE_VERSION}`,
  env: HOSTED_BUN_RUNTIME_ENVIRONMENT,
} as const;

const hostedRustInstallRequest = {
  command: `mise install rust@${HOSTED_RUST_VERSION} && cargo --version && rustc --version`,
  env: HOSTED_BUN_RUNTIME_ENVIRONMENT,
} as const;

/** Installs the builder-owned validation toolchain at most once for each live sandbox. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createHostedRuntimeInstaller() {
  const installs = new Map<string, Promise<void>>();

  return (sandbox: Pick<SandboxSession, "id" | "run">) => {
    const existing = installs.get(sandbox.id);
    if (existing !== undefined) {
      return existing;
    }

    // Promise composition preserves the shared install handle and cleanup identity.
    // oxlint-disable promise/prefer-await-to-callbacks
    // oxlint-disable promise/prefer-await-to-then
    // oxlint-disable-next-line promise/prefer-await-to-then
    const install: Promise<void> = Promise.resolve(sandbox.run(hostedBunRuntimeInstallRequest))
      .then(async (result) => {
        if (result.exitCode !== 0) {
          throw new Error(
            `The hosted Bun and mise runtime could not be installed: ${(result.stderr || result.stdout).trim().slice(0, 2000)}`,
          );
        }
        const rust = await sandbox.run(hostedRustInstallRequest);
        if (rust.exitCode !== 0) {
          throw new Error(
            `The hosted Rust toolchain could not be installed: ${(rust.stderr || rust.stdout).trim().slice(0, 2000)}`,
          );
        }
      })
      // Preserve the shared lazy promise while clearing it after a failed install.
      // oxlint-disable-next-line promise/prefer-await-to-callbacks
      // oxlint-disable-next-line promise/prefer-await-to-then
      .catch((error: unknown) => {
        if (installs.get(sandbox.id) === install) {
          installs.delete(sandbox.id);
        }
        throw error;
      });
    // oxlint-enable promise/prefer-await-to-callbacks
    // oxlint-enable promise/prefer-await-to-then
    installs.set(sandbox.id, install);
    return install;
  };
}
