import { isDeepStrictEqual } from "node:util";
import type { MessageStreamEvent } from "eve/client";
import {
  createPrivateOperatorApprovalCapture,
  readPrivateOperatorApproval,
} from "./private-operator-approval-observation";
import type {
  PrivateOperatorApprovalCapture,
  PrivateOperatorApprovalObservationPort,
} from "./private-operator-approval-observation";
import type { PrivateHistoryObservation } from "./same-origin-http";
import type { OperatorOwnerContext } from "../provisioning/hosted-operator-contract";
import {
  centralHostApprovalInputSchema,
  centralHostOperationRef,
  centralHostPlanDigest,
} from "../provisioning/central-integration-host-transport";
import type { CentralHostPlan } from "../provisioning/central-integration-host-transport";

export const createPrivateCentralHostApprovalCapture = (input: {
  plan: CentralHostPlan;
  callId: string;
  state?: PrivateOperatorApprovalCapture;
}) => {
  const expected = centralHostApprovalInputSchema.parse({
    plan: input.plan,
    planDigest: centralHostPlanDigest(input.plan),
    operationRef: centralHostOperationRef(input.plan),
  });
  const capture = createPrivateOperatorApprovalCapture({
    request: {
      action: "central-integration-host",
      planRef: expected.operationRef,
      planDigest: expected.planDigest,
      idempotencyKey: input.plan.selection.initiatingAppId,
    },
    captureSettlementTime: true,
    ownerUserId: input.plan.authority.ownerUserId,
    callId: input.callId,
    ...(input.state === undefined ? {} : { state: input.state }),
  });
  return {
    observe(event: MessageStreamEvent) {
      if (event.type === "input.requested") {
        for (const request of event.data.requests) {
          if (
            request.kind !== "tool-approval" ||
            request.action.toolName !== "prepare-app-central-integrations"
          )
            continue;
          const parsed = centralHostApprovalInputSchema.safeParse(request.action.input);
          if (parsed.success && isDeepStrictEqual(parsed.data, expected))
            capture.acceptRequest(request.requestId, request.action.callId);
        }
      } else if (event.type === "approval.settled") capture.settle(event);
    },
    read() {
      // A prior cancellation denies the same plan, even when the new call has consent.
      if (capture.snapshot().entries.some((entry) => entry.cancelled)) return null;
      const approved = capture.read();
      if (approved === null) return null;
      const entry = capture
        .snapshot()
        .entries.find((item) => item.requestId === approved.approvalId);
      if (entry?.settledAt === undefined) return null;
      return { ...approved, approvedAt: entry.settledAt };
    },
    snapshot: capture.snapshot,
    proveComplete: capture.proveComplete,
  };
};
export const readPrivateCentralHostApproval = async (input: {
  plan: CentralHostPlan;
  callId: string;
  owner: OperatorOwnerContext;
  observation?: PrivateOperatorApprovalObservationPort;
  readHistory: (
    startIndex: number,
    onEvent: (event: MessageStreamEvent) => void,
  ) => Promise<PrivateHistoryObservation>;
  assertOwner: () => Promise<void>;
}) => {
  if (
    !isDeepStrictEqual(input.plan.authority, input.owner.authority) ||
    input.plan.selection.sessionId !== input.owner.sessionId
  ) {
    throw new Error("Integration capability approval owner changed");
  }
  return await readPrivateOperatorApproval({
    owner: input.owner,
    ...(input.observation === undefined ? {} : { observation: input.observation }),
    capture: (state) =>
      createPrivateCentralHostApprovalCapture({
        plan: input.plan,
        callId: input.callId,
        ...(state === undefined ? {} : { state }),
      }),
    readHistory: input.readHistory,
    assertOwner: input.assertOwner,
  });
};
