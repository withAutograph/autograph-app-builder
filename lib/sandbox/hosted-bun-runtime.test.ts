import { describe, expect, it, vi } from "vitest";

import {
  HOSTED_BUN_RUNTIME_ENVIRONMENT,
  HOSTED_BUN_RUNTIME_PREFIX,
  createHostedBunRuntimeInstaller,
} from "./hosted-bun-runtime";

describe("hosted Bun runtime", () => {
  it("installs Bun once per sandbox and exposes its binary path", async () => {
    // Eve exposes a PromiseLike command, not a native Promise with .catch().
    const run = vi.fn(() => {
      const result = Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
      return { then: result.then.bind(result) };
    });
    const install = createHostedBunRuntimeInstaller();
    const sandbox = { id: "sandbox-1", run };

    await Promise.all([install(sandbox), install(sandbox)]);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({
      command: `npm install --prefix ${HOSTED_BUN_RUNTIME_PREFIX} bun`,
      env: HOSTED_BUN_RUNTIME_ENVIRONMENT,
    });
    expect(HOSTED_BUN_RUNTIME_ENVIRONMENT.PATH).toContain(
      `${HOSTED_BUN_RUNTIME_PREFIX}/node_modules/.bin`
    );
  });
});
