/* oxlint-disable anti-slop/no-module-mocking -- Substitute persisted Eve session state and the scoped runtime at the workflow step boundary. */
import { beforeEach, expect, it, vi } from "vitest";

import type { GitHubPrDeliveryObservation } from "../repository/github-pr-delivery";
import type { GitHubPrDeliveryApproval } from "./github-pr-delivery-approval";
import { approveGitHubPrDelivery, continueGitHubPrDelivery } from "./github-pr-delivery-step";

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  getCandidate: vi.fn(),
  inspect: vi.fn(),
  inspectReconciled: vi.fn(),
  run: vi.fn(),
}));
vi.mock("./draft-reconciliation-state", () => ({
  draftReconciliationState: { get: mocks.getCandidate },
}));
vi.mock("./workflow-state", () => ({ appBuilderWorkflowState: { get: mocks.getState } }));
vi.mock("./deployment-github-publication-runtime", () => ({
  githubPublicationRuntimeForSession: () =>
    Promise.resolve({
      inspectPublishedPullRequest: mocks.inspect,
      inspectPublishedReconciliationHead: mocks.inspectReconciled,
      runPublishedPullRequestEffect: mocks.run,
    }),
}));

const reviewedTarget = {
  baseBranch: "main",
  headSha: "a".repeat(40),
  name: "example-app",
  owner: "withAutograph",
  pullRequestNumber: 42,
  repositoryId: "100",
};
const approval: GitHubPrDeliveryApproval = {
  ...reviewedTarget,
  proposalDigest: "b".repeat(64),
};
const readyAt = "2026-11-05T15:30:00Z";
const mergeCommitSha = "c".repeat(40);
const session = { id: "session-fixture", auth: {} };
const callId = "approved-delivery-call";
const abortSignal = new AbortController().signal;
const observe = (changes: Partial<GitHubPrDeliveryObservation> = {}) => ({
  baseBranch: reviewedTarget.baseBranch,
  checks: "pending",
  draft: false,
  headSha: reviewedTarget.headSha,
  readyAt,
  reviewedRevision: true,
  reviewedTarget,
  state: "open",
  ...changes,
});

const approve = (toolInput: GitHubPrDeliveryApproval) =>
  // SAFETY: The approval callback reads only the supplied session.id and toolInput.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Narrow fixture context to fields used by the approval callback.
  approveGitHubPrDelivery({ session, toolInput } as never);

const step = (input: GitHubPrDeliveryApproval, cycle?: string) =>
  continueGitHubPrDelivery(
    input,
    // SAFETY: The workflow step reads only the supplied call ID, abort signal, and session identity.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Narrow fixture context to fields used by the workflow step.
    { session, callId, abortSignal } as never,
    cycle,
  );

beforeEach(() => {
  mocks.inspect.mockReset();
  mocks.inspectReconciled.mockReset();
  mocks.getCandidate.mockReset();
  mocks.run.mockReset();
  mocks.getState.mockReturnValue({
    phase: "reviewed",
    appSpec: { appId: "example-app" },
    githubDraftProposal: { proposal: { digest: approval.proposalDigest } },
  });
});

it("requires approval for the session's current reviewed publication", async () => {
  await expect(approve(approval)).resolves.toBe("user-approval");
  await expect(approve({ ...approval, sessionId: "another-session" })).resolves.toMatchObject({
    type: "denied",
  });
  await expect(approve({ ...approval, proposalDigest: "d".repeat(64) })).resolves.toMatchObject({
    type: "denied",
  });
  expect(mocks.inspect).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
});

