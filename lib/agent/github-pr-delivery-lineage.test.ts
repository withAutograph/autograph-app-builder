/* oxlint-disable anti-slop/no-module-mocking -- Control persisted session state and external GitHub reads while exercising the real delivery tool, approval callback and lineage resolver. */
/* oxlint-disable sonarjs/no-internal-api-use -- Isolate actual Eve state in each controlled regression. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApprovalContext } from "eve/tools/approval";
import type { ToolContext } from "eve/tools";
import type { RuntimeSandboxSession, SandboxSession } from "eve/sandbox";
import { z } from "zod";
import { appBuilderWorkflowState } from "./workflow-state";
import { draftReconciliationState } from "./draft-reconciliation-state";
import type { GitHubPublicationRuntime } from "./github-publication-runtime";
import type { GitHubPrDeliveryApproval } from "./github-pr-delivery-approval";
import type { ExistingDraftReconciliationProposal } from "../repository/github-draft-reconciliation";
import { sealExistingDraftReconciliation } from "../repository/github-draft-reconciliation";
import type { ExistingDraftObservation } from "../repository/github-draft-update";
import {
  createGitHubInstallationIdentity,
  createRepositoryObservation,
} from "../repository/github-publication";
import type {
  captureGitHubPrDeliveryAuthority,
  GitHubPrDeliveryOwnerSnapshot,
} from "./github-pr-delivery-authority";
import type { GitHubPrDeliveryOwnerBinding } from "./github-pr-delivery-authority-contract";
import { currentGitHubPrDeliveryAuthorityProjection } from "./github-pr-delivery-authority-state";
import { decideApprovedBuildContinuation } from "./approved-build-continuation";
import {
  assertApprovedPrivateApplySession,
  requestPrivateApplyApproval,
  recordApprovedPrivateApply,
} from "./private-apply-authority";
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import readDelivery from "../../agent/tools/read_github_pr_delivery";
import validateCreation from "../../agent/tools/validate_app_creation";
import reviewCandidate from "../../agent/tools/review_github_draft_pr_reconciliation";
import sealCandidate from "../../agent/tools/seal_github_draft_pr_reconciliation";
import publishCandidate from "../../agent/tools/reconcile_github_draft_pr";
import type { inspectDraftReconciliation } from "../repository/sandbox-draft-reconciliation";
import type { compileAppSchemaRelease } from "../../agent/tools/compile-app-schema-release";
import type {
  publishCompiledOperatorArtifactsForSession,
  assertReconciliationCompletionOwnerForSession,
  recordPublishedReconciliationSourceForSession,
} from "./compiled-operator-artifacts";
import type { getSourceBoundSandbox } from "./source-bound-sandbox";
import type { validationLogStoreForSession } from "./validation-log-store-for-session";
import { approveGitHubPrDelivery } from "./github-pr-delivery-step";
import { freshFixture, workflowKey } from "../eve/test-support/draft-reviewed-recovery";

const mocks = vi.hoisted(() => ({
  inspect: vi.fn<NonNullable<GitHubPublicationRuntime["inspectPublishedPullRequest"]>>(),
  inspectReconciled:
    vi.fn<NonNullable<GitHubPublicationRuntime["inspectPublishedReconciliationHead"]>>(),
  run: vi.fn<NonNullable<GitHubPublicationRuntime["runPublishedPullRequestEffect"]>>(),
  runtimeForSession: vi.fn(),
  captureAuthority: vi.fn<typeof captureGitHubPrDeliveryAuthority>(),
  readOwnerBinding: vi.fn<() => Promise<GitHubPrDeliveryOwnerBinding>>(),
  readOwner: vi.fn<() => Promise<GitHubPrDeliveryOwnerSnapshot>>(),
  persist: vi.fn(),
  stored: new Map<string, GitHubPrDeliveryOwnerSnapshot>(),
  inspectCandidate: vi.fn<typeof inspectDraftReconciliation>(),
  compile: vi.fn<typeof compileAppSchemaRelease>(),
  captureArtifacts: vi.fn<typeof publishCompiledOperatorArtifactsForSession>(),
  assertCompletionOwner: vi.fn<typeof assertReconciliationCompletionOwnerForSession>(),
  recordReconciliationSource: vi.fn<typeof recordPublishedReconciliationSourceForSession>(),
  validationLogStore: vi.fn<typeof validationLogStoreForSession>(),
  seal: vi.fn<GitHubPublicationRuntime["sealExistingDraftReconciliation"]>(),
  inspectApplied: vi.fn<GitHubPublicationRuntime["inspectAppliedExistingDraftReconciliation"]>(),
  publish: vi.fn<GitHubPublicationRuntime["reconcileExistingDraft"]>(),
  sandboxRun: vi.fn<SandboxSession["run"]>(),
  sandboxSpawn: vi.fn<SandboxSession["spawn"]>(),
  sandboxReadText: vi.fn<SandboxSession["readTextFile"]>(),
}));
vi.mock("eve/tools", () => ({ defineTool: <T>(tool: T): T => tool }));
vi.mock("./production-delivery-requirement", () => ({
  managedProductionDeliveryRequirements: { get: () => [] },
  retainManagedProductionDeliveryRequirement: vi.fn(),
}));
afterEach(() => vi.unstubAllEnvs());
vi.mock("./deployment-github-publication-runtime", () => ({
  githubPublicationRuntimeForSession: mocks.runtimeForSession,
}));
vi.mock(import("./github-pr-delivery-authority"), async (importOriginal) => ({
  ...(await importOriginal()),
  captureGitHubPrDeliveryAuthority: mocks.captureAuthority,
}));
vi.mock(import("./source-bound-sandbox"), async (importOriginal) => ({
  ...(await importOriginal()),
  getSourceBoundSandbox: async (ctx: Parameters<typeof getSourceBoundSandbox>[0]) =>
    await ctx.getSandbox(),
}));
vi.mock(import("../repository/sandbox-draft-reconciliation"), async (importOriginal) => ({
  ...(await importOriginal()),
  inspectDraftReconciliation: mocks.inspectCandidate,
}));
vi.mock(import("./compiled-operator-artifacts"), async (importOriginal) => ({
  ...(await importOriginal()),
  publishCompiledOperatorArtifactsForSession: mocks.captureArtifacts,
  assertReconciliationCompletionOwnerForSession: mocks.assertCompletionOwner,
  recordPublishedReconciliationSourceForSession: mocks.recordReconciliationSource,
}));
vi.mock(import("../repository/dependency-cache"), async (importOriginal) => ({
  ...(await importOriginal()),
  attachCheckoutDependencyView: vi.fn(),
  detachCheckoutDependencyView: vi.fn(),
}));
vi.mock("../repository/retire-unused-draft-worktrees", () => ({
  retireUnusedDraftWorktrees: vi.fn(),
}));
vi.mock(import("../../agent/tools/compile-app-schema-release"), async (importOriginal) => ({
  ...(await importOriginal()),
  compileAppSchemaRelease: mocks.compile,
}));
vi.mock(import("../../agent/tools/prepare-app-local-preview"), async (importOriginal) => ({
  ...(await importOriginal()),
  appDeclaresLocalSetup: async () => await Promise.resolve(false),
}));
vi.mock(import("./validation-log-store-for-session"), async (importOriginal) => ({
  ...(await importOriginal()),
  validationLogStoreForSession: mocks.validationLogStore,
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
const unexpectedSandboxOperation = (): never => {
  throw new Error("Unexpected sandbox operation in the delivery lineage fixture");
};
const context: ToolContext = {
  session,
  abortSignal: new AbortController().signal,
  callId: "read-delivery",
  toolName: "read_github_pr_delivery",
  getSandbox: unexpectedSandboxOperation,
  getToken: unexpectedSandboxOperation,
  requireAuth: unexpectedSandboxOperation,
};
const owner: GitHubPrDeliveryOwnerBinding = {
  ownerKey: "controlled-tenant-owner",
  adapterSessionId: session.id,
  adapterGeneration: 1,
  cancellationRevision: 0,
};
const approvePrivateBuild = () => {
  const workflow = appBuilderWorkflowState.get();
  if (!("proposal" in workflow)) {
    throw new Error("The controlled app has no Build proposal");
  }
  const scope = {
    appId: workflow.appSpec.appId,
    appSpecDigest: workflow.appSpec.digest,
    proposalDigest: workflow.proposal.digest,
    sessionId: session.id,
    workspaceId: workflow.workspace.workspaceId,
  };
  expect(requestPrivateApplyApproval(scope, "approved-private-build")).toBe("user-approval");
  recordApprovedPrivateApply(scope, "approved-private-build");
};
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

const recovered = async (approvedBuild = true) => {
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
  appBuilderWorkflowState.update(() => workflow);
  draftReconciliationState.update(() => candidate);
  if (approvedBuild) {
    approvePrivateBuild();
  }
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

const emptyOutput = () =>
  new ReadableStream<Uint8Array>({
    start(stream) {
      stream.close();
    },
  });

beforeEach(() => {
  vi.stubEnv("REPOSITORY_PRODUCTION_OPERATOR_URL", "");
  vi.resetAllMocks();
  mocks.stored.clear();
  mocks.runtimeForSession.mockResolvedValue({
    inspectPublishedPullRequest: mocks.inspect,
    inspectPublishedReconciliationHead: mocks.inspectReconciled,
    runPublishedPullRequestEffect: mocks.run,
    sealExistingDraftReconciliation: mocks.seal,
    inspectAppliedExistingDraftReconciliation: mocks.inspectApplied,
    reconcileExistingDraft: mocks.publish,
  });
  mocks.readOwnerBinding.mockResolvedValue(owner);
  mocks.readOwner.mockImplementation(async () => {
    await Promise.resolve();
    const stored = mocks.stored.get("current");
    if (stored === undefined || stored.decision.adapterSessionId !== owner.adapterSessionId) {
      throw new Error(
        "Builder could not verify this delivery call’s current reviewed app and owner.",
      );
    }
    return stored;
  });
  mocks.persist.mockImplementation(async (ctx: ApprovalContext<GitHubPrDeliveryApproval>) => {
    const decision = decideApprovedBuildContinuation({
      adapterSessionId: ctx.session.id,
      approvalMatches: (scope) => {
        assertApprovedPrivateApplySession(scope);
        return true;
      },
      blocked: false,
      pendingInput: false,
      state: appBuilderWorkflowState.get(),
      turnId: ctx.session.turn.id,
      turnSequence: ctx.session.turn.sequence,
    });
    mocks.stored.set("current", {
      owner,
      decision: { ...decision, githubDelivery: currentGitHubPrDeliveryAuthorityProjection() },
    });
    await Promise.resolve();
  });
  mocks.captureAuthority.mockImplementation(async (input, ctx) => {
    const actual = await vi.importActual<{
      captureGitHubPrDeliveryAuthority: typeof captureGitHubPrDeliveryAuthority;
    }>("./github-pr-delivery-authority");
    await actual.captureGitHubPrDeliveryAuthority(input, ctx, {
      readOwnerBinding: mocks.readOwnerBinding,
      readOwner: mocks.readOwner,
      persist: mocks.persist,
    });
  });
  mocks.sandboxRun.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  mocks.sandboxSpawn.mockImplementation(async () => {
    await Promise.resolve();
    return {
      stdout: emptyOutput(),
      stderr: emptyOutput(),
      wait: async () => await Promise.resolve({ exitCode: 0 }),
      async kill() {
        await Promise.resolve();
      },
    };
  });
  mocks.sandboxReadText.mockResolvedValue(JSON.stringify({ scripts: { test: "vitest run" } }));
  mocks.compile.mockResolvedValue({
    status: "compiled",
    command: "mise run --no-deps app:compile orchard",
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
  mocks.assertCompletionOwner.mockResolvedValue();
  mocks.validationLogStore.mockRejectedValue(
    new Error("Controlled validation log storage unavailable"),
  );
  mocks.recordReconciliationSource.mockImplementation(
    async (input) =>
      await Promise.resolve({
        status: "recorded",
        destination: {
          version: 1,
          appId: input.completion.appId,
          appSpecDigest: input.completion.appReview.appSpecDigest,
          publishedSource: input.publishedSource,
        },
      }),
  );
});

/** Run the normal tools in one parent; only sandbox/provider/storage observations are controlled. */
const publishValidatedCandidate = async () => {
  const f = await recovered();
  const { publishedReconciliation: priorPublication, ...unpublished } = f.candidate;
  void priorPublication;
  draftReconciliationState.update(() => unpublished);
  const { changes } = f.candidate.reviewedLineage.applyReceipt;
  mocks.inspectCandidate.mockResolvedValue({
    baseChanges: changes,
    headChanges: changes,
    resolvedTree: f.reconciliation.resolvedTree,
    unresolvedConflicts: [],
  });
  mocks.captureArtifacts.mockResolvedValue({
    status: "not-required",
    compilation: {
      context: {
        authority: {
          issuer: "https://builder.example.test",
          audience: "builder",
          workspaceId: "tenant-workspace",
          ownerUserId: principal.principalId,
        },
        target: { appId: f.workflow.appSpec.appId, sessionId: session.id },
      },
      release: { status: "not-required" },
    },
  });
  const sandbox: RuntimeSandboxSession = {
    delete: unexpectedSandboxOperation,
    stop: unexpectedSandboxOperation,
    removePath: unexpectedSandboxOperation,
    resolvePath: unexpectedSandboxOperation,
    readFile: unexpectedSandboxOperation,
    readBinaryFile: unexpectedSandboxOperation,
    writeFile: unexpectedSandboxOperation,
    writeTextFile: unexpectedSandboxOperation,
    writeBinaryFile: unexpectedSandboxOperation,
    run: mocks.sandboxRun,
    spawn: mocks.sandboxSpawn,
    readTextFile: mocks.sandboxReadText,
  };
  const candidateContext: ToolContext = {
    ...context,
    callId: "owned-candidate-validation",
    getSandbox: async () => await Promise.resolve(sandbox),
    toolName: "validate_app_creation",
  };
  const workflowBefore = structuredClone(appBuilderWorkflowState.get());
  const validation = await validateCreation.execute({ implementationFiles: [] }, candidateContext);
  expect(validation).toMatchObject({
    status: "validated",
    nextCall: { tool: "review_github_draft_pr_reconciliation", input: {} },
  });
  expect(mocks.sandboxRun).toHaveBeenCalled();
  expect(
    mocks.sandboxRun.mock.calls.every(([input]) => input.workingDirectory === unpublished.root),
  ).toBe(true);
  expect(draftReconciliationState.get()?.review).toBeUndefined();
  const review = z
    .object({ reviewDigest: z.string(), resolvedTree: z.string() })
    .parse(
      await reviewCandidate.execute({}, { ...candidateContext, callId: "owned-candidate-review" }),
    );
  expect(draftReconciliationState.get()?.review?.digest).toBe(review.reviewDigest);
  expect(review.reviewDigest).not.toBe(f.candidate.originalReviewDigest);
  expect(appBuilderWorkflowState.get()).toEqual(workflowBefore);

  const { publicationScope } = f.candidate;
  const { proposal: original, publication } = publicationScope;
  const installation = createGitHubInstallationIdentity({
    accountId: "20",
    accountLogin: original.owner,
    accountType: "Organization",
    installationId: f.approval.installationId,
    operation: "publish-draft-pull-request",
    repositorySelection: "selected",
    selectedRepositoryIds: [original.repositoryId],
  });
  const repository = createRepositoryObservation({
    defaultBranch: original.baseBranch,
    headSha: unpublished.baseSha,
    headTree: unpublished.baseTree,
    installationIdentityDigest: installation.digest,
    name: original.name,
    owner: original.owner,
    releaseGate: { configured: false, name: "REPOSITORY_RELEASE_ENABLED" },
    repositoryId: original.repositoryId,
    visibility: "private",
  });
  const observed: ExistingDraftObservation = {
    repositoryId: repository.repositoryId,
    owner: repository.owner,
    name: repository.name,
    number: unpublished.pullRequestNumber,
    pullRequestId: publication.pullRequestId,
    draft: true,
    state: "open",
    baseBranch: original.baseBranch,
    baseRepositoryId: original.repositoryId,
    headBranch: original.branchName,
    headRepositoryId: original.repositoryId,
    headSha: unpublished.headSha,
    headTree: unpublished.headTree,
    verifiedBuilderOrigin: {
      appId: "builder",
      authorId: "builder-user",
      marker: original.idempotencyKey,
    },
  };
  mocks.inspectApplied.mockResolvedValue({ applied: false, observation: observed });
  mocks.seal.mockImplementation(
    async (input) =>
      await sealExistingDraftReconciliation({
        installation,
        repository,
        review: input.review,
        pullRequestNumber: unpublished.pullRequestNumber,
        selectedSourceRef: `refs/heads/${original.branchName}`,
        priorPublicationDigest: publication.digest,
        originMarker: original.idempotencyKey,
        adapter: {
          inspectInstallation: async () => await Promise.resolve(installation),
          inspectRepository: async () => await Promise.resolve(repository),
          inspectExistingDraft: async () => await Promise.resolve(observed),
          reconcileExistingDraft: unexpectedSandboxOperation,
          inspectAppliedDraftReconciliation: unexpectedSandboxOperation,
        },
      }),
  );
  const sealed = await sealCandidate.execute(
    { expectedReviewDigest: review.reviewDigest },
    { ...candidateContext, callId: "owned-candidate-seal" },
  );
  if (!("approvalReceipt" in sealed)) {
    throw new Error("The controlled sealing call did not return its approval receipt");
  }
  const proposal = draftReconciliationState.get()?.proposal;
  if (proposal === undefined) {
    throw new Error("The normal sealing tool did not retain its proposal");
  }
  expect(proposal.reviewDigest).toBe(review.reviewDigest);
  mocks.publish.mockResolvedValue({
    repositoryId: proposal.repositoryId,
    owner: proposal.owner,
    name: proposal.name,
    number: proposal.pullRequestNumber,
    pullRequestId: proposal.pullRequestId,
    draft: true,
    state: "open",
    headRepositoryId: proposal.repositoryId,
    headBranch: proposal.branchName,
    headSha: f.approval.headSha,
    headTree: proposal.resolvedTree,
    baseRepositoryId: proposal.repositoryId,
    baseBranch: proposal.baseBranch,
  });
  await publishCandidate.execute(
    { expectedProposalDigest: proposal.digest, approvalReceipt: sealed.approvalReceipt },
    { ...candidateContext, callId: "approved-candidate-publication" },
  );
  expect(mocks.publish.mock.calls[0]?.[0]).toMatchObject({ proposal });
  expect(mocks.publish.mock.calls[0]?.[0].review.digest).toBe(review.reviewDigest);
  expect(draftReconciliationState.get()?.publishedReconciliation?.digest).toBe(proposal.digest);
  expect(appBuilderWorkflowState.get()).toEqual(workflowBefore);
  expect(mocks.captureAuthority).not.toHaveBeenCalled();
  const approval = { ...f.approval, reconciliationDigest: proposal.digest };
  await expect(readDelivery.execute({}, context)).resolves.toMatchObject({ approval });
  return { approval, proposal, workflowBefore };
};

