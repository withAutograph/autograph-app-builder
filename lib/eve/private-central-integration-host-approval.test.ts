import { describe, expect, it, vi } from "vitest";
import type { MessageStreamEvent } from "eve/client";
import { plan } from "../provisioning/central-integration-host-test-fixture";
import {
  centralHostPlanDigest,
  centralHostOperationRef,
} from "../provisioning/central-integration-host-contract";
import { operatorOwnerContextSchema } from "../provisioning/hosted-operator-contract";
import {
  createPrivateCentralHostApprovalCapture,
  readPrivateCentralHostApproval,
} from "./private-central-integration-host-approval";

const authority = plan.authority;
const input = {
  plan,
  planDigest: centralHostPlanDigest(plan),
  operationRef: centralHostOperationRef(plan),
};
const owner = operatorOwnerContextSchema.parse({
  kind: "direct",
  authority,
  principal: { ...authority, scopes: ["autograph:send"] },
  sessionId: plan.selection.sessionId,
  adapterSessionId: "native",
  adapterGeneration: 1,
});
const request = (
  callId = "current-call",
  requestId = "request",
  toolInput = input,
): MessageStreamEvent => ({
  type: "input.requested",
  meta: { at: "2026-11-03T00:00:00Z", id: "request-event" },
  data: {
    sequence: 1,
    stepIndex: 0,
    turnId: "turn",
    requests: [
      {
        kind: "tool-approval",
        requestId,
        prompt: "Bind named runtime configuration and publish the reviewed source",
        action: {
          kind: "tool-call",
          toolName: "prepare-app-central-integrations",
          callId,
          input: toolInput,
        },
      },
    ],
  },
});
const settlement = (
  outcome: "approved" | "cancelled" = "approved",
  requestId = "request",
  responderPrincipalId = authority.ownerUserId,
): MessageStreamEvent => ({
  type: "approval.settled",
  meta: { at: "2026-11-03T00:00:01Z", id: "settled-event" },
  data: { sequence: 2, stepIndex: 0, turnId: "turn", requestId, responderPrincipalId, outcome },
});
describe("private central-host consent", () => {
  it("requires the exact current call and does not reuse an earlier approval", () => {
    const capture = createPrivateCentralHostApprovalCapture({ plan, callId: "current-call" });
    capture.observe(request("old-call", "old-request"));
    capture.observe(settlement("approved", "old-request"));
    capture.observe(request());
    expect(capture.read()).toBeNull();
    capture.observe(settlement());
    expect(capture.read()).toEqual({
      approvalId: "request",
      approvedByCallId: "current-call",
      approvedAt: "2026-11-03T00:00:01Z",
    });
  });
  it("rejects changed runtime hashes, foreign consent and earlier cancellation", () => {
    const capture = createPrivateCentralHostApprovalCapture({ plan, callId: "current-call" });
    const changed = {
      ...plan,
      environment: [{ key: "INTEGRATIONS_DATABASE_URL", sha256: "f".repeat(64) }],
    };
    capture.observe(
      request("current-call", "changed", {
        plan: changed,
        planDigest: centralHostPlanDigest(changed),
        operationRef: centralHostOperationRef(changed),
      }),
    );
    capture.observe(settlement("approved", "changed"));
    expect(capture.read()).toBeNull();
    capture.observe(request());
    capture.observe(settlement("approved", "request", "foreign"));
    expect(capture.read()).toBeNull();
    const cancelled = createPrivateCentralHostApprovalCapture({ plan, callId: "current-call" });
    cancelled.observe(request("old-call", "old-request"));
    cancelled.observe(settlement("cancelled", "old-request"));
    cancelled.observe(request());
    cancelled.observe(settlement());
    expect(cancelled.read()).toBeNull();
  });
  it("retains the authenticated settlement time across partial history checkpoints", () => {
    const capture = createPrivateCentralHostApprovalCapture({ plan, callId: "current-call" });
    capture.observe(request());
    capture.observe(settlement());
    const resumed = createPrivateCentralHostApprovalCapture({
      plan,
      callId: "current-call",
      state: capture.snapshot(),
    });
    expect(resumed.read()).toEqual({
      approvalId: "request",
      approvedByCallId: "current-call",
      approvedAt: "2026-11-03T00:00:01Z",
    });
    resumed.observe(settlement("cancelled"));
    expect(resumed.read()).toBeNull();
  });
  it("requires complete authenticated history and rechecks owner after reading", async () => {
    const assertOwner = vi.fn(() => Promise.resolve());
    const readHistory = vi.fn((_start, observe: (event: MessageStreamEvent) => void) => {
      observe(request());
      observe(settlement());
      return Promise.resolve({ complete: false, nextNativeIndex: 2, nativeTailIndex: 2 });
    });
    await expect(
      readPrivateCentralHostApproval({
        plan,
        callId: "current-call",
        owner,
        readHistory,
        assertOwner,
      }),
    ).rejects.toThrow();
    expect(assertOwner).toHaveBeenCalledTimes(1);
    const complete = (_start: number, observe: (event: MessageStreamEvent) => void) => {
      observe(request());
      observe(settlement());
      return Promise.resolve({ complete: true, nextNativeIndex: 3, nativeTailIndex: 2 });
    };
    expect(
      await readPrivateCentralHostApproval({
        plan,
        callId: "current-call",
        owner,
        readHistory: complete,
        assertOwner,
      }),
    ).toEqual({
      approvalId: "request",
      approvedByCallId: "current-call",
      approvedAt: "2026-11-03T00:00:01Z",
    });
    await expect(
      readPrivateCentralHostApproval({
        plan,
        callId: "current-call",
        owner,
        readHistory: complete,
        assertOwner: () => Promise.reject(new Error("revoked")),
      }),
    ).rejects.toThrow("revoked");
  });
});
