import { describe, expect, it, vi } from "vitest";

import { inspectSandboxCommand } from "./inspect_sandbox_toolchain";

describe("sandbox command inspection", () => {
  it("does not report an executable as available when its version command fails", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "/usr/local/bin/bun\n" })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "cannot load runtime", stdout: "" });

    await expect(inspectSandboxCommand({ run } as never, "bun")).resolves.toEqual({
      available: false,
      command: "bun",
    });
    expect(run).toHaveBeenCalledTimes(2);
  });
});
