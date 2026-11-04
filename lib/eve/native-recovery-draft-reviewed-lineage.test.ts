/* oxlint-disable anti-slop/no-unknown-parameters -- The installed SDK hydration API accepts opaque encrypted/provider values in the controlled world fixture. */
/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- The installed compiled native collector/reconciler expose private runtime modules; only external world/storage ports use controlled fixtures. */
/* oxlint-disable eslint/require-await -- Synthetic provider/storage ports retain their production asynchronous signatures. */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import {
  deriveNormalizedChangeSet,
  createReviewedChangeSetReceipt,
} from "../repository/reviewed-change-set";
import type { TargetApplyReceipt } from "../repository/target-apply";
import type { TargetValidationReceipt } from "../repository/target-validation";
import { z } from "zod";
import type { DraftReconciliationCandidate } from "../agent/draft-reconciliation-state";
import type { DraftReviewedWorkflow } from "../agent/draft-reviewed-lineage";
import { targetCreationProposalSchema, targetIdentitySchema } from "../repository/target-planning";
import {
  recoverDraftReviewedLineage,
  draftReviewedLineageContextKey,
} from "./native-recovery-draft-reviewed-lineage";

const require = createRequire(import.meta.url);
const sdk = path.dirname(require.resolve("eve/package.json"));
const load = async (file: string) =>
  await import(pathToFileURL(path.join(sdk, "dist/src", file)).href);
const { createTerminalRecoveryCandidateCollector, readTerminalRecoveryCandidate } = await load(
  "execution/session/recovery-candidate.js",
);
const { reconcileTerminalRecoveryCandidate } = await load(
  "execution/session/recovery-reconciliation.js",
);
const { createDurableSessionState, readDurableSession } = await load(
  "execution/durable-session-store.js",
);
const { recoverTerminalSession } = await load("execution/session/terminal-recovery.js");
const serialization = await load("compiled/@workflow/core/serialization.js");
const workflowKey = "autograph-app-builder.workflow.v17";
const logical = "logical-original";
const owner = "physical-source";
const d = "a".repeat(64);
const sha = "b".repeat(40);
const fixture = () => {
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
    [draftReviewedLineageContextKey]: candidate,
    unrelated: { preserved: true },
  };
  const currentContext = { ...olderContext, [workflowKey]: { ...baseline, phase: "validated" } };
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

it("recovers the complete original review as lineage without changing workflow, candidate edits or other context", () => {
  const f = fixture();
  const before = structuredClone(f.input);
  expect(recoverDraftReviewedLineage(f.input)).toEqual(f.reviewed);
  expect(f.input).toEqual(before);
  const retried = {
    ...f.input,
    serializedContext: {
      ...f.currentContext,
      [draftReviewedLineageContextKey]: { ...f.candidate, reviewedLineage: f.reviewed },
    },
  };
  expect(recoverDraftReviewedLineage(retried)).toBeUndefined();
});

it("accepts identical complete review contexts at repeated historical checkpoints", () => {
  const f = fixture();
  f.input.payload.candidates.unshift({
    ...structuredClone(f.old),
    origin: { slot: 0, stepId: "earlier", eventId: "earlier-event" },
  });
  expect(recoverDraftReviewedLineage(f.input)).toEqual(f.reviewed);
});

