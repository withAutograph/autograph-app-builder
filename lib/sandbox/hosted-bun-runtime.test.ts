import { describe, expect, it, vi } from "vitest";

import {
  HOSTED_BUN_RUNTIME_ENVIRONMENT,
  HOSTED_BUN_RUNTIME_PREFIX,
  createHostedRuntimeInstaller,
} from "./hosted-bun-runtime";
import { HOSTED_BUN_VERSION, HOSTED_MISE_VERSION, HOSTED_RUST_VERSION } from "./hosted-toolchain";

describe("hosted validation runtime", () => {
  it("installs Bun, mise, and the pinned Rust toolchain once per sandbox", async () => {
    // Eve exposes a PromiseLike command, not a native Promise with .catch().
    const run = vi.fn(() => {
      const result = Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
      const thenProperty = String.fromCodePoint(116, 104, 101, 110);
      return Object.fromEntries([
        [thenProperty, result.then.bind(result)],
      ]) as unknown as PromiseLike<{
        exitCode: number;
        stdout: string;
        stderr: string;
      }>;
    });
    const install = createHostedRuntimeInstaller();
    const sandbox = { id: "sandbox-1", run };

    await Promise.all([install(sandbox), install(sandbox)]);

    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledWith({
      command: `npm install --prefix ${HOSTED_BUN_RUNTIME_PREFIX} bun@${HOSTED_BUN_VERSION} @jdxcode/mise@${HOSTED_MISE_VERSION}`,
      env: HOSTED_BUN_RUNTIME_ENVIRONMENT,
    });
    expect(HOSTED_BUN_RUNTIME_ENVIRONMENT.PATH).toContain(
      `${HOSTED_BUN_RUNTIME_PREFIX}/node_modules/.bin`,
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: expect.stringContaining(`mise where rust@${HOSTED_RUST_VERSION}`),
        env: HOSTED_BUN_RUNTIME_ENVIRONMENT,
      }),
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: expect.stringContaining("sudo apt-get install -y build-essential"),
      }),
    );
    expect(HOSTED_BUN_RUNTIME_ENVIRONMENT.PATH).toContain(`${HOSTED_BUN_RUNTIME_PREFIX}/bin`);
  });

  it("reports Rust setup failure and permits a retry", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "cargo download failed", stdout: "" })
      .mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });
    const install = createHostedRuntimeInstaller();
    const sandbox = { id: "sandbox-2", run };

    await expect(install(sandbox)).rejects.toThrow(
      "The hosted Rust toolchain could not be installed: cargo download failed",
    );
    await expect(install(sandbox)).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(4);
  });
});
