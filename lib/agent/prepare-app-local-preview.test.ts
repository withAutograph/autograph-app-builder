import { describe, expect, it, vi } from "vitest";

import {
  localPreviewSetupCommand,
  prepareAppLocalPreview,
} from "../../agent/tools/prepare-app-local-preview";

describe("private local preview setup", () => {
  it("runs the selected app's repository task in its checkout", async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ exitCode: 0, stderr: "", stdout: "Local setup complete" });
    const result = await prepareAppLocalPreview({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run },
    });
    expect(run).toHaveBeenCalledWith({
      command: "mise run --skip-tools app:local -- spend-review setup",
      workingDirectory: "/workspace/repository",
    });
    expect(result).toMatchObject({ exitCode: 0, status: "prepared" });
    expect(() => localPreviewSetupCommand("spend-review; deploy")).toThrow();
  });

  it("preserves actionable local database failures without leaking connection strings", async () => {
    const run = vi.fn().mockResolvedValue({
      exitCode: 1,
      stderr:
        "pg_ctl: could not start server at postgres://postgres:secret@127.0.0.1:52016/spend_review",
      stdout: "",
    });
    const result = await prepareAppLocalPreview({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run },
    });
    expect(result).toMatchObject({ exitCode: 1, status: "failed" });
    expect(result.problem).toContain("local PostgreSQL");
    expect(result.stderr).toContain("pg_ctl");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("reports command-provider errors with a recovery action", async () => {
    const result = await prepareAppLocalPreview({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run: vi.fn().mockRejectedValue(new Error("Sandbox unavailable: token=secret")) },
    });
    expect(result).toMatchObject({ exitCode: null, status: "failed" });
    expect(result.problem).toContain("sandbox command runner");
    expect(JSON.stringify(result)).not.toContain("token=secret");
  });
});
