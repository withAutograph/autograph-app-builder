/* oxlint-disable anti-slop/no-unknown-parameters -- The installed SDK hydration API accepts opaque encrypted/provider values in the controlled world fixture. */
/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- The installed compiled native collector/reconciler expose private runtime modules; only external world/storage ports use controlled fixtures. */
/* oxlint-disable eslint/require-await -- Synthetic provider/storage ports retain their production asynchronous signatures. */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  deriveNormalizedChangeSet,
  createReviewedChangeSetReceipt,
} from "../../repository/reviewed-change-set";
import type { TargetApplyReceipt } from "../../repository/target-apply";
import type { TargetValidationReceipt } from "../../repository/target-validation";
import type { DraftReconciliationCandidate } from "../../agent/draft-reconciliation-state";
import type { DraftReviewedWorkflow } from "../../agent/draft-reviewed-lineage";
import { createPublishedDraftRepairSource } from "../../agent/published-draft-repair";
import { GitHubPublicationTestStore } from "../../repository/github-publication-test-store";
import { parseSourceReceipt } from "../../repository/source-receipt";
import {
  GITHUB_PUBLICATION_VERSION,
  createDraftPullRequestProposal,
  createGitHubInstallationIdentity,
  createRepositoryObservation,
  publishApprovedDraftPullRequest,
  resolveImmutableExistingSource,
} from "../../repository/github-publication";
import type { GitHubPublicationAdapter } from "../../repository/github-publication";
import {
  targetCreationProposalSchema,
  targetIdentitySchema,
} from "../../repository/target-planning";
import {
  recoverDraftReviewedLineage,
  draftReviewedLineageContextKey,
} from "../native-recovery-draft-reviewed-lineage";

const require = createRequire(import.meta.url);
const sdk = path.dirname(require.resolve("eve/package.json"));
export const load = async (file: string) =>
  await import(pathToFileURL(path.join(sdk, "dist/src", file)).href);
const {
  createTerminalRecoveryCandidateCollector,
  readTerminalRecoveryCandidate,
  createOwnedLineagePreflightCollector,
  readOwnedLineagePreflight,
  reconcileOwnedLineagePreflight,
} = await load("execution/session/recovery-candidate.js");
const { reconcileTerminalRecoveryCandidate } = await load(
  "execution/session/recovery-reconciliation.js",
);
const { createDurableSessionState, readDurableSession } = await load(
  "execution/durable-session-store.js",
);
export const { recoverTerminalSession, activateTerminalSession, inspectNativeRecoverySource } =
  await load("execution/session/terminal-recovery.js");
