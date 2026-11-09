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
  authSchemaRolloutApprovalSchema,
  authSchemaRolloutDigest,
} from "../provisioning/production-auth-schema-rollout-contract";
import type { AuthSchemaRolloutApproval } from "../provisioning/production-auth-schema-rollout-contract";

/** Consent binds every reviewed schema, ACL, resource and worker field, not a model-supplied digest alone. */
export const createPrivateAuthSchemaRolloutApprovalCapture = (input: {
  plan: AuthSchemaRolloutApproval;
  callId: string;
  state?: PrivateOperatorApprovalCapture;
}) => {
  const expected = authSchemaRolloutApprovalSchema.parse(input.plan);
  const captureInput: Parameters<typeof createPrivateOperatorApprovalCapture>[0] = {
    request: {
      action: "auth-schema-rollout",
      planRef: expected.operationRef,
      planDigest: expected.planDigest,
      idempotencyKey: authSchemaRolloutDigest(expected),
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
        for (const request of event.data.requests) {
          if (
            request.kind === "tool-approval" &&
            request.action.toolName === "apply-production-auth-schema-rollout"
          ) {
            const parsed = authSchemaRolloutApprovalSchema.safeParse(request.action.input);
            if (parsed.success && isDeepStrictEqual(parsed.data, expected)) {
              capture.acceptRequest(request.requestId, request.action.callId);
            }
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

export const readAuthSchemaRolloutApproval = async (input: {
  plan: AuthSchemaRolloutApproval;
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
    input.plan.scope.sessionId !== input.owner.sessionId
  ) {
    throw new Error("Auth schema rollout approval owner changed.");
  }
  return await readPrivateOperatorApproval({
    ...input,
    capture: (state) => {
      const captureInput: Parameters<typeof createPrivateAuthSchemaRolloutApprovalCapture>[0] = {
        plan: input.plan,
        callId: input.callId,
      };
      if (state !== undefined) {
        captureInput.state = state;
      }
      return createPrivateAuthSchemaRolloutApprovalCapture(captureInput);
    },
  });
};
