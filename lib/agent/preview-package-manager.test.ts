import { describe, expect, it } from "vitest";

import { resolvePreviewPackageManager } from "./preview-package-manager";

describe("private preview package manager", () => {
  it("uses a Bun checkout's own script runner when a caller proposed pnpm", () => {
    const result = resolvePreviewPackageManager(
      { args: ["dev"], executable: "pnpm" },
      JSON.stringify({ packageManager: "bun@1.3.14" }),
    );
    expect(result.command).toEqual({ args: ["run", "dev"], executable: "bun" });
    expect(result.adjustment).toContain("instead of pnpm");
  });

  it("preserves a matching package manager and rejects complex mismatches", () => {
    const manifest = JSON.stringify({ packageManager: "bun@1.3.14" });
    const command = { args: ["run", "dev"], executable: "bun" };
    expect(resolvePreviewPackageManager(command, manifest).command).toEqual(command);
    expect(() =>
      resolvePreviewPackageManager(
        { args: ["--filter", "app", "dev"], executable: "pnpm" },
        manifest,
      ),
    ).toThrow("cannot be safely translated");
  });
});
