import { describe, expect, it } from "vitest";

import { hostedEveOperationScopes } from "./hosted-auth";
import {
  durableHostedSessionRecordSchema,
  hostedSessionCheckpointDigest,
  hostedSessionCheckpointProgressDigest,
} from "./hosted-store";

describe("hosted checkpoint diagnostics", () => {
  it("reports both stored and computed digests without accepting a changed checkpoint", () => {
    const checkpoint = {
      capturedAtEpochMs: 1,
      events: [],
      status: "waiting" as const,
      version: 1 as const,
    };
    const record = {
      adapterGeneration: 1,
      adapterSessionId: "adapter-1",
      checkpoint,
      checkpointDigest: `sha256:${"a".repeat(64)}`,
      checkpointProgressDigest: `sha256:${"b".repeat(64)}`,
      createdAtEpochMs: 1,
      lastProgressAtEpochMs: 1,
      originAdapterSessionId: "adapter-1",
      principal: {
        audience: "eve-hosted",
        issuer: "https://identity.example.test",
        ownerUserId: "user-1",
        scopes: Object.values(hostedEveOperationScopes),
        workspaceId: "workspace-1",
      },
      resumability: "live",
      sessionId: "session-1",
      stage: "prototype",
      status: "waiting",
      title: "Review",
      updatedAtEpochMs: 1,
      version: 2,
    };
    const result = durableHostedSessionRecordSchema.safeParse(record);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const messages = result.error.issues.map((issue) => issue.message).join("\n");
    expect(messages).toContain(record.checkpointDigest);
    expect(messages).toContain(hostedSessionCheckpointDigest(checkpoint));
    expect(messages).toContain(record.checkpointProgressDigest);
    expect(messages).toContain(hostedSessionCheckpointProgressDigest(checkpoint));
    expect(messages).toContain("Preserve the session");
  });
});
