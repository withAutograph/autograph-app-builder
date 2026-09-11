import { describe, expect, it, vi } from "vitest";

import {
  implementationFilesSchema,
  withImplementationFiles,
} from "./apply-implementation-files";

describe("approval-bound implementation files", () => {
  it("writes validated files into the successful apply overlay only", async () => {
    const files = implementationFilesSchema.parse([
      {
        content: "export default null",
        path: "apps/stock-exceptions/app/page.tsx",
      },
    ]);
    const writeTextFile = vi.fn(async () => {});
    const executor = vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "receipt",
    }));
    const wrapped = withImplementationFiles(executor, files);

    await expect(
      wrapped({
        appId: "stock-exceptions",
        applyRoot: "/workspace/repository",
        proposal: {} as never,
        proposalPath: "/workspace/proposal.json",
        sandbox: { writeTextFile } as never,
      })
    ).resolves.toEqual({ exitCode: 0, stderr: "", stdout: "receipt" });

    expect(writeTextFile).toHaveBeenCalledWith({
      content: "export default null",
      path: "repository/apps/stock-exceptions/app/page.tsx",
    });
    expect(
      implementationFilesSchema.safeParse([
        { content: "nope", path: "../outside.ts" },
      ]).success
    ).toBe(false);
  });
});
