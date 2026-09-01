import type { SandboxSession } from "eve/sandbox";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PreparedSandboxWorkspace } from "../repository/supported-template";
import type { SourceReceipt } from "../repository/source-receipt";

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
  workspaceId: "workspace-canonical",
  workspacePath: "/workspace/repository",
  sourcePath: "/workspace/repository",
  sourceSha: "a".repeat(40),
  sourceTree: "b".repeat(40),
  workspaceDigest: "c".repeat(64),
  adapter: "arrusted-development-v0",
  eligibilityDigest: "d".repeat(64),
};

const canonicalReceipt = {
  version: 4,
  sourceKind: "fresh-template",
  sourcePath: "/workspace/repository",
  sourceSha: workspace.sourceSha,
  sourceTree: workspace.sourceTree,
  adapter: workspace.adapter,
  eligibilityDigest: workspace.eligibilityDigest,
  contractDigest: "e".repeat(64),
  releaseEnabled: false,
  digest: "f".repeat(64),
  provenance: {
    repository: "https://github.com/withAutograph/arrusted-development.git",
    ref: "refs/heads/main",
    method: "git-clone-v1",
    readinessDigest: "1".repeat(64),
  },
} satisfies SourceReceipt;

const legacyReceipt = {
  ...canonicalReceipt,
  version: 3,
  provenance: undefined,
} as unknown as SourceReceipt;

function sandboxFixture() {
  const readBinaryFile = vi.fn(async ({ path }: { path: string }) =>
    path === "repository/assets/payload.bin"
      ? Buffer.from([0, 255, 17, 128])
      : null,
  );
  return {
    readBinaryFile,
    sandbox: { readBinaryFile } as unknown as SandboxSession,
  };
}

describe("fresh bootstrap source workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inspectSourceBoundSandboxWorkspace.mockResolvedValue(undefined);
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
        sandbox,
        receipt: legacyReceipt,
        workspace,
      }),
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
      sandbox,
      receipt: canonicalReceipt,
      workspace,
    });

    expect(source).toBeDefined();
    expect(calls).toEqual(["reverify", "manifest"]);
    expect(mocks.inspectSourceBoundSandboxWorkspace).toHaveBeenCalledWith({
      sandbox,
      receipt: canonicalReceipt,
      expectedWorkspace: workspace,
    });
    expect(mocks.readPreparedSandboxSourceManifest).toHaveBeenCalledWith(
      sandbox,
      workspace,
    );
  });

  it("reads repository-relative source paths as binary data", async () => {
    const { readBinaryFile, sandbox } = sandboxFixture();
    const source = await freshBootstrapSourceWorkspace({
      sandbox,
      receipt: canonicalReceipt,
      workspace,
    });

    await expect(source?.readSourceFile("assets/payload.bin")).resolves.toEqual(
      Buffer.from([0, 255, 17, 128]),
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
        sandbox,
        receipt: canonicalReceipt,
        workspace,
      }),
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
        sandbox,
        receipt: canonicalReceipt,
        workspace,
      }),
    ).rejects.toBe(manifestError);
    expect(mocks.inspectSourceBoundSandboxWorkspace).toHaveBeenCalledOnce();
    expect(readBinaryFile).not.toHaveBeenCalled();
  });

  it("propagates drift discovered by the returned re-verification hook", async () => {
    const { sandbox } = sandboxFixture();
    const source = await freshBootstrapSourceWorkspace({
      sandbox,
      receipt: canonicalReceipt,
      workspace,
    });
    const driftError = new Error("canonical workspace changed after capture");
    mocks.inspectSourceBoundSandboxWorkspace.mockRejectedValueOnce(driftError);

    await expect(source?.reverify()).rejects.toBe(driftError);
  });
});
