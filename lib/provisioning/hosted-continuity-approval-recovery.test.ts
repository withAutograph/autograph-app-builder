/* oxlint-disable eslint/require-await -- Controlled asynchronous boundaries exercise the actual client, dispatcher, journal and native approval capture. */
import { isDeepStrictEqual } from "node:util";
import type { MessageStreamEvent } from "eve/client";
import { expect, it } from "vitest";
import { createPrivateContinuityApprovalCapture } from "../eve/private-continuity-approval";
import { readPrivateOperatorApproval } from "../eve/private-operator-approval-observation";
import { HostedOperatorError, sameOperatorSelection } from "./hosted-operator-contract";
import {
  createHostedOperatorClient,
  HostedOperatorTransportUnknown,
} from "./hosted-operator-client";
import { createHostedContinuityOperations } from "./hosted-operator-continuity";
import {
  createContinuityDispatcher,
  continuityTransportRequestSchema,
} from "./hosted-operator-continuity-transport";
import { createProtectedHostedOperatorHandler } from "./hosted-operator-service";
import type { ProtectedHostedOperatorDependencies } from "./hosted-operator-service";
import { authority, context, selection, setup } from "./hosted-acceptance-recovery.test-fixture";

const ownerContext = {
  kind: "direct" as const,
  adapterSessionId: "native-owner-anchor",
  adapterGeneration: 1,
  authority,
  principal: { ...authority, scopes: ["autograph:send"] },
  sessionId: context.target.sessionId,
};
const unexpected = async () => {
  throw new Error("Approval recovery must not prepare another app or resource");
};

const composed = async () => {
  const f = setup();
  const saved = await f.operations.plan(context, selection.runtime, "same-retained-intent");
  const events: MessageStreamEvent[] = [
    {
      type: "input.requested",
      meta: { at: "2026-10-20T14:00:01Z", id: "native-request-event" },
      data: {
        sequence: 1,
        stepIndex: 0,
        turnId: "original-turn",
        requests: [
          {
            kind: "tool-approval",
            requestId: "original-human-approval",
            prompt: "Run this saved suite?",
            action: {
              kind: "tool-call",
              toolName: "run-app-continuity-tests",
              callId: "original-tool-call",
              input: saved.request,
            },
          },
        ],
      },
    },
    {
      type: "approval.settled",
      meta: { at: "2026-10-20T14:00:02Z", id: "native-settlement-event" },
      data: {
        sequence: 2,
        stepIndex: 0,
        turnId: "",
        requestId: "original-human-approval",
        responderPrincipalId: authority.ownerUserId,
        outcome: "approved",
      },
    },
  ];
  let pageSize = events.length;
  let historyUnavailable = false;
  let loseExecuteResponse = false;
  const starts: number[] = [];
  f.deps.readApproval = async (_ctx, request, callId, observation) =>
    await readPrivateOperatorApproval({
      owner: ownerContext,
      ...(observation === undefined ? {} : { observation }),
      capture: (state) =>
        createPrivateContinuityApprovalCapture({
          plan: saved.plan,
          request,
          principal: ownerContext.principal,
          ...(callId === undefined ? {} : { callId }),
          ...(state === undefined ? {} : { state }),
        }),
      readHistory: async (startIndex, onEvent) => {
        starts.push(startIndex);
        if (historyUnavailable) {
          throw new HostedOperatorError("operator_unavailable");
        }
        const end = Math.min(events.length, startIndex + pageSize);
        for (const event of events.slice(startIndex, end)) {
          onEvent(event);
        }
        return {
          nextNativeIndex: end,
          nativeTailIndex: events.length,
          complete: end === events.length,
        };
      },
      assertOwner: async () => {
        await f.deps.assertOwner(context);
      },
    });
  const verifyWorkload = async (request: Request) => {
    if (request.headers.get("authorization") !== "Bearer controlled-workload") {
      throw new HostedOperatorError("authorization_required");
    }
  };
  const authorize: ProtectedHostedOperatorDependencies["authorize"] = async (
    request,
    target,
    hint,
  ) => {
    await verifyWorkload(request);
    if (
      !sameOperatorSelection(target, saved.plan.preparedPlan.selection) ||
      !isDeepStrictEqual(hint, ownerContext)
    ) {
      throw new HostedOperatorError("authorization_required");
    }
    await f.deps.assertOwner(context);
    return { ...context, ownerContext };
  };
  // Rebuilding these request-local objects models a stopped caller/process without replacing its journal.
  const client = () => {
    const operations = createHostedContinuityOperations(f.deps);
    const dispatcher = createContinuityDispatcher({
      store: f.deps.store,
      operations,
      verifyWorkload,
      authorize,
      authorizeRead: async (request, current) => {
        await verifyWorkload(request);
        if (!isDeepStrictEqual(current.ownerContext, ownerContext)) {
          throw new HostedOperatorError("authorization_required");
        }
        await f.deps.assertOwner(context);
        return current;
      },
      bindWorkload: () => {},
    });
    const handler = createProtectedHostedOperatorHandler({
      authorize,
      assertAuthorized: unexpected,
      plan: unexpected,
      readApproval: unexpected,
      withResourceLease: unexpected,
      reconcile: unexpected,
      executeEffect: unexpected,
      verify: unexpected,
      bindings: unexpected,
      store: {
        read: unexpected,
        reserve: unexpected,
        compareAndSet: unexpected,
        reserveFenceGeneration: unexpected,
      },
      continuityRequest: dispatcher,
    });
    return createHostedOperatorClient({
      endpoint: "https://operator.fixture.test",
      ownerContext,
      sessionId: context.target.sessionId,
      token: async () => "controlled-workload",
      fetch: async (url, init) => {
        const request = new Request(url instanceof Request ? url.url : url, init);
        const action = continuityTransportRequestSchema.parse(await request.clone().json()).action;
        const result = await handler(request);
        if (action === "continuity" && loseExecuteResponse) {
          loseExecuteResponse = false;
          throw new TypeError("Lost response after the server completed the same operation");
        }
        return result;
      },
    });
  };
  return {
    f,
    saved,
    events,
    starts,
    client,
    setPageSize: (value: number) => {
      pageSize = value;
    },
    setHistoryUnavailable: (value: boolean) => {
      historyUnavailable = value;
    },
    loseNextExecuteResponse: () => {
      loseExecuteResponse = true;
    },
  };
};

