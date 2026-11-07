/* oxlint-disable sonarjs/no-internal-api-use -- Installed Eve context is used only to test durable state observations. */
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import { describe, expect, it } from "vitest";
import type { AppBuilderWorkflowState } from "./workflow-state";
import {
  decideApprovedBuildContinuation,
  approvedBuildDecisionSchema,
} from "./approved-build-continuation";
import {
  currentLocalSourcePrerequisite,
  localSourcePrerequisiteHistory,
  recordLocalSourcePrerequisite,
  resolveLocalSourcePrerequisite,
} from "./local-source-prerequisite-state";

// SAFETY: This classifier fixture supplies exactly the source, validator and approval-scope fields the observation consumes; it grants no actual effect authority.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- Deliberately bounded pure classifier fixture.
const workflow = {
  appSpec: { appId: "supplier-spend", digest: "a".repeat(64) },
  applyReceipt: {},
  phase: "validation_failed",
  proposal: { digest: "e".repeat(64), workspaceDigest: "d".repeat(64) },
  sourceReceipt: { digest: "b".repeat(64), sourceSha: "c".repeat(40) },
  validationFailure: {
    attemptDigest: "f".repeat(64),
    commandFailure: { exitCode: 1, name: "check-build" },
    reason: "command-failed",
  },
  workspace: { workspaceDigest: "d".repeat(64), workspaceId: "owned-workspace" },
} as unknown as AppBuilderWorkflowState;
const record = () =>
  recordLocalSourcePrerequisite({
    callId: "actual-failed-plan",
    originalSourceSha: "c".repeat(40),
    originalWorkspaceDigest: "d".repeat(64),
    sessionId: "same-session",
    state: workflow,
  });
const decide = (sourcePrerequisite?: ReturnType<typeof record>) => {
  const input: Parameters<typeof decideApprovedBuildContinuation>[0] = {
    adapterSessionId: "same-session",
    approvalMatches: () => true,
    blocked: false,
    pendingInput: false,
    state: workflow,
    turnId: "current-turn",
    turnSequence: 4,
  };
  if (sourcePrerequisite !== undefined) {
    input.sourcePrerequisite = sourcePrerequisite;
  }
  return decideApprovedBuildContinuation(input);
};

describe("typed local source prerequisite observations", () => {
  it("blocks stale command-failed auto continuation without changing the old validator or approval", () => {
    contextStorage.run(new ContextContainer(), () => {
      const before = JSON.stringify(workflow);
      expect(decide().decision).toBe("runnable");
      const observation = record();
      const decision = approvedBuildDecisionSchema.parse(decide(observation));
      expect(decision.decision).toBe("blocked");
      expect(decision.sourcePrerequisite?.code).toBe("local_source_baseline_required");
      expect(JSON.stringify(workflow)).toBe(before);
      expect(currentLocalSourcePrerequisite(workflow, "same-session")).toEqual(observation);
    });
  });
  it("does not block another session/source/proposal or infer blockers from prose", () => {
    contextStorage.run(new ContextContainer(), () => {
      const observation = record();
      expect(currentLocalSourcePrerequisite(workflow, "different-session")).toBeUndefined();
      expect(
        recordLocalSourcePrerequisite({
          callId: "foreign-error",
          originalSourceSha: "9".repeat(40),
          originalWorkspaceDigest: "d".repeat(64),
          sessionId: "same-session",
          state: workflow,
        }),
      ).toBeUndefined();
      if (!("proposal" in workflow)) {
        throw new Error("The classifier fixture requires a proposal.");
      }
      const changed = {
        ...workflow,
        proposal: { ...workflow.proposal, digest: "9".repeat(64) },
      };
      expect(currentLocalSourcePrerequisite(changed, "same-session")).toBeUndefined();
      expect(decide(observation).decision).toBe("blocked");
      expect(decide().decision).toBe("runnable");
    });
  });
  it("retains the original observation when a verified same-scope reconciliation resolves it", () => {
    contextStorage.run(new ContextContainer(), () => {
      const observation = record();
      resolveLocalSourcePrerequisite(workflow, "same-session", "verified-reconciliation");
      expect(currentLocalSourcePrerequisite(workflow, "same-session")).toBeUndefined();
      expect(localSourcePrerequisiteHistory.get()).toEqual([
        observation,
        { ...observation, observedByCallId: "verified-reconciliation", status: "resolved" },
      ]);
      expect(decide().decision).toBe("runnable");
    });
  });
});
