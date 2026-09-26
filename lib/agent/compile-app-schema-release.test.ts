import { describe, expect, it, vi } from "vitest";

import {
  appSchemaReleaseCommand,
  compileAppSchemaRelease,
} from "../../agent/tools/compile-app-schema-release";

describe("private app schema release compilation", () => {
  it("targets only the selected app with a fixed repository task", () => {
    expect(appSchemaReleaseCommand("spend-review")).toBe(
      "mise run --skip-tools schema:release -- compile --app spend-review",
    );
    expect(() => appSchemaReleaseCommand("spend-review; deploy")).toThrow();
  });

  it("returns a useful compiler failure without losing the failing command", async () => {
    const run = vi.fn().mockResolvedValue({
      exitCode: 1,
      stderr: "apps/spend-review/schema/spend-review.cue:18: conflicting values",
      stdout: "",
    });
    const result = await compileAppSchemaRelease({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run },
    });
    expect(run).toHaveBeenCalledWith({
      command: "mise run --skip-tools schema:release -- compile --app spend-review",
      workingDirectory: "/workspace/repository",
    });
    expect(result).toMatchObject({
      exitCode: 1,
      status: "failed",
      stderr: "apps/spend-review/schema/spend-review.cue:18: conflicting values",
    });
    expect(result.problem).toContain("fix the named CUE source");
  });

  it("names provider failures and removes credentials", async () => {
    const run = vi.fn().mockRejectedValue(new Error("Sandbox aborted: token=secret-value"));
    const result = await compileAppSchemaRelease({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run },
    });
    expect(result).toMatchObject({ exitCode: null, status: "failed" });
    expect(result.problem).toContain("Sandbox aborted");
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });
});
