import { describe, expect, it, vi } from "vitest";

import { inspectCanonicalArrustedSandboxWorkspace } from "./arrusted-template";
import { inspectCanonicalTemplateSnapshotReceipt } from "./source-receipt";

describe("canonical Arrusted source preparation", () => {
  it("reuses the recorded session workspace without legacy reinspection", async () => {
    const receipt = inspectCanonicalTemplateSnapshotReceipt({
      snapshot: {
        sourcePath: "/workspace/repository",
        sourceSha: "a".repeat(40),
        sourceTree: "b".repeat(40),
        dirtyPaths: [],
        contents: {},
        contract: [],
      },
      readinessDigest: "c".repeat(64),
    });
    if (receipt.version !== 4) throw new Error("Expected cloned source fixture");
    const workspace = {
      workspaceId: "sandbox",
      workspacePath: "/workspace/repository",
      sourcePath: "/workspace/repository",
      sourceSha: receipt.sourceSha,
      sourceTree: receipt.sourceTree,
      workspaceDigest: "d".repeat(64),
      adapter: "arrusted-development-v0",
      eligibilityDigest: receipt.eligibilityDigest,
    } as const;
    const run = vi.fn();

    await expect(
      inspectCanonicalArrustedSandboxWorkspace({
        sandbox: {
          id: "sandbox",
          run,
          readTextFile: vi.fn(async () => JSON.stringify(workspace)),
        } as never,
        receipt,
      }),
    ).resolves.toEqual(workspace);
    expect(run).not.toHaveBeenCalled();
  });
});
