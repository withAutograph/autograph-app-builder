import { describe, expect, it } from "vitest";

import { recoveryPromptForSession } from "./hosted-recovery-prompt";
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
});
