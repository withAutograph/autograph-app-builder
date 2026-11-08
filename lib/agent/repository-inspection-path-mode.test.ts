/* oxlint-disable typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- SAFETY: This fixture supplies only read-only tool context coordinates; all host and Sandbox ports are isolated by mocks. */
/* oxlint-disable anti-slop/no-module-mocking -- Isolate host and Sandbox ports to prove the real tool selects exactly one namespace before any I/O. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "eve/tools";
import type { inspectWorkspacePath } from "../repository/workspace-path-inspection";

import tool from "../../agent/tools/inspect_repository";

const mocks = vi.hoisted(() => ({
  host: vi.fn(),
  sandbox: vi.fn(),
  entry: vi.fn(),
  receipt: vi.fn(),
  development: vi.fn(),
  state: vi.fn(),
}));
vi.mock("eve/tools", () => ({ defineTool: <T>(value: T) => value }));
vi.mock("../repository/development-source", () => ({
  canAutoSelectDevelopmentSource: mocks.development,
  developmentSourceReceipt: mocks.receipt,
}));
vi.mock("../repository/supported-template", () => ({
  inspectSupportedRepository: mocks.host,
  prepareDevelopmentSandboxWorkspace: vi.fn(),
}));
vi.mock("./source-bound-sandbox", () => ({ getSourceBoundSandbox: mocks.sandbox }));
vi.mock("../repository/workspace-path-inspection", async (original) => ({
  ...(await original<{ inspectWorkspacePath: typeof inspectWorkspacePath }>()),
  inspectWorkspacePath: mocks.entry,
}));
vi.mock("./workflow-state", () => ({
  APP_BUILDER_WORKFLOW_VERSION: 17,
  appBuilderWorkflowState: { get: mocks.state },
  assertUpstreamMutationAllowed: vi.fn(),
  updateExactWorkflow: vi.fn(),
}));
vi.mock("./app-baseline-state", () => ({ appBaselineState: { get: vi.fn() } }));

// SAFETY: Only the listed immutable coordinates are consumed; all Sandbox and host I/O ports are mocked in this namespace-routing test.
const ctx = {
  abortSignal: new AbortController().signal,
  callId: "inspection",
  session: { auth: {}, id: "logical", turn: { id: "turn" } },
} as unknown as ToolContext;
const input = (path: string) => ({
  directoryOffset: undefined,
  mode: undefined,
  offsetBytes: undefined,
  path,
  pathIndex: undefined,
  paths: undefined,
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.development.mockReturnValue(true);
  mocks.state.mockReturnValue({ phase: "prepared" });
  mocks.sandbox.mockResolvedValue({ run: vi.fn(), readTextFile: vi.fn() });
  mocks.host.mockResolvedValue({ source: "host" });
  mocks.entry.mockResolvedValue({ entries: [], kind: "workspace-directory" });
  mocks.receipt.mockResolvedValue({ sourcePath: "/owned/source" });
});
describe("repository host versus virtual workspace path modes", () => {
  it.each(["/workspace/repository/packages", "/workspace/repository/packages/playwright-config"])(
    "routes %s only through current source-bound Sandbox",
    async (path) => {
      await tool.execute(input(path), ctx);
      expect(mocks.sandbox).toHaveBeenCalledOnce();
      expect(mocks.entry).toHaveBeenCalledWith(
        expect.objectContaining({ path, signal: ctx.abortSignal }),
      );
      expect(mocks.host).not.toHaveBeenCalled();
      expect(mocks.receipt).not.toHaveBeenCalled();
    },
  );
  it("keeps explicit allowed host repository inspection unchanged", async () => {
    expect(await tool.execute(input("/owned/other-repository"), ctx)).toEqual({ source: "host" });
    expect(mocks.host).toHaveBeenCalledWith("/owned/other-repository");
    expect(mocks.entry).not.toHaveBeenCalled();
  });
  it.each(["/workspace/repository", "/workspace/repository/"])(
    "keeps %s selecting the configured source overview",
    async (path) => {
      await tool.execute(input(path), ctx);
      expect(mocks.host).toHaveBeenCalledWith("/owned/source");
      expect(mocks.entry).not.toHaveBeenCalled();
    },
  );
  it("rejects virtual traversal instead of falling through to a host path", async () => {
    await expect(tool.execute(input("/workspace/repository/../outside"), ctx)).rejects.toThrow(
      "stay inside",
    );
    expect(mocks.host).not.toHaveBeenCalled();
    expect(mocks.sandbox).not.toHaveBeenCalled();
  });
  it("does not silently apply a directory cursor to a host overview or file batch", async () => {
    const requests = [
      { ...input("/owned/source"), directoryOffset: 2 },
      { ...input("/workspace/repository/packages"), directoryOffset: 2, paths: ["README.md"] },
    ];
    await Promise.all(
      requests.map(async (value) => {
        await expect(tool.execute(value, ctx)).rejects.toThrow("Directory continuation");
      }),
    );
    expect(mocks.host).not.toHaveBeenCalled();
    expect(mocks.entry).not.toHaveBeenCalled();
  });
  it("explicit repository mode preserves a real host root inside the virtual-looking namespace", async () => {
    await tool.execute(
      { ...input("/workspace/repository/owned-host-root"), mode: "repository" },
      ctx,
    );
    expect(mocks.host).toHaveBeenCalledWith("/workspace/repository/owned-host-root");
    expect(mocks.entry).not.toHaveBeenCalled();
  });
  it("explicit workspace mode inspects the root directory and never falls back to the host", async () => {
    await tool.execute({ ...input("/workspace/repository"), mode: "workspace" }, ctx);
    expect(mocks.entry).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/workspace/repository" }),
    );
    await expect(
      tool.execute({ ...input("/owned/source"), mode: "workspace" }, ctx),
    ).rejects.toThrow("stay inside");
    expect(mocks.host).not.toHaveBeenCalled();
  });
  it("rejects conflicting repository mode and workspace file paths", async () => {
    await expect(
      tool.execute({ ...input("/owned/source"), mode: "repository", paths: ["README.md"] }, ctx),
    ).rejects.toThrow("conflict");
    expect(mocks.host).not.toHaveBeenCalled();
    expect(mocks.entry).not.toHaveBeenCalled();
  });
});
