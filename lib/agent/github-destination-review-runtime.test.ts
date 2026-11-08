/* oxlint-disable sonarjs/no-wildcard-import -- Type-only namespaces preserve the complete vi.importOriginal module contracts. */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { composeGitHubPublicationRuntime } from "./github-publication-runtime";
import {
  createGitHubDestinationReviewBinding,
  deriveDestinationChanges,
} from "../repository/github-destination-review";
import {
  changedAppTextExport,
  reviewExportChanges,
  destinationReviewReadProgress,
} from "../../agent/tools/change_set_status";
import {
  createGitHubInstallationIdentity,
  createRepositoryObservation,
  GITHUB_PUBLICATION_VERSION,
} from "../repository/github-publication";
import type {
  DraftPublicationReadBack,
  DraftPullRequestProposal,
  DraftPullRequestSuccessReceipt,
  GitHubOperation,
  GitHubPublicationAdapter,
  GitHubPublicationReceiptStore,
  ImmutableGitHubSourceReceipt,
  GitHubMutationPendingReceipt,
} from "../repository/github-publication";
import type { GitHubPublicationProposal } from "../repository/postgres-github-publication-store";
import { createReviewedChangeSetReceipt } from "../repository/reviewed-change-set";
import type { NormalizedChangeSet } from "../repository/reviewed-change-set";
import type { SourceReceiptEvidence } from "../repository/source-receipt";
import { LEGACY_SOURCE_RECEIPT_VERSION } from "../repository/source-receipt";
import { SUPPORTED_TEMPLATE_ADAPTER } from "../repository/supported-template";
import prepareDraftReview from "../../agent/tools/prepare_github_draft_review";
import type { AppBuilderWorkflowState } from "./workflow-state";
import type { GitHubPublicationRuntime } from "./github-publication-runtime";
import type { ExistingDraftReconciliationProposal } from "../repository/github-draft-reconciliation";
import type { priorOwnedAppDraftPublication } from "./existing-app-repair-planning";
import type * as WorkflowStateModule from "./workflow-state";
import type * as RepairPlanningModule from "./existing-app-repair-planning";
import type * as ChangeSetStatusModule from "../../agent/tools/change_set_status";

interface DestinationReviewToolPorts {
  state?: Extract<AppBuilderWorkflowState, { phase: "validated" | "reviewed" }>;
  prior?: ReturnType<typeof priorOwnedAppDraftPublication>;
  runtime?: GitHubPublicationRuntime;
  observed?: { files: { path: string; digest: string; mode: string }[]; treeDigest: string };
  changeSet?: NormalizedChangeSet;
  target?: {
    destination: {
      owner: string;
      name: string;
      repositoryId: string;
      installationId: string;
      defaultBranch: string;
    };
  };
}
const toolPorts = vi.hoisted((): DestinationReviewToolPorts => ({}));
// Only hosted/session/Sandbox ports are controlled; the tool, destination runtime,
// canonical journals, path selection and review invalidation below remain real.
vi.mock("./workflow-state", async (original) => {
  const actual = await original<typeof WorkflowStateModule>();
  return {
    ...actual,
    appBuilderWorkflowState: { get: () => toolPorts.state },
    updateExactWorkflow: (input: {
      expected: AppBuilderWorkflowState;
      operation: string;
      transition: () => typeof toolPorts.state;
    }) => {
      const current = toolPorts.state;
      if (current === undefined) {
        throw new Error("Missing tool workflow fixture");
      }
      actual.assertExactWorkflowState(current, input.expected, input.operation);
      toolPorts.state = input.transition();
    },
  };
});
vi.mock("./existing-app-repair-planning", async (original) => ({
  ...(await original<typeof RepairPlanningModule>()),
  priorOwnedAppDraftPublication: () => toolPorts.prior,
  priorResumedBuildDraftProposal: vi.fn(),
}));
vi.mock("./deployment-github-publication-runtime", () => ({
  githubPublicationRuntimeForSession: () => toolPorts.runtime,
}));
vi.mock("./github-publication-destination", () => ({
  resolvePublicationTargetForTool: () => ({ kind: "ready", target: toolPorts.target }),
}));
vi.mock("./app-baseline-state", () => ({ appBaselineState: { get: vi.fn() } }));
vi.mock("./draft-reconciliation-state", () => ({ draftReconciliationState: { get: () => null } }));
vi.mock("../../agent/tools/change_set_status", async (original) => ({
  ...(await original<typeof ChangeSetStatusModule>()),
  observeNormalizedChangeSet: () => ({
    changeSet: toolPorts.changeSet,
    observed: toolPorts.observed,
  }),
}));

const hash = (
  value:
    | NormalizedChangeSet["changes"]
    | Omit<NormalizedChangeSet, "digest">
    | Omit<GitHubMutationPendingReceipt, "digest">,
) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const installation = (operation: GitHubOperation, installationId = "10") =>
  createGitHubInstallationIdentity({
    accountId: "20",
    accountLogin: "withAutograph",
    accountType: "Organization",
    installationId,
    operation,
    repositorySelection: "selected",
    selectedRepositoryIds: ["100"],
  });
