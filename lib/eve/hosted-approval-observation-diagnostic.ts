import { createHash } from "node:crypto";

import type { PublicInputRequest } from "../mcp/contracts";
import type { NativeObservationState } from "./native-observation-state";
import type {
  PrivateHostedApprovalCaptureState,
  PrivateResourceApprovalReceipt,
} from "./private-hosted-approval";
import type { PrivateInputState } from "./session-limit-input";

const identifierHash = (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

type NativeStateForDiagnostic = Pick<
  NativeObservationState,
  "nextNativeIndex" | "publicEventCount" | "pendingRequests"
> & {
  privateInputState?: Pick<PrivateInputState, "pending" | "resolved">;
};

interface ApprovalReference {
  callHash: string;
  operationHash: string;
  planDigest: string;
  requestHash: string;
  source: "capture_pending" | "capture_receipt" | "inline_receipt";
  outcome?: "approved" | "cancelled";
}

const approvalReference = (
  value: Pick<PrivateResourceApprovalReceipt, "callId" | "requestId" | "toolInput">,
  source: ApprovalReference["source"],
  outcome?: ApprovalReference["outcome"],
): ApprovalReference => ({
  callHash: identifierHash(value.callId),
  operationHash: identifierHash(value.toolInput.operationRef),
  planDigest: value.toolInput.planDigest,
  requestHash: identifierHash(value.requestId),
  source,
  ...(outcome === undefined ? {} : { outcome }),
});

const nativeInputObservations = (nativeState: NativeStateForDiagnostic | undefined) => {
  const nativePending = nativeState?.privateInputState?.pending.flatMap((batch) =>
    batch.requests.map((request) => request.requestId),
  );
  const nativeResolved = nativeState?.privateInputState?.resolved.flatMap((entry) =>
    entry.resolutions.map((resolution) => ({
      kind: resolution.kind,
      outcome: resolution.outcome,
      optionId: resolution.response?.optionId,
      requestId: resolution.requestId,
    })),
  );
  return { nativePending, nativeResolved };
};

/** Closed, owner-scoped observation only; never carries approval input or presentation text. */
export const createHostedApprovalObservationDiagnostic = (input: {
  coldReadProgress: boolean;
  inlineReceipts: readonly PrivateResourceApprovalReceipt[];
  nativeState?: NativeStateForDiagnostic;
  privateCapture?: PrivateHostedApprovalCaptureState;
  publicPendingRequests: readonly PublicInputRequest[];
  sessionId: string;
}) => {
  const capturePending = input.privateCapture?.pendingRequests ?? [];
  const captureReceipts = input.privateCapture?.receipts ?? [];
  const reportedPublicRequests = input.publicPendingRequests.slice(0, 32);
  const { nativePending, nativeResolved } = nativeInputObservations(input.nativeState);
  const nativePendingIds = new Set(nativePending);
  const publicIds = new Set(reportedPublicRequests.map((request) => request.requestId));
  const captureMismatch = reportedPublicRequests.some((request) => {
    const pending = capturePending.some((entry) => entry.requestId === request.requestId);
    const nativePendingMatch = nativePendingIds.has(request.requestId);
    const receipt = captureReceipts.some((entry) => entry.requestId === request.requestId);
    return request.kind === "approval" && (pending !== nativePendingMatch || (receipt && pending));
  });
  const hasPendingInputs =
    input.publicPendingRequests.length > 0 ||
    capturePending.length > 0 ||
    (nativePending?.length ?? 0) > 0;
  const hasRelevantCaptureMismatch =
    captureMismatch ||
    capturePending.some((entry) => !publicIds.has(entry.requestId)) ||
    captureReceipts.some(
      (entry) =>
        publicIds.has(entry.requestId) &&
        !capturePending.some((p) => p.requestId === entry.requestId),
    );
  const summarize = () => {
    const references: ApprovalReference[] = [
      ...capturePending.slice(-32).map((entry) => approvalReference(entry, "capture_pending")),
      ...captureReceipts
        .slice(-32)
        .map((entry) => approvalReference(entry, "capture_receipt", entry.outcome)),
      ...input.inlineReceipts
        .slice(-32)
        .map((entry) => approvalReference(entry, "inline_receipt", entry.outcome)),
    ];
    const requests = reportedPublicRequests.map((request) => {
      const capturePendingMatch = capturePending.find(
        (entry) => entry.requestId === request.requestId,
      );
      const captureReceiptMatch = captureReceipts.find(
        (entry) => entry.requestId === request.requestId,
      );
      const inlineReceiptMatch = input.inlineReceipts.find(
        (entry) => entry.requestId === request.requestId,
      );
      const approvalMatch = capturePendingMatch ?? captureReceiptMatch ?? inlineReceiptMatch;
      const nativePendingMatch = nativePendingIds.has(request.requestId);
      const nativeResolution = nativeResolved?.find(
        (entry) => entry.requestId === request.requestId,
      );
      return {
        capturePending: capturePendingMatch !== undefined,
        captureReceipt: captureReceiptMatch !== undefined,
        inlineReceipt: inlineReceiptMatch !== undefined,
        kind: request.kind,
        nativePending: nativePendingMatch,
        nativeResolved: nativeResolution !== undefined,
        requestHash: identifierHash(request.requestId),
        ...(nativeResolution === undefined
          ? {}
          : {
              resolution: {
                approvedOptionMatch:
                  nativeResolution.optionId === undefined
                    ? undefined
                    : (request.options?.some(
                        (option) =>
                          option.id === nativeResolution.optionId && option.id === "approve",
                      ) ?? false),
                kind: nativeResolution.kind,
                outcome: nativeResolution.outcome,
              },
            }),
        ...(approvalMatch === undefined
          ? {}
          : {
              callHash: identifierHash(approvalMatch.callId),
              operationHash: identifierHash(approvalMatch.toolInput.operationRef),
              planDigest: approvalMatch.toolInput.planDigest,
            }),
      };
    });
    return {
      captureMismatch: hasRelevantCaptureMismatch,
      coldReadProgress: input.coldReadProgress,
      event: "builder.hosted_approval_observation" as const,
      inlineReceiptCount: input.inlineReceipts.length,
      nativeStatePresent: input.nativeState !== undefined,
      nativeNextIndex: input.nativeState?.nextNativeIndex ?? null,
      nativePendingCount: nativePending?.length ?? 0,
      nativePublicEventCount: input.nativeState?.publicEventCount ?? null,
      privateCapturePresent: input.privateCapture !== undefined,
      privateCapturePendingCount: capturePending.length,
      privateCaptureReceiptCount: captureReceipts.length,
      publicPendingRequestCount: input.publicPendingRequests.length,
      publicPendingRequests: requests.slice(0, 32),
      publicPendingRequestsTruncated: input.publicPendingRequests.length > requests.length,
      protectedApprovalReferenceCount:
        capturePending.length + captureReceipts.length + input.inlineReceipts.length,
      protectedApprovalReferencesTruncated:
        capturePending.length + captureReceipts.length + input.inlineReceipts.length > 32,
      protectedApprovalReferences: references.slice(-32),
      sessionHash: identifierHash(input.sessionId),
    };
  };
  return hasPendingInputs || hasRelevantCaptureMismatch ? summarize() : undefined;
};
