import { describe, expect, it } from "vitest";

import { observePrivateApplyRecoveryCandidate } from "./native-recovery-apply-observation";

const authorityKey = "autograph-app-builder.private-apply-authority.v1";
const workflowKey = "autograph-app-builder.workflow.v17";
const secret = "authored-private-content";
const scope = {
  appId: "app",
  appSpecDigest: "spec",
  proposalDigest: "proposal",
  sessionId: "logical",
  workspaceId: "private-workspace-id",
};
interface FixtureContext {
  "eve.sessionId": string;
  "autograph-app-builder.private-apply-authority.v1"?: {
    grant?: typeof scope | null;
    pending: { callId: string; scope: typeof scope }[];
  };
  "autograph-app-builder.workflow.v17": {
    phase: string;
    appSpec: { digest: string };
    proposal: { digest: string; target: { contract: { appId: string } } };
    workspace: { workspaceId: string };
    privateContent: string;
    applyReceipt?: object;
    applyFailure?: object;
  };
}
const fixture = () => {
  const workflow = {
    phase: "planned",
    appSpec: { digest: scope.appSpecDigest },
    proposal: { digest: scope.proposalDigest, target: { contract: { appId: scope.appId } } },
    workspace: { workspaceId: scope.workspaceId },
    privateContent: secret,
  };
  const context: FixtureContext = {
    "eve.sessionId": "logical",
    [authorityKey]: { grant: null, pending: [{ callId: "call", scope }] },
    [workflowKey]: workflow,
  };
  const session = {
    sessionId: "logical",
    history: [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolName: "apply_app_creation",
            toolCallId: "call",
            input: { secret },
          },
        ],
      },
    ],
  };
  const candidate = (slot: number, kind: string) => ({
    kind,
    origin: { slot },
    serializedContext: structuredClone(context),
    sessionState: {
      emissionState: { sequence: 2 },
      snapshot: { session: structuredClone(session) },
    },
  });
  return {
    descriptor: { logicalSessionId: "logical" },
    binding: { ownerRunId: "physical", logicalSessionId: "logical" },
    payload: {
      candidates: [
        candidate(30, "terminal-finalizer-input"),
        candidate(25, "committed-turn-output"),
        { ...candidate(20, "completed-terminal-turn-input"), incoming: { delivery: {} } },
      ],
      // SAFETY: The empty mutable fixture list accepts only this native event shape.
      nativeEvents: [] as { type: string; data: { sequence: number } }[],
      // SAFETY: The empty mutable fixture list accepts only typed issue reasons.
      issues: [] as { reason: string }[],
    },
  };
};

describe("private apply native observation", () => {
  it("reports explicit retained scope/context facts without treating them as a replay certificate", () => {
    const input = fixture();
    const before = structuredClone(input);
    const facts = observePrivateApplyRecoveryCandidate(input);
    expect(facts.flags).toMatchObject({
      grantExplicitNull: true,
      phasePlanned: true,
      logicalIdentityMatches: true,
      latestPendingScopeMatchesCurrent: true,
      latestContextMatchesCommittedOutput: true,
      latestSnapshotMatchesCommittedOutput: true,
      committedOutputAfterSourceInput: true,
      preapprovalGrantExplicitNull: true,
      preapprovalScopeMatchesCurrent: true,
      privateAuthorityUnchangedSinceInput: true,
      appWorkflowUnchangedSinceInput: true,
      noRecordedContextResetAfterInput: true,
    });
    expect(facts.counts.matchingPendingCallCount).toBe(1);
    expect(input).toEqual(before);
    expect(JSON.stringify(facts)).not.toContain(secret);
    expect(JSON.stringify(facts)).not.toContain("private-workspace-id");
    expect(facts.flags).not.toHaveProperty("safeToReplay");
  });
  it("keeps missing authority and absent grant unknown", () => {
    const input = fixture();
    delete input.payload.candidates[0].serializedContext[
      "autograph-app-builder.private-apply-authority.v1"
    ];
    expect(observePrivateApplyRecoveryCandidate(input).flags.grantExplicitNull).toBeNull();
    input.payload.candidates[0].serializedContext[authorityKey] = { pending: [] };
    expect(observePrivateApplyRecoveryCandidate(input).flags.grantExplicitNull).toBeNull();
  });
  it("distinguishes prior execution marker from applied reuse and partial failure", () => {
    const input = fixture();
    input.payload.candidates[0].serializedContext[authorityKey] = { grant: scope, pending: [] };
    input.payload.candidates[0].serializedContext[workflowKey] = {
      ...input.payload.candidates[0].serializedContext[workflowKey],
      phase: "applied",
      applyReceipt: {},
    };
    expect(observePrivateApplyRecoveryCandidate(input).flags).toMatchObject({
      grantExplicitNull: false,
      matchingGrantPresent: true,
      phaseApplied: true,
      latestPendingScopeMatchesCurrent: false,
      latestContextMatchesCommittedOutput: false,
      applyReceiptPresent: true,
    });
    input.payload.candidates[0].serializedContext[workflowKey] = {
      ...input.payload.candidates[0].serializedContext[workflowKey],
      phase: "apply_failed",
      applyFailure: {},
    };
    expect(observePrivateApplyRecoveryCandidate(input).flags.phaseApplyFailed).toBe(true);
  });
  it("does not accept foreign scope, wrong logical identity, context reset or failed native turn", () => {
    const input = fixture();
    input.payload.candidates[0].serializedContext[authorityKey] = {
      grant: null,
      pending: [{ callId: "call", scope: { ...scope, workspaceId: "foreign" } }],
    };
    input.binding.logicalSessionId = "foreign";
    input.payload.nativeEvents.push({ type: "context.cleared", data: { sequence: 3 } });
    input.payload.issues.push({ reason: "failed-turn-effects-unreconciled" });
    expect(observePrivateApplyRecoveryCandidate(input).flags).toMatchObject({
      latestPendingScopeMatchesCurrent: false,
      logicalIdentityMatches: false,
      noRecordedContextResetAfterInput: false,
      noUncommittedFailedNativeTurn: false,
    });
  });
  it("does not assume an unrelated orphan is the app tool or infer an absent ancestor", () => {
    const input = fixture();
    input.payload.candidates[0].sessionState.snapshot.session.history[0].content[0].toolName =
      "other";
    expect(observePrivateApplyRecoveryCandidate(input).flags.exactApplyOrphanIdentified).toBe(
      false,
    );
    expect(observePrivateApplyRecoveryCandidate(input).flags.preapprovalInputPresent).toBe(false);
    expect(
      observePrivateApplyRecoveryCandidate(input).flags.latestPendingScopeMatchesCurrent,
    ).toBeNull();
  });
});
