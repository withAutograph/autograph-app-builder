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
  appIntegrationCapabilityApprovalInputSchema,
  appIntegrationCapabilityOperationRef,
  appIntegrationCapabilityPlanDigest,
} from "../provisioning/app-integration-capability-contract";
import type { AppIntegrationCapabilityPlan } from "../provisioning/app-integration-capability-contract";

export const createPrivateAppIntegrationCapabilityApprovalCapture = (input: {
  plan: AppIntegrationCapabilityPlan;
  callId: string;
  state?: PrivateOperatorApprovalCapture;
}) => {
  const expected = appIntegrationCapabilityApprovalInputSchema.parse({
    operationRef: appIntegrationCapabilityOperationRef(input.plan),
    plan: input.plan,
    planDigest: appIntegrationCapabilityPlanDigest(input.plan),
  });
  const captureInput: Parameters<typeof createPrivateOperatorApprovalCapture>[0] = {
    callId: input.callId,
    ownerUserId: input.plan.authority.ownerUserId,
    request: {
      action: "app-integration-capability",
      idempotencyKey: input.plan.selection.appId,
      planDigest: expected.planDigest,
      planRef: expected.operationRef,
    },
  };
  if (input.state !== undefined) {
    captureInput.state = input.state;
  }
  const capture = createPrivateOperatorApprovalCapture(captureInput);
  return {
    observe(event: MessageStreamEvent) {
      if (event.type === "input.requested") {
        for (const request of event.data.requests) {
          if (
            request.kind !== "tool-approval" ||
            request.action.toolName !== "prepare-app-integration-capability"
          ) {
            continue;
          }
          const parsed = appIntegrationCapabilityApprovalInputSchema.safeParse(
            request.action.input,
          );
          if (parsed.success && isDeepStrictEqual(parsed.data, expected)) {
            capture.acceptRequest(request.requestId, request.action.callId);
          }
        }
      } else if (event.type === "approval.settled") {
        capture.settle(event);
      }
    },
    proveComplete: capture.proveComplete,
    read() {
      // A prior cancellation denies the same plan, even when the new call has consent.
      if (capture.snapshot().entries.some((entry) => entry.cancelled)) {
        return null;
      }
      return capture.read();
    },
    snapshot: capture.snapshot,
  };
};
export const readPrivateAppIntegrationCapabilityApproval = async (input: {
  plan: AppIntegrationCapabilityPlan;
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
  const approvalInput: Parameters<typeof readPrivateOperatorApproval>[0] = {
    assertOwner: input.assertOwner,
    capture: (state) => {
      const captureInput: Parameters<
        typeof createPrivateAppIntegrationCapabilityApprovalCapture
      >[0] = {
        callId: input.callId,
        plan: input.plan,
      };
      if (state !== undefined) {
        captureInput.state = state;
      }
      return createPrivateAppIntegrationCapabilityApprovalCapture(captureInput);
    },
    owner: input.owner,
    readHistory: input.readHistory,
  };
  if (input.observation !== undefined) {
    approvalInput.observation = input.observation;
  }
  return await readPrivateOperatorApproval(approvalInput);
};
