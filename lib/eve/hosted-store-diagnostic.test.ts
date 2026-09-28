import { describe, expect, it } from "vitest";

import { hostedEveOperationScopes } from "./hosted-auth";
import {
  durableHostedSessionRecordSchema,
  hostedSessionCheckpointDigest,
  hostedSessionCheckpointProgressDigest,
} from "./hosted-store";
import type { HostedSessionCheckpoint } from "./hosted-store";

const recordFor = (
  checkpoint: HostedSessionCheckpoint,
  checkpointDigest: string,
  checkpointProgressDigest: string,
) => ({
  adapterGeneration: 1,
  adapterSessionId: "adapter-1",
  checkpoint,
  checkpointDigest,
  checkpointProgressDigest,
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
});

describe("hosted checkpoint diagnostics", () => {
  it("reports both stored and computed digests without accepting a changed checkpoint", () => {
    const checkpoint = {
      capturedAtEpochMs: 1,
      events: [],
      status: "waiting" as const,
      version: 1 as const,
    };
    const record = recordFor(checkpoint, `sha256:${"a".repeat(64)}`, `sha256:${"b".repeat(64)}`);
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

  it("hashes progress events identically before and after JSON storage", () => {
    const checkpoint = {
      capturedAtEpochMs: 1,
      events: [
        {
          index: 0,
          label: "Preparing",
          state: "started" as const,
          // oxlint-disable-next-line sonarjs/no-undefined-assignment -- reproduce the pre-storage event.
          turnId: undefined,
          type: "progress" as const,
        },
      ],
      status: "waiting" as const,
      version: 1 as const,
    };
    const stored = {
      ...checkpoint,
      events: [
        { index: 0, label: "Preparing", state: "started" as const, type: "progress" as const },
      ],
    };
    expect(hostedSessionCheckpointDigest(checkpoint)).toBe(hostedSessionCheckpointDigest(stored));
    expect(hostedSessionCheckpointProgressDigest(checkpoint)).toBe(
      hostedSessionCheckpointProgressDigest(stored),
    );
  });

  it("recovers a legacy inline checkpoint only when both old digests match", () => {
    const storedCheckpoint = {
      capturedAtEpochMs: 1,
      events: [{ index: 0, label: "x", state: "started" as const, type: "progress" as const }],
      status: "waiting" as const,
      version: 1 as const,
    };
    const record = recordFor(
      storedCheckpoint,
      "sha256:5c36133b6898773db8bf9dfaacf8a1cb47cebce8b28d2a31fe8d810e57c40ce2",
      "sha256:23afd9a143f8940db3981d50f2ed50bb367a23e3d6d7de13e540edb62fdb8b9d",
    );
    expect(durableHostedSessionRecordSchema.safeParse(record).success).toBe(true);
    expect(
      durableHostedSessionRecordSchema.safeParse({
        ...record,
        checkpointProgressDigest: hostedSessionCheckpointProgressDigest(storedCheckpoint),
      }).success,
    ).toBe(false);
  });
});
