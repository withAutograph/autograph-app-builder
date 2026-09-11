import type { SandboxSession } from "eve/sandbox";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SourceReceipt } from "../repository/source-receipt";
import type { PreparedSandboxWorkspace } from "../repository/supported-template";

const mocks = vi.hoisted(() => ({
  inspectSourceBoundSandboxWorkspace: vi.fn(),
  readPreparedSandboxSourceManifest: vi.fn(),
}));

vi.mock("../repository/arrusted-template", () => ({
  inspectSourceBoundSandboxWorkspace: mocks.inspectSourceBoundSandboxWorkspace,
}));

vi.mock("../repository/supported-template", () => ({
  readPreparedSandboxSourceManifest: mocks.readPreparedSandboxSourceManifest,
}));

import { freshBootstrapSourceWorkspace } from "./fresh-bootstrap-source";

const workspace: PreparedSandboxWorkspace = {
  adapter: "arrusted-development-v0",
  eligibilityDigest: "d".repeat(64),
  sourcePath: "/workspace/repository",
  sourceSha: "a".repeat(40),
  sourceTree: "b".repeat(40),
  workspaceDigest: "c".repeat(64),
  workspaceId: "workspace-canonical",
  workspacePath: "/workspace/repository",
};

const canonicalReceipt = {
  adapter: workspace.adapter,
  contractDigest: "e".repeat(64),
  digest: "f".repeat(64),
  eligibilityDigest: workspace.eligibilityDigest,
  provenance: {
    method: "git-clone-v1",
    readinessDigest: "1".repeat(64),
    ref: "refs/heads/main",
    repository: "https://github.com/withAutograph/arrusted-development.git",
  },
  releaseEnabled: false,
  sourceKind: "fresh-template",
  sourcePath: "/workspace/repository",
  sourceSha: workspace.sourceSha,
  sourceTree: workspace.sourceTree,
  version: 4,
} satisfies SourceReceipt;

const legacyReceipt = {
  ...canonicalReceipt,
  provenance: undefined,
  version: 3,
} as unknown as SourceReceipt;

function sandboxFixture() {
  const readBinaryFile = vi.fn(async ({ path }: { path: string }) =>
    path === "repository/assets/payload.bin"
      ? Buffer.from([0, 255, 17, 128])
      : null
  );
  return {
    readBinaryFile,
    sandbox: { readBinaryFile } as unknown as SandboxSession,
  };
}

describe("fresh bootstrap source workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inspectSourceBoundSandboxWorkspace.mockResolvedValue();
    mocks.readPreparedSandboxSourceManifest.mockResolvedValue([
      {
        mode: "100644",
        objectId: "2".repeat(40),
        path: "assets/payload.bin",
        sha256: "3".repeat(64),
      },
    ]);
  });

  it("leaves legacy V3 receipts on the host-source path without sandbox access", async () => {
    const { readBinaryFile, sandbox } = sandboxFixture();

    await expect(
      freshBootstrapSourceWorkspace({
        receipt: legacyReceipt,
        sandbox,
        workspace,
      })
    ).resolves.toBeUndefined();

    expect(mocks.inspectSourceBoundSandboxWorkspace).not.toHaveBeenCalled();
    expect(mocks.readPreparedSandboxSourceManifest).not.toHaveBeenCalled();
    expect(readBinaryFile).not.toHaveBeenCalled();
  });

  it("re-verifies V4 canonical state before reading its prepared manifest", async () => {
    const calls: string[] = [];
    mocks.inspectSourceBoundSandboxWorkspace.mockImplementation(async () => {
      calls.push("reverify");
    });
    mocks.readPreparedSandboxSourceManifest.mockImplementation(async () => {
      calls.push("manifest");
      return [];
    });
    const { sandbox } = sandboxFixture();

    const source = await freshBootstrapSourceWorkspace({
      receipt: canonicalReceipt,
      sandbox,
      workspace,
    });

    expect(source).toBeDefined();
    expect(calls).toEqual(["reverify", "manifest"]);
    expect(mocks.inspectSourceBoundSandboxWorkspace).toHaveBeenCalledWith({
      expectedWorkspace: workspace,
      receipt: canonicalReceipt,
      sandbox,
    });
    expect(mocks.readPreparedSandboxSourceManifest).toHaveBeenCalledWith(
      sandbox,
      workspace
    );
  });

  it("reads repository-relative source paths as binary data", async () => {
    const { readBinaryFile, sandbox } = sandboxFixture();
    const source = await freshBootstrapSourceWorkspace({
      receipt: canonicalReceipt,
      sandbox,
      workspace,
    });

    await expect(source?.readSourceFile("assets/payload.bin")).resolves.toEqual(
      Buffer.from([0, 255, 17, 128])
    );
    expect(readBinaryFile).toHaveBeenCalledWith({
      path: "repository/assets/payload.bin",
    });
  });

  it("fails closed when initial canonical re-verification fails", async () => {
    const reverifyError = new Error("canonical workspace drifted");
    mocks.inspectSourceBoundSandboxWorkspace.mockRejectedValue(reverifyError);
    const { readBinaryFile, sandbox } = sandboxFixture();

    await expect(
      freshBootstrapSourceWorkspace({
        receipt: canonicalReceipt,
        sandbox,
        workspace,
      })
    ).rejects.toBe(reverifyError);
    expect(mocks.readPreparedSandboxSourceManifest).not.toHaveBeenCalled();
    expect(readBinaryFile).not.toHaveBeenCalled();
  });

  it("fails closed when the prepared manifest cannot be read", async () => {
    const manifestError = new Error("prepared manifest drifted");
    mocks.readPreparedSandboxSourceManifest.mockRejectedValue(manifestError);
    const { readBinaryFile, sandbox } = sandboxFixture();

    await expect(
      freshBootstrapSourceWorkspace({
        receipt: canonicalReceipt,
        sandbox,
        workspace,
      })
    ).rejects.toBe(manifestError);
    expect(mocks.inspectSourceBoundSandboxWorkspace).toHaveBeenCalledOnce();
    expect(readBinaryFile).not.toHaveBeenCalled();
  });

  it("propagates drift discovered by the returned re-verification hook", async () => {
    const { sandbox } = sandboxFixture();
    const source = await freshBootstrapSourceWorkspace({
      receipt: canonicalReceipt,
      sandbox,
      workspace,
    });
    const driftError = new Error("canonical workspace changed after capture");
    mocks.inspectSourceBoundSandboxWorkspace.mockRejectedValueOnce(driftError);

    await expect(source?.reverify()).rejects.toBe(driftError);
  });
});
