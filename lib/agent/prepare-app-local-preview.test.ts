import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  appDeclaresLocalSetup,
  localPreviewExecutionCommand,
  localPreviewSetupCommand,
  prepareAppLocalPreview,
  prepareValidationLocalData,
} from "../../agent/tools/prepare-app-local-preview";

describe("private local preview setup", () => {
  it("prepares only apps whose contract and repository declare local setup", async () => {
    const readTextFile = vi.fn(
      async ({ path }: { path: string }): Promise<string> =>
        await Promise.resolve(
          path.endsWith("app-spec.md")
            ? "Local data: mise run app:local -- spend-review setup"
            : '[tasks."app:local"]',
        ),
    );
    expect(
      await appDeclaresLocalSetup({
        appId: "spend-review",
        root: "/workspace/repository",
        sandbox: { readTextFile },
      }),
    ).toBe(true);
    expect(readTextFile).toHaveBeenCalledWith({
      path: "/workspace/repository/apps/spend-review/.config/app-spec.md",
    });
    readTextFile.mockImplementationOnce(async () => await Promise.resolve("No local setup task"));
    expect(
      await appDeclaresLocalSetup({
        appId: "spend-review",
        root: "/workspace/repository",
        sandbox: { readTextFile },
      }),
    ).toBe(false);
  });

  it("starts declared local data before validation and reports setup failures", async () => {
    const readTextFile = vi.fn(
      async ({ path }: { path: string }) =>
        await Promise.resolve(
          path.endsWith("app-spec.md")
            ? "mise run app:local -- spend-review setup"
            : '[tasks."app:local"]',
        ),
    );
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "ready" });
    const input = {
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { readTextFile, run },
    };
    await prepareValidationLocalData(input);
    expect(run).toHaveBeenCalledWith({
      command: localPreviewExecutionCommand("spend-review"),
      workingDirectory: "/workspace/repository",
    });
    run.mockResolvedValueOnce({ exitCode: 1, stderr: "pg_ctl failed", stdout: "" });
    await expect(prepareValidationLocalData(input)).rejects.toThrow(
      "Validation could not prepare the selected app's local data",
    );
    await expect(prepareValidationLocalData(input)).resolves.toBeUndefined();
  });

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

  it("runs local setup with a usable terminal when the sandbox has no TERM", () => {
    // oxlint-disable-next-line sonarjs/publicly-writable-directories -- mkdtemp creates an owned fixture directory.
    const bin = mkdtempSync(nodePath.join(tmpdir(), "builder-local-terminal-"));
    // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Matches the command's sandbox-only fixture log.
    const log = "/tmp/app-builder-local-setup-terminal-test.log";
    try {
      const mise = nodePath.join(bin, "mise");
      writeFileSync(
        mise,
        '#!/bin/sh\nif [ "$TERM" = dumb ]; then echo "local setup ready"; else echo "TERM environment variable not set." >&2; exit 1; fi\n',
      );
      chmodSync(mise, 0o755);
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      };
      delete environment.TERM;
      // oxlint-disable-next-line sonarjs/no-os-command-from-path -- PATH intentionally selects the owned mise fixture.
      const result = spawnSync("/bin/sh", ["-c", localPreviewExecutionCommand("terminal-test")], {
        encoding: "utf-8",
        env: environment,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("local setup ready");
    } finally {
      rmSync(bin, { force: true, recursive: true });
      rmSync(log, { force: true });
    }
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
