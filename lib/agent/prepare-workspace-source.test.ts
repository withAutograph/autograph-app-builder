import { beforeEach, describe, expect, it, vi } from "vitest";
import type { repositoryAccessReceiptSchema } from "./repository-access-state";
import prepareWorkspace from "../../agent/tools/prepare_workspace";

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  getSandbox: vi.fn(),
  guard: vi.fn(),
  inspectGitHub: vi.fn(),
  repositoryAccess: vi.fn(),
  source: { phase: "empty" } as {
    phase: string;
    receipt?: Record<string, unknown>;
    githubSource?: Record<string, unknown>;
  },
  update: vi.fn(),
  workflow: { phase: "empty" } as {
    phase: string;
    githubSource?: Record<string, unknown>;
    sourceReceipt?: Record<string, unknown>;
    workspace?: Record<string, unknown>;
  },
  workspace: { workspaceId: "sandbox", workspacePath: "/workspace/repository" },
}));
vi.mock("eve/tools", () => ({ defineTool: (value: unknown) => value }));
vi.mock("./source-bound-sandbox", () => ({
  getSourceBoundSandbox: async (ctx: { getSandbox: () => Promise<{ id: string }> }) =>
    await ctx.getSandbox(),
}));
vi.mock("../../agent/tools/source_status", () => ({ default: { execute: mocks.acquire } }));
vi.mock("./source-state", () => ({ sourceWorkflowState: { get: () => mocks.source } }));
vi.mock("./repository-access-state", async (importOriginal) => {
  const original = await importOriginal<{
    repositoryAccessReceiptSchema: typeof repositoryAccessReceiptSchema;
  }>();
  return { ...original, repositoryAccessReceiptState: { get: mocks.repositoryAccess } };
});
vi.mock("./workflow-state", () => ({
  APP_BUILDER_WORKFLOW_VERSION: 17,
  appBuilderWorkflowState: { get: () => mocks.workflow },
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
  inspectGitHubSourceSandboxWorkspace: mocks.inspectGitHub,
}));

const selectedSource = () => ({
  phase: "reviewed",
  receipt: { sourcePath: "/workspace/repository", version: 4 },
});
const execute = () =>
  prepareWorkspace.execute(
    {},
    {
      abortSignal: new AbortController().signal,
      callId: "prepare",
      getSandbox: mocks.getSandbox,
      getToken: vi.fn(),
      requireAuth: (): never => {
        throw new Error("Unexpected auth request");
      },
      session: {
        auth: { current: null, initiator: null },
        id: "session",
        turn: { id: "turn", sequence: 0 },
      },
      toolName: "prepare_workspace",
    },
  );

describe("hosted workspace source acquisition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.guard.mockReset();
    mocks.getSandbox.mockReset().mockResolvedValue({ id: "sandbox" });
    mocks.repositoryAccess.mockReset();
    mocks.source = { phase: "empty" };
    mocks.workflow = { phase: "empty" };
    mocks.inspectGitHub.mockResolvedValue(mocks.workspace);
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
  it("prepares the original GitHub checkout after source inspection lost its GitHub slot", async () => {
    const githubSource = {
      digest: "accepted-source",
      repository: { repositoryId: "owned" },
      resolvedRef: "refs/heads/main",
    };
    mocks.source = selectedSource();
    mocks.workflow = { githubSource, phase: "applied" };
    await expect(execute()).resolves.toEqual(mocks.workspace);
    expect(mocks.inspectGitHub).toHaveBeenCalledWith({ githubSource, sandbox: { id: "sandbox" } });
    expect(mocks.acquire).not.toHaveBeenCalled();
  });
  it("retains accepted binding when the same branch has newer source metadata", async () => {
    const githubSource = {
      digest: "accepted-source",
      repository: { repositoryId: "owned" },
      resolvedRef: "refs/heads/main",
    };
    mocks.source = {
      ...selectedSource(),
      githubSource: { ...githubSource, digest: "new-head-observation" },
    };
    mocks.workflow = { githubSource, phase: "applied" };
    await expect(execute()).resolves.toEqual(mocks.workspace);
    expect(mocks.inspectGitHub).toHaveBeenCalledWith({ githubSource, sandbox: { id: "sandbox" } });
  });
  it("rejects a genuinely different repository or branch before opening the checkout", async () => {
    const githubSource = {
      digest: "accepted-source",
      repository: { repositoryId: "owned" },
      resolvedRef: "refs/heads/main",
    };
    mocks.workflow = { githubSource, phase: "applied" };
    mocks.source = {
      ...selectedSource(),
      githubSource: { ...githubSource, resolvedRef: "refs/heads/another" },
    };
    await expect(execute()).rejects.toThrow("different GitHub repositories or branches");
    expect(mocks.inspectGitHub).not.toHaveBeenCalled();
  });
  it("blocks a lost accepted binding without saved access before opening the checkout", async () => {
    const githubSource = {
      digest: "saved-source",
      repository: { name: "app", owner: "example", repositoryId: "owned" },
      resolvedByCallId: "original-resolution",
      resolvedRef: "refs/heads/main",
      resolvedSha: "saved-sha",
      resolvedTree: "saved-tree",
    };
    const receipt = {
      digest: "original-receipt",
      sourceSha: "saved-sha",
      sourceTree: "saved-tree",
      version: 3,
    };
    mocks.source = { githubSource, phase: "reviewed", receipt };
    // SAFETY: this harness deliberately retains only fields read by the binding guard.
    mocks.workflow = {
      phase: "applied",
      sourceReceipt: receipt,
      workspace: { sourceSha: "saved-sha", sourceTree: "saved-tree", workspaceId: "sandbox" },
    };
    const diagnostic = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(execute()).rejects.toMatchObject({
        code: "saved_github_binding_provenance_unavailable",
        diagnostics: { accessReceiptPresent: false, stage: "prepare-workspace" },
      });
      expect(mocks.repositoryAccess).toHaveBeenCalledOnce();
      expect(mocks.getSandbox).not.toHaveBeenCalled();
      expect(mocks.inspectGitHub).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
    } finally {
      diagnostic.mockRestore();
    }
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
