import { describe, expect, it, vi } from "vitest";

import { inspectCanonicalArrustedSandboxWorkspace } from "./arrusted-template";
import { inspectCanonicalTemplateSnapshotReceipt } from "./source-receipt";

describe("canonical Arrusted source preparation", () => {
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
          run,
          readTextFile: vi.fn(async () => JSON.stringify(workspace)),
        } as never,
      })
    ).resolves.toEqual(workspace);
    expect(run).not.toHaveBeenCalled();
  });
});
