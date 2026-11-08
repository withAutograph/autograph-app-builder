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
    ownerRunId: "physical-failed-owner",
    logicalSessionId: "same-saved-session",
  };
  const scope = {
    appId: "app",
    appSpecDigest: "spec",
    proposalDigest: "current-proposal",
    sessionId: binding.logicalSessionId,
    workspaceId: "private-workspace",
  };
  const context = {
    "eve.sessionId": binding.logicalSessionId,
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
      phase: "planned",
      appSpec: { digest: "spec" },
      proposal: { digest: scope.proposalDigest, target: { contract: { appId: "app" } } },
      workspace: { workspaceId: scope.workspaceId, workspaceDigest: "workspace-digest" },
    },
  };
  // Actual defect shape: a compaction checkpoint followed by call/approval/response
  // and the old real user that the prior guard wrongly appended after approval.
  const badHistory = [
    { role: "user", kind: "context.compaction", content: "[compaction checkpoint]" },
    { role: "assistant", content: "The same saved app remains planned; no apply has run." },
    ...history().slice(-2),
    originalUser,
  ];
  const session = {
    sessionId: binding.logicalSessionId,
    rootSessionId: binding.logicalSessionId,
    continuationToken: "original-continuation",
    agent: {
      system: "Original product brief",
      tools: [],
      modelReference: { id: "synthetic", provider: "test" },
    },
    compaction: { threshold: 1e6, recentWindowSize: 10 },
    state: { "eve.harness.emission": { sessionStarted: true, sequence: 433, stepIndex: 0 } },
    history: badHistory,
  };
  const step = {
    runId: binding.ownerRunId,
    stepId: "step-original-terminal",
    stepName: "step//eve//terminateChildSessionsStep",
    status: "completed",
    input: await serialization.dehydrateStepArguments(
      {
        args: [
          { sessionState: createDurableSessionState({ session }), serializedContext: context },
        ],
        closureVars: [],
      },
      binding.ownerRunId,
    ),
  };
  const world = {
    runs: { get: async () => ({ runId: binding.ownerRunId, status: "failed" }) },
    events: {
      list: async () => ({
        data: [
          {
            runId: binding.ownerRunId,
            eventId: "evnt_00000000000000000000000001",
            correlationId: step.stepId,
            eventType: "step_completed",
            eventData: { stepName: step.stepName },
          },
        ],
        hasMore: false,
      }),
    },
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