const readInstallation = installation("resolve-existing-source");
const repository = createRepositoryObservation({
  defaultBranch: "main",
  headSha: "1".repeat(40),
  headTree: "2".repeat(40),
  installationIdentityDigest: readInstallation.digest,
  name: "example",
  owner: "withAutograph",
  releaseGate: { configured: false, name: "REPOSITORY_RELEASE_ENABLED" },
  repositoryId: "100",
  visibility: "private",
});
const source: ImmutableGitHubSourceReceipt = {
  digest: "a".repeat(64),
  installationIdentityDigest: readInstallation.digest,
  repository,
  resolvedByCallId: "original-source",
  resolvedRef: "refs/heads/main",
  resolvedSha: "79952fedea119831cc30beab504d3d7d6b271209",
  resolvedTree: "4".repeat(40),
  version: GITHUB_PUBLICATION_VERSION,
};
const path = "apps/example/schema/index.ts";
const before = "65ef3e0c6347d4b901399d48633fdc91af6eb909884227efddb7b61b971f1e01";
const after = "7d13baed047bafdce5448d1daef6222a2b197a8cfdb6de499633d32eb973d835";
const changes = [
  {
    after: { digest: after, mode: "644" },
    before: { digest: before, mode: "644" },
    kind: "modified" as const,
    path,
  },
];
const unsigned = {
  appSpecDigest: "a".repeat(64),
  appSpecPath: "prototype/example/app-spec.md",
  applyDigest: "b".repeat(64),
  approvedPaths: [path],
  artifactRevision: "c".repeat(64),
  changedContentDigest: hash(changes),
  changes,
  contractDigest: "d".repeat(64),
  dependencyCacheContentDigest: "e".repeat(64),
  dependencyCacheDigest: "f".repeat(64),
  dependencyReceiptDigest: "0".repeat(64),
  eligibilityDigest: "1".repeat(64),
  identityDigest: "2".repeat(64),
  imageDigest: `sha256:${"3".repeat(64)}`,
  postTreeDigest: "4".repeat(64),
  preTreeDigest: "5".repeat(64),
  proposalDigest: "6".repeat(64),
  repositoryContractDigest: "7".repeat(64),
  sourceReceiptDigest: "8".repeat(64),
  sourceSha: source.resolvedSha,
  sourceTree: source.resolvedTree,
  targetReceipt: {
    topology: { newDigest: "a".repeat(64), oldDigest: "9".repeat(64), path: "apps.json" },
    version: 1 as const,
  },
  validationDigest: "b".repeat(64),
  version: 2 as const,
  workspaceDigest: "c".repeat(64),
};
const normalized: NormalizedChangeSet = { ...unsigned, digest: hash(unsigned) };
const review = createReviewedChangeSetReceipt(normalized, "destination-review");
const sourceEvidence: SourceReceiptEvidence = {
  adapter: SUPPORTED_TEMPLATE_ADAPTER,
  contractDigest: review.contractDigest,
  digest: review.sourceReceiptDigest,
  eligibilityDigest: review.eligibilityDigest,
  releaseEnabled: false,
  sourceKind: "existing-repository",
  sourceSha: source.resolvedSha,
  sourceTree: source.resolvedTree,
  version: LEGACY_SOURCE_RECEIPT_VERSION,
};
const destination = createGitHubDestinationReviewBinding({
  applyDigest: review.applyDigest,
  candidatePaths: [path],
  installation: readInstallation,
  postTreeDigest: review.postTreeDigest,
  preTree: [{ digest: before, mode: "644", path }],
  repository,
  validationDigest: review.validationDigest,
});

const fixture = () => {
  const unexpected = vi.fn().mockRejectedValue(new Error("Unexpected mutation"));
  const inspectRepository = vi.fn().mockResolvedValue(repository);
  const inspectInstallation = vi
    .fn()
    .mockImplementation(
      async (operation: GitHubOperation) => await Promise.resolve(installation(operation)),
    );
  const inspectDestinationFiles = vi
    .fn<NonNullable<GitHubPublicationAdapter["inspectDestinationFiles"]>>()
    .mockResolvedValue(destination.preTree);
  const inspectDraftPublication = vi.fn<GitHubPublicationAdapter["inspectDraftPublication"]>();
  const compareAndSet = vi
    .fn<GitHubPublicationReceiptStore["compareAndSet"]>()
    .mockResolvedValue(true);
  const readProposal = vi.fn();
  const inspectPr = vi.fn();
  const inspectExistingDraft = vi.fn<GitHubPublicationAdapter["inspectExistingDraft"]>();
  const inspectAppliedDraftReconciliation =
    vi.fn<NonNullable<GitHubPublicationAdapter["inspectAppliedDraftReconciliation"]>>();
  const adapter: GitHubPublicationAdapter = {
    createPrivateFreshHistoryRepository: unexpected,
    inspectDestination: unexpected,
    inspectDestinationFiles,
    inspectDraftPublication,
    inspectExistingDraft,
    inspectAppliedDraftReconciliation,
    inspectFreshRepositoryOutcome: unexpected,
    inspectInstallation,
    inspectRepository,
    publishDraftPullRequest: unexpected,
    updateExistingDraft: unexpected,
    prDelivery: { inspect: inspectPr, markReady: unexpected, merge: unexpected },
  };
  const save = vi.fn(
    async (proposal: GitHubPublicationProposal) => await Promise.resolve(proposal),
  );
  const readReceipt = vi.fn();
  const runtime = composeGitHubPublicationRuntime({
    adapter,
    enabled: true,
    proposals: { read: readProposal, save },
    receipts: { compareAndSet, read: readReceipt },
  });
  return {
    compareAndSet,
    inspectDestinationFiles,
    inspectDraftPublication,
    inspectInstallation,
    inspectRepository,
    readReceipt,
    readProposal,
    inspectPr,
    inspectExistingDraft,
    inspectAppliedDraftReconciliation,
    runtime,
    save,
    unexpected,
  };
};

