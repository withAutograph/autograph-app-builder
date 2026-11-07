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
  const captureInput: Parameters<typeof createPrivateOperatorApprovalCapture>[0] = {
    callId: input.callId,
    ownerUserId: input.plan.authority.ownerUserId,
    request: {
      action: "public-release",
      idempotencyKey: input.plan.selection.appId,
      planDigest: expected.planDigest,
      planRef: expected.operationRef,
    },
  };
  if (input.state !== undefined) {
    Object.assign(captureInput, { state: input.state });
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
  const options: Pick<Parameters<typeof readPrivateOperatorApproval>[0], "owner" | "observation"> =
    {
      owner: input.owner,
    };
  if (input.observation !== undefined) options.observation = input.observation;
  const captureAndHistory = {
    capture: (
      state: Parameters<Parameters<typeof readPrivateOperatorApproval>[0]["capture"]>[0],
    ) => {
      const captureInput = { callId: input.callId, plan: input.plan };
      return state === undefined
        ? createPrivatePublicReleaseApprovalCapture(captureInput)
        : createPrivatePublicReleaseApprovalCapture({ ...captureInput, state });
    },
    readHistory: input.readHistory,
  };
  return await readPrivateOperatorApproval({
    ...options,
    ...captureAndHistory,
    assertOwner: input.assertOwner,
  });
};
