import { describe, expect, it, vi } from "vitest";
import type { MessageStreamEvent } from "eve/client";
import { authority, plan } from "../provisioning/public-release-test-fixture";
import {
  publicReleasePlanDigest,
  publicReleaseOperationRef,
} from "../provisioning/public-release-contract";
import { operatorOwnerContextSchema } from "../provisioning/hosted-operator-contract";
import {
  createPrivatePublicReleaseApprovalCapture,
  readPrivatePublicReleaseApproval,
} from "./private-public-release-approval";

const input = {
  plan,
  planDigest: publicReleasePlanDigest(plan),
  operationRef: publicReleaseOperationRef(plan),
};
const owner = operatorOwnerContextSchema.parse({
  adapterGeneration: 1,
  adapterSessionId: "native",
  authority,
  kind: "direct",
  principal: { ...authority, scopes: ["autograph:send"] },
  sessionId: plan.selection.sessionId,
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
          toolName: "release-app-public-release",
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
describe("private public-release consent", () => {
  it("requires the exact current call and does not reuse an earlier approval", () => {
    const capture = createPrivatePublicReleaseApprovalCapture({ plan, callId: "current-call" });
    capture.observe(request("old-call", "old-request"));
    capture.observe(settlement("approved", "old-request"));
    capture.observe(request());
    expect(capture.read()).toBeNull();
    capture.observe(settlement());
    expect(capture.read()).toEqual({ approvalId: "request", approvedByCallId: "current-call" });
  });
  it("rejects changed runtime hashes, foreign consent and earlier cancellation", () => {
    const capture = createPrivatePublicReleaseApprovalCapture({ plan, callId: "current-call" });
    const changed = { ...plan, environment: [{ key: "APP_DATABASE_URL", sha256: "f".repeat(64) }] };
    capture.observe(
      request("current-call", "changed", {
        plan: changed,
        planDigest: publicReleasePlanDigest(changed),
        operationRef: publicReleaseOperationRef(changed),
      }),
    );
    capture.observe(settlement("approved", "changed"));
    expect(capture.read()).toBeNull();
    capture.observe(request());
    capture.observe(settlement("approved", "request", "foreign"));
    expect(capture.read()).toBeNull();
    const cancelled = createPrivatePublicReleaseApprovalCapture({ plan, callId: "current-call" });
    cancelled.observe(request("old-call", "old-request"));
    cancelled.observe(settlement("cancelled", "old-request"));
    cancelled.observe(request());
    cancelled.observe(settlement());
    expect(cancelled.read()).toBeNull();
  });
  it("requires complete authenticated history and rechecks owner after reading", async () => {
    const assertOwner = vi.fn<() => Promise<void>>().mockResolvedValue();
    const readHistory = vi.fn((_start, observe: (event: MessageStreamEvent) => void) => {
      observe(request());
      observe(settlement());
      return Promise.resolve({ complete: false, nextNativeIndex: 2, nativeTailIndex: 2 });
    });
    await expect(
      readPrivatePublicReleaseApproval({
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
      await readPrivatePublicReleaseApproval({
        plan,
        callId: "current-call",
        owner,
        readHistory: complete,
        assertOwner,
      }),
    ).toEqual({ approvalId: "request", approvedByCallId: "current-call" });
    await expect(
      readPrivatePublicReleaseApproval({
        plan,
        callId: "current-call",
        owner,
        readHistory: complete,
        assertOwner: () => Promise.reject(new Error("revoked")),
      }),
    ).rejects.toThrow("revoked");
  });
});
