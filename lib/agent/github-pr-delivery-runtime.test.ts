/* oxlint-disable anti-slop/no-module-mocking -- Replace Eve session state and the scoped runtime factory while exercising the real tool and publication runtime. */
import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import type { RepositoryProductionDeliveryStatus } from "../provisioning/repository-production-delivery";

import readDelivery from "../../agent/tools/read_github_pr_delivery";
import { GITHUB_PUBLICATION_VERSION } from "../repository/github-publication";
import type {
  DraftPullRequestProposal,
  DraftPullRequestSuccessReceipt,
} from "../repository/github-publication";
import type { ExistingDraftReconciliationProposal } from "../repository/github-draft-reconciliation";
import type {
  GitHubPrDeliveryObservation,
  GitHubPrDeliveryProvider,
} from "../repository/github-pr-delivery";
import { composeGitHubPublicationRuntime } from "./github-publication-runtime";

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  getCandidate: vi.fn(() => null),
  runtimeForSession: vi.fn(),
  directGrant: vi.fn(),
  production:
    vi.fn<
      (target: {
        appId: string;
        repositoryId: string;
        repositoryFullName: string;
        reviewedHeadSha: string;
      }) => Promise<RepositoryProductionDeliveryStatus>
    >(),
}));
vi.mock("./draft-reconciliation-state", () => ({
  draftReconciliationState: { get: mocks.getCandidate },
}));
vi.mock("eve/tools", () => ({ defineTool: <T>(tool: T): T => tool }));
vi.mock("./workflow-state", () => ({ appBuilderWorkflowState: { get: mocks.getState } }));
vi.mock("./direct-production-state", () => ({ currentDirectProductionGrant: mocks.directGrant }));
vi.mock("./deployment-github-publication-runtime", () => ({
  githubPublicationRuntimeForSession: mocks.runtimeForSession,
}));
vi.mock("./github-production-delivery-readiness", () => ({
  readGitHubProductionDeliveryReadiness: mocks.production,
  githubProductionSetupContinuation: (setup: { preparationRequired: boolean; appId: string }) => ({
    tool: setup.preparationRequired ? "plan-app-production" : "get-app-production",
    input: { appId: setup.appId },
  }),
}));
beforeEach(() => {
  mocks.directGrant.mockReset();
  mocks.production.mockReset();
  // oxlint-disable-next-line eslint/require-await -- This controlled service port resolves without provider work.
  mocks.production.mockImplementation(async ({ appId, repositoryId, repositoryFullName }) => ({
    version: 1,
    appId,
    repositoryId,
    repositoryFullName,
    applicable: false,
  }));
});

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
    releaseGate: { name: "REPOSITORY_RELEASE_ENABLED", configured: false },
    repositoryId: "100",
    title: "Add example page",
    version: GITHUB_PUBLICATION_VERSION,
    visibility: "private",
  } satisfies Omit<DraftPullRequestProposal, "digest">);
  const receipt = signed({
    version: GITHUB_PUBLICATION_VERSION,
    kind: "draft-pull-request",
    status: "succeeded",
    proposalDigest: proposal.digest,
    idempotencyKey,
    approvedByCallId: "draft-approval",
    installationIdentityDigest: proposal.installationIdentityDigest,
    repositoryId: receiptRepositoryId,
    branchName: proposal.branchName,
    branchSha: "8".repeat(40),
    branchTree: "9".repeat(40),
    pullRequestId: "150000",
    pullRequestNumber: 1500,
    draft: true,
    baseBranch: proposal.baseBranch,
    baseSha: proposal.baseSha,
    changeSetDigest: proposal.changeSetDigest,
    changedContentDigest: proposal.changedContentDigest,
    normalizedChangedPaths: proposal.approvedPaths,
    releaseGateUnchanged: true,
    recoveredFromPending: false,
    providerReadBackDigest: "a".repeat(64),
  } satisfies Omit<DraftPullRequestSuccessReceipt, "digest">);
  const observation: GitHubPrDeliveryObservation = {
    baseBranch: receipt.baseBranch,
    checks: "pending",
    draft: true,
    headSha: receipt.branchSha,
    state: "open",
  };
  const inspect = vi.fn<GitHubPrDeliveryProvider["inspect"]>().mockResolvedValue(observation);
  // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
  const unexpected = vi.fn(() => Promise.reject(new Error("Unexpected publication operation")));
  const compareAndSet = vi.fn();
  const inspectExistingDraft = vi.fn().mockImplementation(unexpected);
  const inspectAppliedDraftReconciliation = vi.fn().mockImplementation(unexpected);
  const runtime = composeGitHubPublicationRuntime({
    adapter: {
      createPrivateFreshHistoryRepository: unexpected,
      inspectDestination: unexpected,
      inspectDraftPublication: unexpected,
      inspectAppliedDraftReconciliation,
      inspectExistingDraft,
      inspectFreshRepositoryOutcome: unexpected,
      inspectInstallation: unexpected,
      inspectRepository: unexpected,
      publishDraftPullRequest: unexpected,
      updateExistingDraft: unexpected,
      prDelivery: { inspect, markReady: unexpected, merge: unexpected },
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

it.each(["new-app", "presentation", "unchecked-schema", "checked-schema"])(
  "handles missing managed setup before delivery (%s)",
  async (releaseKind) => {
    const { proposal, reviewedTarget, runtime } = fixture();
    const mutate = vi.fn();
    mocks.getState.mockReturnValue({
      appSpec: { appId: "demo" },
      githubDraftProposal: { proposal },
      phase: "reviewed",
    });
    mocks.runtimeForSession.mockResolvedValue({
      ...runtime,
      runPublishedPullRequestEffect: mutate,
    });
    if (releaseKind !== "new-app") {
      const revision =
        releaseKind === "presentation"
          ? {}
          : {
              schemaChange: {
                kind: "add-optional-text-field",
                priorCueSha256: "1".repeat(64),
                candidateCueSha256: "2".repeat(64),
              },
            };
      mocks.directGrant.mockReturnValue({ subject: { revision } });
    }
    const status: RepositoryProductionDeliveryStatus = {
      version: 1,
      appId: "demo",
      repositoryId: reviewedTarget.repositoryId,
      repositoryFullName: `${reviewedTarget.owner}/${reviewedTarget.name}`,
      applicable: true,
      operationRef: "11111111-1111-4111-8111-111111111111",
      state: "setting-up-data",
      preparationRequired: true,
    };
    if (releaseKind === "checked-schema") {
      status.schemaTransitionVerified = true;
    }
    mocks.production.mockResolvedValue(status);
    // SAFETY: Runtime and prerequisite reads are controlled; the real tool owns approval construction.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Fixture supplies only the fields used through these injected boundaries.
    const result = await readDelivery.execute({}, { session: { auth: {} } } as never);
    if (releaseKind === "checked-schema") {
      expect(result).toMatchObject({
        checks: "deferred",
        nextCall: { tool: "finish-github-pr-delivery" },
        approval: { headSha: reviewedTarget.headSha },
      });
    } else if (releaseKind === "new-app") {
      expect(result).toMatchObject({
        checks: "deferred",
        nextCall: { tool: "plan-app-production", input: { appId: "demo" } },
      });
    } else {
      expect(result).toMatchObject({ status: "production-revision-setup-changed" });
      expect(result).not.toHaveProperty("nextCall");
    }
    if (releaseKind !== "checked-schema") {
      expect(result).not.toHaveProperty("approval");
    }
    expect(mocks.production).toHaveBeenCalledExactlyOnceWith(
      {
        appId: "demo",
        repositoryId: reviewedTarget.repositoryId,
        repositoryFullName: `${reviewedTarget.owner}/${reviewedTarget.name}`,
        reviewedHeadSha: reviewedTarget.headSha,
      },
      expect.anything(),
    );
    expect(mutate).not.toHaveBeenCalled();
  },
);

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
