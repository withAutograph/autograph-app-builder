import { describe, expect, it, vi } from "vitest";
import type { SandboxSession } from "eve/sandbox";

import { materializePlanningOverlay } from "./target-planning";

describe("planning from the current checkout", () => {
  it.each([null, "invalid old inventory"])(
    "copies current files without requiring an inspection manifest (%s)",
    async (manifest) => {
      const run = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
      const readTextFile = vi.fn(async () => manifest);
      const writeTextFile = vi.fn(async () => undefined);
      const sandbox = {
        run,
        readTextFile,
        writeTextFile,
        removePath: vi.fn(async () => undefined),
      } as unknown as SandboxSession;

      const result = await materializePlanningOverlay({
        sandbox,
        artifactRevision: "a".repeat(64),
        appId: "stock-exceptions",
        appSpecContent: "Stock Exceptions product design",
        appSpecDigest: "b".repeat(64),
      });

      expect(readTextFile).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          command: expect.stringContaining("cp -R /workspace/repository/."),
        }),
      );
      expect(result.planningRoot).toContain("/workspace/");
      expect(writeTextFile).toHaveBeenCalledWith(
        expect.objectContaining({ content: "Stock Exceptions product design" }),
      );
    },
  );

  it("reports an actual checkout copy failure", async () => {
    const sandbox = {
      run: vi.fn(async ({ command }: { command: string }) => ({
        exitCode: command.startsWith("cp ") ? 1 : 0,
        stdout: "",
        stderr: "",
      })),
      writeTextFile: vi.fn(async () => undefined),
      removePath: vi.fn(async () => undefined),
    } as unknown as SandboxSession;

    await expect(
      materializePlanningOverlay({
        sandbox,
        artifactRevision: "a".repeat(64),
        appId: "stock-exceptions",
        appSpecContent: "Stock Exceptions product design",
        appSpecDigest: "b".repeat(64),
      }),
    ).rejects.toThrow("source copy");
  });
});
