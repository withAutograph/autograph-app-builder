/* oxlint-disable anti-slop/no-module-mocking -- Replace Eve session state and the scoped runtime factory while exercising the real tool and publication runtime. */
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";

import readDelivery from "../../agent/tools/read_github_pr_delivery";
import { GITHUB_PUBLICATION_VERSION } from "../repository/github-publication";
import type {
  DraftPullRequestProposal,
  DraftPullRequestSuccessReceipt,
} from "../repository/github-publication";
import type { ExistingDraftReconciliationProposal } from "../repository/github-draft-reconciliation";
import type { GitHubPrDeliveryObservation } from "../repository/github-pr-delivery";
import { composeGitHubPublicationRuntime } from "./github-publication-runtime";

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  getCandidate: vi.fn(() => null),
  runtimeForSession: vi.fn(),
}));
vi.mock("./draft-reconciliation-state", () => ({
  draftReconciliationState: { get: mocks.getCandidate },
}));
vi.mock("eve/tools", () => ({ defineTool: <T>(tool: T): T => tool }));
vi.mock("./workflow-state", () => ({ appBuilderWorkflowState: { get: mocks.getState } }));
vi.mock("./deployment-github-publication-runtime", () => ({
  githubPublicationRuntimeForSession: mocks.runtimeForSession,
}));

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const signed = <T extends object>(value: T): T & { digest: string } => ({
  ...value,
  digest: digest(JSON.stringify(value)),
});

const fixture = (receiptRepositoryId = "100") => {
  const identities = {
    installationIdentityDigest: "1".repeat(64),
    repositoryObservationDigest: "2".repeat(64),
    reviewDigest: "3".repeat(64),
  };
  const idempotencyKey = digest(JSON.stringify(identities));
  const proposal = signed({
    ...identities,
    approvedPaths: ["apps/demo/page.tsx"],
    baseBranch: "main",
    baseSha: "4".repeat(40),
    baseTree: "5".repeat(40),
    branchName: `app-builder/review-${idempotencyKey.slice(0, 20)}`,
    changeSetDigest: "6".repeat(64),
    changedContentDigest: "7".repeat(64),
    draft: true,
    idempotencyKey,
    intendedOutcome: "publish-reviewed-change-set-as-draft-pull-request",
    name: "example-app",
    owner: "withAutograph",
    releaseGate: { configured: false, name: "REPOSITORY_RELEASE_ENABLED" },
    repositoryId: "100",
    title: "Add example page",
    version: GITHUB_PUBLICATION_VERSION,
    visibility: "private",
  } satisfies Omit<DraftPullRequestProposal, "digest">);
  const receipt = signed({
    approvedByCallId: "draft-approval",
    baseBranch: proposal.baseBranch,
    baseSha: proposal.baseSha,
    branchName: proposal.branchName,
    branchSha: "8".repeat(40),
    branchTree: "9".repeat(40),
    changeSetDigest: proposal.changeSetDigest,
    changedContentDigest: proposal.changedContentDigest,
    draft: true,
    idempotencyKey,
    installationIdentityDigest: proposal.installationIdentityDigest,
    kind: "draft-pull-request",
    normalizedChangedPaths: proposal.approvedPaths,
    proposalDigest: proposal.digest,
    providerReadBackDigest: "a".repeat(64),
    pullRequestId: "150000",
    pullRequestNumber: 1500,
    recoveredFromPending: false,
    releaseGateUnchanged: true,
    repositoryId: receiptRepositoryId,
    status: "succeeded",
    version: GITHUB_PUBLICATION_VERSION,
  } satisfies Omit<DraftPullRequestSuccessReceipt, "digest">);
  const observation: GitHubPrDeliveryObservation = {
    baseBranch: receipt.baseBranch,
    checks: "pending",
    draft: true,
    headSha: receipt.branchSha,
    state: "open",
  };
  const inspect = vi.fn().mockResolvedValue(observation);
  const unexpected = vi.fn(async () => {
    throw new Error("Unexpected publication operation");
  });
  const compareAndSet = vi.fn();
  const inspectExistingDraft = vi.fn().mockImplementation(unexpected);
  const inspectAppliedDraftReconciliation = vi.fn().mockImplementation(unexpected);
  const runtime = composeGitHubPublicationRuntime({
    adapter: {
      createPrivateFreshHistoryRepository: unexpected,
      inspectDestination: unexpected,
      inspectDraftPublication: unexpected,
      inspectExistingDraft,
      inspectAppliedDraftReconciliation,
      inspectFreshRepositoryOutcome: unexpected,
      inspectInstallation: unexpected,
      inspectRepository: unexpected,
      prDelivery: { inspect, markReady: unexpected, merge: unexpected },
      publishDraftPullRequest: unexpected,
      updateExistingDraft: unexpected,
    },
    enabled: true,
    proposals: { read: vi.fn().mockResolvedValue(proposal), save: unexpected },
    receipts: { compareAndSet, read: vi.fn().mockResolvedValue(receipt) },
  });
  const reviewedTarget = {
    baseBranch: receipt.baseBranch,
    headSha: receipt.branchSha,
    name: proposal.name,
    owner: proposal.owner,
    pullRequestNumber: receipt.pullRequestNumber,
    repositoryId: proposal.repositoryId,
  };
  return {
    compareAndSet,
    inspect,
    inspectAppliedDraftReconciliation,
    inspectExistingDraft,
    observation,
    proposal,
    receipt,
    reviewedTarget,
    runtime,
    unexpected,
  };
};

