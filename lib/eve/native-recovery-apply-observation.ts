import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

interface CandidateFacts {
  flags: Record<string, boolean | null>;
  counts: Record<string, number>;
  hashes: Record<string, string | null>;
}
interface ObservationInput {
  descriptor: { logicalSessionId: string };
  binding: { ownerRunId: string; logicalSessionId: string };
  payload: unknown;
}
const authorityKey = "autograph-app-builder.private-apply-authority.v1";
const workflowKey = "autograph-app-builder.workflow.v17";
const scopeSchema = z.object({
  appId: z.string().min(1),
  appSpecDigest: z.string().min(1),
  proposalDigest: z.string().min(1),
  sessionId: z.string().min(1),
  workspaceId: z.string().min(1),
});
const authoritySchema = z.object({
  grant: scopeSchema.nullable().optional(),
  pending: z.array(z.object({ callId: z.string(), scope: scopeSchema })).optional(),
});
const workflowSchema = z.looseObject({
  appSpec: z.object({ digest: z.string().optional() }).optional(),
  applyFailure: z.object({}).optional(),
  applyReceipt: z.object({}).optional(),
  phase: z.string().optional(),
  proposal: z
    .object({
      digest: z.string().optional(),
      target: z
        .object({ contract: z.object({ appId: z.string().optional() }).optional() })
        .optional(),
    })
    .optional(),
  workspace: z.object({ workspaceId: z.string().optional() }).optional(),
});
const partSchema = z.looseObject({
  providerExecuted: z.boolean().optional(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  type: z.string().optional(),
});
const contextSchema = z.looseObject({
  "eve.sessionId": z.string().optional(),
  [authorityKey]: z.unknown().optional(),
  [workflowKey]: z.unknown().optional(),
});
const sessionSchema = z.looseObject({
  history: z.array(
    z.looseObject({ content: z.union([z.string(), z.array(partSchema)]), role: z.string() }),
  ),
  sessionId: z.string(),
});
const candidateSchema = z.object({
  incoming: z.object({ delivery: z.unknown().optional() }).optional(),
  kind: z.string(),
  origin: z.object({ slot: z.number().int().nonnegative() }),
  serializedContext: contextSchema,
  sessionState: z.looseObject({
    emissionState: z.object({ sequence: z.number().int().nonnegative() }).optional(),
    snapshot: z.looseObject({ session: sessionSchema }),
  }),
});
const payloadSchema = z.object({
  candidates: z.array(candidateSchema),
  issues: z.array(z.object({ reason: z.string() })),
  nativeEvents: z.array(
    z.object({ data: z.object({ sequence: z.number().optional() }).optional(), type: z.string() }),
  ),
});
const hash = (value: string | undefined): string | null =>
  value === undefined
    ? null
    : createHash("sha256").update("eve.model-protocol.id.v1\0").update(value).digest("hex");
const scope = (workflow: z.infer<typeof workflowSchema> | undefined, logicalSessionId: string) =>
  scopeSchema.safeParse({
    appId: workflow?.proposal?.target?.contract?.appId,
    appSpecDigest: workflow?.appSpec?.digest,
    proposalDigest: workflow?.proposal?.digest,
    sessionId: logicalSessionId,
    workspaceId: workflow?.workspace?.workspaceId,
  }).data;
const pendingCall = (
  authority: z.infer<typeof authoritySchema> | undefined,
  callId: string | undefined,
) =>
  callId === undefined ? [] : (authority?.pending ?? []).filter((entry) => entry.callId === callId);

/**
 * Pure app-owned diagnostics over an already authorized in-process candidate.
 * Explicit null is distinct from absent state. These facts never authorize replay.
 * Even an unchanged null grant cannot exclude a previous native step attempt
 * whose effects ran before its context could commit.
 */
// oxlint-disable-next-line eslint/complexity, sonarjs/cognitive-complexity -- Independent tri-state diagnostic facts intentionally do not combine into an admission or replay decision.
export const observePrivateApplyRecoveryCandidate = (input: ObservationInput): CandidateFacts => {
  const parsed = payloadSchema.safeParse(input.payload);
  if (!parsed.success) {
    return { counts: {}, flags: { payloadParsed: false }, hashes: {} };
  }
  const payload = parsed.data;
  const candidates = payload.candidates.toSorted(
    (left, right) => right.origin.slot - left.origin.slot,
  );
  const [latest] = candidates;
  const latestContext = latest?.serializedContext;
  const latestSession = latest?.sessionState.snapshot.session;
  const latestWorkflow = workflowSchema.safeParse(latestContext?.[workflowKey]).data;
  const latestAuthority = authoritySchema.safeParse(latestContext?.[authorityKey]).data;
  const parts = (latestSession?.history ?? []).flatMap((message) =>
    Array.isArray(message.content) ? message.content : [],
  );
  const completedCallIds = new Set(
    parts.flatMap((part) => (part.type === "tool-result" ? [part.toolCallId] : [])),
  );
  const calls = parts.filter(
    (call) =>
      call.type === "tool-call" &&
      call.toolName === "apply_app_creation" &&
      call.providerExecuted !== true &&
      !completedCallIds.has(call.toolCallId),
  );
  const callId = calls.length === 1 ? calls[0].toolCallId : undefined;
  const expectedScope = scope(latestWorkflow, input.descriptor.logicalSessionId);
  const latestPending = pendingCall(latestAuthority, callId);
  const latestPendingScope = latestPending[0]?.scope;
  const committed = candidates.find((candidate) => candidate.kind === "committed-turn-output");
  const before =
    callId === undefined
      ? undefined
      : candidates.find(
          (candidate) =>
            candidate.kind === "completed-terminal-turn-input" &&
            candidate.incoming?.delivery !== undefined &&
            pendingCall(
              authoritySchema.safeParse(candidate.serializedContext[authorityKey]).data,
              callId,
            ).length === 1,
        );
  const beforeContext = before?.serializedContext;
  const beforeAuthority = authoritySchema.safeParse(beforeContext?.[authorityKey]).data;
  const beforeWorkflow = workflowSchema.safeParse(beforeContext?.[workflowKey]).data;
  const beforePending = pendingCall(beforeAuthority, callId);
  const beforePendingScope = beforePending[0]?.scope;
  const sequence = before?.sessionState.emissionState?.sequence;
  const frontier =
    sequence === undefined
      ? undefined
      : payload.nativeEvents.filter(
          (event) => event.data?.sequence === undefined || event.data.sequence >= sequence,
        );
  const { issues } = payload;
  const failedStepCount = issues.filter(
    (issue) => issue.reason === "failed-turn-effects-unreconciled",
  ).length;
  const resetCount = frontier?.filter((event) => event.type === "context.cleared").length;
  const logicalSessionMatches =
    latestSession?.sessionId === input.descriptor.logicalSessionId &&
    input.binding.logicalSessionId === input.descriptor.logicalSessionId;
  const pendingScopeAvailable =
    callId !== undefined && expectedScope !== undefined && latestAuthority !== undefined;
  const result: CandidateFacts = {
    counts: {
      applyOrphanCount: calls.length,
      failedNativeTurnIssueCount: failedStepCount,
      matchingPendingCallCount: latestPending.length,
      matchingPreapprovalPendingCallCount: beforePending.length,
    },
    flags: {
      appWorkflowUnchangedSinceInput:
        beforeWorkflow === undefined || latestWorkflow === undefined
          ? null
          : isDeepStrictEqual(beforeContext?.[workflowKey], latestContext?.[workflowKey]),
      applyFailurePresent:
        latestWorkflow === undefined ? null : latestWorkflow.applyFailure !== undefined,
      applyReceiptPresent:
        latestWorkflow === undefined ? null : latestWorkflow.applyReceipt !== undefined,
      committedOutputAfterSourceInput:
        committed === undefined || before === undefined
          ? null
          : committed.origin.slot > before.origin.slot,
      exactApplyOrphanIdentified: calls.length === 1,
      grantExplicitNull:
        latestAuthority === undefined || !Object.hasOwn(latestAuthority, "grant")
          ? null
          : latestAuthority.grant === null,
      latestContextMatchesCommittedOutput:
        committed === undefined || latestContext === undefined
          ? null
          : isDeepStrictEqual(latestContext, committed.serializedContext),
      latestPendingScopeMatchesCurrent: pendingScopeAvailable
        ? latestPending.length === 1 && isDeepStrictEqual(latestPendingScope, expectedScope)
        : null,
      latestSnapshotMatchesCommittedOutput:
        committed === undefined || latestSession === undefined
          ? null
          : isDeepStrictEqual(latestSession, committed.sessionState.snapshot.session),
      logicalIdentityMatches:
        latestContext === undefined || latestSession === undefined
          ? null
          : latestContext["eve.sessionId"] === input.descriptor.logicalSessionId &&
            logicalSessionMatches,
      matchingGrantPresent:
        latestAuthority === undefined || expectedScope === undefined
          ? null
          : isDeepStrictEqual(latestAuthority.grant, expectedScope),
      nativeStreamComplete: !issues.some((issue) => issue.reason === "native-stream-incomplete"),
      noRecordedContextResetAfterInput: resetCount === undefined ? null : resetCount === 0,
      noUncommittedFailedNativeTurn: failedStepCount === 0,
      payloadParsed: true,
      phaseApplied: latestWorkflow === undefined ? null : latestWorkflow.phase === "applied",
      phaseApplyFailed:
        latestWorkflow === undefined ? null : latestWorkflow.phase === "apply_failed",
      phasePlanned: latestWorkflow === undefined ? null : latestWorkflow.phase === "planned",
      preapprovalGrantExplicitNull:
        beforeAuthority === undefined || !Object.hasOwn(beforeAuthority, "grant")
          ? null
          : beforeAuthority.grant === null,
      preapprovalInputPresent: before !== undefined,
      preapprovalPhasePlanned:
        beforeWorkflow === undefined ? null : beforeWorkflow.phase === "planned",
      preapprovalScopeMatchesCurrent:
        beforePendingScope === undefined || expectedScope === undefined
          ? null
          : isDeepStrictEqual(beforePendingScope, expectedScope),
      privateAuthorityKeyPresent:
        latestContext === undefined ? null : Object.hasOwn(latestContext, authorityKey),
      privateAuthorityUnchangedSinceInput:
        beforeAuthority === undefined || latestAuthority === undefined
          ? null
          : isDeepStrictEqual(beforeContext?.[authorityKey], latestContext?.[authorityKey]),
      workflowKeyPresent:
        latestContext === undefined ? null : Object.hasOwn(latestContext, workflowKey),
    },
    hashes: {
      appId: hash(expectedScope?.appId),
      appSpecDigest: hash(expectedScope?.appSpecDigest),
      applyToolName: hash("apply_app_creation"),
      callId: hash(callId),
      latestPhase: hash(latestWorkflow?.phase),
      logicalSessionId: hash(expectedScope?.sessionId),
      proposalDigest: hash(expectedScope?.proposalDigest),
      workspaceId: hash(expectedScope?.workspaceId),
    },
  };
  return result;
};
