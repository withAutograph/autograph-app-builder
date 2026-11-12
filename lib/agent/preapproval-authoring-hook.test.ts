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
import { recordInitialBuildAuthoring } from "./initial-build-authoring";
import { readPrivateApplyAuthority, requestPrivateApplyApproval } from "./private-apply-authority";
import { observePrivateApplyDecisionEvent } from "./private-apply-decision-lifecycle";
import { privateApplyDenialEvents } from "../eve/private-apply-denial.test-fixture";
import { targetProposalSchema } from "../repository/target-planning";
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

const freezePlan = (callId: string, operation?: "iterate-existing-app") => {
  const current = appBuilderWorkflowState.get();
  if (current.phase !== "app_spec_accepted" && current.phase !== "planned") {
    throw new Error("This fixture needs an accepted app");
  }
  const { appId, artifactPath, digest } = current.appSpec;
  const packageName = `@repo/${appId}`;
  const appSpec = { path: artifactPath, sha256: digest };
  const changes = [
    {
      after: { content: "updated", digest: sha256("updated"), mode: "644" },
      path: `apps/${appId}/app/page.tsx`,
    },
  ];
  const contract = { appId, appSpec, version: 1 };
  const target = targetProposalSchema.parse({
    blockers: [],
    contract,
    mutations: [],
    plan: {
      product: { appSpec },
      source: {
        packageName,
        runtime: "nextjs",
        schema: { kind: "none" },
        workspacePath: `apps/${appId}`,
      },
      topology: {
        configPath: "microfrontends.json",
        packageName,
        projectName: appId,
        routes: [`/${appId}`],
      },
    },
    ...(operation === undefined
      ? undefined
      : { operation, iteration: { changes, digest: sha256(JSON.stringify(changes)) } }),
  });
  const proposal = {
    version: 1,
    appSpecDigest: digest,
    artifactRevision: current.appSpec.artifactRevision,
    contractDigest: sha256(JSON.stringify(contract)),
    plannedByCallId: callId,
    sourceReceiptDigest: current.sourceReceipt.digest,
    target,
    workspaceDigest: current.workspace.workspaceDigest,
  };
  const planned = {
    ...current,
    phase: "planned",
    dependencyReceipt: { digest: sha256("dependency") },
    identityReceipt: { digest: sha256("identity"), identity: { appId } },
    proposal: { ...proposal, digest: sha256(JSON.stringify(proposal)) },
  } as unknown as Extract<AppBuilderWorkflowState, { phase: "planned" }>;
  appBuilderWorkflowState.update(() => planned);
  return planned;
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
  it("continues the first frozen Build plan after an idle turn without release preflight", async () => {
    await contextStorage.run(context(), async () => {
      await seed();
      await emit("turn.started");
      await emit("actions.requested", { actions: [{ callId: "first-plan" }] });
      freezePlan("first-plan");
      recordInitialBuildAuthoring(ctx.session.id);
      await emit("action.result", {
        status: "completed",
        result: {
          kind: "tool-result",
          toolName: "prepare_app_creation",
          callId: "first-plan",
          output: { reused: false },
        },
      });
      await emit("turn.completed");
      const ready = diagnosticAuthoringDecisionState.get();
      expect(ready).toMatchObject({
        decision: "runnable",
        scope: { authoritySessionId: ctx.session.id, acceptedByCallId: "actual-accept" },
      });
      expect(readPrivateApplyAuthority()).toEqual({ grant: null, pending: [] });

      const nextTurn = {
        session: { ...ctx.session, turn: { id: "authoring-turn", sequence: 2 } },
      };
      await emit("turn.started", {}, nextTurn);
      authenticatedAuthoringDelivery.update(() => ({
        turnId: nextTurn.session.turn.id,
        scopeDigest: ready!.scopeDigest!,
      }));
      await emit("turn.completed", {}, nextTurn);
      expect(diagnosticAuthoringDecisionState.get()).toMatchObject({
        decision: "blocked",
        reason: "authoring_no_progress",
      });
    });
  });
  it("requires a recording for the exact current first plan", async () => {
    await contextStorage.run(context(), async () => {
      await seed();
      await emit("turn.started");
      freezePlan("first-plan");
      await emit("turn.completed");
      expect(diagnosticAuthoringDecisionState.get()?.decision).toBe("planned");

      recordInitialBuildAuthoring(ctx.session.id);
      freezePlan("replacement-plan");
      await emit("turn.completed");
      expect(diagnosticAuthoringDecisionState.get()?.decision).toBe("planned");
    });
  });
  it("keeps existing app proposals outside first-Build continuation", async () => {
    await contextStorage.run(context(), async () => {
      await seed();
      await emit("turn.started");
      freezePlan("revision-plan", "iterate-existing-app");
      recordInitialBuildAuthoring(ctx.session.id);
      await emit("turn.completed");
      expect(diagnosticAuthoringDecisionState.get()?.decision).toBe("planned");
    });
  });
  it("waits for pending Build approval and respects a settled denial on the first plan", async () => {
    await contextStorage.run(context(), async () => {
      await seed();
      await emit("turn.started");
      const state = freezePlan("first-plan");
      recordInitialBuildAuthoring(ctx.session.id);
      requestPrivateApplyApproval(
        {
          appId: state.appSpec.appId,
          appSpecDigest: state.appSpec.digest,
          proposalDigest: state.proposal.digest,
          sessionId: ctx.session.id,
          workspaceId: state.workspace.workspaceId,
        },
        "pending-build",
      );
      await emit("turn.completed");
      expect(diagnosticAuthoringDecisionState.get()?.decision).toBe("waiting-input");
      expect(readPrivateApplyAuthority().grant).toBeNull();

      for (const event of privateApplyDenialEvents("pending-build")) {
        observePrivateApplyDecisionEvent(
          event as Parameters<typeof observePrivateApplyDecisionEvent>[0],
          ctx.session.id,
        );
      }
      await emit("turn.completed");
      expect(readPrivateApplyAuthority().pending).toEqual([]);
      expect(diagnosticAuthoringDecisionState.get()?.decision).toBe("planned");
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