const { emitTurnEpilogue, setHarnessEmissionState } = await load("harness/emission.js");
const serialization = await load("compiled/@workflow/core/serialization.js");
export const workflowKey = "autograph-app-builder.workflow.v17";
export const logical = "physical-ancestor";
export const owner = "physical-source";
const d = "a".repeat(64);
const sha = "b".repeat(40);
export const fixture = () => {
  const execution = {
    appSpecDigest: d,
    artifactRevision: "revision",
    dependencyCacheDigest: d,
    eligibilityDigest: d,
    imageDigest: d,
    sourceReceiptDigest: d,
    sourceSha: sha,
    sourceTree: sha,
    workspaceDigest: d,
  };
  const appSpecPath = ".config/app-specs/orchard.cue";
  const identity = targetIdentitySchema.parse({
    appId: "orchard",
    appSpecPath,
    appSpecSourcePath: appSpecPath,
    baseRoutes: ["/orchard"],
    cueSourcePath: appSpecPath,
    packageName: "@fixture/orchard",
    projectName: "orchard",
    schemaCuePath: "apps/orchard/schema/index.cue",
    title: "Orchard",
    workspacePath: "apps/orchard",
  });
  const target = targetCreationProposalSchema.parse({
    blockers: [],
    contract: { appId: "orchard", appSpec: { path: appSpecPath, sha256: d }, version: 1 },
    mutations: [],
    plan: {
      product: { appSpec: { path: appSpecPath, sha256: d } },
      source: {
        packageName: "@fixture/orchard",
        runtime: "nextjs",
        schema: { kind: "none" },
        workspacePath: "apps/orchard",
      },
      topology: {
        configPath: "microfrontends.json",
        packageName: "@fixture/orchard",
        projectName: "orchard",
        routes: ["/orchard"],
      },
    },
  });
  const apply: TargetApplyReceipt = {
    ...execution,
    appSpecPath,
    appliedByCallId: "apply",
    applyRoot: "/workspace/original",
    changedContentDigest: d,
    changes: [{ after: { digest: d, mode: "644" }, kind: "added", path: "apps/orchard/page.ts" }],
    command: { exitCode: 0, name: "iterate-existing-app", stderrDigest: d, stdoutDigest: d },
    dependencyCacheContentDigest: d,
    dependencyReceiptDigest: d,
    digest: d,
    identityDigest: d,
    planningTreeDigest: d,
    postTree: [],
    postTreeDigest: d,
    preTree: [],
    preTreeDigest: d,
    preparedTreeDigest: d,
    proposalDigest: d,
    status: "applied",
    targetReceipt: {
      appId: "orchard",
      mutations: ["apps/orchard", "microfrontends.json"],
      omittedAuthorities: ["provider-provisioning", "deployment", "production-readiness"],
      recovered: false,
      topology: { newDigest: d, oldDigest: d, path: "microfrontends.json" },
      version: 1,
      workspacePath: "apps/orchard",
    },
    version: 2,
  };
  const validation: TargetValidationReceipt = {
    appId: "orchard",
    ...execution,
    version: 3,
    digest: d,
    status: "passed",
    commands: [
      {
        command: "mise run --no-deps --skip-tools app:check orchard",
        exitCode: 0,
        inputTreeDigest: d,
        name: "check-build",
        stderrDigest: d,
        stdoutDigest: d,
        validationRoot: apply.applyRoot,
      },
    ],
    testShards: ["1/1"],
    appValidationSha256: d,
    appSpecPath,
    dependencyReceiptDigest: d,
    identityDigest: d,
    dependencyCacheContentDigest: d,
    proposalDigest: d,
    applyDigest: d,
    appliedTreeDigest: d,
    changedContentDigest: d,
    attemptDigest: d,
    validatedByCallId: "validate",
  };
  const receipt = createReviewedChangeSetReceipt(
    deriveNormalizedChangeSet(apply, validation, d, d),
    "original-review",
  );
  const reviewed: DraftReviewedWorkflow = {
    appSpec: {
      acceptedByCallId: "accept",
      appId: "orchard",
      artifactPath: "apps/orchard/spec.md",
      artifactRevision: "revision",
      digest: d,
    },
    applyReceipt: apply,
    artifacts: [],
    dependencyReceipt: {
      ...execution,
      cacheContentDigest: d,
      cacheManifestDigest: d,
      dependencyLayout: { kind: "fixture", roots: [], version: 1, workspaceLinks: [] },
      digest: d,
      preparedByCallId: "dependencies",
      targetSha: sha,
      targetTree: sha,
      version: 2,
    },
    githubSource: {
      digest: d,
      installationIdentityDigest: d,
      repository: {
        defaultBranch: "main",
        digest: d,
        headSha: sha,
        headTree: sha,
        installationIdentityDigest: d,
        name: "repository",
        owner: "owner",
        releaseGate: { configured: false, name: "REPOSITORY_RELEASE_ENABLED" },
        repositoryId: "repo",
        version: 2,
        visibility: "private",
      },
      resolvedByCallId: "source",
      resolvedRef: "main",
      resolvedSha: sha,
      resolvedTree: sha,
      version: 2,
    },
    identityReceipt: {
      ...execution,
      digest: d,
      identity,
      resolvedByCallId: "identity",
      version: 1,
    },
    phase: "reviewed",
    preparedByCallId: "prepare",
    proposal: {
      ...execution,
      contractDigest: d,
      digest: d,
      identityDigest: d,
      plannedByCallId: "plan",
      target,
      version: 1,
    },
    reviewReceipt: receipt,
    sourceReceipt: {
      adapter: "arrusted-development-v0",
      contractDigest: d,
      digest: d,
      eligibilityDigest: d,
      releaseEnabled: false,
      sourceKind: "existing-repository",
      sourcePath: "/source",
      sourceSha: sha,
      sourceTree: sha,
      version: 3,
    },
    validationReceipt: validation,
    version: 17,
    workspace: {
      adapter: "arrusted-development-v0",
      eligibilityDigest: d,
      sourcePath: "/source",
      sourceSha: sha,
      sourceTree: sha,
      workspaceDigest: d,
      workspaceId: "workspace",
      workspacePath: "/workspace/repository",
    },
  };
  const { reviewReceipt: _review, ...baseline } = reviewed;
  void _review;
  const candidate = {
    appId: "orchard",
    baseSha: sha,
    baseTree: sha,
    conflicts: [],
    githubSourceDigest: d,
    headSha: sha,
    headTree: sha,
    originalReviewDigest: receipt.digest,
    pullRequestNumber: 42,
    repositoryId: "repo",
    root: "/workspace/same-draft",
    unpublished: "actual unchanged edits",
    version: 1,
    workspaceRoot: "/workspace",
  } satisfies DraftReconciliationCandidate & { unpublished: string };
  const olderContext = {
    "eve.sessionId": logical,
    [workflowKey]: reviewed,
    [draftReviewedLineageContextKey]: {
      ...candidate,
      unpublished: "earlier draft before latest edits",
    },
    unrelated: { preserved: true },
  };
  const currentContext = {
    ...olderContext,
    [draftReviewedLineageContextKey]: candidate,
    [workflowKey]: { ...baseline, phase: "validated" as const },
  };
  const checkpoint = (
    slot: number,
    serializedContext: Parameters<typeof recoverDraftReviewedLineage>[0]["serializedContext"],
  ) => ({
    kind: "terminal-finalizer-input",
    origin: { eventId: `event-${slot}`, slot, stepId: `step-${slot}` },
    serializedContext,
    sessionState: { snapshot: { session: { sessionId: logical } } },
  });
  const old = checkpoint(1, olderContext);
  const current = checkpoint(7, currentContext);
  const descriptor = {
    logicalSessionId: logical,
    operationId: "recover",
    originalAuthoritySessionId: "public-original",
    parentCancellationRevision: 0,
    sourceAdapterGeneration: 1,
    sourceOwnerRunId: owner,
    sourcePublicSessionId: "public-original",
    version: 1,
  };
  const binding = { logicalSessionId: logical, ownerRunId: owner };
  const payload = { binding, candidates: [old, current] };
  const input = {
    binding,
    descriptor,
    payload,
    selectedOrigin: current.origin,
    serializedContext: currentContext,
  };
  return { candidate, current, currentContext, input, old, reviewed };
};

