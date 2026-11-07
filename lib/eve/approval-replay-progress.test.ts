import { describe, expect, it } from "vitest";
import {
  approvalReplayProgressSchema,
  pagedCheckpointMetadataSchema,
} from "./postgres-hosted-checkpoint-history";

const fixture = () => ({
  binding: {
    adapterGeneration: 2,
    adapterSessionId: "adapter",
    approvalSessionId: "original-session",
    principal: {
      audience: "builder",
      issuer: "https://identity.example",
      ownerUserId: "owner",
      scopes: ["autograph:get"],
      workspaceId: "workspace",
    },
    sessionId: "session",
  },
  events: [{ index: 0, status: "working" as const, type: "status" as const }],
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
    pendingRequests: [],
    receipts: [],
    sessionId: "original-session",
    version: 1 as const,
  },
  sourceCheckpoint: {
    digest: `sha256:${"a".repeat(64)}`,
    eventCount: 5,
    id: "00000000-0000-4000-8000-000000000001",
  },
  version: 1 as const,
});

describe("approval replay checkpoint progress", () => {
  it("coexists with the normal incremental cursor and preserves the original source checkpoint", () => {
    const progress = fixture();
    const metadata = pagedCheckpointMetadataSchema.parse({
      approvalReplayProgress: progress,
      capturedAtEpochMs: 1,
      nativeObservationState: progress.nativeObservationState,
      status: "waiting",
      version: 1,
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
        capturedAtEpochMs: 1,
        status: "waiting",
        version: 1,
      }).success,
    ).toBe(true);
  });
});
