import type { SandboxSession } from "eve/sandbox";
import { HOSTED_BUN_VERSION, HOSTED_MISE_VERSION, HOSTED_RUST_VERSION } from "./hosted-toolchain";

export const HOSTED_BUN_RUNTIME_PREFIX = "/workspace/.app-builder/runtime";
const hostedMiseData = `${HOSTED_BUN_RUNTIME_PREFIX}/mise-data`;

export const HOSTED_BUN_RUNTIME_ENVIRONMENT = {
  MISE_DATA_DIR: hostedMiseData,
  PATH: `${HOSTED_BUN_RUNTIME_PREFIX}/bin:${HOSTED_BUN_RUNTIME_PREFIX}/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
} as const;

const hostedBunRuntimeInstallRequest = {
  command: `npm install --prefix ${HOSTED_BUN_RUNTIME_PREFIX} bun@${HOSTED_BUN_VERSION} @jdxcode/mise@${HOSTED_MISE_VERSION}`,
  env: HOSTED_BUN_RUNTIME_ENVIRONMENT,
} as const;

const hostedRustInstallRequest = {
  command: `set -eu
mise install rust@${HOSTED_RUST_VERSION}
rust_root="$(mise where rust@${HOSTED_RUST_VERSION})"
if test -x "$rust_root/cargo" && test -x "$rust_root/rustc"; then
  rust_bin="$rust_root"
else
  rust_bin="$rust_root/bin"
fi
test -x "$rust_bin/cargo"
test -x "$rust_bin/rustc"
install -d ${HOSTED_BUN_RUNTIME_PREFIX}/bin
ln -sfn "$rust_bin/cargo" ${HOSTED_BUN_RUNTIME_PREFIX}/bin/cargo
ln -sfn "$rust_bin/rustc" ${HOSTED_BUN_RUNTIME_PREFIX}/bin/rustc
cargo --version
rustc --version
if ! command -v cc >/dev/null; then
  if command -v apt-get >/dev/null; then
    sudo apt-get update
    sudo apt-get install -y build-essential
  elif command -v dnf >/dev/null; then
    sudo dnf install -y gcc
  else
    echo 'A C compiler is required for Rust schema compilation; this sandbox has neither cc nor a supported package manager.' >&2
    exit 1
  fi
fi
command -v cc
cc --version`,
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
