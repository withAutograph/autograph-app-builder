import type { SandboxSession } from "eve/sandbox";
import { describe, expect, it, vi } from "vitest";

import {
  executeTargetIdentityAndPlanning,
  fixtureTargetCommandExecutor,
  materializePlanningOverlay,
} from "./target-planning";

describe("planning from the current checkout", () => {
  it("completes identity and planning without a source inventory", async () => {
    const readTextFile = vi.fn(async ({ path }: { path: string }) => {
      if (path.includes("source-files")) {
        throw new Error("Inventory must not be required");
      }
      return null;
    });
    const executor = vi.fn(fixtureTargetCommandExecutor());
    const sandbox = {
      readTextFile,
      removePath: vi.fn(async () => undefined),
      run: vi.fn(async ({ command }: { command: string }) => ({
        exitCode: command.startsWith("test -d") ? 1 : 0,
        stdout: "",
        stderr: "",
      })),
      writeTextFile: vi.fn(async () => undefined),
    } as unknown as SandboxSession;
    const result = await executeTargetIdentityAndPlanning({
      appId: "stock-exceptions",
      appSpecContent: "Stock Exceptions product design",
      appSpecDigest: "b".repeat(64),
      artifactRevision: "a".repeat(64),
      executor,
      sandbox,
    });
    expect(result.proposal.contract.appId).toBe("stock-exceptions");
    expect(executor.mock.calls.map(([request]) => request.command)).toEqual([
      "identity",
      "planning",
    ]);
  });

  it("runs creation planning when new-app drafts are supplied", async () => {
    const executor = vi.fn(fixtureTargetCommandExecutor());
    const sandbox = {
      removePath: vi.fn(async () => undefined),
      run: vi.fn(async ({ command }: { command: string }) => ({
        exitCode: command.startsWith("test -d") ? 1 : 0,
        stdout: "",
        stderr: "",
      })),
      writeTextFile: vi.fn(async () => undefined),
    } as unknown as SandboxSession;

    const result = await executeTargetIdentityAndPlanning({
      appId: "stock-exceptions",
      appSpecContent: "Stock Exceptions product design",
      appSpecDigest: "b".repeat(64),
      artifactRevision: "a".repeat(64),
      executor,
      existingAppChanges: [
        {
          path: "apps/stock-exceptions/app/page.tsx",
          content: "new component",
        },
      ],
      sandbox,
    });

    expect(result.proposal).not.toHaveProperty("operation");
    expect(executor.mock.calls.map(([request]) => request.command)).toEqual([
      "identity",
      "planning",
    ]);
  });

  it("plans explicit existing-app edits from the actual checkout", async () => {
    const before = Buffer.from("old component");
    const sandbox = {
      readBinaryFile: vi.fn(async () => before),
      readTextFile: vi.fn(async () => null),
      removePath: vi.fn(async () => undefined),
      run: vi.fn(async ({ command }: { command: string }) => ({
        exitCode: 0,
        stdout: command.startsWith("stat ") ? "755\n" : "",
        stderr: "",
      })),
      writeTextFile: vi.fn(async () => undefined),
    } as unknown as SandboxSession;
    const result = await executeTargetIdentityAndPlanning({
      appId: "vendor",
      appSpecContent: "Improve Vendor",
      appSpecDigest: "b".repeat(64),
      artifactRevision: "a".repeat(64),
      executor: fixtureTargetCommandExecutor(),
      existingAppChanges: [
        { path: "apps/vendor/app/page.tsx", content: "new component" },
      ],
      sandbox,
    });
    expect(result.proposal).toMatchObject({
      iteration: {
        changes: [
          {
            before: { mode: "755" },
            after: { mode: "755", content: "new component" },
          },
        ],
      },
      operation: "iterate-existing-app",
    });
    expect(sandbox.readBinaryFile).toHaveBeenCalledWith({
      path: "repository/apps/vendor/app/page.tsx",
    });
    expect(sandbox.readBinaryFile).not.toHaveBeenCalledWith({
      path: "repository/microfrontends.json",
    });
  });
  it.each([null, "invalid old inventory"])(
    "copies current files without requiring an inspection manifest (%s)",
    async (manifest) => {
      const run = vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: "" }));
      const readTextFile = vi.fn(async () => manifest);
      const writeTextFile = vi.fn(async () => {});
      const sandbox = {
        readTextFile,
        removePath: vi.fn(async () => undefined),
        run,
        writeTextFile,
      } as unknown as SandboxSession;

      const result = await materializePlanningOverlay({
        appId: "stock-exceptions",
        appSpecContent: "Stock Exceptions product design",
        appSpecDigest: "b".repeat(64),
        artifactRevision: "a".repeat(64),
        sandbox,
      });

      expect(readTextFile).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          command: expect.stringContaining("cp -R /workspace/repository/."),
        })
      );
      expect(result.planningRoot).toContain("/workspace/");
      expect(writeTextFile).toHaveBeenCalledWith(
        expect.objectContaining({ content: "Stock Exceptions product design" })
      );
    }
  );

  it("reports an actual checkout copy failure", async () => {
    const sandbox = {
      removePath: vi.fn(async () => undefined),
      run: vi.fn(async ({ command }: { command: string }) => ({
        exitCode: command.startsWith("cp ") ? 1 : 0,
        stdout: "",
        stderr: "",
      })),
      writeTextFile: vi.fn(async () => undefined),
    } as unknown as SandboxSession;

    await expect(
      materializePlanningOverlay({
        appId: "stock-exceptions",
        appSpecContent: "Stock Exceptions product design",
        appSpecDigest: "b".repeat(64),
        artifactRevision: "a".repeat(64),
        sandbox,
      })
    ).rejects.toThrow("source copy");
  });
});
