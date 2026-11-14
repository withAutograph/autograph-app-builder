/* oxlint-disable anti-slop/no-module-mocking -- Exercise tool selection against the bound session and read-only client. */
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import getAppProduction from "../../agent/tools/get-app-production";

const mocks = vi.hoisted(() => ({
  subject: vi.fn(),
  grant: vi.fn(),
  project: vi.fn(),
  runtime: vi.fn(),
  inspect: vi.fn(),
  inspectReconciliation: vi.fn(),
  client: vi.fn(),
  predecessor: vi.fn(),
  status: vi.fn(),
}));
vi.mock("./github-pr-delivery-subject", () => ({
  resolveGitHubPrDeliverySubject: mocks.subject,
}));
vi.mock("./direct-production-state", () => ({
  currentDirectProductionGrant: mocks.grant,
  retainedDirectProductionSchemaReadbackGrant: mocks.grant,
}));
vi.mock("./approved-build-continuation-runtime", () => ({
  emitCurrentBuildWorkflowProjection: mocks.project,
}));
vi.mock("./deployment-github-publication-runtime", () => ({
  githubPublicationRuntimeForSession: mocks.runtime,
}));
vi.mock("./repository-production-client", () => ({
  repositoryProductionClientForContext: mocks.client,
}));
vi.mock("./draft-reconciliation-state", () => ({ draftReconciliationState: { get: () => null } }));
vi.mock("./workflow-state", () => ({ appBuilderWorkflowState: { get: () => null } }));
vi.mock("./prepare-app-production-step", () => ({ nextProductionDeliveryCall: {} }));

const appId = "fixture-app";
const repoId = "123";
const repositoryName = "example/repo";
const installationId = "456";
const headSha = "a".repeat(40);
const proposalDigest = "b".repeat(64);
const identity = {
  version: 1,
  appId,
  repositoryId: repoId,
  releaseId: "fixture.v8",
  artifactSha256: "a".repeat(64),
  manifestSha256: "b".repeat(64),
  cueSha256: "c".repeat(64),
};
const target = {
  baseBranch: "main",
  headSha,
  repositoryId: repoId,
  owner: "example",
  name: "repo",
  pullRequestNumber: 123,
};
const session: ToolContext["session"] = {
  auth: { current: null, initiator: null },
  id: "saved-session",
  turn: { id: "readback", sequence: 1 },
};
const observation = {
  state: "open",
  draft: true,
  reviewedRevision: true,
  reviewedTarget: target,
};
const readback = { appId, includeSchemaPredecessor: true } as const;
const unexpectedToolEffect = (): never => {
  throw new Error("The installed schema diagnostic should only read the existing setup.");
};
const ctx: ToolContext = {
  abortSignal: new AbortController().signal,
  callId: "readback",
  getSandbox: unexpectedToolEffect,
  getToken: unexpectedToolEffect,
  requireAuth: unexpectedToolEffect,
  session,
  toolName: "get-app-production",
};

describe("read installed schema through the saved app tool", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.subject.mockReturnValue({ appId, installationId, proposalDigest });
    mocks.grant.mockReturnValue({
      digest: "d".repeat(64),
      subject: {
        repositoryId: repoId,
        repositoryFullName: repositoryName,
        baseBranch: target.baseBranch,
        revision: { schemaChange: { kind: "add-optional-text-field" } },
      },
    });
    mocks.runtime.mockResolvedValue({
      inspectPublishedPullRequest: mocks.inspect,
      inspectPublishedReconciliationHead: mocks.inspectReconciliation,
    });
    mocks.inspect.mockResolvedValue(observation);
    mocks.client.mockResolvedValue({ schemaPredecessor: mocks.predecessor, status: mocks.status });
    mocks.predecessor.mockResolvedValue(identity);
  });

  it("uses the exact reviewed head and returns the diagnostic without a setup continuation", async () => {
    await expect(getAppProduction.execute(readback, ctx)).resolves.toEqual(identity);
    expect(mocks.runtime).toHaveBeenCalledWith(session.auth, {
      selectedInstallationId: installationId,
    });
    expect(mocks.inspect).toHaveBeenCalledOnce();
    expect(mocks.inspect.mock.calls[0]?.[0]).toBe(proposalDigest);
    expect(mocks.inspect.mock.calls[0]?.[1]).toBeUndefined();
    expect(mocks.predecessor).toHaveBeenCalledExactlyOnceWith(appId, repoId, headSha);
    expect(mocks.project).toHaveBeenCalledExactlyOnceWith(ctx);
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it("keeps ordinary setup status on its existing path", async () => {
    mocks.status.mockResolvedValue({ state: "reconciling" });
    await expect(getAppProduction.execute({ appId }, ctx)).resolves.toEqual({
      state: "reconciling",
    });
    expect(mocks.status).toHaveBeenCalledExactlyOnceWith(appId);
    expect(mocks.runtime).not.toHaveBeenCalled();
    expect(mocks.predecessor).not.toHaveBeenCalled();
  });

  it.each([{ draft: false }, { reviewedRevision: false }, { state: "merged" }])(
    "preserves the setup when the owned draft state changes (%j)",
    async (change) => {
      mocks.inspect.mockResolvedValue({ ...observation, ...change });
      await expect(getAppProduction.execute(readback, ctx)).rejects.toThrow(
        "could not verify the installed schema",
      );
      expect(mocks.client).not.toHaveBeenCalled();
    },
  );

  it("reports a safe readback authority failure and does not call the operator", async () => {
    mocks.project.mockRejectedValue(new Error("opaque test internals"));
    await expect(getAppProduction.execute(readback, ctx)).rejects.toThrow(
      "readback-authority-unavailable",
    );
    expect(mocks.client).not.toHaveBeenCalled();
  });

  it("reports a safe operator failure after projecting current authority", async () => {
    mocks.predecessor.mockRejectedValue(new Error("opaque test internals"));
    await expect(getAppProduction.execute(readback, ctx)).rejects.toThrow(
      "operator-read-unavailable",
    );
    expect(mocks.project).toHaveBeenCalledOnce();
  });

  it("does not reveal a diagnostic when the approved grant changes while the operator reads", async () => {
    mocks.predecessor.mockImplementation(async () => {
      mocks.grant.mockReturnValue(null);
      return await Promise.resolve(identity);
    });
    await expect(getAppProduction.execute(readback, ctx)).rejects.toThrow(
      "could not verify the installed schema",
    );
    expect(mocks.predecessor).toHaveBeenCalledOnce();
  });
});
