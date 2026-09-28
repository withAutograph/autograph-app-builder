import { describe, expect, it, vi } from "vitest";

import { appBrowserTestCommand, runAppBrowserTests } from "../../agent/tools/run-app-browser-tests";

describe("private app browser tests", () => {
  it("uses only the selected app's test-e2e task in the applied checkout", async () => {
    const run = vi.fn().mockResolvedValue({
      exitCode: 0,
      stderr: "",
      stdout: "5 passed",
    });
    const result = await runAppBrowserTests({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run },
    });
    expect(run).toHaveBeenCalledWith({
      command: "mise run --skip-tools //apps/spend-review:test-e2e",
      workingDirectory: "/workspace/repository",
    });
    expect(result).toMatchObject({ exitCode: 0, status: "passed", stdout: "5 passed" });
    expect(() => appBrowserTestCommand("other-app; deploy")).toThrow();
  });

  it("reports failing browser assertions and redacts private runtime addresses", async () => {
    const result = await runAppBrowserTests({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: {
        run: vi.fn().mockResolvedValue({
          exitCode: 1,
          stderr:
            "Error: expected one audit event at postgres://postgres:secret@127.0.0.1:52016/demo",
          stdout: "1 failed: create-refresh-decide-reset",
        }),
      },
    });
    expect(result).toMatchObject({ exitCode: 1, status: "failed" });
    expect(result.problem).toContain("browser test task exited");
    expect(result.stdout).toContain("create-refresh-decide-reset");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("names sandbox command failures", async () => {
    const result = await runAppBrowserTests({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run: vi.fn().mockRejectedValue(new Error("checkout missing")) },
    });
    expect(result).toMatchObject({ exitCode: null, status: "failed" });
    expect(result.problem).toContain("checkout missing");
    expect(result.problem).toContain("command runner");
  });
});
