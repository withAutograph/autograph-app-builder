import { describe, expect, it, vi } from "vitest";

import { listCurrentAppSourcePaths } from "../../agent/tools/inspect_existing_app";

describe("existing app source listing", () => {
  it("re-reads tracked and newly added app files from the live checkout", async () => {
    const run = vi.fn(
      async (_input: { command: string }) =>
        await Promise.resolve({
          exitCode: 0,
          stderr: "",
          stdout:
            "apps/spend-review/app/page.tsx\0apps/spend-review/server/new-request.ts\0apps/other/app/page.tsx\0",
        }),
    );
    await expect(listCurrentAppSourcePaths({ run }, "spend-review")).resolves.toEqual([
      "apps/spend-review/app/page.tsx",
      "apps/spend-review/server/new-request.ts",
    ]);
    expect(run.mock.calls[0]?.[0].command).toContain(
      "ls-files -z --cached --others --exclude-standard -- 'apps/spend-review/'",
    );
  });

  it("reports a checkout read failure with the repository operation", async () => {
    const run = vi.fn(
      async (_input: { command: string }) =>
        await Promise.resolve({
          exitCode: 128,
          stderr: "fatal: not a git repository",
          stdout: "",
        }),
    );
    await expect(listCurrentAppSourcePaths({ run }, "spend-review")).rejects.toThrow(
      "Could not list current spend-review source files: fatal: not a git repository",
    );
  });
});
