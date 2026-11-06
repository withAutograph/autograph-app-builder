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
    operationRef: publicReleaseOperationRef(input.plan),
    plan: input.plan,
    planDigest: publicReleasePlanDigest(input.plan),
  });
  const capture = createPrivateOperatorApprovalCapture({
    callId: input.callId,
    ownerUserId: input.plan.authority.ownerUserId,
    request: {
      action: "public-release",
      idempotencyKey: input.plan.selection.appId,
      planDigest: expected.planDigest,
      planRef: expected.operationRef,
    },
    ...(input.state === undefined ? {} : { state: input.state }),
  });
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
  return await readPrivateOperatorApproval({
    owner: input.owner,
    ...(input.observation === undefined ? {} : { observation: input.observation }),
    capture: (state) =>
      createPrivatePublicReleaseApprovalCapture({
        callId: input.callId,
        plan: input.plan,
        ...(state === undefined ? {} : { state }),
      }),
    readHistory: input.readHistory,
    assertOwner: input.assertOwner,
  });
};
