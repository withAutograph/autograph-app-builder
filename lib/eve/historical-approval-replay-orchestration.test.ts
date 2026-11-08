import { describe, expect, it, vi } from "vitest";
import type { PublicEveEvent } from "../mcp/contracts";
import type { ApprovalReplayProgress } from "./postgres-hosted-checkpoint-history";
import { runHistoricalApprovalReplay } from "./historical-approval-replay-orchestration";

const principal = {
  audience: "builder",
  issuer: "https://identity.example",
  ownerUserId: "owner",
  scopes: ["autograph:get"],
  workspaceId: "workspace",
};
const binding = {
  principal,
  sessionId: "session",
  approvalSessionId: "session",
  adapterSessionId: "adapter",
  adapterGeneration: 1,
};
const checkpoint = {
  id: "00000000-0000-4000-8000-000000000001",
  digest: `sha256:${"a".repeat(64)}`,
  eventCount: 2,
};
const events: PublicEveEvent[] = [
  { index: 0, status: "working", type: "status" },
  { index: 1, status: "waiting", type: "status" },
];
const stream = async function* stream(items: PublicEveEvent[]) {
  for (const item of items) {
    yield item;
  }
};
const progress = (complete: boolean) => ({
  version: 1 as const,
  binding,
  sourceCheckpoint: checkpoint,
  events: complete ? events : events.slice(0, 1),
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
    nextNativeIndex: complete ? 5 : 3,
    pendingRequests: [],
    prototypeProjector: { artifactReadRequests: [], readChunks: [], requested: [], transfers: [] },
    prototypeReference: { requested: [], requestedUiPreview: [] },
    publicEventCount: complete ? 2 : 1,
    version: 1 as const,
  },
  privateApprovalCaptureState: {
    pendingRequests: [],
    receipts: [],
    sessionId: "session",
    version: 1 as const,
  },
});
const fixture = () => {
  const assertOwner = vi.fn(async () => {});
  const persistPartial = vi.fn().mockResolvedValue(true);
  const publishVerified = vi.fn().mockResolvedValue(true);
  return {
    assertOwner,
    binding,
    checkpoint,
    persistPartial,
    publishVerified,
    trustedEvents: () => stream(events),
  };
};
describe("historical approval replay orchestration", () => {
  it("persists partial observation and resumes from that state without dispatch", async () => {
    const f = fixture();
    const first = progress(false);
    await expect(
      runHistoricalApprovalReplay({
        ...f,
        // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
        observe: () =>
          Promise.resolve({
            nativeTail: { complete: false, nativeTailIndex: 4, nextNativeIndex: 3 },
            progress: first,
          }),
      }),
    ).resolves.toEqual({ status: "partial" });
    expect(f.persistPartial).toHaveBeenCalledWith(first, checkpoint);
    expect(f.publishVerified).not.toHaveBeenCalled();
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    const observe = vi.fn((prior: ApprovalReplayProgress | undefined) => {
      expect(prior).toEqual(first);
      return Promise.resolve({
        nativeTail: { complete: true, nativeTailIndex: 4, nextNativeIndex: 5 },
        progress: progress(true),
      });
    });
    await expect(runHistoricalApprovalReplay({ ...f, observe, progress: first })).resolves.toEqual({
      status: "ready",
    });
    expect(f.publishVerified).toHaveBeenCalledWith(progress(true), checkpoint);
  });
  it("fails closed on changed owner, adapter, or saved replay prefix", async () => {
    const f = fixture();
    for (const changed of [
      { ...binding, principal: { ...principal, ownerUserId: "other" } },
      { ...binding, adapterSessionId: "other" },
      { ...binding, adapterGeneration: 2 },
    ]) {
      const p = {
        ...progress(true),
        binding: changed,
        nativeObservationState: {
          ...progress(true).nativeObservationState,
          adapterSessionId: changed.adapterSessionId,
        },
      };
      // Each changed binding is checked in sequence against the same fixture.
      // oxlint-disable-next-line eslint/no-await-in-loop
      await expect(
        runHistoricalApprovalReplay({
          ...f,
          // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
          observe: () =>
            Promise.resolve({
              nativeTail: { complete: true, nativeTailIndex: 4, nextNativeIndex: 5 },
              progress: p,
            }),
        }),
      ).rejects.toThrow();
    }
    const p = {
      ...progress(true),
      events: [events[0], { index: 1, status: "cancelled" as const, type: "status" as const }],
    };
    await expect(
      runHistoricalApprovalReplay({
        ...f,
        // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
        observe: () =>
          Promise.resolve({
            nativeTail: { complete: true, nativeTailIndex: 4, nextNativeIndex: 5 },
            progress: p,
          }),
      }),
    ).rejects.toThrow("prefix mismatch");
    expect(f.publishVerified).not.toHaveBeenCalled();
  });
  it("refuses to publish after concurrent checkpoint changes", async () => {
    const f = fixture();
    f.publishVerified.mockResolvedValue(false);
    await expect(
      runHistoricalApprovalReplay({
        ...f,
        // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
        observe: () =>
          Promise.resolve({
            nativeTail: { complete: true, nativeTailIndex: 4, nextNativeIndex: 5 },
            progress: progress(true),
          }),
      }),
    ).rejects.toThrow("checkpoint changed");
    expect(f.assertOwner).toHaveBeenCalledTimes(2);
  });
  it("does not publish a purported complete observation with an incomplete cursor", async () => {
    const f = fixture();
    await expect(
      runHistoricalApprovalReplay({
        ...f,
        // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
        observe: () =>
          Promise.resolve({
            nativeTail: { complete: true, nativeTailIndex: 4, nextNativeIndex: 3 },
            progress: progress(false),
          }),
      }),
    ).rejects.toThrow("incomplete");
    expect(f.publishVerified).not.toHaveBeenCalled();
  });
});
