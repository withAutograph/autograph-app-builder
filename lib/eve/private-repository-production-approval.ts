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
  repositoryProductionApprovalInputSchema,
  repositoryProductionApprovalReference,
  repositoryProductionPrepareInputSchema,
} from "../provisioning/repository-production-approval";
import type { RepositoryProductionApprovalInput } from "../provisioning/repository-production-approval";

export const createPrivateRepositoryProductionApprovalCapture = (input: {
  plan: RepositoryProductionApprovalInput;
  callId: string;
  state?: PrivateOperatorApprovalCapture;
}) => {
  const expected = repositoryProductionApprovalInputSchema.parse(input.plan);
  const expectedReference = repositoryProductionApprovalReference(expected);
  const captureInput: Parameters<typeof createPrivateOperatorApprovalCapture>[0] = {
    request: {
      action: "repository-production",
      planRef: expected.operationRef,
      planDigest: expected.planDigest,
      idempotencyKey: expected.scope.appId,
    },
    ownerUserId: expected.scope.authority.ownerUserId,
    callId: input.callId,
  };
  if (input.state !== undefined) {
    captureInput.state = input.state;
  }
  const capture = createPrivateOperatorApprovalCapture(captureInput);
  return {
    observe(event: MessageStreamEvent) {
      if (event.type === "input.requested") {
        // oxlint-disable-next-line sonarjs/too-many-break-or-continue-in-loop -- Select only matching Production approval requests in event order.
        for (const request of event.data.requests) {
          if (
            request.kind !== "tool-approval" ||
            request.action.toolName !== "prepare-app-production"
          ) {
            continue;
          }
          const parsed = repositoryProductionPrepareInputSchema.safeParse(request.action.input);
          if (!parsed.success) {
            continue;
          }
          if ("version" in parsed.data) {
            if (isDeepStrictEqual(parsed.data, expectedReference)) {
              capture.acceptRequest(request.requestId, request.action.callId);
            }
            continue;
          }
          if (
            parsed.data.planDigest === expected.planDigest &&
            parsed.data.operationRef === expected.operationRef &&
            parsed.data.intent.sessionId === expected.intent.sessionId &&
            isDeepStrictEqual(parsed.data.scope, expected.scope)
          ) {
            capture.acceptRequest(request.requestId, request.action.callId);
          }
        }
      } else if (event.type === "approval.settled") {
        capture.settle(event);
      }
    },
    read: () => capture.read(),
    snapshot: () => capture.snapshot(),
    proveComplete: () => {
      capture.proveComplete();
    },
  };
};

export const readRepositoryProductionApproval = async (input: {
  plan: RepositoryProductionApprovalInput;
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
    !isDeepStrictEqual(input.plan.scope.authority, input.owner.authority) ||
    input.plan.intent.sessionId !== input.owner.sessionId
  ) {
    throw new Error("App setup approval owner changed.");
  }
  return await readPrivateOperatorApproval({
    ...input,
    capture: (state) => {
      const captureInput: Parameters<typeof createPrivateRepositoryProductionApprovalCapture>[0] = {
        plan: input.plan,
        callId: input.callId,
      };
      if (state !== undefined) {
        captureInput.state = state;
      }
      return createPrivateRepositoryProductionApprovalCapture(captureInput);
    },
  });
};
