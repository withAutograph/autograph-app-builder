/* oxlint-disable anti-slop/no-module-mocking, anti-slop/no-unknown-parameters, anti-slop/no-object-parameters, typescript/consistent-type-imports -- Native event fixtures isolate persistence and deterministic preparation while retaining real acceptance, context and classification. */
/* oxlint-disable typescript/no-non-null-assertion, typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Focused fixtures provide only consumed native coordinates; real stores and producer paths validate authority separately. */
/* oxlint-disable eslint/require-await, eslint/no-await-in-loop, unicorn/no-await-expression-member -- Native lifecycle observations and durable store transitions are deliberately ordered; fixture ports preserve their asynchronous interface. */
/* oxlint-disable typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- Native lifecycle fixtures supply exact event/session fields; accepted intent uses the actual acceptance producer and Eve context. */
/* oxlint-disable sonarjs/no-internal-api-use -- Real Eve context is used only by focused native lifecycle tests. */
import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import type { HookContext } from "eve/hooks";
import { BUILD_READY_APP_SPEC } from "../../evals/support/app-spec";
import { appBuilderWorkflowState, sha256 } from "./workflow-state";
import type { AppBuilderWorkflowState } from "./workflow-state";
import { normalizeBuildReadyAppSpec } from "./app-spec-validation";
import {
  diagnosticAuthoringDecisionState,
  authenticatedAuthoringDelivery,
} from "./preapproval-authoring-runtime";
import { requestPrivateApplyApproval } from "./private-apply-authority";
import hook from "../../agent/hooks/continue-preapproval-authoring";
import acceptAppSpec from "../../agent/tools/accept_app_spec";

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), projection: vi.fn(), record: vi.fn() }));
vi.mock("eve/hooks", () => ({ defineHook: <T>(value: T) => value }));
vi.mock("eve/tools", () => ({ defineTool: <T>(value: T) => value }));
vi.mock("./prepare-app-creation", () => ({ prepareAppCreation: mocks.prepare }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Persistence is isolated; real native workflow classification and state are exercised without provider/database effects.
vi.mock("./preapproval-authoring-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./preapproval-authoring-runtime")>();
  return {
    ...actual,
    recordPreapprovalAuthoringDecision: async (
      _ctx: unknown,
      decision: Parameters<typeof actual.recordPreapprovalAuthoringDecision>[1],
    ) => {
      mocks.record(decision);
      actual.diagnosticAuthoringDecisionState.update(() => decision);
    },
  };
});
// oxlint-disable-next-line anti-slop/no-module-mocking -- Existing approved projection is outside preapproval lifecycle test scope.
vi.mock("./approved-build-continuation-runtime", () => ({
  emitCurrentBuildWorkflowProjection: mocks.projection,
}));
const ctx = { session: { id: "original-logical", turn: { id: "turn1", sequence: 1 } } } as Pick<
  HookContext,
  "session"
