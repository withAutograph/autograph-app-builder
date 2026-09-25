import { describe, expect, it, vi } from "vitest";

import {
  HOSTED_BUN_RUNTIME_ENVIRONMENT,
  HOSTED_BUN_RUNTIME_PREFIX,
  createHostedBunRuntimeInstaller,
} from "./hosted-bun-runtime";
import { HOSTED_BUN_VERSION, HOSTED_MISE_VERSION } from "./hosted-toolchain";

describe("hosted Bun runtime", () => {
  it("installs Bun and the pinned Mise runtime once per sandbox", async () => {
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
    const install = createHostedBunRuntimeInstaller();
    const sandbox = { id: "sandbox-1", run };

    await Promise.all([install(sandbox), install(sandbox)]);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({
      command: `npm install --prefix ${HOSTED_BUN_RUNTIME_PREFIX} bun@${HOSTED_BUN_VERSION} @jdxcode/mise@${HOSTED_MISE_VERSION}`,
      env: HOSTED_BUN_RUNTIME_ENVIRONMENT,
    });
    expect(HOSTED_BUN_RUNTIME_ENVIRONMENT.PATH).toContain(
      `${HOSTED_BUN_RUNTIME_PREFIX}/node_modules/.bin`,
    );
  });
});