it("recovers the original native approval after a paginated interruption, then dispatches and cleans up once despite response loss", async () => {
  const c = await composed();
  c.setPageSize(1);
  await expect(c.client().continuityApproval(c.saved.request)).rejects.toMatchObject({
    code: "operator_unavailable",
    recoveryProgressAdvanced: true,
    recoveryStage: "native_history",
  });
  expect(c.f.rows.get(c.saved.plan.intentId)?.approvalObservation?.nextNativeIndex).toBe(1);
  expect(c.f.events).toEqual([]);
  expect(await c.client().continuityApproval(c.saved.request)).toEqual({ approved: true });
  expect(c.starts).toEqual([0, 1]);
  expect(c.f.rows.get(c.saved.plan.intentId)?.approval).toMatchObject({
    approvalId: "original-human-approval",
    approvedByCallId: "original-tool-call",
    planDigest: c.saved.request.planDigest,
  });
  c.loseNextExecuteResponse();
  await expect(
    c.client().runContinuity(c.saved.request, "resumed-tool-call"),
  ).rejects.toBeInstanceOf(HostedOperatorTransportUnknown);
  expect(await c.client().continuityStatus(c.saved.plan.intentId)).toMatchObject({
    state: "settled",
  });
  expect(await c.client().runContinuity(c.saved.request, "another-transport-retry")).toMatchObject({
    state: "settled",
  });
  expect(c.f.events.filter((event) => event === "dispatch-suite")).toHaveLength(1);
  expect(c.f.events.filter((event) => event === "close")).toHaveLength(1);
  expect(c.f.events.filter((event) => event === "revoke-owned-rows")).toHaveLength(1);
  expect(c.f.rows.size).toBe(1);
  expect(c.f.rows.get(c.saved.plan.intentId)?.plan).toEqual(c.saved.plan);
});

it("reports a setup refusal separately from missing native consent", async () => {
  const c = await composed();
  c.f.deps.assertSetup = async () => {
    throw new HostedOperatorError("operation_in_progress");
  };
  await expect(c.client().continuityApproval(c.saved.request)).rejects.toMatchObject({
    code: "operation_in_progress",
    recoveryStage: "setup",
  });
  expect(c.starts).toEqual([]);
  expect(c.f.events).toEqual([]);
});

