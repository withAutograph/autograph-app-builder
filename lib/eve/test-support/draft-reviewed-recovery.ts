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
const ORCHARD_PACKAGE_NAME = "@fixture/orchard";
const ORCHARD_WORKSPACE_PATH = "apps/orchard";
const TOPOLOGY_CONFIG_PATH = "microfrontends.json";
const d = "a".repeat(64);
const sha = "b".repeat(40);
export const fixture = () => {
  const execution = {
    sourceSha: sha,
    sourceTree: sha,
    sourceReceiptDigest: d,
    eligibilityDigest: d,
    workspaceDigest: d,
    imageDigest: d,
    dependencyCacheDigest: d,
    appSpecDigest: d,
    artifactRevision: "revision",
  };
  const appSpecPath = ".config/app-specs/orchard.cue";
  const identity = targetIdentitySchema.parse({
    appId: "orchard",
    appSpecPath,
    appSpecSourcePath: appSpecPath,
    baseRoutes: ["/orchard"],
    cueSourcePath: appSpecPath,
    packageName: ORCHARD_PACKAGE_NAME,
    projectName: "orchard",
    schemaCuePath: "apps/orchard/schema/index.cue",
    title: "Orchard",
    workspacePath: ORCHARD_WORKSPACE_PATH,
  });
  const target = targetCreationProposalSchema.parse({
    blockers: [],
    contract: { appId: "orchard", appSpec: { path: appSpecPath, sha256: d }, version: 1 },
    mutations: [],
    plan: {
      product: { appSpec: { path: appSpecPath, sha256: d } },
      source: {
        packageName: ORCHARD_PACKAGE_NAME,
        runtime: "nextjs",
        schema: { kind: "none" },
        workspacePath: ORCHARD_WORKSPACE_PATH,
      },
      topology: {
        configPath: TOPOLOGY_CONFIG_PATH,
        packageName: ORCHARD_PACKAGE_NAME,
        projectName: "orchard",
        routes: ["/orchard"],
      },
    },
  });
  const apply: TargetApplyReceipt = {
    ...execution,
    version: 2,
    status: "applied",
    appSpecPath,
    changedContentDigest: d,
    changes: [{ kind: "added", path: "apps/orchard/page.ts", after: { mode: "644", digest: d } }],
    dependencyCacheContentDigest: d,
    dependencyReceiptDigest: d,
    identityDigest: d,
    postTreeDigest: d,
    preTreeDigest: d,
    proposalDigest: d,
    targetReceipt: {
      appId: "orchard",
      mutations: [ORCHARD_WORKSPACE_PATH, TOPOLOGY_CONFIG_PATH],
      omittedAuthorities: ["provider-provisioning", "deployment", "production-readiness"],
      recovered: false,
      topology: { path: TOPOLOGY_CONFIG_PATH, oldDigest: d, newDigest: d },
      version: 1,
      workspacePath: ORCHARD_WORKSPACE_PATH,
    },
    planningTreeDigest: d,
    preparedTreeDigest: d,
    preTree: [],
    postTree: [],
    appliedByCallId: "apply",
    command: { name: "iterate-existing-app", exitCode: 0, stdoutDigest: d, stderrDigest: d },
    digest: d,
    applyRoot: "/workspace/original",
  };
  const validation: TargetValidationReceipt = {
    appId: "orchard",
    ...execution,
    version: 3,
    digest: d,
    status: "passed",
    commands: [
      {
        name: "check-build",
        command: "mise run --no-deps --skip-tools app:check orchard",
        validationRoot: apply.applyRoot,
        inputTreeDigest: d,
        exitCode: 0,
        stdoutDigest: d,
        stderrDigest: d,
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
    version: 17,
    phase: "reviewed",
    appSpec: {
      appId: "orchard",
      digest: d,
      artifactPath: "apps/orchard/spec.md",
      artifactRevision: "revision",
      acceptedByCallId: "accept",
    },
    applyReceipt: apply,
    validationReceipt: validation,
    reviewReceipt: receipt,
    sourceReceipt: {
      version: 3,
      digest: d,
      sourceKind: "existing-repository",
      sourceSha: sha,
      sourceTree: sha,
      adapter: "arrusted-development-v0",
      eligibilityDigest: d,
      contractDigest: d,
      releaseEnabled: false,
      sourcePath: "/source",
    },
    githubSource: {
      version: 2,
      digest: d,
      installationIdentityDigest: d,
      resolvedByCallId: "source",
      resolvedRef: "main",
      resolvedSha: sha,
      resolvedTree: sha,
      repository: {
        version: 2,
        repositoryId: "repo",
        owner: "owner",
        name: "repository",
        headSha: sha,
        headTree: sha,
        defaultBranch: "main",
        visibility: "private",
        releaseGate: { configured: false, name: "REPOSITORY_RELEASE_ENABLED" },
        installationIdentityDigest: d,
        digest: d,
      },
    },
    identityReceipt: {
      ...execution,
      version: 1,
      identity,
      resolvedByCallId: "identity",
      digest: d,
    },
    proposal: {
      ...execution,
      version: 1,
      digest: d,
      contractDigest: d,
      identityDigest: d,
      target,
      plannedByCallId: "plan",
    },
    workspace: {
      workspaceId: "workspace",
      workspacePath: "/workspace/repository",
      sourcePath: "/source",
      sourceSha: sha,
      sourceTree: sha,
      workspaceDigest: d,
      adapter: "arrusted-development-v0",
      eligibilityDigest: d,
    },
    dependencyReceipt: {
      ...execution,
      version: 2,
      targetSha: sha,
      targetTree: sha,
      cacheManifestDigest: d,
      cacheContentDigest: d,
      dependencyLayout: { kind: "fixture", roots: [], version: 1, workspaceLinks: [] },
      preparedByCallId: "dependencies",
      digest: d,
    },
    artifacts: [],
    preparedByCallId: "prepare",
  };
  const { reviewReceipt: _review, ...baseline } = reviewed;
  void _review;
  const candidate = {
    workspaceRoot: "/workspace",
    headSha: sha,
    headTree: sha,
    baseSha: sha,
    baseTree: sha,
    conflicts: [],
    version: 1,
    appId: "orchard",
    githubSourceDigest: d,
    originalReviewDigest: receipt.digest,
    repositoryId: "repo",
    pullRequestNumber: 42,
    root: "/workspace/same-draft",
    unpublished: "actual unchanged edits",
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
    origin: { slot, stepId: `step-${slot}`, eventId: `event-${slot}` },
    serializedContext,
    sessionState: { snapshot: { session: { sessionId: logical } } },
  });
  const old = checkpoint(1, olderContext);
  const current = checkpoint(7, currentContext);
  const descriptor = {
    version: 1,
    operationId: "recover",
    sourcePublicSessionId: "public-original",
    sourceOwnerRunId: owner,
    sourceAdapterGeneration: 1,
    logicalSessionId: logical,
    originalAuthoritySessionId: "public-original",
    parentCancellationRevision: 0,
  };
  const binding = { ownerRunId: owner, logicalSessionId: logical };
  const payload = { binding, candidates: [old, current] };
  const input = {
    descriptor,
    binding,
    payload,
    selectedOrigin: current.origin,
    serializedContext: currentContext,
  };
  return { candidate, current, currentContext, input, old, reviewed };
};

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
    installation: publicationInstallation,
    repository: publicationRepository,
    review: f.reviewed.reviewReceipt,
    changedPathsSinceBase: [],
    title: "Owned draft",
  });
  const unsigned = {
    version: GITHUB_PUBLICATION_VERSION,
    idempotencyKey: proposal.idempotencyKey,
    repository: publicationRepository,
    changedPathsSinceBase: [],
    branch: {
      status: "present" as const,
      branchName: proposal.branchName,
      branchSha: sha,
      branchTree: sha,
      changedContentDigest: proposal.changedContentDigest,
      idempotencyKey: proposal.idempotencyKey,
      normalizedChangedPaths: proposal.approvedPaths,
    },
    pullRequest: {
      status: "present" as const,
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
    },
  };
  const readBack = {
    ...unsigned,
    digest: createHash("sha256").update(JSON.stringify(unsigned)).digest("hex"),
  };
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this helper scoped to its fixture or invocation.
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
      store: new GitHubPublicationTestStore(),
      proposal,
      review: f.reviewed.reviewReceipt,
      approvedByCallId: "retained-fixture-approval",
      contentSource: { readFile: unavailable },
    }),
    resolveImmutableExistingSource({
      adapter,
      expectedInstallationId: "10",
      repositoryId: "100",
      ref: `refs/heads/${proposal.branchName}`,
      expectedSha: sha,
      expectedTree: sha,
      resolvedByCallId: "resolve-owned-draft",
    }),
  ]);
  const repair = createPublishedDraftRepairSource({
    appId: f.reviewed.appSpec.appId,
    appSpecDigest: f.reviewed.appSpec.digest,
    originSourceReceiptDigest: f.reviewed.sourceReceipt.digest,
    publicationProposalDigest: proposal.digest,
    publicationDigest: publication.digest,
    installationId: "10",
    source,
    draft: {
      repositoryId: "100",
      owner: "owner",
      name: "repository",
      number: 42,
      pullRequestId: "400",
      draft: true,
      state: "open",
      headRepositoryId: "100",
      headBranch: proposal.branchName,
      headSha: sha,
      headTree: sha,
      baseRepositoryId: "100",
      baseBranch: "main",
      verifiedBuilderOrigin: { appId: "builder", authorId: "builder-user", marker: "owned" },
    },
  });
  const publicationScope = {
    kind: "owned-publication" as const,
    proposal,
    publication,
    automaticMergeNonAppDigest: d,
  };
  const candidate = Object.assign(f.candidate, {
    kind: "reconciliation" as const,
    repositoryId: "100",
    githubSourceDigest: source.digest,
    publishedOrigin: repair,
    publicationScope,
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
    sessionId: logical,
    rootSessionId: logical,
    continuationToken: "same-continuation",
    agent: {
      system: "Original brief",
      tools: [],
      modelReference: { id: "synthetic", provider: "test" },
    },
    compaction: { threshold: 1e6, recentWindowSize: 10 },
    state: {
      "eve.harness.emission": {
        sessionStarted: true,
        sequence: 2,
        stepIndex: 0,
        ...(options.live === true
          ? { turnId: options.activeTurn === true ? "active-turn" : "" }
          : {}),
      },
    },
    history: [
      { role: "user", content: "Continue the same app" },
      { role: "assistant", content: "Ready" },
    ],
  };
  if (options.live === true && options.activeTurn !== true) {
    const emission = await emitTurnEpilogue(
      async () => {
        /* Native event delivery is external to this checkpoint-construction fixture. */
      },
      {
        sessionStarted: true,
        sequence: 1,
        stepIndex: 0,
        turnId: "completed-native-turn",
      },
    );
    session = setHarnessEmissionState(session, emission);
  }
  if (options.pendingApproval === true) {
    const { appendPendingInputBatch } = await load("harness/pending-input-batches.js");
    session = appendPendingInputBatch({
      session,
      requests: [
        {
          kind: "tool-approval",
          requestId: "pending-original-approval",
          prompt: "Approve resource",
          action: {
            kind: "tool-call",
            toolName: "provision-original",
            callId: "pending-original-call",
            input: {},
          },
        },
      ],
      responseAuthRequiredRequestIds: ["pending-original-approval"],
      responseMessages: [],
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
    origin: { slot: 2, stepId: "step-prior-cutoff", eventId: "event-prior-cutoff" },
    serializedContext: {
      ...f.currentContext,
      [draftReviewedLineageContextKey]: f.old.serializedContext[draftReviewedLineageContextKey],
    },
  };
  const afterCutoff = {
    ...f.old,
    origin: { slot: 3, stepId: "step-after-cutoff", eventId: "event-after-cutoff" },
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
      runId: priorEntry(index) ? logical : owner,
      stepId: entry.origin.stepId,
      stepName:
        options.live === true ? "step//eve//turnStep" : "step//eve//terminateChildSessionsStep",
      status: "completed",
      ...(options.live === true
        ? {
            output: await serialization.dehydrateStepReturnValue(
              {
                action: "park",
                hasPendingAuthorization: false,
                hasPendingInputBatch: options.pendingApproval ?? false,
                sessionState: createDurableSessionState({ session }),
                serializedContext: entry.serializedContext,
              },
              priorEntry(index) ? logical : owner,
            ),
          }
        : {
            input: await serialization.dehydrateStepArguments(
              {
                args: [
                  {
                    sessionState: createDurableSessionState({ session }),
                    serializedContext: entry.serializedContext,
                  },
                ],
                closureVars: [],
              },
              priorEntry(index) ? logical : owner,
            ),
          }),
    })),
  );
  const nativeEvents = steps.map((step, index) => ({
    runId: step.runId,
    eventId: `evnt_${String(options.priorOwnerReview === true && step.runId === owner ? index - priorEntries.length + 1 : index + 1).padStart(26, "0")}`,
    correlationId: step.stepId,
    eventType: "step_completed",
    eventData: { stepName: step.stepName },
  }));
  interface RecoveryFixturePage<T> {
    cursor?: string;
    data: T[];
    hasMore: boolean;
  }
  const paginate = <T>(
    values: T[],
    runId: string,
    pagination?: { sortOrder?: string; cursor?: string; limit?: number },
  ) => {
    const ordered = pagination?.sortOrder === "desc" ? values.toReversed() : values;
    const offset = pagination?.cursor === undefined ? 0 : Number(pagination.cursor);
    const limit =
      options.paginateAncestor === true && runId === logical
        ? 1
        : (pagination?.limit ?? ordered.length);
    const data = ordered.slice(offset, offset + limit);
    const next = offset + data.length;
    const page: RecoveryFixturePage<T> = { data, hasMore: next < ordered.length };
    if (next < ordered.length) {
      page.cursor = String(next);
    }
    return page;
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
                  stepId: "unsettled-provider-effect",
                  stepName: "step//eve//dispatchCoordinationStep",
                  status: "running",
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
  const collectLineagePreflight = createOwnedLineagePreflightCollector(collectorPorts);
  const deps = {
    collect,
    collectLineagePreflight,
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
        return { runId: hook.runId, logicalSessionId: logical };
      }
      if (nativeStatus === "running") {
        return { runId: owner, logicalSessionId: logical };
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
        runId: "physical-child",
        metadata: Promise.resolve({
          recoveryBinding: {
            ...input.descriptor,
            provenance: input.provenance,
            ownerRunId: "physical-child",
          },
        }),
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
