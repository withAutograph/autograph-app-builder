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
  publicReleaseApprovalInputSchema,
  publicReleaseOperationRef,
  publicReleasePlanDigest,
} from "../provisioning/public-release-contract";
import type { PublicReleasePlan } from "../provisioning/public-release-contract";

export const createPrivatePublicReleaseApprovalCapture = (input: {
  plan: PublicReleasePlan;
  callId: string;
  state?: PrivateOperatorApprovalCapture;
}) => {
  const expected = publicReleaseApprovalInputSchema.parse({
    plan: input.plan,
    planDigest: publicReleasePlanDigest(input.plan),
    operationRef: publicReleaseOperationRef(input.plan),
  });
  const captureInput: Parameters<typeof createPrivateOperatorApprovalCapture>[0] = {
    request: {
      action: "public-release",
      planRef: expected.operationRef,
      planDigest: expected.planDigest,
      idempotencyKey: input.plan.selection.appId,
    },
    ownerUserId: input.plan.authority.ownerUserId,
    callId: input.callId,
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
            request.action.toolName !== "release-app-public-release"
          ) {
            continue;
          }
          const parsed = publicReleaseApprovalInputSchema.safeParse(request.action.input);
          if (parsed.success && isDeepStrictEqual(parsed.data, expected)) {
            capture.acceptRequest(request.requestId, request.action.callId);
          }
        }
      } else if (event.type === "approval.settled") {
        capture.settle(event);
      }
    },
    read() {
      // A prior cancellation denies the same plan, even when the new call has consent.
      if (capture.snapshot().entries.some((entry) => entry.cancelled)) {
        return null;
      }
      return capture.read();
    },
    snapshot: capture.snapshot,
    proveComplete: capture.proveComplete,
  };
};
export const readPrivatePublicReleaseApproval = async (input: {
  plan: PublicReleasePlan;
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
    throw new Error("Public release approval owner changed");
  }
  const approvalContext: Pick<
    Parameters<typeof readPrivateOperatorApproval>[0],
    "owner" | "observation"
  > = { owner: input.owner };
  if (input.observation !== undefined) {
    approvalContext.observation = input.observation;
  }
  return await readPrivateOperatorApproval({
    ...approvalContext,
    capture: (state) => {
      const captureInput: Parameters<typeof createPrivatePublicReleaseApprovalCapture>[0] = {
        plan: input.plan,
        callId: input.callId,
      };
      if (state !== undefined) {
        captureInput.state = state;
      }
      return createPrivatePublicReleaseApprovalCapture(captureInput);
    },
    readHistory: input.readHistory,
    assertOwner: input.assertOwner,
  });
};
