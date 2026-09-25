import { describe, expect, it, vi } from "vitest";

import {
  acquireCanonicalArrustedTemplate,
  inspectCanonicalArrustedSandboxWorkspace,
} from "./arrusted-template";
import { inspectCanonicalTemplateSnapshotReceipt } from "./source-receipt";

describe("canonical Arrusted source preparation", () => {
  it("uses the provider-created starter checkout once", async () => {
    const sourceSha = "a".repeat(40);
    const sourceTree = "b".repeat(40);
    const commands: string[] = [];
    const written: string[] = [];
    const run = vi.fn(async ({ command }: { command: string }) => {
      await Promise.resolve();
      commands.push(command);
      return {
        exitCode: command.startsWith("test -L ") ? 1 : 0,
        stderr: "",
        stdout: command.includes("rev-parse")
          ? `${sourceSha}\n${sourceTree}\nhttps://github.com/withAutograph/arrusted-development.git\n`
          : "",
      };
    });
    const receipt = await acquireCanonicalArrustedTemplate({
      callId: "prepare",
      reader: { acquire: async () => await Promise.resolve({ token: "test-token" }) },
      sandbox: {
        id: "sandbox",
        readTextFile: async () => await Promise.resolve(null),
        run,
        writeTextFile: async ({ path }: { path: string }) => {
          await Promise.resolve();
          written.push(path);
        },
      } as never,
    });
    expect(receipt.sourceKind).toBe("fresh-template");
    expect(commands.some((command) => command.includes("git clone"))).toBe(false);
    expect(written).toContain(".app-builder/prepare-intent.json");
  });

  it("reuses the recorded session workspace without legacy reinspection", async () => {
    const receipt = inspectCanonicalTemplateSnapshotReceipt({
      readinessDigest: "c".repeat(64),
      snapshot: {
        contents: {},
        contract: [],
        dirtyPaths: [],
        sourcePath: "/workspace/repository",
        sourceSha: "a".repeat(40),
        sourceTree: "b".repeat(40),
      },
    });
    if (receipt.version !== 4) {
      throw new Error("Expected cloned source fixture");
    }
    const workspace = {
      adapter: "arrusted-development-v0",
      eligibilityDigest: receipt.eligibilityDigest,
      sourcePath: "/workspace/repository",
      sourceSha: receipt.sourceSha,
      sourceTree: receipt.sourceTree,
      workspaceDigest: "d".repeat(64),
      workspaceId: "sandbox",
      workspacePath: "/workspace/repository",
    } as const;
    const run = vi.fn();

    await expect(
      inspectCanonicalArrustedSandboxWorkspace({
        receipt,
        sandbox: {
          id: "sandbox",
          // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
          readTextFile: vi.fn(async () => JSON.stringify(workspace)),
          run,
        } as never,
      }),
    ).resolves.toEqual(workspace);
    expect(run).not.toHaveBeenCalled();
  });
});