/** Construct real provider-bound owned-publication receipts against a controlled provider. */
export const freshFixture = async () => {
  const f = fixture();
  const sourceEvidence = {
    adapter: f.reviewed.sourceReceipt.adapter,
    contractDigest: d,
    eligibilityDigest: d,
    releaseEnabled: false as const,
    sourceKind: "fresh-template" as const,
    sourceSha: sha,
    sourceTree: sha,
    version: 3 as const,
  };
  const sourceDigest = createHash("sha256").update(JSON.stringify(sourceEvidence)).digest("hex");
  Object.assign(
    f.reviewed.sourceReceipt,
    parseSourceReceipt({ ...sourceEvidence, digest: sourceDigest, sourcePath: "/source" }),
  );
  for (const receipt of [
    f.reviewed.applyReceipt,
    f.reviewed.validationReceipt,
    f.reviewed.identityReceipt,
    f.reviewed.proposal,
    f.reviewed.dependencyReceipt,
  ]) {
    receipt.sourceReceiptDigest = sourceDigest;
  }
  f.reviewed.reviewReceipt = createReviewedChangeSetReceipt(
    deriveNormalizedChangeSet(f.reviewed.applyReceipt, f.reviewed.validationReceipt, d, d),
    "original-review",
  );
  f.candidate.originalReviewDigest = f.reviewed.reviewReceipt.digest;
  delete f.reviewed.githubSource;
  const current = f.currentContext[workflowKey];
  delete current.githubSource;
  const installation = (operation: "resolve-existing-source" | "publish-draft-pull-request") =>
    createGitHubInstallationIdentity({
      accountId: "20",
      accountLogin: "owner",
      accountType: "Organization",
      installationId: "10",
      operation,
      repositorySelection: "selected",
      selectedRepositoryIds: ["100"],
    });
  const publicationInstallation = installation("publish-draft-pull-request");
  const resolutionInstallation = installation("resolve-existing-source");
  const repository = (installationIdentityDigest: string) =>
    createRepositoryObservation({
      defaultBranch: "main",
      headSha: sha,
      headTree: sha,
      installationIdentityDigest,
      name: "repository",
      owner: "owner",
      releaseGate: { configured: false, name: "REPOSITORY_RELEASE_ENABLED" },
      repositoryId: "100",
      visibility: "private",
    });
  const publicationRepository = repository(publicationInstallation.digest);
  const resolutionRepository = repository(resolutionInstallation.digest);
  const proposal = createDraftPullRequestProposal({
    changedPathsSinceBase: [],
    installation: publicationInstallation,
    repository: publicationRepository,
    review: f.reviewed.reviewReceipt,
    title: "Owned draft",
  });
  const unsigned = {
    branch: {
      branchName: proposal.branchName,
      branchSha: sha,
      branchTree: sha,
      changedContentDigest: proposal.changedContentDigest,
      idempotencyKey: proposal.idempotencyKey,
      normalizedChangedPaths: proposal.approvedPaths,
      status: "present" as const,
    },
    changedPathsSinceBase: [],
    idempotencyKey: proposal.idempotencyKey,
    pullRequest: {
      baseBranch: proposal.baseBranch,
      baseRepositoryId: "100",
      baseSha: sha,
      changeSetDigest: proposal.changeSetDigest,
      draft: true as const,
      headBranch: proposal.branchName,
      headRepositoryId: "100",
      headSha: sha,
      idempotencyKey: proposal.idempotencyKey,
      pullRequestId: "400",
      pullRequestNumber: 42,
      status: "present" as const,
    },
    repository: publicationRepository,
    version: GITHUB_PUBLICATION_VERSION,
  };
  const readBack = {
    ...unsigned,
    digest: createHash("sha256").update(JSON.stringify(unsigned)).digest("hex"),
  };
  const unavailable = async (): Promise<never> => {
    throw new Error("Unexpected provider effect");
  };
  const adapter: GitHubPublicationAdapter = {
    createPrivateFreshHistoryRepository: unavailable,
    inspectDestination: unavailable,
    inspectDraftPublication: async () => readBack,
    inspectExistingDraft: unavailable,
    inspectFreshRepositoryOutcome: unavailable,
    inspectInstallation: async (operation) =>
      operation === "resolve-existing-source" ? resolutionInstallation : publicationInstallation,
    inspectRepository: async () => resolutionRepository,
    publishDraftPullRequest: unavailable,
    updateExistingDraft: unavailable,
  };
  const [publication, source] = await Promise.all([
    publishApprovedDraftPullRequest({
      adapter,
      approvedByCallId: "retained-fixture-approval",
      contentSource: { readFile: unavailable },
      proposal,
      review: f.reviewed.reviewReceipt,
      store: new GitHubPublicationTestStore(),
    }),
    resolveImmutableExistingSource({
      adapter,
      expectedInstallationId: "10",
      expectedSha: sha,
      expectedTree: sha,
      ref: `refs/heads/${proposal.branchName}`,
      repositoryId: "100",
      resolvedByCallId: "resolve-owned-draft",
    }),
  ]);
  const repair = createPublishedDraftRepairSource({
    appId: f.reviewed.appSpec.appId,
    appSpecDigest: f.reviewed.appSpec.digest,
    draft: {
      baseBranch: "main",
      baseRepositoryId: "100",
      draft: true,
      headBranch: proposal.branchName,
      headRepositoryId: "100",
      headSha: sha,
      headTree: sha,
      name: "repository",
      number: 42,
      owner: "owner",
      pullRequestId: "400",
      repositoryId: "100",
      state: "open",
      verifiedBuilderOrigin: { appId: "builder", authorId: "builder-user", marker: "owned" },
    },
    installationId: "10",
    originSourceReceiptDigest: f.reviewed.sourceReceipt.digest,
    publicationDigest: publication.digest,
    publicationProposalDigest: proposal.digest,
    source,
  });
  const publicationScope = {
    automaticMergeNonAppDigest: d,
    kind: "owned-publication" as const,
    proposal,
    publication,
  };
  const candidate = Object.assign(f.candidate, {
    githubSourceDigest: source.digest,
    kind: "reconciliation" as const,
    publicationScope,
    publishedOrigin: repair,
    repositoryId: "100",
  });
  Reflect.set(f.old.serializedContext, draftReviewedLineageContextKey, {
    ...candidate,
    unpublished: "earlier draft before latest edits",
  });
  Object.assign(current, { publishedGitHubDraftProposalDigest: proposal.digest });
  Object.assign(f.reviewed, { publishedGitHubDraftProposalDigest: proposal.digest });
  return { ...f, candidate };
};