it("requires provider proof of the retained reconciliation before approving its exact head", async () => {
  const reconciliation = { digest: "e".repeat(64) };
  const reconciled = { ...approval, reconciliationDigest: reconciliation.digest };
  mocks.getCandidate.mockReturnValue({
    appId: "example-app",
    publishedReconciliation: reconciliation,
  });
  mocks.inspectReconciled.mockResolvedValue(reconciled.headSha);
  await expect(approve(reconciled)).resolves.toBe("user-approval");
  expect(mocks.inspectReconciled).toHaveBeenCalledWith(approval.proposalDigest, reconciliation);
  await expect(approve({ ...reconciled, headSha: "f".repeat(40) })).resolves.toMatchObject({
    type: "denied",
  });
  mocks.inspect.mockResolvedValue(observe({ draft: true }));
  mocks.run.mockResolvedValue({ status: "succeeded", evidence: { kind: "pr-ready", readyAt } });
  await expect(step(reconciled)).resolves.toEqual({ readyAt, status: "waiting-for-checks" });
  expect(mocks.inspect).toHaveBeenCalledWith(approval.proposalDigest, approval.headSha);
  expect(mocks.run).toHaveBeenCalledWith(
    expect.objectContaining({
      reconciledHeadSha: approval.headSha,
      reviewedTarget,
    }),
  );
});

it("rechecks the approved proposal in the authenticated workflow without a model-carried session ID", async () => {
  mocks.inspect.mockResolvedValue(observe());
  const callback = { session: { ...session, id: "workflow-session" }, callId, abortSignal };
  // SAFETY: These are the only callback fields the step reads.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Partial workflow fixture.
  await expect(continueGitHubPrDelivery(approval, callback as never, readyAt)).resolves.toEqual({
    readyAt,
    status: "waiting-for-checks",
  });
  expect(mocks.inspect).toHaveBeenCalledExactlyOnceWith(approval.proposalDigest);
  expect(mocks.run).not.toHaveBeenCalled();
});

it("refuses a mismatch between the approval target and the live reviewed publication", async () => {
  mocks.inspect.mockResolvedValue(observe());
  await expect(step({ ...approval, headSha: "d".repeat(40) })).resolves.toEqual({
    status: "revision-changed",
  });
  expect(mocks.run).not.toHaveBeenCalled();
});

it("marks the approved draft ready and returns the observed cycle without merging", async () => {
  mocks.inspect.mockResolvedValue(observe({ draft: true }));
  mocks.run.mockResolvedValue({ status: "succeeded", evidence: { kind: "pr-ready", readyAt } });
  await expect(step(approval)).resolves.toEqual({ readyAt, status: "waiting-for-checks" });
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith({
    abortSignal,
    approvedByCallId: callId,
    kind: "pr-ready",
    proposalDigest: approval.proposalDigest,
    reviewedTarget,
  });
});

it.each([
  [observe({ checks: "pending" }), { readyAt, status: "waiting-for-checks" }],
  [observe({ checks: "failed" }), { status: "checks-failed" }],
  [
    observe({ checks: "passed", readyAt: "2026-11-05T15:45:00Z" }),
    { status: "ready-cycle-changed" },
  ],
])("does not merge pending, failed, or superseded checks", async (observation, result) => {
  mocks.inspect.mockResolvedValue(observation);
  await expect(step(approval, readyAt)).resolves.toEqual(result);
  expect(mocks.run).not.toHaveBeenCalled();
});

it.each([
  [
    { status: "succeeded", evidence: { kind: "pr-merge", mergeCommitSha } },
    { mergeCommitSha, status: "merged" },
  ],
  [{ status: "pending" }, { status: "merge-unconfirmed" }],
])("merges the approved revision only after its current checks pass", async (receipt, result) => {
  mocks.inspect.mockResolvedValue(observe({ checks: "passed", checkRunId: 42 }));
  mocks.run.mockResolvedValue(receipt);
  await expect(step(approval, readyAt)).resolves.toEqual(result);
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith({
    abortSignal,
    approvedByCallId: callId,
    kind: "pr-merge",
    proposalDigest: approval.proposalDigest,
    readyAt,
    reviewedTarget,
  });
});

it("recovers a ready transition after the original response is lost", async () => {
  mocks.inspect.mockResolvedValue(observe());
  mocks.run.mockResolvedValue({ status: "succeeded", evidence: { kind: "pr-ready", readyAt } });
  await expect(step(approval)).resolves.toEqual({ readyAt, status: "waiting-for-checks" });
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith({
    abortSignal,
    approvedByCallId: callId,
    kind: "pr-ready",
    proposalDigest: approval.proposalDigest,
    reconcileOnly: true,
    reviewedTarget,
  });
});
