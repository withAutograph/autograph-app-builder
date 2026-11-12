/* oxlint-disable anti-slop/no-module-mocking -- Controlled ports exercise the actual normal Production planner and recovery decisions without hosted effects. */
import { beforeEach, expect, it, vi } from "vitest";
import type { ToolContext } from "eve/tools";
import planAppProduction from "../../agent/tools/plan-app-production";
import type { publishCompiledOperatorArtifactsForSession } from "./compiled-operator-artifacts";

const ports = vi.hoisted(() => ({
  assertProposal: vi.fn(),
  hasCapture: vi.fn(),
  inspectPublished: vi.fn(),
  normalize: vi.fn(),
  plan: vi.fn(),
  publish: vi.fn(),
  workflow: vi.fn(),
}));

vi.mock("./compiled-operator-artifacts", () => ({
  hasCapturedStaticDescriptionForSession: ports.hasCapture,
  publishCompiledOperatorArtifactsForSession: ports.publish,
}));
vi.mock("./deployment-github-publication-runtime", () => ({
  githubPublicationRuntimeForSession: () => ({
    inspectPublishedPullRequest: ports.inspectPublished,
  }),
}));
vi.mock("./repository-production-client", () => ({
  repositoryProductionClientForContext: () => ({ plan: ports.plan }),
}));
vi.mock(import("./workflow-state"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    appBuilderWorkflowState: { ...actual.appBuilderWorkflowState, get: ports.workflow },
    assertCurrentGitHubDraftProposal: ports.assertProposal,
  };
});
vi.mock("../../agent/tools/change_set_status", () => ({
  exactNormalizedChangeSet: ports.normalize,
}));

const appId = "frontend";
const state = {
  appBackendKind: "static",
  appSpec: { appId, digest: "app-spec" },
  applyReceipt: { applyRoot: "/workspace/owned-app" },
  githubDestinationReview: { installation: { installationId: "42" } },
  githubDraftProposal: { proposal: { digest: "published-proposal" } },
  phase: "reviewed",
  publishedGitHubDraftProposalDigest: "published-proposal",
  reviewReceipt: { changeSetDigest: "reviewed-change", digest: "app-review" },
  sourceReceipt: { digest: "original-source" },
} as const;
const missing = new Error("Builder could not read the saved Production setup.");
const plan = {
  version: 1,
  approvalReference: { appId },
  accessSummary: "Private creator access",
  nextCall: { tool: "prepare-app-production", input: { appId } },
};

const context = () =>
  ({
    callId: "restore-description",
    toolName: "plan-app-production",
    abortSignal: new AbortController().signal,
    session: {
      id: "original-session",
      auth: { current: null, initiator: null },
      turn: { id: "turn", sequence: 2 },
    },
    getSandbox: vi.fn().mockResolvedValue({ id: "original-checkout" }),
    getToken: () => {
      throw new Error("Frontend metadata restoration cannot request credentials.");
    },
    requireAuth: () => {
      throw new Error("Frontend metadata restoration cannot request authorization.");
    },
  }) satisfies ToolContext;

beforeEach(() => {
  vi.resetAllMocks();
  ports.workflow.mockReturnValue(state);
  ports.assertProposal.mockReturnValue(state.githubDraftProposal.proposal);
  ports.hasCapture.mockResolvedValue(false);
  ports.inspectPublished.mockResolvedValue({ state: "open", reviewedRevision: true });
  ports.normalize.mockResolvedValue({ digest: state.reviewReceipt.changeSetDigest });
  ports.plan.mockRejectedValueOnce(missing).mockResolvedValueOnce(plan);
  ports.publish.mockImplementation(
    async (input: Parameters<typeof publishCompiledOperatorArtifactsForSession>[0]) => {
      await input.assertStaticRecoverySource?.();
      return { status: "not-required" };
    },
  );
});

it("restores missing frontend metadata and retries the normal plan with the same open reviewed draft", async () => {
  const ctx = context();
  await expect(planAppProduction.execute({ appId }, ctx)).resolves.toEqual(plan);
  expect(ports.plan).toHaveBeenCalledTimes(2);
  expect(ports.inspectPublished).toHaveBeenCalledWith(state.publishedGitHubDraftProposalDigest);
  expect(ports.assertProposal).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedProposalDigest: state.publishedGitHubDraftProposalDigest,
      changeSetDigest: state.reviewReceipt.changeSetDigest,
      sourceReceiptDigest: state.sourceReceipt.digest,
    }),
  );
  expect(ports.publish).toHaveBeenCalledWith(
    expect.objectContaining({
      adapterSessionId: ctx.session.id,
      appId,
      appSpecDigest: state.appSpec.digest,
      root: state.applyReceipt.applyRoot,
    }),
  );
  expect(ports.plan).toHaveBeenCalledBefore(ports.publish);
});

it("does not attempt capture when GitHub reports a different head", async () => {
  const ctx = context();
  ports.inspectPublished.mockResolvedValue({ state: "open", reviewedRevision: false });
  await expect(planAppProduction.execute({ appId }, ctx)).rejects.toBe(missing);
  expect(ctx.getSandbox).not.toHaveBeenCalled();
  expect(ports.publish).not.toHaveBeenCalled();
  expect(ports.plan).toHaveBeenCalledOnce();
});

it("does not capture an edited private checkout under the old review", async () => {
  ports.normalize.mockResolvedValue({ digest: "new-unreviewed-change" });
  await expect(planAppProduction.execute({ appId }, context())).rejects.toThrow(
    "current frontend source differs",
  );
  expect(ports.plan).toHaveBeenCalledOnce();
});

it("preserves the first plan failure when the description is already captured", async () => {
  ports.hasCapture.mockResolvedValue(true);
  await expect(planAppProduction.execute({ appId }, context())).rejects.toBe(missing);
  expect(ports.inspectPublished).not.toHaveBeenCalled();
  expect(ports.publish).not.toHaveBeenCalled();
  expect(ports.plan).toHaveBeenCalledOnce();
});
