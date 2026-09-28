import { describe, expect, it } from "vitest";

import { recoveryPromptForPagedSession, recoveryPromptForSession } from "./hosted-recovery-prompt";
import {
  durableHostedSessionRecordSchema,
  hostedSessionCheckpointDigest,
  hostedSessionCheckpointProgressDigest,
  hostedSessionCheckpointSchema,
} from "./hosted-store";

describe("hosted recovery prompt", () => {
  it("marks legacy truncation and conversation excerpts without granting approval", () => {
    const checkpoint = hostedSessionCheckpointSchema.parse({
      capturedAtEpochMs: 1,
      events: Array.from({ length: 30 }, (_, index) => ({
        index: index + 100,
        text: `message ${index}`,
        turnId: "turn-1",
        type: "assistant_message",
      })),
      inputRequests: [
        { allowFreeform: false, kind: "approval", requestId: "approve-1", title: "Build" },
      ],
      status: "input_required",
      truncatedBeforeIndex: 100,
      version: 1,
    });
    const record = durableHostedSessionRecordSchema.parse({
      adapterGeneration: 1,
      adapterSessionId: "adapter-1",
      checkpoint,
      checkpointDigest: hostedSessionCheckpointDigest(checkpoint),
      checkpointProgressDigest: hostedSessionCheckpointProgressDigest(checkpoint),
      createdAtEpochMs: 1,
      lastProgressAtEpochMs: 1,
      originAdapterSessionId: "adapter-1",
      principal: {
        audience: "https://builder.example.test/mcp",
        issuer: "https://builder.example.test",
        ownerUserId: "user-1",
        scopes: ["autograph:session"],
        workspaceId: "workspace-1",
      },
      resumability: "checkpoint",
      sessionId: "session-1",
      stage: "needs_attention",
      status: "input_required",
      title: "Example app",
      updatedAtEpochMs: 1,
      version: 2,
    });

    const prompt = recoveryPromptForSession(record);
    expect(prompt).toContain("discarded its first 100 public events");
    expect(prompt).toContain("authenticated autograph_get for session session-1");
    expect(prompt).toContain("Reissue every unresolved product request");
    expect(prompt).toContain('"requestId":"approve-1"');
    expect(prompt).not.toContain("message 0\n\n");
  });

  it("recovers recent conversation from a paged checkpoint without losing earlier history", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const record = durableHostedSessionRecordSchema.parse({
      adapterGeneration: 1,
      adapterSessionId: "adapter-2",
      appId: "spend-review",
      checkpointDigest: digest,
      checkpointProgressDigest: `sha256:${"b".repeat(64)}`,
      checkpointRef: {
        digest,
        eventCount: 400,
        id: "123e4567-e89b-42d3-a456-426614174002",
      },
      createdAtEpochMs: 1,
      lastProgressAtEpochMs: 2,
      originAdapterSessionId: "adapter-2",
      principal: {
        audience: "https://builder.example.test/mcp",
        issuer: "https://builder.example.test",
        ownerUserId: "user-1",
        scopes: ["autograph:session"],
        workspaceId: "workspace-1",
      },
      resumability: "terminal",
      sessionId: "session-2",
      stage: "needs_attention",
      status: "failed",
      title: "Spend Review",
      updatedAtEpochMs: 2,
      version: 2,
    });

    const prompt = recoveryPromptForPagedSession({
      earlierEventsRemain: true,
      metadata: {
        capturedAtEpochMs: 2,
        inputRequests: [
          { allowFreeform: false, kind: "approval", requestId: "review-1", title: "Review" },
        ],
        status: "failed",
        version: 1,
      },
      recentMessages: ["The private build passed", "Validation needs repair"],
      record,
    });

    expect(prompt).toContain("App id: spend-review");
    expect(prompt).toContain("Validation needs repair");
    expect(prompt).toContain("authenticated autograph_get for session session-2");
    expect(prompt).toContain('"requestId":"review-1"');
    expect(prompt).toContain("Reissue every unresolved product request");
    expect(prompt).not.toContain("discarded");
  });
});
