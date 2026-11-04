/* oxlint-disable anti-slop/no-unknown-parameters -- The installed SDK hydration API accepts opaque encrypted/provider values in the controlled world fixture. */
/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- The installed compiled native collector/reconciler expose private runtime modules; only external world/storage ports use controlled fixtures. */
/* oxlint-disable eslint/require-await -- Synthetic provider/storage ports retain their production asynchronous signatures. */
import { createRequire } from "node:module";
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
export const logical = "logical-original";
export const owner = "physical-source";
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
      mutations: ["apps/orchard", "microfrontends.json"],
      omittedAuthorities: ["provider-provisioning", "deployment", "production-readiness"],
      recovered: false,
      topology: { path: "microfrontends.json", oldDigest: d, newDigest: d },
      version: 1,
      workspacePath: "apps/orchard",
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
  return { input, reviewed, candidate, currentContext, old, current };
};

export const nativeFixture = async (
  options: { live?: boolean; pendingApproval?: boolean; activeTurn?: boolean } = {},
) => {
  const f = fixture();
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
  const steps = await Promise.all(
    [f.old, f.current].map(async (entry) => ({
      runId: owner,
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
              owner,
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
              owner,
            ),
          }),
    })),
  );
  const world = {
    runs: { get: async () => ({ runId: owner, status: nativeStatus }) },
    events: {
      list: async () => ({
        data: steps.map((step, index) => ({
          runId: owner,
          eventId: `evnt_${String(index + 1).padStart(26, "0")}`,
          correlationId: step.stepId,
          eventType: "step_completed",
          eventData: { stepName: step.stepName },
        })),
        hasMore: false,
      }),
    },
    steps: {
      get: async (_run: string, step: string) => steps.find((entry) => entry.stepId === step),
      list: async () => ({
        data: [
          ...steps,
          ...(effectConflict
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
    resolveRunEncryptionKey: async () => {
      /* Controlled fixture checkpoints are not encrypted. */
    },
    hydrateStepArguments: (value: unknown, run: string, key: unknown) =>
      serialization.hydrateStepArguments(value, run, key, []),
    hydrateStepReturnValue: (value: unknown, run: string, key: unknown) =>
      serialization.hydrateStepReturnValue(value, run, key),
    readDurableSession,
    requireEventSlot: (id: string) => Number(id.slice(5)),
    async *readNativeEvents() {
      yield* [];
    },
    now: () => 0,
  };
  const collect = createTerminalRecoveryCandidateCollector(collectorPorts);
  let receipt: unknown;
  let hook: { runId: string; metadata: Promise<{ recoveryBinding: unknown }> } | undefined;
  let denied = false;
  const starts: unknown[] = [];
  const ports = {
    authorize: async () => {
      if (denied) {
        throw new Error("owner revoked");
      }
    },
    readReceipt: async () => receipt,
    commitReceipt: async ({ recoveryBinding }: { recoveryBinding: unknown }) => {
      receipt = recoveryBinding;
      return recoveryBinding;
    },
    authorizeActivation: async () => {
      throw new Error("unexpected activation");
    },
    applicationStateRecovery: {
      contextKey: draftReviewedLineageContextKey,
      field: "reviewedLineage",
      recover: async (input: Parameters<typeof recoverDraftReviewedLineage>[0]) =>
        recoverDraftReviewedLineage(input),
    },
  };
  const stopReceipts = new Set<string>();
  const activatedHooks = new Set<string>();
  const deps = {
    collect,
    collectLineagePreflight: createOwnedLineagePreflightCollector(collectorPorts),
    readLineagePreflight: readOwnedLineagePreflight,
    reconcileLineagePreflight: reconcileOwnedLineagePreflight,
    inspectSource: async (id: string) => await inspectNativeRecoverySource(world, id),
    stopSource: async (id: string, reason: string) => {
      if (id !== owner) {
        throw new Error("Foreign owner stop");
      }
      nativeStatus = "cancelled";
      stopReceipts.add(reason);
    },
    readStopReceipt: async (id: string, reason: string) => id === owner && stopReceipts.has(reason),
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
    resumeHook: async (token: string) => {
      activatedHooks.add(token);
    },
    readCandidate: readTerminalRecoveryCandidate,
    reconcile: reconcileTerminalRecoveryCandidate,
    readEntry: async () => ({
      kind: "initial",
      serializedContext: { "eve.capabilities": { original: true } },
      sessionTimeoutMs: false,
    }),
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
    getHook: async () => {
      if (hook === undefined) {
        throw new Error("missing hook");
      }
      return hook;
    },
    isHookNotFound: (error: Error) => error.message === "missing hook",
    now: () => 0,
    wait: async () => {
      throw new Error("unexpected wait");
    },
  };
  return {
    ...f,
    ports,
    deps,
    starts,
    world,
    stopReceipts,
    activations: () => activatedHooks.size,
    setEffectConflict: (value: boolean) => {
      effectConflict = value;
    },
    setNativeStatus: (value: string) => {
      nativeStatus = value;
    },
    revoke: () => {
      denied = true;
    },
  };
};