it("reports draft checks as deferred using only the session's reviewed publication receipt", async () => {
  const { compareAndSet, inspect, observation, proposal, reviewedTarget, runtime, unexpected } =
    fixture();
  mocks.getState.mockReturnValue({
    appSpec: { appId: "demo" },
    githubDestinationReview: { installation: { installationId: "300" } },
    githubDraftProposal: { proposal },
    phase: "reviewed",
  });
  mocks.runtimeForSession.mockResolvedValue(runtime);
  const auth = { current: { principalId: "fixture-user" } };
  // SAFETY: The tool reads only session.auth, which the mocked runtime factory receives.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Provide only the context field under test.
  const result = await readDelivery.execute({}, { session: { auth } } as never);
  expect(result).toEqual({
    ...observation,
    checks: "deferred",
    reviewedRevision: true,
    reviewedTarget,
  });
  expect(mocks.runtimeForSession).toHaveBeenCalledWith(auth, { selectedInstallationId: "300" });
  expect(inspect).toHaveBeenCalledExactlyOnceWith(reviewedTarget);
  expect(unexpected).not.toHaveBeenCalled();
  expect(compareAndSet).not.toHaveBeenCalled();
});

it("fails before provider inspection when the stored receipt belongs to a different repository", async () => {
  const { inspect, proposal, runtime } = fixture("101");
  await expect(runtime.inspectPublishedPullRequest?.(proposal.digest)).rejects.toThrow(
    "The publication does not match the reviewed repository.",
  );
  expect(inspect).not.toHaveBeenCalled();
});

it("distinguishes the live head from the reviewed publication when the branch moves", async () => {
  const { inspect, observation, proposal, reviewedTarget, runtime } = fixture();
  const current = { ...observation, draft: false, headSha: "f".repeat(40) };
  inspect.mockResolvedValueOnce(current);
  await expect(runtime.inspectPublishedPullRequest?.(proposal.digest)).resolves.toEqual({
    ...current,
    reviewedRevision: false,
    reviewedTarget,
  });
});

it("selects the reconciled revision only when GitHub proves the retained commit", async () => {
  const { inspectAppliedDraftReconciliation, inspectExistingDraft, proposal, receipt, runtime } =
    fixture();
  const reconciliation = {
    version: 1,
    intendedOutcome: "reconcile-existing-draft-pull-request",
    repositoryId: receipt.repositoryId,
    owner: proposal.owner,
    name: proposal.name,
    pullRequestNumber: receipt.pullRequestNumber,
    pullRequestId: receipt.pullRequestId,
    branchName: receipt.branchName,
    baseBranch: receipt.baseBranch,
    expectedHeadSha: receipt.branchSha,
    expectedHeadTree: receipt.branchTree,
    expectedBaseSha: proposal.baseSha,
    expectedBaseTree: proposal.baseTree,
    resolvedTree: "e".repeat(40),
    originMarker: receipt.idempotencyKey,
    priorPublicationDigest: receipt.digest,
    installationIdentityDigest: proposal.installationIdentityDigest,
    reviewDigest: proposal.reviewDigest,
    baseChangesDigest: proposal.changeSetDigest,
    headChangesDigest: proposal.changeSetDigest,
    idempotencyKey: "a".repeat(64),
    digest: "b".repeat(64),
    approvedPaths: proposal.approvedPaths,
  } satisfies ExistingDraftReconciliationProposal;
  const updatedHead = "f".repeat(40);
  inspectExistingDraft.mockResolvedValue({
    ...reconciliation,
    number: receipt.pullRequestNumber,
    headBranch: receipt.branchName,
    headSha: updatedHead,
    headTree: reconciliation.resolvedTree,
    headRepositoryId: receipt.repositoryId,
    baseRepositoryId: receipt.repositoryId,
    verifiedBuilderOrigin: { marker: receipt.idempotencyKey },
  });
  inspectAppliedDraftReconciliation.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(
    runtime.inspectPublishedReconciliationHead?.(proposal.digest, reconciliation),
  ).resolves.toBe(updatedHead);
  await expect(
    runtime.inspectPublishedReconciliationHead?.(proposal.digest, reconciliation),
  ).resolves.toBeNull();
});