it.each(["missing", "stale"] as const)(
  "captures first Ready after candidate validation, review and publication with a %s canonical projection",
  async (projection) => {
    await contextStorage.run(new ContextContainer(), async () => {
      const f = await publishValidatedCandidate();
      if (projection === "stale") {
        const decision = decideApprovedBuildContinuation({
          adapterSessionId: "retired-owner-run",
          approvalMatches: () => false,
          blocked: false,
          pendingInput: false,
          state: appBuilderWorkflowState.get(),
          turnId: "old-turn",
          turnSequence: 0,
        });
        mocks.stored.set("current", { owner, decision });
      }
      await expect(approve(f.approval)).resolves.toBe("user-approval");
      expect(mocks.persist).toHaveBeenCalledOnce();
      expect(mocks.stored.get("current")?.decision.githubDelivery?.calls).toHaveLength(1);
      expect(mocks.stored.get("current")?.decision.githubDelivery?.calls[0]).toMatchObject({
        callId: "lineage-delivery-call",
        owner,
        subject: {
          proposalDigest: f.approval.proposalDigest,
          reconciliationDigest: f.proposal.digest,
        },
      });
      expect(appBuilderWorkflowState.get()).toEqual(f.workflowBefore);
      expect(mocks.run).not.toHaveBeenCalled();
    });
  },
);

