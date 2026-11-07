/* oxlint-disable anti-slop/no-unknown-parameters -- SDK serialization ports accept opaque controlled fixture values, not application input or provider authority. */
/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- Actual private SDK modules are loaded under their own package imports; only World/storage ports use controlled synthetic fixtures. */
/* oxlint-disable eslint/require-await -- Controlled asynchronous World and serialization ports preserve the installed SDK signatures. */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { authorizeRepeatablePrivateApplyCalls } from "./native-recovery-repeatable-apply";
import { call, originalUser, history } from "./native-approval-compaction.test-fixture";

const sdk = path.dirname(createRequire(import.meta.url).resolve("eve/package.json"));
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
const serialization = await load("compiled/@workflow/core/serialization.js");

export const retainedPrivateApplyRecoveryFixture = async (
  foreign = false,
  selectedBinding?: { ownerRunId: string; logicalSessionId: string },
) => {
  const binding = selectedBinding ?? {
    logicalSessionId: "same-saved-session",
    ownerRunId: "physical-failed-owner",
  };
  const scope = {
    appId: "app",
    appSpecDigest: "spec",
    proposalDigest: "current-proposal",
    sessionId: binding.logicalSessionId,
    workspaceId: "private-workspace",
  };
  const context = {
    "autograph-app-builder.private-apply-authority.v1": {
      grant: { ...scope, proposalDigest: "older-approved-proposal" },
      pending: [
        {
          callId: call.toolCallId,
          scope: { ...scope, proposalDigest: foreign ? "foreign-proposal" : scope.proposalDigest },
        },
      ],
    },
    "autograph-app-builder.workflow.v17": {
      appSpec: { digest: "spec" },
      phase: "planned",
      proposal: { digest: scope.proposalDigest, target: { contract: { appId: "app" } } },
      workspace: { workspaceDigest: "workspace-digest", workspaceId: scope.workspaceId },
    },
    "eve.sessionId": binding.logicalSessionId,
  };
  // Actual defect shape: a compaction checkpoint followed by call/approval/response
  // and the old real user that the prior guard wrongly appended after approval.
  const badHistory = [
    { content: "[compaction checkpoint]", kind: "context.compaction", role: "user" },
    { content: "The same saved app remains planned; no apply has run.", role: "assistant" },
    ...history().slice(-2),
    originalUser,
  ];
  const session = {
    agent: {
      modelReference: { id: "synthetic", provider: "test" },
      system: "Original product brief",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 1e6 },
    continuationToken: "original-continuation",
    history: badHistory,
    rootSessionId: binding.logicalSessionId,
    sessionId: binding.logicalSessionId,
    state: { "eve.harness.emission": { sequence: 433, sessionStarted: true, stepIndex: 0 } },
  };
  const step = {
    input: await serialization.dehydrateStepArguments(
      {
        args: [
          { serializedContext: context, sessionState: createDurableSessionState({ session }) },
        ],
        closureVars: [],
      },
      binding.ownerRunId,
    ),
    runId: binding.ownerRunId,
    status: "completed",
    stepId: "step-original-terminal",
    stepName: "step//eve//terminateChildSessionsStep",
  };
  const world = {
    events: {
      list: async () => ({
        data: [
          {
            correlationId: step.stepId,
            eventData: { stepName: step.stepName },
            eventId: "evnt_00000000000000000000000001",
            eventType: "step_completed",
            runId: binding.ownerRunId,
          },
        ],
        hasMore: false,
      }),
    },
    runs: { get: async () => ({ runId: binding.ownerRunId, status: "failed" }) },
    steps: { get: async () => step },
  };
  const collect = createTerminalRecoveryCandidateCollector({
    getWorld: async () => world,
    hydrateStepArguments: (value: unknown, run: string, key: unknown) =>
      serialization.hydrateStepArguments(value, run, key, []),
    hydrateStepReturnValue: (value: unknown, run: string, key: unknown) =>
      serialization.hydrateStepReturnValue(value, run, key),
    now: () => 0,
    readDurableSession,
    async *readNativeEvents() {
      /* No native effect result exists for this pending call. */
    },
    requireEventSlot: (id: string) => Number(id.slice(5)),
    resolveRunEncryptionKey: async () => {
      /* This controlled World has no encryption key. */
    },
  });
  const collected = await collect({
    authorizeOwner: async () => {
      /* Controlled local World ownership; the real adapter ports are tested separately. */
    },
    binding,
  });
  expect(collected.kind).toBe("candidate");
  const payload = readTerminalRecoveryCandidate(collected.candidate);
  const repeatableCallIds = authorizeRepeatablePrivateApplyCalls({
    binding,
    descriptor: { logicalSessionId: binding.logicalSessionId },
    payload,
  });
  const reconciled = await reconcileTerminalRecoveryCandidate(collected.candidate, {
    repeatableCallIds,
  });
  return {
    binding,
    collected,
    context,
    payload,
    readDurableSession,
    reconcile: (ids: readonly string[]) =>
      reconcileTerminalRecoveryCandidate(collected.candidate, { repeatableCallIds: ids }),
    reconciled,
    repeatableCallIds,
  };
};
