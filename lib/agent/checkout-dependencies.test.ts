import { describe, expect, it, vi } from "vitest";
import { ensureCheckoutDependencies } from "./checkout-dependencies";

const result = (exitCode: number, stderr = "", stdout = "") => ({
  exitCode,
  stderr,
  stdout,
});

describe("replacement checkout dependencies", () => {
  it("does no install work when the live checkout already has dependencies", async () => {
    const run = vi.fn().mockResolvedValue(result(0));
    await expect(
      ensureCheckoutDependencies({ root: "/workspace/repository", sandbox: { run } }),
    ).resolves.toEqual({ status: "reused" });
    expect(run).toHaveBeenCalledExactlyOnceWith({
      command: "test -d node_modules/.bin",
      workingDirectory: "/workspace/repository",
    });
  });

  it("installs the selected checkout after compute replacement", async () => {
    const run = vi.fn().mockResolvedValueOnce(result(1)).mockResolvedValueOnce(result(0));
    await expect(
      ensureCheckoutDependencies({
        requiredExecutable: "next",
        root: "/workspace/repository",
        sandbox: { run },
      }),
    ).resolves.toEqual({ status: "installed" });
    expect(run).toHaveBeenNthCalledWith(1, {
      command: "test -x node_modules/.bin/next",
      workingDirectory: "/workspace/repository",
    });
    expect(run).toHaveBeenNthCalledWith(2, {
      command: "bun install --frozen-lockfile",
      workingDirectory: "/workspace/repository",
    });
  });

  it("names the install command, cause, and recovery when the lockfile fails", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(result(1))
      .mockResolvedValueOnce(result(1, "frozen lockfile mismatch"));
    await expect(
      ensureCheckoutDependencies({ root: "/workspace/repository", sandbox: { run } }),
    ).rejects.toThrow(
      /bun install --frozen-lockfile.*status 1.*lockfile.*frozen lockfile mismatch/u,
    );
  });
});