it("refuses a moved published head after the same candidate sequence before capturing Ready", async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    const f = await publishValidatedCandidate();
    mocks.inspectReconciled.mockResolvedValue("0".repeat(40));
    await expect(approve(f.approval)).resolves.toMatchObject({ type: "denied" });
    expect(mocks.readOwnerBinding).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

it("refuses a changed owner after the same candidate sequence before offering Ready approval", async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    const f = await publishValidatedCandidate();
    mocks.readOwnerBinding.mockResolvedValue({ ...owner, ownerKey: "another-owner" });
    await expect(approve(f.approval)).rejects.toThrow();
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

it("refuses a projection label without the underlying exact private Build grant", async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    const f = await recovered(false);
    mocks.stored.set("current", {
      owner,
      decision: decideApprovedBuildContinuation({
        adapterSessionId: session.id,
        approvalMatches: () => true,
        blocked: false,
        pendingInput: false,
        state: appBuilderWorkflowState.get(),
        turnId: session.turn.id,
        turnSequence: session.turn.sequence,
      }),
    });
    await expect(approve(f.approval)).rejects.toThrow();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

it("reads the provider-proved published head after validation without changing the retained private candidate", async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    const f = await recovered();
    const before = structuredClone(f);
    const result = await readDelivery.execute({}, context);
    expect(result).toMatchObject({ checks: "deferred", approval: f.approval });
    expect(mocks.runtimeForSession).toHaveBeenCalledWith(session.auth, {
      selectedInstallationId: f.approval.installationId,
    });
    expect(mocks.inspectReconciled).toHaveBeenCalledWith(
      f.approval.proposalDigest,
      f.reconciliation,
    );
    expect(mocks.inspect).toHaveBeenCalledWith(f.approval.proposalDigest, f.approval.headSha);
    expect(f).toEqual(before);
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

it("requests native approval for that exact published reconciliation after validation", async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    const f = await recovered();
    await expect(approve(f.approval)).resolves.toBe("user-approval");
    expect(mocks.inspectReconciled).toHaveBeenCalledWith(
      f.approval.proposalDigest,
      f.reconciliation,
    );
    expect(mocks.captureAuthority).toHaveBeenCalledWith(
      f.approval,
      expect.objectContaining({ session, callId: "lineage-delivery-call" }),
    );
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

it("does not offer native approval when canonical owner capture fails", async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    const f = await recovered();
    const ownerChanged = new Error("Current delivery owner changed");
    mocks.readOwnerBinding.mockRejectedValue(ownerChanged);
    await expect(approve(f.approval)).rejects.toBe(ownerChanged);
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

it("honors native cancellation before capturing approval scope", async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    const f = await recovered();
    const controller = new AbortController();
    const cancelled = new Error("Creator cancelled delivery");
    controller.abort(cancelled);
    await expect(approve(f.approval, controller.signal)).rejects.toBe(cancelled);
    expect(mocks.captureAuthority).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

it.each(["applied", "validated"] as const)(
  "retains the same owned publication during %s without accepting the private proposal",
  async (phase) => {
    await contextStorage.run(new ContextContainer(), async () => {
      const f = await recovered();
      appBuilderWorkflowState.update(() => ({ ...f.workflow, phase }));
      f.candidate.proposal = { ...f.reconciliation, digest: "1".repeat(64) };
      const result = await readDelivery.execute({}, context);
      expect(result).toMatchObject({ approval: f.approval });
      await expect(
        approve({ ...f.approval, proposalDigest: f.candidate.proposal.digest }),
      ).resolves.toMatchObject({
        type: "denied",
      });
      expect(mocks.run).not.toHaveBeenCalled();
    });
  },
);

it.each(["app", "spec", "source", "workspace", "apply-root", "publication"] as const)(
  "refuses changed %s lineage before reading GitHub or offering approval",
  async (binding) => {
    await contextStorage.run(new ContextContainer(), async () => {
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
    });
  },
);

it("retains the original publication when a current review has another sealed private proposal", async () => {
  await contextStorage.run(new ContextContainer(), async () => {
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
    appBuilderWorkflowState.update(() => current);
    await expect(readDelivery.execute({}, context)).resolves.toMatchObject({
      approval: f.approval,
    });
    await expect(
      approve({ ...f.approval, proposalDigest: current.githubDraftProposal.proposal.digest }),
    ).resolves.toMatchObject({
      type: "denied",
    });
  });
});

it("does not offer or accept delivery approval without fresh proof of the published reconciliation", async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    const f = await recovered();
    mocks.inspectReconciled.mockResolvedValue(null);
    await expect(readDelivery.execute({}, context)).resolves.not.toHaveProperty("approval");
    await expect(approve(f.approval)).resolves.toMatchObject({ type: "denied" });
    mocks.inspectReconciled.mockResolvedValue("0".repeat(40));
    await expect(approve(f.approval)).resolves.toMatchObject({ type: "denied" });
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

it("rejects another session, installation or reconciliation rather than borrowing its approval", async () => {
  await contextStorage.run(new ContextContainer(), async () => {
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
});