export const nativeFixture = async (
  options: {
    live?: boolean;
    pendingApproval?: boolean;
    activeTurn?: boolean;
    fresh?: boolean;
    priorOwnerReview?: boolean;
    afterCutoffReview?: boolean;
    beforeCutoffReview?: boolean;
    malformedBeforeCutoff?: "null" | "unknown-phase";
    omitPriorReview?: boolean;
    paginateAncestor?: boolean;
  } = {},
) => {
  const f = options.fresh === true ? await freshFixture() : fixture();
  let session = {
    agent: {
      modelReference: { id: "synthetic", provider: "test" },
      system: "Original brief",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 1e6 },
    continuationToken: "same-continuation",
    history: [
      { content: "Continue the same app", role: "user" },
      { content: "Ready", role: "assistant" },
    ],
    rootSessionId: logical,
    sessionId: logical,
    state: {
      "eve.harness.emission": {
        sequence: 2,
        sessionStarted: true,
        stepIndex: 0,
        ...(options.live === true
          ? { turnId: options.activeTurn === true ? "active-turn" : "" }
          : {}),
      },
    },
  };
  if (options.live === true && options.activeTurn !== true) {
    const emission = await emitTurnEpilogue(
      async () => {
        /* Native event delivery is external to this checkpoint-construction fixture. */
      },
      {
        sequence: 1,
        sessionStarted: true,
        stepIndex: 0,
        turnId: "completed-native-turn",
      },
    );
    session = setHarnessEmissionState(session, emission);
  }
  if (options.pendingApproval === true) {
    const { appendPendingInputBatch } = await load("harness/pending-input-batches.js");
    session = appendPendingInputBatch({
      requests: [
        {
          action: {
            callId: "pending-original-call",
            input: {},
            kind: "tool-call",
            toolName: "provision-original",
          },
          kind: "tool-approval",
          prompt: "Approve resource",
          requestId: "pending-original-approval",
        },
      ],
      responseAuthRequiredRequestIds: ["pending-original-approval"],
      responseMessages: [],
      session,
    });
  }
  let nativeStatus = options.live === true ? "running" : "completed";
  let effectConflict = false;
  const earlier =
    options.omitPriorReview === true
      ? {
          ...f.old,
          serializedContext: {
            ...f.old.serializedContext,
            [workflowKey]: f.currentContext[workflowKey],
          },
        }
      : f.old;
  const priorCutoff = {
    ...f.current,
    origin: { eventId: "event-prior-cutoff", slot: 2, stepId: "step-prior-cutoff" },
    serializedContext: {
      ...f.currentContext,
      [draftReviewedLineageContextKey]: f.old.serializedContext[draftReviewedLineageContextKey],
    },
  };
  const afterCutoff = {
    ...f.old,
    origin: { eventId: "event-after-cutoff", slot: 3, stepId: "step-after-cutoff" },
    serializedContext: { ...f.old.serializedContext, [workflowKey]: fixture().reviewed },
  };
  const priorEntries = [earlier, priorCutoff];
  if (options.beforeCutoffReview === true || options.malformedBeforeCutoff !== undefined) {
    priorEntries.splice(
      1,
      0,
      options.malformedBeforeCutoff === undefined
        ? afterCutoff
        : {
            ...afterCutoff,
            serializedContext: {
              ...afterCutoff.serializedContext,
              [workflowKey]: options.malformedBeforeCutoff === "null" ? null : { phase: "unknown" },
            },
          },
    );
  }
  if (options.afterCutoffReview === true) {
    priorEntries.push(afterCutoff);
  }
  const entries =
    options.priorOwnerReview === true ? [...priorEntries, f.current] : [f.old, f.current];
  const priorEntry = (index: number) =>
    options.priorOwnerReview === true && index < priorEntries.length;
  const steps = await Promise.all(
    entries.map(async (entry, index) => ({
      runId: priorEntry(index) ? "physical-ancestor" : owner,
      status: "completed",
      stepId: entry.origin.stepId,
      stepName:
        options.live === true ? "step//eve//turnStep" : "step//eve//terminateChildSessionsStep",
      ...(options.live === true
        ? {
            output: await serialization.dehydrateStepReturnValue(
              {
                action: "park",
                hasPendingAuthorization: false,
                hasPendingInputBatch: options.pendingApproval ?? false,
                serializedContext: entry.serializedContext,
                sessionState: createDurableSessionState({ session }),
              },
              priorEntry(index) ? "physical-ancestor" : owner,
            ),
          }
        : {
            input: await serialization.dehydrateStepArguments(
              {
                args: [
                  {
                    serializedContext: entry.serializedContext,
                    sessionState: createDurableSessionState({ session }),
                  },
                ],
                closureVars: [],
              },
              priorEntry(index) ? "physical-ancestor" : owner,
            ),
          }),
    })),
  );
  const nativeEvents = steps.map((step, index) => ({
    correlationId: step.stepId,
    eventData: { stepName: step.stepName },
    eventId: `evnt_${String(options.priorOwnerReview === true && step.runId === owner ? index - priorEntries.length + 1 : index + 1).padStart(26, "0")}`,
    eventType: "step_completed",
    runId: step.runId,
  }));
  const paginate = <T>(
    values: T[],
    runId: string,
    pagination?: { sortOrder?: string; cursor?: string; limit?: number },
  ) => {
    const ordered = pagination?.sortOrder === "desc" ? values.toReversed() : values;
    const offset = pagination?.cursor === undefined ? 0 : Number(pagination.cursor);
    const limit =
      options.paginateAncestor === true && runId === "physical-ancestor"
        ? 1
        : (pagination?.limit ?? ordered.length);
    const data = ordered.slice(offset, offset + limit);
    const next = offset + data.length;
    return {
      data,
      hasMore: next < ordered.length,
      ...(next < ordered.length ? { cursor: String(next) } : {}),
    };
  };
  const world = {
    events: {
      get: async (runId: string, eventId: string) => {
        const event = nativeEvents.find(
          (entry) => entry.runId === runId && entry.eventId === eventId,
        );
        if (event === undefined) {
          throw new Error("Unknown native event");
        }
        return event;
      },
      list: async ({
        runId,
        pagination,
      }: {
        runId: string;
        pagination?: { sortOrder?: string; cursor?: string; limit?: number };
      }) =>
        paginate(
          nativeEvents.filter((event) => event.runId === runId),
          runId,
          pagination,
        ),
      listByCorrelationId: async ({
        runId,
        correlationId,
        pagination,
      }: {
        runId: string;
        correlationId: string;
        pagination?: { sortOrder?: string; cursor?: string; limit?: number };
      }) =>
        paginate(
          nativeEvents.filter(
            (event) => event.runId === runId && event.correlationId === correlationId,
          ),
          runId,
          pagination,
        ),
    },
    runs: {
      get: async (runId: string) => ({
        runId,
        status: runId === owner ? nativeStatus : "cancelled",
      }),
    },
    steps: {
      get: async (runId: string, step: string) =>
        steps.find((entry) => entry.runId === runId && entry.stepId === step),
      list: async ({ runId }: { runId: string }) => ({
        data: [
          ...steps.filter((step) => step.runId === runId),
          ...(effectConflict && runId === owner
            ? [
                {
                  runId: owner,
                  status: "running",
                  stepId: "unsettled-provider-effect",
                  stepName: "step//eve//dispatchCoordinationStep",
                },
              ]
            : []),
        ],
        hasMore: false,
      }),
    },
  };
  const collectorPorts = {
    getWorld: async () => world,
    hydrateStepArguments: (value: unknown, run: string, key: unknown) =>
      serialization.hydrateStepArguments(value, run, key, []),
    hydrateStepReturnValue: (value: unknown, run: string, key: unknown) =>
      serialization.hydrateStepReturnValue(value, run, key),
    now: () => 0,
    readDurableSession,
    async *readNativeEvents() {
      yield* [];
    },
    requireEventSlot: (id: string) => Number(id.slice(5)),
    resolveRunEncryptionKey: async () => {
      /* Controlled fixture checkpoints are not encrypted. */
    },
  };
  const { createHistoricalCheckpointVisitor } = await load(
    "execution/session/historical-checkpoints.js",
  );
  const historicalPorts = {
    ...collectorPorts,
    guardWorld: (value: typeof world) => value,
    guardedDependencies: (_authorize: unknown, value: typeof world) => ({
      ...collectorPorts,
      getWorld: async () => value,
    }),
    hydrateHookPayload: async (value: unknown, _run: string, key: unknown) =>
      serialization.deserializePreparedReplayPayload(
        await serialization.prepareReplayPayload(value, key),
      ),
    hydrateWorkflowArguments: (value: unknown, run: string, key: unknown) =>
      serialization.hydrateWorkflowArguments(value, run, key),
  };
  const visitHistoricalCheckpoints = createHistoricalCheckpointVisitor(historicalPorts);
  const collect = createTerminalRecoveryCandidateCollector(collectorPorts);
  let receipt: unknown;
  let hook: { runId: string; metadata: Promise<{ recoveryBinding: unknown }> } | undefined;
  let denied = false;
  const starts: unknown[] = [];
  const ports = {
    applicationStateRecovery: {
      contextKey: draftReviewedLineageContextKey,
      field: "reviewedLineage",
      recover: async (input: Parameters<typeof recoverDraftReviewedLineage>[0]) =>
        recoverDraftReviewedLineage(input),
    },
    authorize: async () => {
      if (denied) {
        throw new Error("owner revoked");
      }
    },
    authorizeActivation: async () => {
      throw new Error("unexpected activation");
    },
    commitReceipt: async ({ recoveryBinding }: { recoveryBinding: unknown }) => {
      receipt = recoveryBinding;
      return recoveryBinding;
    },
    readReceipt: async () => receipt,
  };
  const stopReceipts = new Set<string>();
  const activatedHooks = new Set<string>();
  const deps = {
    collect,
    collectLineagePreflight: createOwnedLineagePreflightCollector(collectorPorts),
    getHook: async () => {
      if (hook === undefined) {
        throw new Error("missing hook");
      }
      return hook;
    },
    inspectSource: async (id: string) => await inspectNativeRecoverySource(world, id),
    isHookNotFound: (error: Error) => error.message === "missing hook",
    now: () => 0,
    readCandidate: readTerminalRecoveryCandidate,
    readEntry: async () => ({
      kind: "initial",
      serializedContext: { "eve.capabilities": { original: true } },
      sessionTimeoutMs: false,
    }),
    readLineagePreflight: readOwnedLineagePreflight,
    readLogicalInboxOwner: async (): Promise<
      { runId: string; logicalSessionId: string } | undefined
    > => {
      if (hook !== undefined) {
        return { logicalSessionId: logical, runId: hook.runId };
      }
      if (nativeStatus === "running") {
        return { logicalSessionId: logical, runId: owner };
      }
      return undefined;
    },
    readStopReceipt: async (id: string, reason: string) => id === owner && stopReceipts.has(reason),
    reconcile: reconcileTerminalRecoveryCandidate,
    reconcileLineagePreflight: reconcileOwnedLineagePreflight,
    resumeHook: async (token: string) => {
      activatedHooks.add(token);
    },
    start: async (input: { descriptor: typeof f.input.descriptor; provenance: unknown }) => {
      starts.push(input);
      hook = {
        metadata: Promise.resolve({
          recoveryBinding: {
            ...input.descriptor,
            ownerRunId: "physical-child",
            provenance: input.provenance,
          },
        }),
        runId: "physical-child",
      };
    },
    stopSource: async (id: string, reason: string) => {
      if (id !== owner) {
        throw new Error("Foreign owner stop");
      }
      nativeStatus = "cancelled";
      stopReceipts.add(reason);
    },
    visitHistoricalCheckpoints,
    wait: async () => {
      throw new Error("unexpected wait");
    },
  };
  return {
    ...f,
    activations: () => activatedHooks.size,
    deps,
    ports,
    revoke: () => {
      denied = true;
    },
    setEffectConflict: (value: boolean) => {
      effectConflict = value;
    },
    setNativeStatus: (value: string) => {
      nativeStatus = value;
    },
    starts,
    stopReceipts,
    world,
  };
};
