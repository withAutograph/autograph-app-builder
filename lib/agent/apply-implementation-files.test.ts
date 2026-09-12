import { describe, expect, it, vi } from "vitest";

import { implementationFilesSchema, withImplementationFiles } from "./apply-implementation-files";

describe("approval-bound implementation files", () => {
  it("writes validated files into the successful apply overlay only", async () => {
    const files = implementationFilesSchema.parse([
      {
        path: "apps/stock-exceptions/app/page.tsx",
        content: "export default null",
      },
    ]);
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const writeTextFile = vi.fn(async () => undefined);
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const executor = vi.fn(async () => ({
      exitCode: 0,
      stdout: "receipt",
      stderr: "",
    }));
    const wrapped = withImplementationFiles(executor, files);

    await expect(
      wrapped({
        sandbox: { writeTextFile } as never,
        appId: "stock-exceptions",
        applyRoot: "/workspace/repository",
        proposalPath: "/workspace/proposal.json",
        proposal: {} as never,
      }),
    ).resolves.toEqual({ exitCode: 0, stdout: "receipt", stderr: "" });

    expect(writeTextFile).toHaveBeenCalledWith({
      path: "repository/apps/stock-exceptions/app/page.tsx",
      content: "export default null",
    });
    expect(
      implementationFilesSchema.safeParse([{ path: "../outside.ts", content: "nope" }]).success,
    ).toBe(false);
  });
});
