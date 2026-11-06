import type { SandboxSession } from "eve/sandbox";

import { describe, expect, it, vi } from "vitest";

import type { PreparedSandboxWorkspace } from "../repository/supported-template";
import type { SourceReceipt } from "../repository/source-receipt";
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
  adapter: workspace.adapter,
  contractDigest: "e".repeat(64),
  digest: "f".repeat(64),
  eligibilityDigest: workspace.eligibilityDigest,
  releaseEnabled: false,
  sourceKind: "fresh-template",
  sourcePath: "/workspace/repository",
  sourceSha: workspace.sourceSha,
  sourceTree: workspace.sourceTree,
  version: 3,
} satisfies SourceReceipt;

const dependencies = () => ({
  inspectSourceBoundSandboxWorkspace: vi.fn(async () => {}),
  readPreparedSandboxSourceManifest: vi.fn(async () => [{
    mode: "100644",
    objectId: "2".repeat(40),
    path: "assets/payload.bin",
    sha256: "3".repeat(64),
  }]),
});

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function sandboxFixture() {
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  const readBinaryFile = vi.fn(async ({ path }: { path: string }) =>
    path === "repository/assets/payload.bin" ? Buffer.from([0, 255, 17, 128]) : null,
  );
  const readFile = vi.fn(async ({ path }: { path: string }) => {
    await Promise.resolve();
    return path === "repository/assets/payload.bin"
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.from([0, 255]));
            controller.enqueue(Uint8Array.from([17, 128]));
            controller.close();
          },
        })
      : null;
  });
  const sandbox: SandboxSession = {
    description: "test sandbox",
    readBinaryFile,
    readFile,
    readTextFile: async () => null,
    removePath: async () => {},
    resolvePath: (path) => path,
    run: async () => ({ exitCode: 0, stderr: "", stdout: "" }),
    spawn: async () => { throw new Error("Unexpected sandbox process spawn"); },
    writeBinaryFile: async () => {},
    writeFile: async () => {},
    writeTextFile: async () => {},
  };
  return {
    readBinaryFile,
    readFile,
    sandbox,
  };
}

describe("fresh bootstrap source workspace", () => {
  it("leaves legacy V3 receipts on the host-source path without sandbox access", async () => {
    const { readBinaryFile, sandbox } = sandboxFixture();
    const deps = dependencies();

    await expect(
      freshBootstrapSourceWorkspace({
        receipt: legacyReceipt,
        sandbox,
        workspace,
        dependencies: deps,
      }),
    ).resolves.toBeUndefined();

    expect(deps.inspectSourceBoundSandboxWorkspace).not.toHaveBeenCalled();
    expect(deps.readPreparedSandboxSourceManifest).not.toHaveBeenCalled();
    expect(readBinaryFile).not.toHaveBeenCalled();
  });

  it("re-verifies V4 canonical state before reading its prepared manifest", async () => {
    const calls: string[] = [];
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const deps = dependencies();
    deps.inspectSourceBoundSandboxWorkspace.mockImplementation(async () => {
      calls.push("reverify");
    });
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    deps.readPreparedSandboxSourceManifest.mockImplementation(async () => {
      calls.push("manifest");
      return [];
    });
    const { sandbox } = sandboxFixture();

    const source = await freshBootstrapSourceWorkspace({
      receipt: canonicalReceipt,
      sandbox,
      workspace,
      dependencies: deps,
    });

    expect(source).toBeDefined();
    expect(calls).toEqual(["reverify", "manifest"]);
    expect(deps.inspectSourceBoundSandboxWorkspace).toHaveBeenCalledWith({
      expectedWorkspace: workspace,
      receipt: canonicalReceipt,
      sandbox,
    });
    expect(deps.readPreparedSandboxSourceManifest).toHaveBeenCalledWith(sandbox, workspace);
  });

  it("reads repository-relative source paths as binary data", async () => {
    const { readBinaryFile, readFile, sandbox } = sandboxFixture();
    const deps = dependencies();
    const source = await freshBootstrapSourceWorkspace({
      receipt: canonicalReceipt,
      sandbox,
      workspace,
      dependencies: deps,
    });

    await expect(source?.readSourceFile("assets/payload.bin")).resolves.toEqual(
      Buffer.from([0, 255, 17, 128]),
    );
    expect(readBinaryFile).toHaveBeenCalledWith({
      path: "repository/assets/payload.bin",
    });
    const stream = await source?.readSourceFileStream?.("assets/payload.bin");
    expect(stream).not.toBeNull();
    const reader = stream?.getReader();
    expect(await reader?.read()).toMatchObject({ value: Uint8Array.from([0, 255]) });
    expect(await reader?.read()).toMatchObject({ value: Uint8Array.from([17, 128]) });
    expect(readFile).toHaveBeenCalledWith({ path: "repository/assets/payload.bin" });
  });

  it("fails closed when initial canonical re-verification fails", async () => {
    const reverifyError = new Error("canonical workspace drifted");
    const deps = dependencies();
    deps.inspectSourceBoundSandboxWorkspace.mockRejectedValue(reverifyError);
    const { readBinaryFile, sandbox } = sandboxFixture();

    await expect(
      freshBootstrapSourceWorkspace({
        receipt: canonicalReceipt,
        sandbox,
        workspace,
        dependencies: deps,
      }),
    ).rejects.toBe(reverifyError);
    expect(deps.readPreparedSandboxSourceManifest).not.toHaveBeenCalled();
    expect(readBinaryFile).not.toHaveBeenCalled();
  });

  it("fails closed when the prepared manifest cannot be read", async () => {
    const manifestError = new Error("prepared manifest drifted");
    const deps = dependencies();
    deps.readPreparedSandboxSourceManifest.mockRejectedValue(manifestError);
    const { readBinaryFile, sandbox } = sandboxFixture();

    await expect(
      freshBootstrapSourceWorkspace({
        receipt: canonicalReceipt,
        sandbox,
        workspace,
        dependencies: deps,
      }),
    ).rejects.toBe(manifestError);
    expect(deps.inspectSourceBoundSandboxWorkspace).toHaveBeenCalledOnce();
    expect(readBinaryFile).not.toHaveBeenCalled();
  });

  it("propagates drift discovered by the returned re-verification hook", async () => {
    const { sandbox } = sandboxFixture();
    const deps = dependencies();
    const source = await freshBootstrapSourceWorkspace({
      receipt: canonicalReceipt,
      sandbox,
      workspace,
      dependencies: deps,
    });
    const driftError = new Error("canonical workspace changed after capture");
    deps.inspectSourceBoundSandboxWorkspace.mockRejectedValueOnce(driftError);

    await expect(source?.reverify()).rejects.toBe(driftError);
  });
});
