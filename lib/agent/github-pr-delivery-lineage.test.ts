/* oxlint-disable anti-slop/no-module-mocking -- Control persisted session state and external GitHub reads while exercising the real delivery tool, approval callback and lineage resolver. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApprovalContext } from "eve/tools/approval";
import type { ToolContext } from "eve/tools";
import type { AppBuilderWorkflowState } from "./workflow-state";
import type { DraftReconciliationCandidate } from "./draft-reconciliation-state";
import type { GitHubPublicationRuntime } from "./github-publication-runtime";
import type { GitHubPrDeliveryApproval } from "./github-pr-delivery-approval";
import type { ExistingDraftReconciliationProposal } from "../repository/github-draft-reconciliation";
import type { captureGitHubPrDeliveryAuthority } from "./github-pr-delivery-authority";
import readDelivery from "../../agent/tools/read_github_pr_delivery";
import { approveGitHubPrDelivery } from "./github-pr-delivery-step";
import { freshFixture, workflowKey } from "../eve/test-support/draft-reviewed-recovery";

const mocks = vi.hoisted(() => ({
  getState: vi.fn<() => AppBuilderWorkflowState>(),
  getCandidate: vi.fn<() => DraftReconciliationCandidate | null>(),
  inspect: vi.fn<NonNullable<GitHubPublicationRuntime["inspectPublishedPullRequest"]>>(),
  inspectReconciled:
    vi.fn<NonNullable<GitHubPublicationRuntime["inspectPublishedReconciliationHead"]>>(),
  run: vi.fn<NonNullable<GitHubPublicationRuntime["runPublishedPullRequestEffect"]>>(),
  runtimeForSession: vi.fn(),
  captureAuthority: vi.fn<typeof captureGitHubPrDeliveryAuthority>(),
}));
vi.mock("eve/tools", () => ({ defineTool: <T>(tool: T): T => tool }));
vi.mock("./workflow-state", () => ({ appBuilderWorkflowState: { get: mocks.getState } }));
vi.mock("./draft-reconciliation-state", () => ({
  draftReconciliationState: { get: mocks.getCandidate },
}));
vi.mock("./production-delivery-requirement", () => ({
  managedProductionDeliveryRequirements: { get: () => [] },
  retainManagedProductionDeliveryRequirement: vi.fn(),
}));
afterEach(() => vi.unstubAllEnvs());
vi.mock("./deployment-github-publication-runtime", () => ({
  githubPublicationRuntimeForSession: mocks.runtimeForSession,
}));
vi.mock("./github-pr-delivery-authority", () => ({
  captureGitHubPrDeliveryAuthority: mocks.captureAuthority,
}));

const principal = {
  attributes: {},
  authenticator: "controlled-owner",
  principalId: "creator",
  principalType: "user",
};
const session = {
  id: "same-logical-session",
  auth: { current: principal, initiator: principal },
  turn: { id: "same-parent-turn", sequence: 1 },
};
// SAFETY: The read tool only consumes authenticated session fields from this controlled context.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Tool fixture omits unused execution ports.
const context = { session } as ToolContext;
// oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
const approve = (toolInput: GitHubPrDeliveryApproval, abortSignal = new AbortController().signal) =>
  approveGitHubPrDelivery({
    abortSignal,
    approvedTools: new Set<string>(),
    callId: "lineage-delivery-call",
    getSandbox: () => {
      throw new Error("Approval lineage must not open an app sandbox");
    },
    session,
    toolInput,
    toolName: "finish-github-pr-delivery",
  } satisfies ApprovalContext<GitHubPrDeliveryApproval>);

const recovered = async () => {
  const f = await freshFixture();
  const original = f.candidate.publicationScope.proposal;
  const receipt = f.candidate.publicationScope.publication;
  const reconciliation: ExistingDraftReconciliationProposal = {
    version: 1,
    intendedOutcome: "reconcile-existing-draft-pull-request",
    repositoryId: original.repositoryId,
    owner: original.owner,
    name: original.name,
    pullRequestNumber: receipt.pullRequestNumber,
    pullRequestId: receipt.pullRequestId,
    branchName: original.branchName,
    baseBranch: original.baseBranch,
    expectedHeadSha: receipt.branchSha,
    expectedHeadTree: receipt.branchTree,
    expectedBaseSha: original.baseSha,
    expectedBaseTree: original.baseTree,
    resolvedTree: "e".repeat(40),
    originMarker: receipt.idempotencyKey,
    priorPublicationDigest: receipt.digest,
    installationIdentityDigest: original.installationIdentityDigest,
    reviewDigest: original.reviewDigest,
    baseChangesDigest: original.changeSetDigest,
    headChangesDigest: original.changeSetDigest,
    idempotencyKey: "f".repeat(64),
    digest: "e".repeat(64),
    approvedPaths: original.approvedPaths,
  };
  const candidate: typeof f.candidate & {
    reviewedLineage: typeof f.reviewed;
    publishedReconciliation: ExistingDraftReconciliationProposal;
    proposal?: ExistingDraftReconciliationProposal;
  } = {
    ...f.candidate,
    reviewedLineage: structuredClone(f.reviewed),
    publishedReconciliation: reconciliation,
    unpublished: "private edits retained after the published update",
  };
  const workflow = structuredClone(f.currentContext[workflowKey]);
  const reviewedTarget = {
    baseBranch: original.baseBranch,
    headSha: "d".repeat(40),
    name: original.name,
    owner: original.owner,
    pullRequestNumber: receipt.pullRequestNumber,
    repositoryId: original.repositoryId,
  };
  const approval = {
    ...reviewedTarget,
    installationId: f.candidate.publishedOrigin.installationId,
    proposalDigest: original.digest,
    reconciliationDigest: reconciliation.digest,
  };
  mocks.getState.mockReturnValue(workflow);
  mocks.getCandidate.mockReturnValue(candidate);
  mocks.inspectReconciled.mockResolvedValue(reviewedTarget.headSha);
  mocks.inspect.mockResolvedValue({
    ...reviewedTarget,
    state: "open",
    draft: true,
    checks: "pending",
    reviewedRevision: true,
    reviewedTarget,
  });
  return { approval, candidate, reconciliation, workflow };
};

beforeEach(() => {
  vi.stubEnv("REPOSITORY_PRODUCTION_OPERATOR_URL", "");
  vi.resetAllMocks();
  mocks.runtimeForSession.mockResolvedValue({
    inspectPublishedPullRequest: mocks.inspect,
    inspectPublishedReconciliationHead: mocks.inspectReconciled,
    runPublishedPullRequestEffect: mocks.run,
  });
  mocks.captureAuthority.mockResolvedValue();
});

it("reads the provider-proved published head after validation without changing the retained private candidate", async () => {
  const f = await recovered();
  const before = structuredClone(f);
  const result = await readDelivery.execute({}, context);
  expect(result).toMatchObject({ checks: "deferred", approval: f.approval });
  expect(mocks.runtimeForSession).toHaveBeenCalledWith(session.auth, {
    selectedInstallationId: f.approval.installationId,
  });
  expect(mocks.inspectReconciled).toHaveBeenCalledWith(f.approval.proposalDigest, f.reconciliation);
  expect(mocks.inspect).toHaveBeenCalledWith(f.approval.proposalDigest, f.approval.headSha);
  expect(f).toEqual(before);
  expect(mocks.run).not.toHaveBeenCalled();
});

it("requests native approval for that exact published reconciliation after validation", async () => {
  const f = await recovered();
  await expect(approve(f.approval)).resolves.toBe("user-approval");
  expect(mocks.inspectReconciled).toHaveBeenCalledWith(f.approval.proposalDigest, f.reconciliation);
  expect(mocks.captureAuthority).toHaveBeenCalledWith(
    f.approval,
    expect.objectContaining({ session, callId: "lineage-delivery-call" }),
  );
  expect(mocks.run).not.toHaveBeenCalled();
});

it("does not offer native approval when canonical owner capture fails", async () => {
  const f = await recovered();
  const ownerChanged = new Error("Current delivery owner changed");
  mocks.captureAuthority.mockRejectedValue(ownerChanged);
  await expect(approve(f.approval)).rejects.toBe(ownerChanged);
  expect(mocks.run).not.toHaveBeenCalled();
});

it("honors native cancellation before capturing approval scope", async () => {
  const f = await recovered();
  const controller = new AbortController();
  const cancelled = new Error("Creator cancelled delivery");
  controller.abort(cancelled);
  await expect(approve(f.approval, controller.signal)).rejects.toBe(cancelled);
  expect(mocks.captureAuthority).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
});

it.each(["applied", "validated"] as const)(
  "retains the same owned publication during %s without accepting the private proposal",
  async (phase) => {
    const f = await recovered();
    mocks.getState.mockReturnValue({ ...f.workflow, phase });
    f.candidate.proposal = { ...f.reconciliation, digest: "1".repeat(64) };
    const result = await readDelivery.execute({}, context);
    expect(result).toMatchObject({ approval: f.approval });
    await expect(
      approve({ ...f.approval, proposalDigest: f.candidate.proposal.digest }),
    ).resolves.toMatchObject({
      type: "denied",
    });
    expect(mocks.run).not.toHaveBeenCalled();
  },
);

it.each(["app", "spec", "source", "workspace", "apply-root", "publication"] as const)(
  "refuses changed %s lineage before reading GitHub or offering approval",
  async (binding) => {
    const f = await recovered();
    const change = {
      app: () => {
        f.workflow.appSpec.appId = "another-app";
      },
      spec: () => {
        f.workflow.appSpec.digest = "2".repeat(64);
      },
      source: () => {
        f.workflow.sourceReceipt.digest = "2".repeat(64);
      },
      workspace: () => {
        f.workflow.workspace.workspaceId = "another-workspace";
      },
      "apply-root": () => {
        f.workflow.applyReceipt.applyRoot = "/another-private-workspace";
      },
      publication: () => {
        f.workflow.publishedGitHubDraftProposalDigest = "2".repeat(64);
      },
    };
    change[binding]();
    await expect(readDelivery.execute({}, context)).rejects.toThrow(
      "This session has no reviewed draft pull request publication.",
    );
    await expect(approve(f.approval)).resolves.toMatchObject({ type: "denied" });
    expect(mocks.runtimeForSession).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  },
);

it("retains the original publication when a current review has another sealed private proposal", async () => {
  const f = await recovered();
  const reviewed = f.candidate.reviewedLineage;
  const current = {
    ...reviewed,
    githubDraftProposal: {
      proposal: { ...f.candidate.publicationScope.proposal, digest: "1".repeat(64) },
      sourceReceiptDigest: reviewed.sourceReceipt.digest,
      destinationReviewDigest: "2".repeat(64),
    },
  };
  mocks.getState.mockReturnValue(current);
  await expect(readDelivery.execute({}, context)).resolves.toMatchObject({ approval: f.approval });
  await expect(
    approve({ ...f.approval, proposalDigest: current.githubDraftProposal.proposal.digest }),
  ).resolves.toMatchObject({
    type: "denied",
  });
});

it("does not offer or accept delivery approval without fresh proof of the published reconciliation", async () => {
  const f = await recovered();
  mocks.inspectReconciled.mockResolvedValue(null);
  await expect(readDelivery.execute({}, context)).resolves.not.toHaveProperty("approval");
  await expect(approve(f.approval)).resolves.toMatchObject({ type: "denied" });
  mocks.inspectReconciled.mockResolvedValue("0".repeat(40));
  await expect(approve(f.approval)).resolves.toMatchObject({ type: "denied" });
  expect(mocks.run).not.toHaveBeenCalled();
});

it("rejects another session, installation or reconciliation rather than borrowing its approval", async () => {
  const f = await recovered();
  const [otherSession, otherInstallation, otherReconciliation] = [
    { ...f.approval, sessionId: "another-session" },
    { ...f.approval, installationId: "999" },
    { ...f.approval, reconciliationDigest: "0".repeat(64) },
  ];
  await expect(approve(otherSession)).resolves.toMatchObject({ type: "denied" });
  await expect(approve(otherInstallation)).resolves.toMatchObject({ type: "denied" });
  await expect(approve(otherReconciliation)).resolves.toMatchObject({ type: "denied" });
  expect(mocks.runtimeForSession).not.toHaveBeenCalled();
  expect(mocks.inspectReconciled).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
});
