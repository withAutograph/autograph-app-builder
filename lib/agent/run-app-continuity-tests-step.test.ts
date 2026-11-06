/* oxlint-disable anti-slop/no-module-mocking -- Replace only authenticated transport while exercising canonical service, approval capture and production steps. */
/* oxlint-disable eslint/require-await -- Controlled provider ports keep asynchronous contracts. */
import { expect, it, vi } from "vitest";
import { z } from "zod";
import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import type { ContinuityApprovalToolInput } from "../eve/private-continuity-approval";
import "../../agent/tools/run-app-continuity-tests";
import { HostedOperatorError } from "../provisioning/hosted-operator-contract";
import {
  runHostedContinuityStep,
  readHostedContinuityApprovalStep,
  readHostedContinuityApprovalPreflightStep,
} from "./run-app-continuity-tests-step";
import { createPrivateContinuityApprovalCapture } from "../eve/private-continuity-approval";
import {
  authority,
  context,
  selection,
  setup,
} from "../provisioning/hosted-acceptance-recovery.test-fixture";

const hooks = vi.hoisted(() => ({
  approval: vi.fn<(ctx: ApprovalContext<ContinuityApprovalToolInput>) => Promise<ApprovalStatus>>(),
  client: vi.fn(),
}));
vi.mock("eve/tools", () => ({
  defineWorkflowTool: <
    T extends {
      approval: (ctx: ApprovalContext<ContinuityApprovalToolInput>) => Promise<ApprovalStatus>;
    },
  >(
    tool: T,
  ) => {
    hooks.approval.mockImplementation(tool.approval);
    return tool;
  },
}));
vi.mock("../provisioning/hosted-operator-client", () => ({
  hostedOperatorClientForSession: hooks.client,
}));

vi.mock("workflow", () => ({
  RetryableError: class extends Error {
    override name = "RetryableError";
  },
  sleep: vi.fn(),
}));

const fixture = async () => {
  const f = setup();
  const saved = await f.operations.plan(context, selection.runtime, "retained-continuity");
  const capture = createPrivateContinuityApprovalCapture({
    callId: "continuity-call",
    plan: saved.plan,
    principal: { ...authority, scopes: ["autograph:send"] },
    request: saved.request,
  });
  f.deps.readApproval = async () => capture.read();
  const client = {
    continuityApproval: async (request: typeof saved.request) =>
      await f.operations.approval(context, request),
    readContinuity: async (intentId: string) => await f.operations.readPlan(context, intentId),
    runContinuity: async (request: typeof saved.request, callId: string) =>
      await f.operations.execute(context, request, callId),
    sessionId: context.target.sessionId,
  };
  hooks.client.mockResolvedValue(client);
  const ctx = z.custom<Parameters<typeof runHostedContinuityStep>[1]>().parse({
    abortSignal: new AbortController().signal,
    callId: "continuity-call",
    session: {
      auth: {},
      id: context.target.sessionId,
      ownerAnchorRunId: context.target.sessionId,
      ownerRunId: "owner-run",
    },
  });
  const approve = () => {
    capture.observe({
      data: {
        requests: [
          {
            action: {
              callId: ctx.callId,
              input: saved.request,
              kind: "tool-call",
              toolName: "run-app-continuity-tests",
            },
            kind: "tool-approval",
            prompt: "Approve continuity",
            requestId: "native-approval",
          },
        ],
        sequence: 1,
        stepIndex: 0,
        turnId: "retained-turn",
      },
      meta: { at: "2026-11-03T00:00:00Z", id: "request-event" },
      type: "input.requested",
    });
    capture.observe({
      data: {
        outcome: "approved",
        requestId: "native-approval",
        responderPrincipalId: authority.ownerUserId,
        sequence: 2,
        stepIndex: 0,
        turnId: "retained-turn",
      },
      meta: { at: "2026-11-03T00:00:01Z", id: "approval-event" },
      type: "approval.settled",
    });
  };
  return { approve, capture, client, ctx, f, saved };
};

it("server-loads the complete saved plan from compact arguments and never executes before native settlement", async () => {
  const { f, saved, ctx, approve } = await fixture();
  expect(await readHostedContinuityApprovalPreflightStep(saved.request, ctx)).toEqual({
    approved: false,
  });
  expect(await readHostedContinuityApprovalStep(saved.request, ctx)).toMatchObject({
    approved: false,
  });
  await expect(runHostedContinuityStep(saved.request, ctx)).rejects.toMatchObject({
    code: "authorization_required",
  });
  expect(f.events).toEqual([]);
  approve();
  expect(await readHostedContinuityApprovalStep(saved.request, ctx)).toMatchObject({
    approved: true,
  });
  expect(await runHostedContinuityStep(saved.request, ctx)).toMatchObject({ state: "settled" });
  expect(f.events).toContain("dispatch-suite");
  expect(f.rows.get(saved.plan.intentId)?.plan.preparedPlan).toEqual(saved.plan.preparedPlan);
});