const sealDraft = async (runtime: ReturnType<typeof fixture>["runtime"]) =>
  await runtime.sealDraftPullRequestProposal({
    destinationReview: destination,
    githubSource: source,
    review,
    source: sourceEvidence,
    title: "Update reviewed schema",
  });

const publishedReceipt = (proposal: DraftPullRequestProposal): DraftPullRequestSuccessReceipt => {
  const body: Omit<DraftPullRequestSuccessReceipt, "digest"> = {
    approvedByCallId: "original-publication-approval",
    baseBranch: proposal.baseBranch,
    baseSha: proposal.baseSha,
    branchName: proposal.branchName,
    branchSha: "5".repeat(40),
    branchTree: "6".repeat(40),
    changedContentDigest: proposal.changedContentDigest,
    changeSetDigest: proposal.changeSetDigest,
    draft: true,
    idempotencyKey: proposal.idempotencyKey,
    installationIdentityDigest: proposal.installationIdentityDigest,
    kind: "draft-pull-request",
    normalizedChangedPaths: proposal.approvedPaths,
    proposalDigest: proposal.digest,
    providerReadBackDigest: "7".repeat(64),
    pullRequestId: "1234",
    pullRequestNumber: 42,
    recoveredFromPending: false,
    releaseGateUnchanged: true,
    repositoryId: proposal.repositoryId,
    status: "succeeded",
    version: GITHUB_PUBLICATION_VERSION,
  };
  return { ...body, digest: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
};

const pendingReceipt = (proposal: DraftPullRequestProposal): GitHubMutationPendingReceipt => {
  const pending = {
    approvedByCallId: "prior-approval",
    idempotencyKey: proposal.idempotencyKey,
    kind: "draft-pull-request" as const,
    proposalDigest: proposal.digest,
    status: "pending" as const,
    version: GITHUB_PUBLICATION_VERSION,
  };
  return { ...pending, digest: hash(pending) };
};

const ownedRevisionTool = async (published = true, marker = true) => {
  const f = fixture();
  const proposal = await sealDraft(f.runtime);
  f.readProposal.mockResolvedValue(proposal);
  const receipt = publishedReceipt(proposal);
  f.readReceipt.mockResolvedValue(published ? receipt : undefined);
  f.inspectPr.mockResolvedValue({
    state: "merged",
    draft: false,
    checks: "passed",
    headSha: receipt.branchSha,
    baseBranch: receipt.baseBranch,
    mergeCommitSha: "9".repeat(40),
  });
  const revision = { ...unsigned, applyDigest: "0".repeat(64), validationDigest: "1".repeat(64) };
  toolPorts.changeSet = { ...revision, digest: hash(revision) };
  // SAFETY: The real tool consumes these workflow fields; history authority is
  // independently exercised through real Eve state in owned-app-revision-history.test.ts.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- Controlled partial workflow fixture; every consumed field is supplied.
  const state = {
    phase: "reviewed",
    appSpec: { appId: "example", digest: normalized.appSpecDigest },
    sourceReceipt: { ...sourceEvidence, sourceKind: "fresh-template" },
    workspace: {
      workspaceId: "retained-workspace",
      workspacePath: "/retained",
      workspaceDigest: "original-workspace",
      sourceSha: source.resolvedSha,
      sourceTree: source.resolvedTree,
    },
    proposal: { target: { operation: "iterate-existing-app" } },
    applyReceipt: {
      digest: revision.applyDigest,
      applyRoot: "/retained",
      targetReceipt: normalized.targetReceipt,
    },
    validationReceipt: { digest: revision.validationDigest },
    reviewReceipt: review,
    githubDraftProposal: {
      proposal,
      sourceReceiptDigest: sourceEvidence.digest,
      destinationReviewDigest: destination.digest,
    },
    ...(marker ? { publishedGitHubDraftProposalDigest: proposal.digest } : {}),
  } as unknown as Extract<AppBuilderWorkflowState, { phase: "reviewed" }>;
  toolPorts.state = state;
  toolPorts.prior = { proposal, installationId: "10", reviewed: state };
  toolPorts.runtime = f.runtime;
  toolPorts.target = {
    destination: {
      owner: repository.owner,
      name: repository.name,
      repositoryId: repository.repositoryId,
      installationId: "10",
      defaultBranch: "main",
    },
  };
  toolPorts.observed = {
    treeDigest: revision.postTreeDigest,
    files: [
      { path, digest: after, mode: "644" },
      { path: "apps/example/package.json", digest: before, mode: "644" },
    ],
  };
  const readTextFile = vi.fn().mockResolvedValue(null);
  const cancellation = new AbortController();
  // SAFETY: The real tool needs only these session and Sandbox read ports.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- The controlled resolver replaces hosted credentials; every tool context port used here is supplied.
  const context = {
    callId: "new-destination-review",
    session: { id: "original-session", auth: undefined, turn: { id: "revision-turn" } },
    getSandbox: () => Promise.resolve({ readTextFile }),
    abortSignal: cancellation.signal,
  } as unknown as Parameters<typeof prepareDraftReview.execute>[1];
  return { ...f, proposal, receipt, state, readTextFile, context, cancellation };
};

describe("same-session post-merge destination review", () => {
  it("reviews total unpublished app changes across config and Auth private iterations", async () => {
    const f = await ownedRevisionTool();
    const priorPaths = [
      "apps/example/next.config.ts",
      "apps/example/src/new.ts",
      "apps/example/src/retired.ts",
      "apps/example/src/reverted.ts",
    ] as const;
    Object.assign(toolPorts.prior ?? {}, { appChangedPaths: priorPaths });
    const preTree = [
      { path, digest: before, mode: "644" },
      { path: priorPaths[0], digest: before, mode: "644" },
      { path: priorPaths[2], digest: before, mode: "644" },
      { path: priorPaths[3], digest: before, mode: "644" },
    ];
    toolPorts.observed = {
      treeDigest: normalized.postTreeDigest,
      files: [
        { path, digest: after, mode: "644" },
        { path: priorPaths[0], digest: after, mode: "644" },
        { path: priorPaths[1], digest: after, mode: "644" },
        { path: priorPaths[3], digest: before, mode: "644" },
        { path: "apps/another-app/page.tsx", digest: after, mode: "644" },
        { path: "packages/platform/index.ts", digest: after, mode: "644" },
      ],
    };
    f.inspectDestinationFiles.mockImplementation(({ paths }) =>
      Promise.resolve(preTree.filter((file) => paths.includes(file.path))),
    );
    await prepareDraftReview.execute({}, f.context);
    const binding = toolPorts.state?.githubDestinationReview;
    if (binding === undefined) {
      throw new Error("Missing refreshed review");
    }
    expect(binding.candidatePaths).toEqual(expect.arrayContaining([path, ...priorPaths]));
    const actual = deriveDestinationChanges(binding, toolPorts.observed);
    expect(actual.map((change) => [change.path, change.kind])).toEqual([
      ["apps/example/next.config.ts", "modified"],
      [path, "modified"],
      ["apps/example/src/new.ts", "added"],
      ["apps/example/src/retired.ts", "deleted"],
    ]);
    expect(f.readTextFile).not.toHaveBeenCalled();
    expect(f.unexpected).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "starts a new PR after the approved published reconciliation merged (marker %s)",
    async (marker) => {
      const f = await ownedRevisionTool(true, marker);
      const reconciliation: ExistingDraftReconciliationProposal = {
        version: 1,
        intendedOutcome: "reconcile-existing-draft-pull-request",
        repositoryId: f.receipt.repositoryId,
        owner: f.proposal.owner,
        name: f.proposal.name,
        pullRequestNumber: f.receipt.pullRequestNumber,
        pullRequestId: f.receipt.pullRequestId,
        branchName: f.proposal.branchName,
        baseBranch: f.proposal.baseBranch,
        expectedHeadSha: f.receipt.branchSha,
        expectedHeadTree: f.receipt.branchTree,
        expectedBaseSha: f.proposal.baseSha,
        expectedBaseTree: f.proposal.baseTree,
        resolvedTree: "e".repeat(40),
        originMarker: f.receipt.idempotencyKey,
        priorPublicationDigest: f.receipt.digest,
        installationIdentityDigest: f.proposal.installationIdentityDigest,
        reviewDigest: "e".repeat(64),
        baseChangesDigest: f.proposal.changeSetDigest,
        headChangesDigest: f.proposal.changeSetDigest,
        idempotencyKey: "a".repeat(64),
        digest: "b".repeat(64),
        approvedPaths: f.proposal.approvedPaths,
      };
      const reconciledHead = "f".repeat(40);
      const { prior } = toolPorts;
      if (prior === undefined) {
        throw new Error("Missing prior publication fixture");
      }
      toolPorts.prior = { ...prior, reconciliation };
      Object.assign(f.state, { existingDraftUpdate: { proposal: { digest: "old-update" } } });
      f.inspectExistingDraft.mockResolvedValue({
        ...reconciliation,
        number: f.receipt.pullRequestNumber,
        headBranch: f.receipt.branchName,
        headSha: reconciledHead,
        headTree: reconciliation.resolvedTree,
        headRepositoryId: f.receipt.repositoryId,
        baseRepositoryId: f.receipt.repositoryId,
        verifiedBuilderOrigin: {
          appId: "builder",
          authorId: "builder",
          marker: f.receipt.idempotencyKey,
        },
        draft: false,
        state: "closed",
      });
      f.inspectAppliedDraftReconciliation.mockResolvedValue(true);
      f.inspectPr.mockResolvedValue({
        state: "merged",
        draft: false,
        checks: "passed",
        headSha: reconciledHead,
        baseBranch: f.receipt.baseBranch,
        mergeCommitSha: "9".repeat(40),
      });
      await prepareDraftReview.execute({}, f.context);
      expect(f.inspectAppliedDraftReconciliation).toHaveBeenCalled();
      expect(f.inspectPr).toHaveBeenCalledWith(
        expect.objectContaining({ headSha: reconciledHead }),
      );
      expect(f.readTextFile).not.toHaveBeenCalled();
      expect(toolPorts.state).toMatchObject({
        phase: "validated",
        sourceReceipt: f.state.sourceReceipt,
        workspace: f.state.workspace,
        applyReceipt: f.state.applyReceipt,
      });
      expect(toolPorts.state).not.toHaveProperty("existingDraftUpdate");
      expect(toolPorts.state).not.toHaveProperty("githubDraftProposal");
      expect(toolPorts.state).not.toHaveProperty("reviewReceipt");
      expect(f.unexpected).not.toHaveBeenCalled();
      // Repeating preparation never restores an old acceptance or update approval.
      await prepareDraftReview.execute({}, f.context);
      expect(f.inspectDestinationFiles).toHaveBeenCalledTimes(2);
      expect(toolPorts.state).not.toHaveProperty("reviewReceipt");
    },
  );

  it("does not treat a private or unverified reconciliation as the merged revision", async () => {
    const f = await ownedRevisionTool();
    const { prior } = toolPorts;
    if (prior === undefined) {
      throw new Error("Missing prior publication fixture");
    }
    // This is deliberately not a provider-proved published reconciliation.
    toolPorts.prior = {
      ...prior,
      reconciliation: {
        installationIdentityDigest: f.proposal.installationIdentityDigest,
        priorPublicationDigest: "8".repeat(64),
      } as ExistingDraftReconciliationProposal,
    };
    Object.assign(f.state, { existingDraftUpdate: { proposal: { digest: "private-update" } } });
    f.inspectPr.mockResolvedValue({
      state: "merged",
      draft: false,
      checks: "passed",
      headSha: "f".repeat(40),
      baseBranch: f.receipt.baseBranch,
      mergeCommitSha: "9".repeat(40),
    });
    await expect(prepareDraftReview.execute({}, f.context)).rejects.toThrow(
      "verified reviewed revision",
    );
    expect(toolPorts.state).toBe(f.state);
    expect(f.inspectDestinationFiles).not.toHaveBeenCalled();
    expect(f.unexpected).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "prepares a narrow revision with a missing original manifest (marker %s)",
    async (marker) => {
      const f = await ownedRevisionTool(true, marker);
      await prepareDraftReview.execute({}, f.context);
      expect(f.readTextFile).not.toHaveBeenCalled();
      expect(f.inspectDestinationFiles).toHaveBeenCalledWith({ paths: [path], repository });
      expect(toolPorts.state).toMatchObject({
        phase: "validated",
        sourceReceipt: f.state.sourceReceipt,
        workspace: f.state.workspace,
        applyReceipt: f.state.applyReceipt,
      });
      expect(toolPorts.state).not.toHaveProperty("reviewReceipt");
      expect(toolPorts.state).not.toHaveProperty("githubDraftProposal");
      expect(toolPorts.state).not.toHaveProperty("publishedGitHubDraftProposalDigest");
      expect(f.unexpected).not.toHaveBeenCalled();
      const refreshed = toolPorts.state?.githubDestinationReview;
      if (refreshed === undefined) {
        throw new Error("Missing refreshed destination review");
      }
      await expect(
        f.runtime.sealDraftPullRequestProposal({
          destinationReview: refreshed,
          githubSource: source,
          review,
          source: sourceEvidence,
          title: "Revision",
        }),
      ).rejects.toThrow();
    },
  );

  it("retains an active draft update when the original tenant journal is absent", async () => {
    const f = await ownedRevisionTool(false, false);
    Object.assign(f.state, { existingDraftUpdate: { proposal: { digest: "retained-update" } } });
    await expect(prepareDraftReview.execute({}, f.context)).rejects.toThrow(
      "existing draft update",
    );
    expect(toolPorts.state).toBe(f.state);
    expect(f.readTextFile).not.toHaveBeenCalled();
    expect(f.inspectPr).not.toHaveBeenCalled();
    expect(f.inspectDestinationFiles).not.toHaveBeenCalled();
  });

  it("keeps a sealed-only first publication on the full-app completeness route", async () => {
    const f = await ownedRevisionTool(false, false);
    const original = [
      { path: "package.json", sha256: before, mode: "100644", objectId: "8".repeat(40) },
    ];
    f.readTextFile.mockResolvedValue(JSON.stringify(original));
    f.state.workspace.workspaceDigest = createHash("sha256")
      .update(JSON.stringify(original))
      .digest("hex");
    await prepareDraftReview.execute({}, f.context);
    expect(f.readTextFile).toHaveBeenCalled();
    expect(f.inspectPr).not.toHaveBeenCalled();
    expect(f.inspectDestinationFiles).toHaveBeenCalledWith({
      paths: expect.arrayContaining([path, "apps/example/package.json"]),
      repository,
    });
  });

  it("does not bypass a missing manifest for an unpublished initial app", async () => {
    const f = await ownedRevisionTool(false, false);
    await expect(prepareDraftReview.execute({}, f.context)).rejects.toThrow("manifest is missing");
    expect(toolPorts.state).toBe(f.state);
    expect(f.inspectDestinationFiles).not.toHaveBeenCalled();
    expect(f.inspectPr).not.toHaveBeenCalled();
  });

  it.each([
    "open",
    "closed",
    "moved",
    "foreign-installation",
    "foreign-app",
    "foreign-repository",
    "unknown-provider",
    "pending",
  ])("does not authorize revision paths from %s publication", async (kind) => {
    const f = await ownedRevisionTool();
    Object.assign(f.state, { existingDraftUpdate: { proposal: { digest: "retained-update" } } });
    if (kind === "open" || kind === "closed") {
      f.inspectPr.mockResolvedValue({
        state: kind,
        draft: false,
        checks: "passed",
        headSha: f.receipt.branchSha,
        baseBranch: f.receipt.baseBranch,
      });
    }
    if (kind === "moved") {
      f.inspectPr.mockResolvedValue({
        state: "merged",
        draft: false,
        checks: "passed",
        headSha: "a".repeat(40),
        baseBranch: f.receipt.baseBranch,
        mergeCommitSha: "9".repeat(40),
      });
    }
    if (kind === "foreign-installation") {
      const { prior } = toolPorts;
      if (prior === undefined) {
        throw new Error("Missing prior publication fixture");
      }
      toolPorts.prior = { ...prior, installationId: "foreign" };
    }
    if (kind === "foreign-app") {
      f.state.appSpec.appId = "foreign";
    }
    if (kind === "foreign-repository") {
      f.inspectRepository.mockResolvedValue(
        createRepositoryObservation({ ...repository, repositoryId: "200" }),
      );
    }
    if (kind === "unknown-provider") {
      f.inspectPr.mockRejectedValue(new Error("Provider result unavailable"));
    }
    if (kind === "pending") {
      f.readReceipt.mockResolvedValue(pendingReceipt(f.proposal));
    }
    await expect(prepareDraftReview.execute({}, f.context)).rejects.toThrow();
    expect(toolPorts.state).toBe(f.state);
    expect(f.readTextFile).not.toHaveBeenCalled();
    expect(f.inspectDestinationFiles).not.toHaveBeenCalled();
    expect(f.unexpected).not.toHaveBeenCalled();
  });

  it("retains the cancelled revision and never reads or replaces destination files", async () => {
    const f = await ownedRevisionTool();
    f.cancellation.abort();
    await expect(prepareDraftReview.execute({}, f.context)).rejects.toThrow();
    expect(toolPorts.state).toBe(f.state);
    expect(f.inspectDestinationFiles).not.toHaveBeenCalled();
    expect(f.unexpected).not.toHaveBeenCalled();
  });

  it("rechecks the workspace after immutable destination preimages return", async () => {
    const f = await ownedRevisionTool();
    f.inspectDestinationFiles.mockImplementation(() => {
      toolPorts.state = { ...f.state, workspace: { ...f.state.workspace, workspaceId: "other" } };
      return Promise.resolve(destination.preTree);
    });
    await expect(prepareDraftReview.execute({}, f.context)).rejects.toThrow("changed concurrently");
    expect(toolPorts.state?.workspace.workspaceId).toBe("other");
    expect(f.unexpected).not.toHaveBeenCalled();
  });

  it("keeps private edits and denies a workspace change during provider reads", async () => {
    const f = await ownedRevisionTool();
    f.inspectPr.mockImplementation(() => {
      toolPorts.state = { ...f.state, workspace: { ...f.state.workspace, workspaceId: "other" } };
      return Promise.resolve({
        state: "merged",
        draft: false,
        checks: "passed",
        headSha: f.receipt.branchSha,
        baseBranch: f.receipt.baseBranch,
        mergeCommitSha: "9".repeat(40),
      });
    });
    await expect(prepareDraftReview.execute({}, f.context)).rejects.toThrow("changed concurrently");
    expect(f.inspectDestinationFiles).not.toHaveBeenCalled();
    expect(f.unexpected).not.toHaveBeenCalled();
  });
});

const pendingReadBackCases = ["absent", "branch-only", "different-head"] as const;

const draftReadBack = (
  proposal: DraftPullRequestProposal,
  observation: (typeof pendingReadBackCases)[number] | "exact",
): DraftPublicationReadBack => {
  const branchSha = "5".repeat(40);
  const body: Omit<DraftPublicationReadBack, "digest"> = {
    version: GITHUB_PUBLICATION_VERSION,
    idempotencyKey: proposal.idempotencyKey,
    repository: createRepositoryObservation({
      defaultBranch: repository.defaultBranch,
      headSha: repository.headSha,
      headTree: repository.headTree,
      installationIdentityDigest: proposal.installationIdentityDigest,
      name: repository.name,
      owner: repository.owner,
      releaseGate: repository.releaseGate,
      repositoryId: repository.repositoryId,
      visibility: repository.visibility,
    }),
    changedPathsSinceBase: [],
    branch:
      observation === "absent"
        ? { status: "absent" }
        : {
            status: "present",
            branchName: proposal.branchName,
            branchSha,
            branchTree: "6".repeat(40),
            normalizedChangedPaths: proposal.approvedPaths,
            changedContentDigest: proposal.changedContentDigest,
            idempotencyKey: proposal.idempotencyKey,
          },
    pullRequest:
      observation === "exact" || observation === "different-head"
        ? {
            status: "present",
            pullRequestId: "1234",
            pullRequestNumber: 42,
            draft: true,
            headRepositoryId: proposal.repositoryId,
            headBranch: proposal.branchName,
            headSha: observation === "exact" ? branchSha : "7".repeat(40),
            baseRepositoryId: proposal.repositoryId,
            baseBranch: proposal.baseBranch,
            baseSha: repository.headSha,
            changeSetDigest: proposal.changeSetDigest,
            idempotencyKey: proposal.idempotencyKey,
          }
        : { status: "absent" },
  };
  return { ...body, digest: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
};

describe("initial draft destination runtime", () => {
  it("reviews both current pointer sides before sealing the same snapshot while retaining original source provenance", async () => {
    const f = fixture();
    const oldBefore = "2e8b47059d77abc6d06d9260d630b0081cb5495e9fb550526b40a92fd717afd4";
    const currentText = 'export * from "./release/2026-10-07.http-expiry-v26/data-server";\n';
    const validatedText =
      'export * from "./release/2026-10-08.authenticated-review-v2/data-server";\n';
    expect(createHash("sha256").update(currentText).digest("hex")).toBe(before);
    expect(createHash("sha256").update(validatedText).digest("hex")).toBe(after);
    const derived = deriveDestinationChanges(destination, {
      files: [{ digest: after, mode: "644", path }],
      treeDigest: "full-checkout",
    });
    expect(derived[0]?.before?.digest).not.toBe(oldBefore);
    expect(derived[0]?.before?.digest).toBe(before);
    const refreshedBody = {
      ...unsigned,
      approvedPaths: derived.map((change) => change.path),
      changedContentDigest: hash(derived),
      changes: derived,
    };
    const refreshed = createReviewedChangeSetReceipt(
      { ...refreshedBody, digest: hash(refreshedBody) },
      "fresh-destination-review",
    );
    const beforeExport = await changedAppTextExport(
      reviewExportChanges(derived, "before"),
      "example",
      async () => await Promise.resolve(currentText),
    );
    const afterExport = await changedAppTextExport(
      reviewExportChanges(derived, "after"),
      "example",
      async () => await Promise.resolve(validatedText),
    );
    expect(beforeExport.exportFiles[0]?.content).toBe(currentText);
    expect(afterExport.exportFiles[0]?.content).toBe(validatedText);
    const beforeRead = destinationReviewReadProgress({
      changeSetDigest: refreshed.changeSetDigest,
      readable: true,
      side: "before",
    });
    const bothRead = destinationReviewReadProgress({
      changeSetDigest: refreshed.changeSetDigest,
      previous: beforeRead,
      readable: true,
      side: "after",
    });
    expect(bothRead).toMatchObject({ afterComplete: true, beforeComplete: true });
    const proposal = await f.runtime.sealDraftPullRequestProposal({
      destinationReview: destination,
      githubSource: source,
      review: refreshed,
      source: sourceEvidence,
      title: "Update reviewed schema",
    });
    expect(proposal).toMatchObject({
      baseSha: destination.repository.headSha,
      baseTree: destination.repository.headTree,
      reviewDigest: refreshed.digest,
    });
    expect(refreshed.sourceSha).toBe("79952fedea119831cc30beab504d3d7d6b271209");
    expect(f.inspectRepository).not.toHaveBeenCalled();
  });
  it.each([...pendingReadBackCases, "unavailable"] as const)(
    "preserves pending publication when readback is %s",
    async (observation) => {
      const f = fixture();
      const proposal = await sealDraft(f.runtime);
      f.readReceipt.mockResolvedValue(pendingReceipt(proposal));
      if (observation === "unavailable") {
        f.inspectDraftPublication.mockRejectedValue(new Error("Provider unavailable"));
      } else {
        f.inspectDraftPublication.mockResolvedValue(draftReadBack(proposal, observation));
      }
      await expect(
        f.runtime.inspectDraftDestination?.({
          existingProposal: proposal,
          githubSource: source,
          paths: [path],
        }),
      ).rejects.toThrow("outcome is unknown");
      expect(f.inspectDraftPublication).toHaveBeenCalledExactlyOnceWith(proposal);
      expect(f.compareAndSet).not.toHaveBeenCalled();
      expect(f.inspectRepository).not.toHaveBeenCalled();
      expect(f.inspectDestinationFiles).not.toHaveBeenCalled();
      expect(f.unexpected).not.toHaveBeenCalled();
    },
  );

  it("settles an exact pending branch and draft readback under the original approval", async () => {
    const f = fixture();
    const proposal = await sealDraft(f.runtime);
    const pending = pendingReceipt(proposal);
    f.readReceipt.mockResolvedValue(pending);
    const readBack = draftReadBack(proposal, "exact");
    f.inspectDraftPublication.mockResolvedValue(readBack);

    const request = { existingProposal: proposal, githubSource: source, paths: [path] };
    await expect(f.runtime.inspectDraftDestination?.(request)).rejects.toThrow("pull request #42");
    expect(f.compareAndSet).toHaveBeenCalledExactlyOnceWith(
      proposal.digest,
      pending.digest,
      expect.objectContaining({
        approvedByCallId: pending.approvedByCallId,
        providerReadBackDigest: readBack.digest,
        pullRequestNumber: 42,
        recoveredFromPending: true,
        status: "succeeded",
      }),
    );

    f.readReceipt.mockResolvedValue(f.compareAndSet.mock.calls[0]?.[2]);
    await expect(f.runtime.inspectDraftDestination?.(request)).rejects.toThrow("pull request #42");
    expect(f.inspectDraftPublication).toHaveBeenCalledExactlyOnceWith(proposal);
    expect(f.inspectRepository).not.toHaveBeenCalled();
    expect(f.inspectDestinationFiles).not.toHaveBeenCalled();
    expect(f.unexpected).not.toHaveBeenCalled();
  });
  it("opens an ordinary review for a sealed-only draft and identifies the same PR after publication", async () => {
    const f = fixture();
    const proposal = await f.runtime.sealDraftPullRequestProposal({
      destinationReview: destination,
      githubSource: source,
      review,
      source: sourceEvidence,
      title: "Update reviewed schema",
    });
    const request = { existingProposal: proposal, githubSource: source, paths: [path] };
    await expect(f.runtime.inspectDraftDestination?.(request)).resolves.toMatchObject({
      repository,
    });

    const published: Omit<DraftPullRequestSuccessReceipt, "digest"> = {
      approvedByCallId: "prior-publication",
      baseBranch: repository.defaultBranch,
      baseSha: proposal.baseSha,
      branchName: proposal.branchName,
      branchSha: "5".repeat(40),
      branchTree: "6".repeat(40),
      changedContentDigest: review.changedContentDigest,
      changeSetDigest: review.changeSetDigest,
      draft: true,
      idempotencyKey: proposal.idempotencyKey,
      installationIdentityDigest: proposal.installationIdentityDigest,
      kind: "draft-pull-request",
      normalizedChangedPaths: [path],
      proposalDigest: proposal.digest,
      providerReadBackDigest: "7".repeat(64),
      pullRequestId: "1234",
      pullRequestNumber: 42,
      recoveredFromPending: false,
      releaseGateUnchanged: true,
      repositoryId: repository.repositoryId,
      status: "succeeded",
      version: GITHUB_PUBLICATION_VERSION,
    };
    f.readReceipt.mockResolvedValue({
      ...published,
      digest: createHash("sha256").update(JSON.stringify(published)).digest("hex"),
    });
    f.inspectRepository.mockClear();
    await expect(f.runtime.inspectDraftDestination?.(request)).rejects.toThrow("pull request #42");
    expect(f.inspectRepository).not.toHaveBeenCalled();
  });
  it("reads destination metadata with source-only authority", async () => {
    const f = fixture();
    await expect(
      f.runtime.inspectDraftDestination?.({ githubSource: source, paths: [path] }),
    ).resolves.toEqual({
      installation: readInstallation,
      preTree: destination.preTree,
      repository,
    });
    expect(f.inspectRepository).toHaveBeenCalledWith({
      operation: "resolve-existing-source",
      ref: "refs/heads/main",
      repositoryId: "100",
    });
    expect(f.inspectInstallation).toHaveBeenCalledWith("resolve-existing-source");
  });

  it("seals the reviewed snapshot with fresh write proof without refreshing its head or preimages", async () => {
    const f = fixture();
    const proposal = await f.runtime.sealDraftPullRequestProposal({
      destinationReview: destination,
      githubSource: source,
      review,
      source: sourceEvidence,
      title: "Update reviewed schema",
    });
    expect(proposal).toMatchObject({
      baseSha: repository.headSha,
      baseTree: repository.headTree,
      changeSetDigest: review.changeSetDigest,
      installationIdentityDigest: installation("publish-draft-pull-request").digest,
      reviewDigest: review.digest,
    });
    expect(f.inspectRepository).not.toHaveBeenCalled();
    expect(f.inspectInstallation).toHaveBeenCalledWith("publish-draft-pull-request");
    expect(review.changes[0]?.before?.digest).toBe(before);
  });

  it("rejects a changed tenant installation instead of rebinding the reviewed destination", async () => {
    const f = fixture();
    f.inspectInstallation.mockResolvedValueOnce(installation("publish-draft-pull-request", "11"));
    await expect(
      f.runtime.sealDraftPullRequestProposal({
        destinationReview: destination,
        githubSource: source,
        review,
        source: sourceEvidence,
        title: "Update reviewed schema",
      }),
    ).rejects.toThrow("selected repository and publication installation");
    expect(f.save).not.toHaveBeenCalled();
  });
});
