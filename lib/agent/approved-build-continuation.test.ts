/* oxlint-disable anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- The fixture models exactly the trusted workflow fields consumed by this classifier; actual approval uses installed Eve state, not a stub grant. */
/* oxlint-disable sonarjs/no-internal-api-use -- Actual Eve approval state is exercised only in this fixture, never imported by product code. */
import { describe, expect, it } from "vitest";
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import {
  assertApprovedPrivateApplySession,
  requestPrivateApplyApproval,
  recordApprovedPrivateApply,
} from "./private-apply-authority";
import { decideApprovedBuildContinuation } from "./approved-build-continuation";
import type { AppBuilderWorkflowState } from "./workflow-state";

const scope = {
  appId: "spend-review",
  appSpecDigest: "a".repeat(64),
  proposalDigest: "b".repeat(64),
  sessionId: "original-adapter-session",
  workspaceId: "private-workspace",
};
// SAFETY: These are precisely the source-owned fields read by the finish classifier; approval itself uses real installed Eve state.
const failed = {
  appSpec: { appId: scope.appId, digest: scope.appSpecDigest },
  applyReceipt: { postTree: [{ path: "apps/spend-review/server/local-demo.ts" }] },
  phase: "validation_failed",
  proposal: { digest: scope.proposalDigest },
  validationFailure: {
    attemptDigest: "c".repeat(64),
    commandFailure: { exitCode: 1, name: "test" },
    diagnostics: [
      {
        code: "VITEST",
        column: 1,
        line: 1,
        message: "Test assertion failed at this location.",
        path: "server/local-demo.ts",
      },
    ],
    reason: "command-failed",
  },
  workspace: { workspaceId: scope.workspaceId },
} as unknown as Extract<AppBuilderWorkflowState, { phase: "validation_failed" }>;
const decide = (
  state: AppBuilderWorkflowState = failed,
  changes: { blocked?: boolean; pendingInput?: boolean } = {},
) =>
  decideApprovedBuildContinuation({
    adapterSessionId: scope.sessionId,
    approvalMatches: (current) => {
      try {
        assertApprovedPrivateApplySession(current);
        return true;
      } catch {
        return false;
      }
    },
    blocked: changes.blocked ?? false,
    pendingInput: changes.pendingInput ?? false,
    state,
    turnId: "actual-stopped-turn-14",
    turnSequence: 13,
  });
describe("approved stopped build continuation", () => {
  it("continues app command repairs without requiring changed-file diagnostic membership", () => {
    contextStorage.run(new ContextContainer(), () => {
      requestPrivateApplyApproval(scope, "approve");
      recordApprovedPrivateApply(scope, "approve");
      for (const diagnostics of [
        undefined,
        [],
        [
          {
            code: "VITEST",
            column: 1,
            line: 1,
            message: "Assertion failed",
            path: "tests/unchanged.test.ts",
          },
        ],
        [
          {
            code: "VITEST",
            column: 1,
            line: 1,
            message: "tenant_scope_not_bound",
            path: "packages/auth/runtime.ts",
          },
        ],
      ]) {
        // SAFETY: Exercise only source-owned validator diagnostics; retained approval is real Eve state.
        const state = {
          ...failed,
          validationFailure: { ...failed.validationFailure, diagnostics },
        } as AppBuilderWorkflowState;
        expect(decide(state).decision).toBe("runnable");
      }
    });
  });
  it("keeps provider and materialization failures blocked", () => {
    contextStorage.run(new ContextContainer(), () => {
      requestPrivateApplyApproval(scope, "approve");
      recordApprovedPrivateApply(scope, "approve");
      for (const reason of [
        "execution-error",
        "command-timeout",
        "materialization-failed",
        "protected-workspace-drift",
      ] as const) {
        // SAFETY: Change only the validator failure reason, preserving the actual approval.
        const state = {
          ...failed,
          validationFailure: { ...failed.validationFailure, reason },
        } as AppBuilderWorkflowState;
        expect(decide(state).decision).toBe("blocked");
      }
    });
  });
  it("retains runnable app-owned legacy demo repair after a prose-only turn without declaring checks passed", () => {
    contextStorage.run(new ContextContainer(), () => {
      expect(decide().decision).toBe("blocked");
      requestPrivateApplyApproval(scope, "approve");
      recordApprovedPrivateApply(scope, "approve");
      const decision = decide();
      expect(decision.decision).toBe("runnable");
      expect(decision.validation).toMatchObject({
        command: "test",
        exitCode: 1,
        reason: "command-failed",
      });
      expect(decision.currentSpec?.appSpecDigest).toBe(scope.appSpecDigest);
      expect(failed.phase).toBe("validation_failed");
      expect(decide(failed, { pendingInput: true }).decision).toBe("waiting-input");
      expect(decide(failed, { blocked: true }).decision).toBe("blocked");
    });
  });
  it("current accepted spec is projected separately from an old or missing build approval", () => {
    contextStorage.run(new ContextContainer(), () => {
      requestPrivateApplyApproval(scope, "approve");
      recordApprovedPrivateApply(scope, "approve");
      // SAFETY: Only the accepted digest changes; this must never adopt the old approval.
      const changed = {
        ...failed,
        appSpec: { appId: scope.appId, digest: "d".repeat(64) },
      } as AppBuilderWorkflowState;
      const result = decide(changed);
      expect(result.currentSpec?.appSpecDigest).toBe("d".repeat(64));
      expect(result.scope).toBeUndefined();
      expect(result.decision).toBe("blocked");
    });
  });
});