it("retains full-plan legacy input without accepting a model-reconstructed payload", async () => {
  const { saved, ctx } = await fixture();
  expect(
    await readHostedContinuityApprovalPreflightStep({ ...saved.request, plan: saved.plan }, ctx),
  ).toEqual({ approved: false });
  const changed = { ...saved.plan, actors: [{ actorId: "foreign", organizationId: "foreign" }] };
  await expect(
    readHostedContinuityApprovalPreflightStep({ ...saved.request, plan: changed }, ctx),
  ).rejects.toThrow();
});

it.each(["planDigest", "planRef", "idempotencyKey"] as const)(
  "rejects changed compact %s before dispatch",
  async (key) => {
    const { f, saved, ctx } = await fixture();
    const request = {
      ...saved.request,
      [key]: key === "planDigest" ? "f".repeat(64) : "different",
    };
    await expect(runHostedContinuityStep(request, ctx)).rejects.toThrow();
    expect(f.events).toEqual([]);
  },
);

it("rechecks owner, session and superseded canonical state on each stage", async () => {
  const { f, saved, ctx, client } = await fixture();
  f.revokeOwner();
  await expect(readHostedContinuityApprovalPreflightStep(saved.request, ctx)).rejects.toThrow();
  const other = await fixture();
  hooks.client.mockResolvedValue({ ...other.client, sessionId: "foreign-session" });
  await expect(readHostedContinuityApprovalStep(other.saved.request, other.ctx)).rejects.toThrow(
    "Continuity session differs",
  );
  hooks.client.mockResolvedValue({
    ...client,
    readContinuity: async () => ({
      ...saved,
      status: { ...saved.status, supersededBy: "30000000-0000-4000-8000-000000000003" },
    }),
  });
  await expect(runHostedContinuityStep(saved.request, ctx)).rejects.toThrow("superseded");
  expect(f.events).toEqual([]);
});

it("defers a transient canonical read without granting consent or losing the original request", async () => {
  const { f, saved, ctx, client } = await fixture();
  hooks.client.mockResolvedValue({
    ...client,
    readContinuity: async () => {
      throw new HostedOperatorError("operator_unavailable");
    },
  });
  await expect(readHostedContinuityApprovalStep(saved.request, ctx)).rejects.toMatchObject({
    name: "RetryableError",
  });
  await expect(readHostedContinuityApprovalPreflightStep(saved.request, ctx)).rejects.toMatchObject(
    {
      name: "RetryableError",
    },
  );
  await expect(
    hooks.approval(
      z
        .custom<ApprovalContext<ContinuityApprovalToolInput>>()
        .parse({ ...ctx, toolInput: saved.request }),
    ),
  ).rejects.toMatchObject({ name: "RetryableError" });
  expect(f.events).toEqual([]);
  hooks.client.mockResolvedValue(client);
  expect(await readHostedContinuityApprovalPreflightStep(saved.request, ctx)).toEqual({
    approved: false,
  });
});

it("recovers the original native approval for a still-planned intent before requesting duplicate consent", async () => {
  const { f, saved, ctx, approve } = await fixture();
  approve();
  const planned = await f.operations.readPlan(context, saved.plan.intentId);
  expect(planned.status.state).toBe("planned");
  await expect(readHostedContinuityApprovalPreflightStep(saved.request, ctx)).resolves.toEqual({
    approved: true,
  });
  expect(f.rows.get(saved.plan.intentId)?.approval).toMatchObject({
    approvalId: "native-approval",
    approvedByCallId: "continuity-call",
  });
  expect(f.events).toEqual([]);
  await expect(
    hooks.approval(
      z
        .custom<ApprovalContext<ContinuityApprovalToolInput>>()
        .parse({ ...ctx, toolInput: saved.request }),
    ),
  ).resolves.toBe("not-applicable");
  await expect(readHostedContinuityApprovalPreflightStep(saved.request, ctx)).resolves.toEqual({
    approved: true,
  });
  expect(f.rows.get(saved.plan.intentId)?.requestId).toBe(saved.plan.intentId);
});

it("defers an original unsettled native request during preflight while execution continues its legitimate wait", async () => {
  const { f, saved, ctx, client } = await fixture();
  hooks.client.mockResolvedValue({
    ...client,
    continuityApproval: async () => ({ approved: false, pending: true }),
  });
  await expect(readHostedContinuityApprovalPreflightStep(saved.request, ctx)).rejects.toThrow(
    "approval_settlement_pending",
  );
  await expect(
    hooks.approval(
      z
        .custom<ApprovalContext<ContinuityApprovalToolInput>>()
        .parse({ ...ctx, toolInput: saved.request }),
    ),
  ).rejects.toMatchObject({ name: "RetryableError" });
  await expect(readHostedContinuityApprovalStep(saved.request, ctx)).resolves.toMatchObject({
    approved: false,
    pending: true,
  });
  expect(f.events).toEqual([]);
});
