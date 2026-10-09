/* oxlint-disable anti-slop/no-module-mocking, typescript/no-unsafe-type-assertion, anti-slop/require-safety-comment-for-type-assertion -- Minimal saved-state fixtures exercise the real source inspection tool, with no repository or provider effects. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import inspectSource from "../../agent/tools/inspect_source";

interface SavedInspection {
  phase: string;
  receipt?: { digest: string; sourcePath: string };
  sourceReceipt?: { digest: string; sourcePath: string };
  githubSource?: { digest: string; repository: { repositoryId: string }; resolvedRef: string };
}

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  development: vi.fn(),
  source: { phase: "empty" } as SavedInspection,
  update: vi.fn<(transition: () => SavedInspection) => void>(),
  workflow: { phase: "empty" } as SavedInspection,
}));
vi.mock("eve/tools", () => ({ defineTool: <T>(tool: T) => tool }));
vi.mock("./source-state", () => ({
  APP_BUILDER_SOURCE_VERSION: 3,
  sourceWorkflowState: { get: () => mocks.source, update: mocks.update },
}));
vi.mock("./workflow-state", () => ({ appBuilderWorkflowState: { get: () => mocks.workflow } }));
vi.mock("../repository/arrusted-template", () => ({
  acquireCanonicalArrustedTemplate: mocks.acquire,
}));
vi.mock("../repository/development-source", () => ({
  canAutoSelectDevelopmentSource: () => false,
  developmentSourceReceipt: mocks.development,
}));
vi.mock("../sandbox/backend", () => ({ isHostedVercelRuntime: () => true }));

const githubSource = {
  digest: "owned-source",
  repository: { repositoryId: "owned" },
  resolvedRef: "refs/heads/main",
};
const receipt = { digest: "owned-receipt", sourcePath: "/workspace/repository" };
const execute = async () =>
  await inspectSource.execute({ sourceKind: "fresh-template" }, {
    callId: "inspect",
    getSandbox: vi.fn(),
    session: { id: "saved-session" },
  } as never);

describe("saved GitHub app source inspection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.source = { githubSource, phase: "reviewed", receipt };
    mocks.workflow = { githubSource, phase: "applied", sourceReceipt: receipt };
  });
  it("preserves the actual selected checkout instead of reacquiring a starter", async () => {
    await expect(execute()).resolves.toBe(receipt);
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(mocks.development).not.toHaveBeenCalled();
    const transition = mocks.update.mock.calls[0]?.[0];
    expect(transition()).toMatchObject({ githubSource, phase: "reviewed", receipt });
  });
  it("restores the GitHub slot lost by an earlier inspection from accepted workflow state", async () => {
    mocks.source = { phase: "reviewed", receipt };
    await expect(execute()).resolves.toBe(receipt);
    const transition = mocks.update.mock.calls[0]?.[0];
    expect(transition()).toMatchObject({ githubSource, receipt });
  });
  it("restores an empty inspection state from the accepted app without new source acquisition", async () => {
    mocks.source = { phase: "empty" };
    await expect(execute()).resolves.toBe(receipt);
    const transition = mocks.update.mock.calls[0]?.[0];
    expect(transition()).toMatchObject({ githubSource, receipt });
    expect(mocks.acquire).not.toHaveBeenCalled();
  });
});