it("distinguishes a retained approval still awaiting settlement from a fresh request", async () => {
  const c = await composed();
  const settled = c.events.pop();
  expect(await c.client().continuityApproval(c.saved.request)).toEqual({
    approved: false,
    pending: true,
  });
  expect(c.f.events).toEqual([]);
  if (settled === undefined) {
    throw new Error("Missing controlled native settlement");
  }
  c.events.push(settled);
  expect(await c.client().continuityApproval(c.saved.request)).toEqual({ approved: true });
  expect(c.f.rows.get(c.saved.plan.intentId)?.approval?.approvalId).toBe("original-human-approval");
});

it("reconciles the exact receipt when another approval reader wins the journal write", async () => {
  const c = await composed();
  const compareAndSet = c.f.deps.store.compareAndSet;
  let raced = false;
  c.f.deps.store.compareAndSet = async (input): ReturnType<typeof compareAndSet> => {
    if (!raced && input.record.approval !== undefined) {
      raced = true;
      await compareAndSet(input);
      // oxlint-disable-next-line unicorn/no-useless-undefined -- A lost CAS returns no journal winner.
      return undefined;
    }
    return await compareAndSet(input);
  };
  expect(await c.client().continuityApproval(c.saved.request)).toEqual({ approved: true });
  expect(c.f.rows.get(c.saved.plan.intentId)?.approval?.approvalId).toBe("original-human-approval");
  expect(c.f.events).toEqual([]);
});

it("retains progress through transport failure and a checkpoint CAS conflict without granting or losing consent", async () => {
  const c = await composed();
  c.setPageSize(1);
  c.f.rejectNextCas();
  await expect(c.client().continuityApproval(c.saved.request)).rejects.toMatchObject({
    code: "operation_in_progress",
    recoveryStage: "journal",
  });
  expect(c.f.rows.get(c.saved.plan.intentId)?.approval).toBeUndefined();
  await expect(c.client().continuityApproval(c.saved.request)).rejects.toMatchObject({
    code: "operator_unavailable",
  });
  c.setHistoryUnavailable(true);
  await expect(c.client().continuityApproval(c.saved.request)).rejects.toMatchObject({
    code: "operator_unavailable",
  });
  expect(c.f.rows.get(c.saved.plan.intentId)?.approvalObservation?.nextNativeIndex).toBe(1);
  expect(c.f.events).toEqual([]);
  c.setHistoryUnavailable(false);
  expect(await c.client().continuityApproval(c.saved.request)).toEqual({ approved: true });
  expect(c.starts).toEqual([0, 0, 1, 1]);
  expect(c.f.rows.get(c.saved.plan.intentId)?.approval?.approvalId).toBe("original-human-approval");
});

it.each(["cancelled", "foreign", "different-request", "changed-digest", "conflicting-settlement"])(
  "never dispatches from %s native evidence",
  async (failure) => {
    const c = await composed();
    const settlement = c.events[1];
    if (settlement?.type !== "approval.settled") {
      throw new Error("Missing controlled native settlement");
    }
    if (failure === "cancelled") {
      settlement.data.outcome = "cancelled";
    }
    if (failure === "foreign") {
      settlement.data.responderPrincipalId = "different-owner";
    }
    if (failure === "different-request") {
      settlement.data.requestId = "unrelated-approval";
    }
    if (failure === "conflicting-settlement") {
      c.events.push({
        ...settlement,
        meta: { at: "2026-10-20T14:00:03Z", id: "conflicting-native-settlement" },
        data: { ...settlement.data, sequence: 3, outcome: "cancelled" },
      });
      c.setPageSize(c.events.length);
    }
    if (failure === "changed-digest") {
      const requested = c.events[0];
      if (requested?.type !== "input.requested") {
        throw new Error("Missing controlled request");
      }
      const first = requested.data.requests[0];
      if (first?.kind !== "tool-approval") {
        throw new Error("Missing controlled tool approval");
      }
      first.action.input = { ...c.saved.request, planDigest: "f".repeat(64) };
    }
    if (["cancelled", "foreign", "conflicting-settlement"].includes(failure)) {
      await expect(c.client().continuityApproval(c.saved.request)).rejects.toMatchObject({
        code: "authorization_required",
        recoveryStage: "native_history",
      });
    } else {
      const result = await c.client().continuityApproval(c.saved.request);
      expect(result.approved).toBe(false);
      expect(result.pending).toBe(failure === "different-request" ? true : undefined);
    }
    await expect(
      c.client().runContinuity(c.saved.request, "resumed-tool-call"),
    ).rejects.toMatchObject({ code: "authorization_required" });
    expect(c.f.events).toEqual([]);
    expect(c.f.rows.get(c.saved.plan.intentId)?.attemptId).toBeUndefined();
  },
);