it.each([
  "foreign-owner",
  "foreign-session",
  "changed-source",
  "changed-app",
  "changed-apply",
  "malformed-receipt",
  "compact-receipt",
  "superseding-review",
  "conflicting-slot",
  "selected-context-change",
  "mixed-appspec",
  "mixed-source-receipt",
  "mixed-identity",
  "missing-target",
  "missing-command-root",
])("refuses %s rather than manufacturing review authority", (variant) => {
  const f = fixture();
  if (variant === "mixed-appspec") {
    f.reviewed.appSpec.digest = "f".repeat(64);
  }
  if (variant === "mixed-source-receipt") {
    f.reviewed.sourceReceipt.digest = "f".repeat(64);
  }
  if (variant === "mixed-identity") {
    f.reviewed.identityReceipt.digest = "f".repeat(64);
  }
  if (variant === "missing-target") {
    Reflect.deleteProperty(f.reviewed.proposal, "target");
  }
  if (variant === "missing-command-root") {
    Reflect.deleteProperty(f.reviewed.validationReceipt.commands[0], "validationRoot");
  }
  if (variant === "foreign-owner") {
    f.input.binding.ownerRunId = "foreign";
  }
  if (variant === "foreign-session") {
    Reflect.set(f.input.payload.candidates[0].serializedContext, "eve.sessionId", "foreign");
  }
  if (variant === "changed-source") {
    const source = f.currentContext[workflowKey].githubSource;
    if (source === undefined) {
      throw new Error("Fixture source is absent");
    }
    source.digest = "f".repeat(64);
  }
  if (variant === "changed-app") {
    f.currentContext[workflowKey].appSpec.appId = "foreign";
  }
  if (variant === "changed-apply") {
    f.currentContext[workflowKey].applyReceipt.digest = "f".repeat(64);
  }
  if (variant === "malformed-receipt") {
    f.reviewed.reviewReceipt.digest = "f".repeat(64);
  }
  if (variant === "compact-receipt") {
    Reflect.deleteProperty(f.reviewed.reviewReceipt, "changes");
  }
  if (variant === "superseding-review") {
    f.input.payload.candidates.splice(1, 0, {
      ...structuredClone(f.old),
      origin: { slot: 3, stepId: "new-review", eventId: "new-review-event" },
      serializedContext: {
        ...f.old.serializedContext,
        [workflowKey]: {
          ...f.reviewed,
          reviewReceipt: { ...f.reviewed.reviewReceipt, reviewedByCallId: "new-review" },
        },
      },
    });
  }
  if (variant === "conflicting-slot") {
    f.input.payload.candidates.unshift({
      ...structuredClone(f.old),
      serializedContext: {
        ...f.old.serializedContext,
        [workflowKey]: { ...f.reviewed, preparedByCallId: "other" },
      },
    });
  }
  if (variant === "selected-context-change") {
    f.input.serializedContext = { ...f.currentContext, unrelated: { preserved: false } };
  }
  expect(recoverDraftReviewedLineage(f.input)).toBeUndefined();
});

