import { describe, expect, it, vi } from "vitest";
import type { SandboxSession } from "eve/sandbox";

import {
  executeTargetIdentityAndPlanning,
  fixtureTargetCommandExecutor,
  materializePlanningOverlay,
} from "./target-planning";

describe("planning from the current checkout", () => {
  it("completes identity and planning without a source inventory", async () => {
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const readTextFile = vi.fn(async ({ path }: { path: string }) => {
      if (path.includes("source-files")) {
        throw new Error("Inventory must not be required");
      }
      return null;
    });
    const executor = vi.fn(fixtureTargetCommandExecutor());
    const sandbox = {
      readTextFile,
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      removePath: vi.fn(async () => {}),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      run: vi.fn(async ({ command }: { command: string }) => ({
        exitCode: command.startsWith("test -d") ? 1 : 0,
        stderr: "",
        stdout: "",
      })),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      writeTextFile: vi.fn(async () => {}),
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
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      removePath: vi.fn(async () => {}),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      run: vi.fn(async ({ command }: { command: string }) => ({
        exitCode: command.startsWith("test -d") ? 1 : 0,
        stderr: "",
        stdout: "",
      })),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      writeTextFile: vi.fn(async () => {}),
    } as unknown as SandboxSession;

    const result = await executeTargetIdentityAndPlanning({
      appId: "stock-exceptions",
      appSpecContent: "Stock Exceptions product design",
      appSpecDigest: "b".repeat(64),
      artifactRevision: "a".repeat(64),
      executor,
      existingAppChanges: [
        {
          content: "new component",
          path: "apps/stock-exceptions/app/page.tsx",
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
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      readBinaryFile: vi.fn(async () => before),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      readTextFile: vi.fn(async () => null),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      removePath: vi.fn(async () => {}),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      run: vi.fn(async ({ command }: { command: string }) => ({
        exitCode: 0,
        stderr: "",
        stdout: command.startsWith("stat ") ? "755\n" : "",
      })),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      writeTextFile: vi.fn(async () => {}),
    } as unknown as SandboxSession;
    const result = await executeTargetIdentityAndPlanning({
      appId: "vendor",
      appSpecContent: "Improve Vendor",
      appSpecDigest: "b".repeat(64),
      artifactRevision: "a".repeat(64),
      executor: fixtureTargetCommandExecutor(),
      existingAppChanges: [{ content: "new component", path: "apps/vendor/app/page.tsx" }],
      sandbox,
    });
    expect(result.proposal).toMatchObject({
      iteration: {
        changes: [
          {
            after: { content: "new component", mode: "755" },
            before: { mode: "755" },
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
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      const run = vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: "" }));
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      const readTextFile = vi.fn(async () => manifest);
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      const writeTextFile = vi.fn(async () => {});
      const sandbox = {
        readTextFile,
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        removePath: vi.fn(async () => {}),
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
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      removePath: vi.fn(async () => {}),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      run: vi.fn(async ({ command }: { command: string }) => ({
        exitCode: command.startsWith("cp ") ? 1 : 0,
        stderr: "",
        stdout: "",
      })),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      writeTextFile: vi.fn(async () => {}),
    } as unknown as SandboxSession;

    await expect(
      materializePlanningOverlay({
        appId: "stock-exceptions",
        appSpecContent: "Stock Exceptions product design",
        appSpecDigest: "b".repeat(64),
        artifactRevision: "a".repeat(64),
        sandbox,
      }),
    ).rejects.toThrow("source copy");
  });
});
