import type { DurablePrototypeChunkResult } from "./prototype-artifacts-v2";

/** The Browser receives verified durable HTML; the model receives its immutable reference. */
export const hostedUiPreviewReceipt = (input: {
  result: DurablePrototypeChunkResult;
  preview: { appId: string; revision: string; routes: readonly string[] };
  callId: string;
  reused: boolean;
}) => {
  const { artifact } = input.result;
  if (!input.result.complete || artifact.transfer !== undefined) {
    throw new Error("A hosted Browser preview receipt requires a completed durable artifact.");
  }
  return {
    appId: input.preview.appId,
    artifactDigest: artifact.digest,
    artifactRevision: artifact.revision,
    browserReady: true,
    browserVerification: "not-observed" as const,
    chunkCount: artifact.chunkCount,
    complete: true,
    contentBytes: artifact.contentBytes,
    contentDelivery: "hosted-browser-stream" as const,
    digest: artifact.digest,
    fidelity: "arrusted-component-catalog" as const,
    functionality: "fixtures-only" as const,
    mediaType: "text/html" as const,
    path: artifact.path,
    recordedByCallId: input.callId,
    // This remains the raw-export flag consumed by existing public preview reducers.
    requiresChunkedRead: true,
    reused: input.reused,
    revision: input.preview.revision,
    routes: input.preview.routes,
    routineReadNotRequired: true,
    sessionId: artifact.sessionId,
    totalBytes: artifact.contentBytes,
    version: 2 as const,
  };
};