const nativeFixture = async () => {
  const f = fixture();
  const session = {
    sessionId: logical,
    rootSessionId: logical,
    continuationToken: "same-continuation",
    agent: {
      system: "Original brief",
      tools: [],
      modelReference: { id: "synthetic", provider: "test" },
    },
    compaction: { threshold: 1e6, recentWindowSize: 10 },
    state: { "eve.harness.emission": { sessionStarted: true, sequence: 2, stepIndex: 0 } },
    history: [
      { role: "user", content: "Continue the same app" },
      { role: "assistant", content: "Ready" },
    ],
  };
  const steps = await Promise.all(
    [f.old, f.current].map(async (entry) => ({
      runId: owner,
      stepId: entry.origin.stepId,
      stepName: "step//eve//terminateChildSessionsStep",
      status: "completed",
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
    })),
  );
  const world = {
    runs: { get: async () => ({ runId: owner, status: "completed" }) },
    events: {
      list: async () => ({
        data: steps.map((step, index) => ({
          runId: owner,
          eventId: `evnt_0000000000000000000000000${index + 1}`,
          correlationId: step.stepId,
          eventType: "step_completed",
          eventData: { stepName: step.stepName },
        })),
        hasMore: false,
      }),
    },
    steps: {
      get: async (_run: string, step: string) => steps.find((entry) => entry.stepId === step),
    },
  };
  const collect = createTerminalRecoveryCandidateCollector({
    getWorld: async () => world,
    resolveRunEncryptionKey: async () => {},
    hydrateStepArguments: (value: unknown, run: string, key: unknown) =>
      serialization.hydrateStepArguments(value, run, key, []),
    hydrateStepReturnValue: (value: unknown, run: string, key: unknown) =>
      serialization.hydrateStepReturnValue(value, run, key),
    readDurableSession,
    requireEventSlot: (id: string) => Number(id.slice(5)),
    async *readNativeEvents() {},
    now: () => 0,
  });
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
  const deps = {
    collect,
    readCandidate: readTerminalRecoveryCandidate,
    reconcile: reconcileTerminalRecoveryCandidate,
    readEntry: async () => ({
      kind: "initial",
      serializedContext: { "eve.capabilities": { original: true } },
      sessionTimeoutMs: false,
    }),
    start: async (input: { descriptor: unknown; provenance: unknown }) => {
      starts.push(input);
      hook = {
        runId: "physical-child",
        metadata: Promise.resolve({
          recoveryBinding: {
            ...f.input.descriptor,
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
    revoke: () => {
      denied = true;
    },
  };
};

it("the installed native collector, reconciler and restore path append only the verified lineage", async () => {
  const f = await nativeFixture();
  const result = await recoverTerminalSession(
    {
      auth: { authenticator: "test", principalType: "user", principalId: "owner" },
      descriptor: f.input.descriptor,
      ports: f.ports,
    },
    f.deps,
  );
  expect(result.kind).toBe("accepted");
  const restored = z
    .object({ checkpoint: z.object({ serializedContext: z.record(z.string(), z.unknown()) }) })
    .parse(f.starts[0]);
  expect(restored.checkpoint.serializedContext).toEqual({
    ...f.currentContext,
    [draftReviewedLineageContextKey]: { ...f.candidate, reviewedLineage: f.reviewed },
  });
  const retried = await recoverTerminalSession(
    {
      auth: { authenticator: "test", principalType: "user", principalId: "owner" },
      descriptor: f.input.descriptor,
      ports: f.ports,
    },
    f.deps,
  );
  expect(retried.kind).toBe("accepted");
  expect(f.starts).toHaveLength(1);
});

it("current owner revocation during the recovery port prevents any new native start", async () => {
  const f = await nativeFixture();
  f.ports.applicationStateRecovery.recover = async (input) => {
    const value = recoverDraftReviewedLineage(input);
    f.revoke();
    return value;
  };
  await expect(
    recoverTerminalSession(
      {
        auth: { authenticator: "test", principalType: "user", principalId: "owner" },
        descriptor: f.input.descriptor,
        ports: f.ports,
      },
      f.deps,
    ),
  ).rejects.toThrow("owner revoked");
  expect(f.starts).toHaveLength(0);
});

it("the SDK refuses an application recovery registration targeting its own session identity", async () => {
  const f = await nativeFixture();
  f.ports.applicationStateRecovery.contextKey = "eve.sessionId";
  const result = await recoverTerminalSession(
    {
      auth: { authenticator: "test", principalType: "user", principalId: "owner" },
      descriptor: f.input.descriptor,
      ports: f.ports,
    },
    f.deps,
  );
  expect(result).toEqual({
    kind: "unavailable",
    reason: "application-state-recovery-configuration",
  });
  expect(f.starts).toHaveLength(0);
});

it("the SDK never overwrites an existing candidate field through the recovery hook", async () => {
  const f = await nativeFixture();
  f.ports.applicationStateRecovery.field = "unpublished";
  f.ports.applicationStateRecovery.recover = async () => {
    throw new Error("existing fields must not reach the callback");
  };
  const result = await recoverTerminalSession(
    {
      auth: { authenticator: "test", principalType: "user", principalId: "owner" },
      descriptor: f.input.descriptor,
      ports: f.ports,
    },
    f.deps,
  );
  expect(result.kind).toBe("accepted");
  const restored = z
    .object({ checkpoint: z.object({ serializedContext: z.record(z.string(), z.unknown()) }) })
    .parse(f.starts[0]);
  expect(restored.checkpoint.serializedContext).toEqual(f.currentContext);
});
