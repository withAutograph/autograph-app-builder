import { describe, expect, it, vi } from "vitest";

import {
  localPreviewExecutionCommand,
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
      command: localPreviewExecutionCommand("spend-review"),
      workingDirectory: "/workspace/repository",
    });
    expect(localPreviewExecutionCommand("spend-review")).toContain(
      "mise run --skip-tools app:local -- spend-review setup > '/tmp/app-builder-local-setup-spend-review.log' 2>&1",
    );
    expect(localPreviewExecutionCommand("spend-review")).toContain('exit "$status"');
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

  it("installs the repository-pinned PostgreSQL tool when initdb is absent", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 1, stderr: "error: initdb failed", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "installed" })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "setup complete" });
    const result = await prepareAppLocalPreview({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run },
    });
    expect(run).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ command: localPreviewExecutionCommand("spend-review") }),
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ command: "command -v initdb" }),
    );
    expect(run).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ command: "mise install conda:postgresql" }),
    );
    expect(run).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({ status: "prepared", stdout: "setup complete" });
  });

  it("reports why PostgreSQL installation could not complete", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 1, stderr: "error: initdb failed", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 2, stderr: "conda backend unavailable", stdout: "" });
    const result = await prepareAppLocalPreview({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run },
    });
    expect(result).toMatchObject({ exitCode: 2, status: "failed" });
    expect(result.problem).toContain("mise's conda backend");
    expect(result.stderr).toContain("conda backend unavailable");
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
