import { isDeepStrictEqual } from "node:util";
import { digest } from "./hosted-operation-identifiers";
import {
  privateHostedApprovalCaptureStateSchema,
  privateResourceApprovalReceiptSchema,
  privateResourceApprovalSessionId,
} from "./private-hosted-approval";
import type {
  PrivateHostedApprovalCaptureState,
  PrivateResourceApprovalReceipt,
} from "./private-hosted-approval";
import {
  provesResourceApprovalResponse,
  resourceApprovalResponseProofSchema,
} from "./resource-approval-response";
import type { PrivateInputState } from "./session-limit-input";

const nativeTargetToolName = "prepare-app-native-target";
const toolApprovalKind = "tool-approval";
const targetIdentityKeys = ["appId", "operationRef", "planDigest"] as const;
const resolutionOutcomes = new Set(["approved", "denied"]);

/**
 * Reconstruct one unknown response only from fully settled owner-bound native batches.
 * The exact request digest is the final authority; no subsets or response dispatches
 * are attempted. The caller must independently bind the checkpoint and adapter under lock.
 */
// oxlint-disable-next-line eslint/complexity -- Each fail-closed branch verifies a distinct ownership or terminal-receipt invariant.
export const reconstructNativeApprovalResponse = (input: {
  clientRequestId: string;
  sessionId: string;
  ownerUserId: string;
  requestDigest: string;
  adapterSessionId: string;
  adapterGeneration: number;
  checkpointDigest: string;
  target: { appId: string; operationRef: string; planDigest: string };
  state: PrivateInputState;
  capture: PrivateHostedApprovalCaptureState;
  receipts: readonly PrivateResourceApprovalReceipt[];
}):
  | {
      clientRequestId: string;
      sessionId: string;
      responses: { requestId: string; response: { kind: "approve" | "deny" } }[];
    }
  // oxlint-disable-next-line sonarjs/cognitive-complexity -- Reconciliation checks the complete ordered batch before deriving any response.
  | undefined => {
  const parsedCapture = privateHostedApprovalCaptureStateSchema.safeParse(input.capture);
  if (!parsedCapture.success || parsedCapture.data.sessionId !== input.sessionId) {
    return undefined;
  }
  const capture = parsedCapture.data;
  const persisted = input.receipts.map((receipt) =>
    privateResourceApprovalReceiptSchema.safeParse(receipt),
  );
  if (persisted.some((receipt) => !receipt.success)) {
    return undefined;
  }
  const receipts = persisted.flatMap((receipt) => (receipt.success ? [receipt.data] : []));
  const isTarget = (receipt: PrivateResourceApprovalReceipt) => {
    if (receipt.toolName !== nativeTargetToolName) {
      return false;
    }
    return [
      receipt.toolInput.appId === input.target.appId,
      receipt.toolInput.operationRef === input.target.operationRef,
      receipt.toolInput.planDigest === input.target.planDigest,
      receipt.toolInput.plan.origin.adapterSessionId === input.adapterSessionId,
      receipt.toolInput.plan.origin.adapterGeneration === input.adapterGeneration,
      privateResourceApprovalSessionId(receipt) === input.sessionId,
    ].every(Boolean);
  };

  // Any still-pending native request without a clearly different target is ambiguous.
  for (const batch of input.state.pending) {
    for (const request of batch.requests) {
      if (request.kind !== toolApprovalKind || request.toolName !== nativeTargetToolName) {
        continue;
      }
      const pending = capture.pendingRequests.filter(
        (entry) => entry.requestId === request.requestId,
      );
      if (pending.length !== 1 || pending[0]?.toolName !== nativeTargetToolName) {
        return undefined;
      }
      if (targetIdentityKeys.every((key) => pending[0].toolInput[key] === input.target[key])) {
        return undefined;
      }
    }
  }

  const selected: typeof input.state.resolved = [];
  for (const resolved of input.state.resolved) {
    const native = resolved.batch.requests.filter(
      (request) => request.kind === toolApprovalKind && request.toolName === nativeTargetToolName,
    );
    if (native.length > 0) {
      const captured = native.map((request) =>
        capture.receipts.filter((receipt) => receipt.requestId === request.requestId),
      );
      if (captured.some((matches) => matches.length !== 1)) {
        return undefined;
      }
      const targetCount = captured.filter(
        (matches) => matches[0] !== undefined && isTarget(matches[0]),
      ).length;
      if (targetCount > 0) {
        if (targetCount !== resolved.batch.requests.length) {
          return undefined;
        }
        selected.push(resolved);
      }
    }
  }
  if (selected.length === 0) {
    return undefined;
  }
  const ordered = selected.toSorted(
    (a, b) => a.batch.sequence - b.batch.sequence || a.batch.stepIndex - b.batch.stepIndex,
  );
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]?.batch;
    const current = ordered[index]?.batch;
    if (previous?.sequence === current?.sequence && previous?.stepIndex === current?.stepIndex) {
      return undefined;
    }
  }
  const responses: { requestId: string; response: { kind: "approve" | "deny" } }[] = [];
  const seen = new Set<string>();
  for (const item of ordered) {
    if (item.resolutions.length !== item.batch.requests.length) {
      return undefined;
    }
    for (const request of item.batch.requests) {
      if (seen.has(request.requestId)) {
        return undefined;
      }
      seen.add(request.requestId);
      const resolution = item.resolutions.filter((entry) => entry.requestId === request.requestId);
      const matched = capture.receipts.filter((entry) => entry.requestId === request.requestId);
      const saved = receipts.filter((entry) => entry.requestId === request.requestId);
      const [terminal] = matched;
      const [resolutionEntry] = resolution;
      const [savedReceipt] = saved;
      if (terminal === undefined || resolutionEntry === undefined) {
        return undefined;
      }
      const matches = [
        resolution.length === 1,
        matched.length === 1,
        saved.length === 1,
        isTarget(terminal),
        isDeepStrictEqual(terminal, savedReceipt),
        terminal.responderPrincipalId === input.ownerUserId,
        resolutionEntry.kind === toolApprovalKind,
        resolutionOutcomes.has(resolutionEntry.outcome),
        terminal.outcome === (resolutionEntry.outcome === "approved" ? "approved" : "cancelled"),
      ];
      if (!matches.every(Boolean)) {
        return undefined;
      }
      responses.push({
        requestId: request.requestId,
        response: { kind: terminal.outcome === "approved" ? "approve" : "deny" },
      });
    }
  }
  const request = { clientRequestId: input.clientRequestId, responses, sessionId: input.sessionId };
  if (digest({ kind: "respond", request, sessionId: input.sessionId }) !== input.requestDigest) {
    return undefined;
  }
  const parsedProof = resourceApprovalResponseProofSchema.safeParse({
    adapterGeneration: input.adapterGeneration,
    adapterSessionId: input.adapterSessionId,
    checkpointDigest: input.checkpointDigest,
    request,
  });
  if (!parsedProof.success) {
    return undefined;
  }
  if (
    !provesResourceApprovalResponse({
      capture,
      clientRequestId: input.clientRequestId,
      ownerUserId: input.ownerUserId,
      proof: parsedProof.data,
      receipts,
      requestDigest: input.requestDigest,
      sessionId: input.sessionId,
      state: input.state,
    })
  ) {
    return undefined;
  }
  return request;
};
