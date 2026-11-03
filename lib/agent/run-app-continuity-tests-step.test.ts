/* oxlint-disable anti-slop/no-module-mocking -- Replace only authenticated transport while exercising canonical service, approval capture and production steps. */
/* oxlint-disable eslint/require-await -- Controlled provider ports keep asynchronous contracts. */
import { expect, it, vi } from "vitest";
import { z } from "zod";
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

const hooks = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock("../provisioning/hosted-operator-client", () => ({
  hostedOperatorClientForSession: hooks.client,
}));

const fixture = async () => {
  const f = setup();
  const saved = await f.operations.plan(context, selection.runtime, "retained-continuity");
  const capture = createPrivateContinuityApprovalCapture({
    plan: saved.plan,
    request: saved.request,
    principal: { ...authority, scopes: ["autograph:send"] },
    callId: "continuity-call",
  });
  f.deps.readApproval = async () => capture.read();
  const client = {
    sessionId: context.target.sessionId,
    readContinuity: async (intentId: string) => await f.operations.readPlan(context, intentId),
    continuityApproval: async (request: typeof saved.request) =>
      await f.operations.approval(context, request),
    runContinuity: async (request: typeof saved.request, callId: string) =>
      await f.operations.execute(context, request, callId),
  };
  hooks.client.mockResolvedValue(client);
  const ctx = z.custom<Parameters<typeof runHostedContinuityStep>[1]>().parse({
    session: {
      id: context.target.sessionId,
      auth: {},
      ownerRunId: "owner-run",
      ownerAnchorRunId: context.target.sessionId,
    },
    callId: "continuity-call",
    abortSignal: new AbortController().signal,
  });
  const approve = () => {
    capture.observe({
      type: "input.requested",
      meta: { at: "2026-11-03T00:00:00Z", id: "request-event" },
      data: {
        sequence: 1,
        stepIndex: 0,
        turnId: "retained-turn",
        requests: [
          {
            kind: "tool-approval",
            requestId: "native-approval",
            prompt: "Approve continuity",
            action: {
              kind: "tool-call",
              toolName: "run-app-continuity-tests",
              callId: ctx.callId,
              input: saved.request,
            },
          },
        ],
      },
    });
    capture.observe({
      type: "approval.settled",
      meta: { at: "2026-11-03T00:00:01Z", id: "approval-event" },
      data: {
        sequence: 2,
        stepIndex: 0,
        turnId: "retained-turn",
        requestId: "native-approval",
        responderPrincipalId: authority.ownerUserId,
        outcome: "approved",
      },
    });
  };
  return { f, saved, capture, client, ctx, approve };
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
  expect(await readHostedContinuityApprovalStep(saved.request, ctx)).toMatchObject({
    approved: false,
  });
  expect(f.events).toEqual([]);
  hooks.client.mockResolvedValue(client);
  expect(await readHostedContinuityApprovalPreflightStep(saved.request, ctx)).toEqual({
    approved: false,
  });
});