>;
const context = () => new ContextContainer();
const emit = async (name: string, data: object = {}, owner = ctx) => {
  const handlers = hook.events as unknown as Record<
    string,
    (event: { data: object }, ctx: HookContext) => Promise<void> | void
  >;
  const handler = handlers[name];
  if (handler === undefined) {
    throw new Error("Missing lifecycle fixture handler");
  }
  await handler({ data }, owner as HookContext);
};
const seed = async () => {
  const content = normalizeBuildReadyAppSpec(BUILD_READY_APP_SPEC);
  const artifact = {
    appId: "inventory",
    content,
    digest: sha256(content),
    mediaType: "text/markdown",
    path: "prototype/inventory/app-spec.md",
    revision: "revision1",
    sessionId: ctx.session.id,
    recordedByCallId: "record",
  };
  const state = {
    version: 17,
    phase: "prepared",
    artifacts: [artifact],
    preparedByCallId: "prepare",
    sourceReceipt: { digest: "a".repeat(64) },
    workspace: { workspaceId: "same-sandbox", workspaceDigest: "b".repeat(64) },
  } as unknown as AppBuilderWorkflowState;
  appBuilderWorkflowState.update(() => state);
  mocks.prepare.mockResolvedValue(null);
  await acceptAppSpec.execute({ appId: "inventory" }, {
    callId: "actual-accept",
    getSandbox: vi.fn(),
    getSkill: vi.fn(),
    session: ctx.session,
  } as unknown as Parameters<typeof acceptAppSpec.execute>[1]);
  expect(appBuilderWorkflowState.get().phase).toBe("app_spec_accepted");
};
beforeEach(() => {
  vi.clearAllMocks();
});
describe("native preapproval drafting lifecycle", () => {
  it("does not introduce persistence/auth prerequisites for a greeting or read-only empty workflow", async () => {
    await contextStorage.run(context(), async () => {
      await emit("turn.started");
      await emit("turn.completed");
      expect(mocks.record).not.toHaveBeenCalled();
    });
  });
  it("continues after three successful inspections using genuinely accepted logical intent", async () => {
    await contextStorage.run(context(), async () => {
      await seed();
      await emit("turn.started");
      for (const callId of ["read1", "read2", "read3"]) {
        await emit("actions.requested", { actions: [{ callId }] });
        await emit("action.result", {
          status: "completed",
          result: { kind: "tool-result", toolName: "inspect_existing_app", callId, output: {} },
        });
      }
      await emit("turn.completed");
      expect(diagnosticAuthoringDecisionState.get()).toMatchObject({
        decision: "runnable",
        scope: {
          acceptedByCallId: "actual-accept",
          authoritySessionId: "original-logical",
          workspaceId: "same-sandbox",
        },
      });
    });
  });
  it.each([
    "failed",
    "rejected",
    "unfinished",
    "isError",
    "cancelled",
    "pendingInput",
    "pendingApproval",
  ])("blocks actual %s native boundary", async (mode) => {
    await contextStorage.run(context(), async () => {
      await seed();
      await emit("turn.started");
      if (mode === "pendingInput") {
        await emit("input.requested", { requests: [{ requestId: "real-question" }] });
      } else if (mode === "pendingApproval") {
        requestPrivateApplyApproval(
          {
            sessionId: ctx.session.id,
            appId: "inventory",
            appSpecDigest: "c".repeat(64),
            proposalDigest: "d".repeat(64),
            workspaceId: "same-sandbox",
          },
          "pending-build",
        );
      } else if (mode === "cancelled") {
        await emit("turn.cancelled");
      } else {
        await emit("actions.requested", { actions: [{ callId: "read" }] });
        if (mode !== "unfinished") {
          await emit("action.result", {
            status: mode === "isError" ? "completed" : mode,
            result: {
              kind: "tool-result",
              toolName: "inspect_repository",
              callId: "read",
              output: {},
              isError: mode === "isError",
            },
          });
        }
      }
      if (mode !== "cancelled") {
        await emit("turn.completed");
      }
      expect(diagnosticAuthoringDecisionState.get()?.decision).not.toBe("runnable");
    });
  });
  it("shows typed no-progress only when an authenticated drafting turn leaves planning state unchanged", async () => {
    await contextStorage.run(context(), async () => {
      await seed();
      await emit("turn.started");
      await emit("turn.completed");
      const first = diagnosticAuthoringDecisionState.get()!;
      authenticatedAuthoringDelivery.update(() => ({
        turnId: "turn1",
        scopeDigest: first.scopeDigest!,
      }));
      await emit("turn.completed");
      expect(diagnosticAuthoringDecisionState.get()).toMatchObject({
        decision: "blocked",
        reason: "authoring_no_progress",
      });
    });
  });
  it("keeps actual dependency progress eligible instead of treating it as inspection-only", async () => {
    await contextStorage.run(context(), async () => {
      await seed();
      await emit("turn.started");
      await emit("turn.completed");
      const before = diagnosticAuthoringDecisionState.get()!;
      authenticatedAuthoringDelivery.update(() => ({
        turnId: "turn1",
        scopeDigest: before.scopeDigest!,
      }));
      const state = appBuilderWorkflowState.get();
      appBuilderWorkflowState.update(
        () =>
          ({
            ...state,
            phase: "dependencies_prepared",
            dependencyReceipt: { digest: "e".repeat(64) },
          }) as unknown as AppBuilderWorkflowState,
      );
      await emit("turn.completed");
      expect(diagnosticAuthoringDecisionState.get()?.decision).toBe("runnable");
      expect(diagnosticAuthoringDecisionState.get()?.scopeDigest).not.toBe(before.scopeDigest);
    });
  });
});
