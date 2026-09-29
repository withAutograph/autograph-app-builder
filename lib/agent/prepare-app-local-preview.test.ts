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
      "MISE_TASK_RUN_AUTO_INSTALL=true MISE_AUTO_INSTALL=true mise run app:local -- spend-review setup > '/tmp/app-builder-local-setup-spend-review.log' 2>&1",
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
    expect(result.problem).toContain("local database startup");
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
