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
      if (path.includes("source-files")) throw new Error("Inventory must not be required");
      return null;
    });
    const executor = vi.fn(fixtureTargetCommandExecutor());
    const sandbox = {
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      run: vi.fn(async ({ command }: { command: string }) => ({
        exitCode: command.startsWith("test -d") ? 1 : 0,
        stdout: "",
        stderr: "",
      })),
      readTextFile,
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      writeTextFile: vi.fn(async () => undefined),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      removePath: vi.fn(async () => undefined),
    } as unknown as SandboxSession;
    const result = await executeTargetIdentityAndPlanning({
      sandbox,
      executor,
      appId: "stock-exceptions",
      artifactRevision: "a".repeat(64),
      appSpecDigest: "b".repeat(64),
      appSpecContent: "Stock Exceptions product design",
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
      run: vi.fn(async ({ command }: { command: string }) => ({
        exitCode: command.startsWith("test -d") ? 1 : 0,
        stdout: "",
        stderr: "",
      })),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      writeTextFile: vi.fn(async () => undefined),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      removePath: vi.fn(async () => undefined),
    } as unknown as SandboxSession;

    const result = await executeTargetIdentityAndPlanning({
      sandbox,
      executor,
      appId: "stock-exceptions",
      artifactRevision: "a".repeat(64),
      appSpecDigest: "b".repeat(64),
      appSpecContent: "Stock Exceptions product design",
      existingAppChanges: [
        {
          path: "apps/stock-exceptions/app/page.tsx",
          content: "new component",
        },
      ],
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
      run: vi.fn(async ({ command }: { command: string }) => ({
        exitCode: 0,
        stdout: command.startsWith("stat ") ? "755\n" : "",
        stderr: "",
      })),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      readTextFile: vi.fn(async () => null),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      readBinaryFile: vi.fn(async () => before),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      writeTextFile: vi.fn(async () => undefined),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      removePath: vi.fn(async () => undefined),
    } as unknown as SandboxSession;
    const result = await executeTargetIdentityAndPlanning({
      sandbox,
      executor: fixtureTargetCommandExecutor(),
      appId: "vendor",
      artifactRevision: "a".repeat(64),
      appSpecDigest: "b".repeat(64),
      appSpecContent: "Improve Vendor",
      existingAppChanges: [{ path: "apps/vendor/app/page.tsx", content: "new component" }],
    });
    expect(result.proposal).toMatchObject({
      operation: "iterate-existing-app",
      iteration: {
        changes: [
          {
            before: { mode: "755" },
            after: { mode: "755", content: "new component" },
          },
        ],
      },
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
      const run = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      const readTextFile = vi.fn(async () => manifest);
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      const writeTextFile = vi.fn(async () => undefined);
      const sandbox = {
        run,
        readTextFile,
        writeTextFile,
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
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
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      run: vi.fn(async ({ command }: { command: string }) => ({
        exitCode: command.startsWith("cp ") ? 1 : 0,
        stdout: "",
        stderr: "",
      })),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      writeTextFile: vi.fn(async () => undefined),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
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
