import { describe, expect, it } from "vitest";
import {
  approvalReplayProgressSchema,
  pagedCheckpointMetadataSchema,
} from "./postgres-hosted-checkpoint-history";

const fixture = () => ({
  version: 1 as const,
  binding: {
    principal: {
      issuer: "https://identity.example",
      audience: "builder",
      workspaceId: "workspace",
      ownerUserId: "owner",
      scopes: ["autograph:get"],
    },
    sessionId: "session",
    approvalSessionId: "original-session",
    adapterSessionId: "adapter",
    adapterGeneration: 2,
  },
  sourceCheckpoint: {
    id: "00000000-0000-4000-8000-000000000001",
    digest: `sha256:${"a".repeat(64)}`,
    eventCount: 5,
  },
  events: [{ type: "status" as const, status: "working" as const, index: 0 }],
  nativeObservationState: {
    adapterSessionId: "adapter",
    artifactReadback: {
      incompleteArtifacts: [],
      incompleteUiPreviews: [],
      legacy: false,
      markdownCalls: [],
      pending: [],
      references: { requested: [], requestedUiPreview: [] },
    },
    boundary: "working" as const,
    invalidInput: false,
    nextNativeIndex: 11,
    pendingRequests: [],
    prototypeProjector: { artifactReadRequests: [], readChunks: [], requested: [], transfers: [] },
    prototypeReference: { requested: [], requestedUiPreview: [] },
    publicEventCount: 1,
    version: 1 as const,
  },
  privateApprovalCaptureState: {
    sessionId: "original-session",
    version: 1 as const,
    pendingRequests: [],
    receipts: [],
  },
});

describe("approval replay checkpoint progress", () => {
  it("coexists with the normal incremental cursor and preserves the original source checkpoint", () => {
    const progress = fixture();
    const metadata = pagedCheckpointMetadataSchema.parse({
      version: 1,
      capturedAtEpochMs: 1,
      status: "waiting",
      nativeObservationState: progress.nativeObservationState,
      approvalReplayProgress: progress,
    });
    expect(metadata.approvalReplayProgress).toEqual(progress);
    expect(metadata.nativeObservationState).toEqual(progress.nativeObservationState);
  });
  it("rejects a mismatched adapter or authority session", () => {
    const wrongAdapter = fixture();
    wrongAdapter.nativeObservationState.adapterSessionId = "other";
    expect(approvalReplayProgressSchema.safeParse(wrongAdapter).success).toBe(false);
    const wrongSession = fixture();
    wrongSession.privateApprovalCaptureState.sessionId = "other";
    expect(approvalReplayProgressSchema.safeParse(wrongSession).success).toBe(false);
  });
  it("rejects malformed source identity and inconsistent replay prefixes", () => {
    const wrongDigest = fixture();
    wrongDigest.sourceCheckpoint.digest = "bad";
    expect(approvalReplayProgressSchema.safeParse(wrongDigest).success).toBe(false);
    const wrongIndex = fixture();
    if (wrongIndex.events[0] === undefined) {
      throw new Error("Expected a saved replay event.");
    }
    wrongIndex.events[0].index = 4;
    expect(approvalReplayProgressSchema.safeParse(wrongIndex).success).toBe(false);
    const wrongCount = fixture();
    wrongCount.nativeObservationState.publicEventCount = 2;
    expect(approvalReplayProgressSchema.safeParse(wrongCount).success).toBe(false);
    const wrongGeneration = fixture();
    wrongGeneration.binding.adapterGeneration = 0;
    expect(approvalReplayProgressSchema.safeParse(wrongGeneration).success).toBe(false);
  });
  it("continues to accept legacy checkpoint metadata without replay progress", () => {
    expect(
      pagedCheckpointMetadataSchema.safeParse({
        version: 1,
        capturedAtEpochMs: 1,
        status: "waiting",
      }).success,
    ).toBe(true);
  });
});
