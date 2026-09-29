import { beforeEach, describe, expect, it, vi } from "vitest";
import prepareWorkspace from "../../agent/tools/prepare_workspace";

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  guard: vi.fn(),
  source: { phase: "empty" } as { phase: string; receipt?: Record<string, unknown> },
  update: vi.fn(),
  workspace: { workspaceId: "sandbox", workspacePath: "/workspace/repository" },
}));
vi.mock("eve/tools", () => ({ defineTool: (value: unknown) => value }));
vi.mock("../../agent/tools/source_status", () => ({ default: { execute: mocks.acquire } }));
vi.mock("./source-state", () => ({ sourceWorkflowState: { get: () => mocks.source } }));
vi.mock("./workflow-state", () => ({
  APP_BUILDER_WORKFLOW_VERSION: 17,
  appBuilderWorkflowState: { get: () => ({ phase: "empty" }) },
  assertUpstreamMutationAllowed: mocks.guard,
  updateExactWorkflow: mocks.update,
  workflowWorkspace: () => {},
}));
vi.mock("../repository/development-source", () => ({
  canAutoSelectDevelopmentSource: () => false,
}));
vi.mock("../repository/github-publication", () => ({
  assertExactImmutableGitHubSourceReceipt: vi.fn(),
}));
vi.mock("../repository/source-receipt", () => ({ SOURCE_RECEIPT_VERSION: 4 }));
vi.mock("../repository/supported-template", () => ({
  prepareDevelopmentSandboxWorkspace: vi.fn(),
  prepareSupportedSandboxWorkspace: vi.fn(),
  readPreparedSandboxWorkspaceRecord: () => Promise.resolve(mocks.workspace),
}));
vi.mock("../repository/sandbox-github-source", () => ({
  inspectGitHubSourceSandboxWorkspace: vi.fn(),
}));

const selectedSource = () => ({
  phase: "reviewed",
  receipt: { sourcePath: "/workspace/repository", version: 4 },
});
const execute = () =>
  prepareWorkspace.execute({}, {
    callId: "prepare",
    getSandbox: () => Promise.resolve({ id: "sandbox" }),
  } as Parameters<typeof prepareWorkspace.execute>[1]);

describe("hosted workspace source acquisition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.guard.mockReset();
    mocks.source = { phase: "empty" };
    mocks.acquire.mockImplementation(() => {
      mocks.source = selectedSource();
      return Promise.resolve(mocks.source);
    });
  });
  it("requires hosted source selection before preparing a workspace", async () => {
    await expect(execute()).rejects.toThrow("Select the app source first");
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("preserves an already selected source without reacquiring the starter", async () => {
    const selected = selectedSource();
    mocks.source = selected;
    await expect(execute()).resolves.toEqual(mocks.workspace);
    expect(mocks.source).toBe(selected);
    expect(mocks.acquire).not.toHaveBeenCalled();
  });
  it("retains the mutation authority check before source acquisition", async () => {
    mocks.guard.mockImplementation(() => {
      throw new Error("publication in progress");
    });
    await expect(execute()).rejects.toThrow("publication in progress");
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
