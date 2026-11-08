/* oxlint-disable anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- The fixture models exactly the trusted workflow fields consumed by this classifier; actual approval uses installed Eve state, not a stub grant. */
/* oxlint-disable sonarjs/no-internal-api-use -- Actual Eve approval state is exercised only in this fixture, never imported by product code. */
import { describe, expect, it, vi } from "vitest";
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
import { appBuilderWorkflowState } from "./workflow-state";
import type { AppBuilderWorkflowState } from "./workflow-state";
import type { HookContext } from "eve/hooks";
import hook from "../../agent/hooks/continue-approved-build";
import {
  authenticatedBuildDelivery,
  currentApprovedBuildProgress,
  recordApprovedBuildDecision,
} from "./approved-build-continuation-runtime";

// oxlint-disable-next-line anti-slop/no-module-mocking -- Lifecycle events are delivered directly and only remote projection persistence is stubbed.
vi.mock("eve/hooks", () => ({ defineHook: <T>(value: T) => value }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep real workflow and progress state while isolating the hosted database adapter.
vi.mock("./approved-build-continuation-runtime", async (importOriginal) => ({
  ...(await importOriginal<{
    authenticatedBuildDelivery: typeof authenticatedBuildDelivery;
    currentApprovedBuildProgress: typeof currentApprovedBuildProgress;
  }>()),
  recordApprovedBuildDecision: vi.fn(),
}));

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

const approveBuild = () => {
  requestPrivateApplyApproval(scope, "approve");
  recordApprovedPrivateApply(scope, "approve");
};

describe("approved apply and review continuation", () => {
  it("continues an approved plan before apply and a validated app before review", () => {
    contextStorage.run(new ContextContainer(), () => {
      // SAFETY: Only the phase, frozen proposal and scope are read before apply.
      const planned = { ...failed, phase: "planned" } as AppBuilderWorkflowState;
      // SAFETY: Only the phase, applied tree and scope are read before review.
      const validated = { ...failed, phase: "validated" } as unknown as AppBuilderWorkflowState;
      expect(decide(planned).decision).toBe("blocked");
      approveBuild();
      expect(decide(planned).decision).toBe("runnable");
      expect(decide(validated).decision).toBe("runnable");
      expect(decide(validated, { pendingInput: true }).decision).toBe("waiting-input");
      // SAFETY: Settled private review needs only the retained approved scope.
      const reviewed = { ...failed, phase: "reviewed" } as unknown as AppBuilderWorkflowState;
      expect(decide(reviewed).decision).toBe("settled");
    });
  });

  it("repairs a completed apply command failure and preserves uncertain and stale operations", () => {
    contextStorage.run(new ContextContainer(), () => {
      approveBuild();
      const applyFailure = {
        command: { exitCode: 1, name: "create-app" },
        commandFailureKind: "dependency" as const,
        reason: "command-failed" as const,
      };
      // SAFETY: The classifier reads only the retained scope and command outcome.
      const rejected = { ...failed, phase: "apply_failed", applyFailure } as unknown as Extract<
        AppBuilderWorkflowState,
        { phase: "apply_failed" }
      >;
      expect(decide(rejected).decision).toBe("runnable");
      expect(
        decide({
          ...rejected,
          applyFailure: { ...rejected.applyFailure, commandFailureKind: "stale-proposal" },
        }).decision,
      ).toBe("blocked");
      expect(
        decide({
          ...rejected,
          applyFailure: {
            ...rejected.applyFailure,
            command: { ...rejected.applyFailure.command, exitCode: -1 },
          },
        }).decision,
      ).toBe("blocked");
    });
  });

  it("stops an authenticated continuation that merely creates another identical failed attempt", async () => {
    await contextStorage.run(new ContextContainer(), async () => {
      approveBuild();
      appBuilderWorkflowState.update(() => failed);
      const turn = { id: "repair-turn", sequence: 14 };
      authenticatedBuildDelivery.update(() => ({
        progress: currentApprovedBuildProgress(),
        turnId: turn.id,
      }));
      appBuilderWorkflowState.update(() => ({
        ...failed,
        validationFailure: { ...failed.validationFailure, attemptDigest: "f".repeat(64) },
      }));
      // SAFETY: The finish hook reads only the native session and turn identities.
      const ctx = { session: { id: scope.sessionId, turn } } as HookContext;
      const complete = hook.events?.["turn.completed"];
      if (!complete) {
        throw new Error("Expected the approved build completion hook.");
      }
      // SAFETY: The completed event body is unused by this handler.
      await complete({} as never, ctx);
      expect(recordApprovedBuildDecision).toHaveBeenLastCalledWith(
        ctx,
        expect.objectContaining({ decision: "blocked", reason: "build_no_progress" }),
      );
    });
  });
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
        "tooling-prerequisite",
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
  it.each(["native-tool-panic", "missing-app-task"])(
    "retains typed %s facts and allows recovery from a checker panic",
    (failureClass) => {
      contextStorage.run(new ContextContainer(), () => {
        requestPrivateApplyApproval(scope, "approve");
        recordApprovedPrivateApply(scope, "approve");
        // SAFETY: Change only source-owned fatal validation facts while preserving the real retained approval.
        const state = {
          ...failed,
          validationFailure: {
            ...failed.validationFailure,
            reason: "tooling-prerequisite",
            commandFailure: { exitCode: 134, failureClass, name: "check-build" },
          },
        } as AppBuilderWorkflowState;
        expect(decide(state)).toMatchObject({
          decision: failureClass === "native-tool-panic" ? "runnable" : "blocked",
          validation: {
            exitCode: 134,
            failureClass,
            reason: "tooling-prerequisite",
          },
        });
        // SAFETY: An actual later apply phase has no pending validation failure authority.
        const reapplied = { ...failed, phase: "applied" } as AppBuilderWorkflowState;
        expect(decide(reapplied).decision).toBe("runnable");
      });
    },
  );
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

it("projects only the independently acquired existing repository into private destination recovery", async () => {
  const { recordRepositoryAccessReceipt } = await import("./repository-access-state");
  const access = recordRepositoryAccessReceipt({
    current: undefined,
    sessionId: scope.sessionId,
    confirmedByCallId: "actual-repository-acquisition",
    access: {
      accessDigest: "3".repeat(64),
      repository: {
        archived: false,
        defaultBranch: "main",
        headSha: "1".repeat(40),
        headTree: "2".repeat(40),
        name: "existing-app",
        owner: "owned",
        repositoryId: "200",
        repositoryVariableNames: [],
        visibility: "private",
      },
      scope: { accountLogin: "owned", accountType: "Organization", installationId: "10" },
      status: "ready",
    },
  });
  const state = {
    ...failed,
    sourceReceipt: { ...failed.sourceReceipt, sourceKind: "existing-repository" as const },
    githubSource: {
      version: 2 as const,
      repository: {
        version: 2 as const,
        repositoryId: "200",
        name: "existing-app",
        owner: "owned",
        visibility: "private" as const,
        defaultBranch: "main",
        headSha: "1".repeat(40),
        headTree: "2".repeat(40),
        installationIdentityDigest: "4".repeat(64),
        releaseGate: { name: "REPOSITORY_RELEASE_ENABLED" as const, configured: true },
        digest: "5".repeat(64),
      },
      installationIdentityDigest: "4".repeat(64),
      resolvedRef: "refs/heads/main",
      resolvedSha: "1".repeat(40),
      resolvedTree: "2".repeat(40),
      resolvedByCallId: "actual-source-acquisition",
      digest: "6".repeat(64),
    },
  };
  const project = (repositoryAccess = access) =>
    decideApprovedBuildContinuation({
      adapterSessionId: scope.sessionId,
      approvalMatches: () => false,
      blocked: false,
      pendingInput: false,
      repositoryAccess,
      state,
      turnId: "revision-turn",
      turnSequence: 1,
    });
  expect(project().existingRepositorySource).toEqual(access);
  expect(
    project({ ...access, repository: { ...access.repository, repositoryId: "201" } })
      .existingRepositorySource,
  ).toBeUndefined();
  expect(
    decideApprovedBuildContinuation({
      adapterSessionId: scope.sessionId,
      approvalMatches: () => false,
      blocked: false,
      pendingInput: false,
      repositoryAccess: access,
      state: { ...state, sourceReceipt: { ...state.sourceReceipt, sourceKind: "fresh-template" } },
      turnId: "revision-turn",
      turnSequence: 1,
    }).existingRepositorySource,
  ).toBeUndefined();
});
