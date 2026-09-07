import { describe, expect, it, vi } from "vitest";

import {
  HOSTED_BUN_RUNTIME_ENVIRONMENT,
  HOSTED_BUN_RUNTIME_PREFIX,
  createHostedBunRuntimeInstaller,
} from "./hosted-bun-runtime";

describe("hosted Bun runtime", () => {
  it("installs Bun once per sandbox and exposes its binary path", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0 });
    const install = createHostedBunRuntimeInstaller();
    const sandbox = { id: "sandbox-1", run };

    await Promise.all([install(sandbox), install(sandbox)]);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({
      command: `npm install --prefix ${HOSTED_BUN_RUNTIME_PREFIX} bun`,
      env: HOSTED_BUN_RUNTIME_ENVIRONMENT,
    });
    expect(HOSTED_BUN_RUNTIME_ENVIRONMENT.PATH).toContain(
      `${HOSTED_BUN_RUNTIME_PREFIX}/node_modules/.bin`,
    );
  });
});
