import { z } from "zod";
import { digest } from "./hosted-operation-identifiers";
import { nativeInputBatchSchema } from "./session-limit-input";
import type { PrivateInputState } from "./session-limit-input";
import {
  privateResourceApprovalReceiptSchema,
  privateResourcePendingApprovalSchema,
  privateResourceApprovalSessionId,
} from "./private-hosted-approval";
import type {
  PrivateHostedApprovalCaptureState,
  PrivateResourceApprovalReceipt,
} from "./private-hosted-approval";

const approvalRequestSchema = privateResourcePendingApprovalSchema;
export const resourceApprovalResponseMarkerSchema = z.strictObject({
  adapterGeneration: z.number().int().positive(),
  adapterSessionId: z.string().min(1),
  approvals: z.array(approvalRequestSchema).min(1),
  batches: z.array(nativeInputBatchSchema).min(1),
});
export type ResourceApprovalResponseMarker = z.infer<typeof resourceApprovalResponseMarkerSchema>;
export const resourceApprovalResponseProofSchema = z.strictObject({
  adapterGeneration: z.number().int().positive(),
  adapterSessionId: z.string().min(1),
  checkpointDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  request: z.strictObject({
    clientRequestId: z.string().min(1),
    responses: z
      .array(
        z.strictObject({
          requestId: z.string().min(1),
          response: z.strictObject({ kind: z.enum(["approve", "deny"]) }),
        }),
      )
      .min(1),
    sessionId: z.string().min(1),
  }),
});
export type ResourceApprovalResponseProof = z.infer<typeof resourceApprovalResponseProofSchema>;

const completeApprovalBatches = (
  batches: ResourceApprovalResponseMarker["batches"],
  ids: string[],
) => {
  const requests = batches.flatMap((batch) => batch.requests);
  return (
    requests.length === ids.length &&
    new Set(ids).size === ids.length &&
    requests.every(
      (request, index) => request.kind === "tool-approval" && request.requestId === ids[index],
    )
  );
};
export const captureResourceApprovalResponse = (
  binding: Pick<ResourceApprovalResponseMarker, "adapterSessionId" | "adapterGeneration">,
  state: PrivateInputState | undefined,
  capture: PrivateHostedApprovalCaptureState | undefined,
  request: ResourceApprovalResponseProof["request"],
): ResourceApprovalResponseMarker | undefined => {
  const parsed = resourceApprovalResponseProofSchema.shape.request.safeParse(request);
  if (!parsed.success || state === undefined || capture?.sessionId !== parsed.data.sessionId) {
    return undefined;
  }
  const ids = parsed.data.responses.map((entry) => entry.requestId);
  if (!completeApprovalBatches(state.pending, ids)) {
    return undefined;
  }
  const approvals = ids.flatMap((id) =>
    capture.pendingRequests.filter((entry) => entry.requestId === id),
  );
  if (approvals.length !== ids.length) {
    return undefined;
  }
  return resourceApprovalResponseMarkerSchema.parse({
    adapterSessionId: binding.adapterSessionId,
    adapterGeneration: binding.adapterGeneration,
    approvals,
    batches: state.pending,
  });
};

/** Checks only native settlement facts; a cleared public request is never an acknowledgement. */
export const provesResourceApprovalResponse = (input: {
  clientRequestId: string;
  requestDigest: string;
  sessionId: string;
  ownerUserId: string;
  marker?: ResourceApprovalResponseMarker;
  proof: ResourceApprovalResponseProof;
  state?: PrivateInputState;
  capture?: PrivateHostedApprovalCaptureState;
  receipts: readonly PrivateResourceApprovalReceipt[];
}): boolean => {
  const { proof, state, capture, marker } = input;
  if (state === undefined || capture?.sessionId !== input.sessionId) {
    return false;
  }
  if (
    [
      proof.request.clientRequestId !== input.clientRequestId,
      proof.request.sessionId !== input.sessionId,
      digest({ kind: "respond", request: proof.request, sessionId: input.sessionId }) !==
        input.requestDigest,
    ].some(Boolean)
  ) {
    return false;
  }
  const ids = proof.request.responses.map((entry) => entry.requestId);
  if (
    marker !== undefined &&
    (marker.approvals.length !== ids.length ||
      marker.approvals.some((approval, index) => approval.requestId !== ids[index]))
  ) {
    return false;
  }
  const requestedIds = new Set(ids);
  const resolved = state.resolved.filter((entry) =>
    entry.batch.requests.some((request) => requestedIds.has(request.requestId)),
  );
  if (
    !completeApprovalBatches(
      resolved.map((entry) => entry.batch),
      ids,
    )
  ) {
    return false;
  }
  if (
    marker !== undefined &&
    digest(marker.batches) !== digest(resolved.map((entry) => entry.batch))
  ) {
    return false;
  }
  return proof.request.responses.every((entry) => {
    const matches = input.receipts.filter((receipt) => receipt.requestId === entry.requestId);
    const nativeMatches = capture.receipts.filter(
      (receipt) => receipt.requestId === entry.requestId,
    );
    if (matches.length !== 1 || nativeMatches.length !== 1) {
      return false;
    }
    const receipt = privateResourceApprovalReceiptSchema.parse(matches[0]);
    if (
      [
        digest(receipt) !== digest(nativeMatches[0]),
        privateResourceApprovalSessionId(receipt) !== input.sessionId,
        receipt.responderPrincipalId !== input.ownerUserId,
        receipt.outcome !== (entry.response.kind === "approve" ? "approved" : "cancelled"),
      ].some(Boolean)
    ) {
      return false;
    }
    const original = marker?.approvals.find((approval) => approval.requestId === entry.requestId);
    if (
      marker !== undefined &&
      (original === undefined ||
        digest(original) !==
          digest({
            callId: receipt.callId,
            requestId: receipt.requestId,
            toolInput: receipt.toolInput,
            toolName: receipt.toolName,
          }))
    ) {
      return false;
    }
    const batches = resolved.filter((batch) =>
      batch.batch.requests.some(
        (request) => request.requestId === entry.requestId && request.toolName === receipt.toolName,
      ),
    );
    if (batches.length !== 1) {
      return false;
    }
    const resolutions = batches[0]?.resolutions.filter(
      (resolution) => resolution.requestId === entry.requestId,
    );
    return (
      resolutions?.length === 1 &&
      resolutions[0]?.kind === "tool-approval" &&
      resolutions[0].outcome === (entry.response.kind === "approve" ? "approved" : "denied")
    );
  });
};
