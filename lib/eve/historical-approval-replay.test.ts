import { describe, expect, it } from "vitest";
import type { PublicEveEvent } from "../mcp/contracts";
import { verifyHistoricalApprovalReplay } from "./historical-approval-replay";

const binding = {
  issuer: "issuer",
  audience: "audience",
  workspaceId: "workspace",
  ownerUserId: "owner",
  sessionId: "session",
  adapterSessionId: "adapter",
  adapterGeneration: 1,
};
const events: [PublicEveEvent, PublicEveEvent, PublicEveEvent] = [
  { type: "status", status: "working", index: 0 },
  { type: "assistant_message", text: "Saved", turnId: "turn", index: 1 },
  { type: "status", status: "waiting", index: 2 },
];
const stream = async function* stream(items: PublicEveEvent[]) {
  for (const item of items) {
    yield item;
  }
};
const input = () => ({
  trustedBinding: binding,
  replayBinding: { ...binding },
  trustedEventCount: 2,
  trustedEvents: stream(events.slice(0, 2)),
  replayEvents: stream(events),
  nativeTail: { complete: true, nextNativeIndex: 10, nativeTailIndex: 9 },
});

describe("historical approval replay", () => {
  it("streams and validates the immutable prefix while permitting a later suffix", async () => {
    await expect(verifyHistoricalApprovalReplay(input())).resolves.toEqual({ replayEventCount: 3 });
  });
  it.each(["ownerUserId", "workspaceId", "sessionId", "adapterSessionId"] as const)(
    "rejects changed %s",
    async (field) => {
      const value = input();
      value.replayBinding[field] = "different";
      await expect(verifyHistoricalApprovalReplay(value)).rejects.toThrow("binding mismatch");
    },
  );
  it("rejects another adapter generation", async () => {
    const value = input();
    value.replayBinding.adapterGeneration = 2;
    await expect(verifyHistoricalApprovalReplay(value)).rejects.toThrow("binding mismatch");
  });
  it("rejects an incomplete native tail", async () => {
    const value = input();
    value.nativeTail.complete = false;
    await expect(verifyHistoricalApprovalReplay(value)).rejects.toThrow("incomplete");
    const gap = input();
    gap.nativeTail.nextNativeIndex = 9;
    await expect(verifyHistoricalApprovalReplay(gap)).rejects.toThrow("incomplete");
  });
  it("rejects changed, missing, and noncontiguous checkpoint events", async () => {
    const changed = input();
    changed.replayEvents = stream([
      events[0],
      { type: "assistant_message", text: "Changed", turnId: "turn", index: 1 },
      events[2],
    ]);
    await expect(verifyHistoricalApprovalReplay(changed)).rejects.toThrow("prefix mismatch");
    const truncated = input();
    truncated.replayEvents = stream(events.slice(0, 1));
    await expect(verifyHistoricalApprovalReplay(truncated)).rejects.toThrow("truncated");
    const gap = input();
    gap.replayEvents = stream([events[0], { ...events[1], index: 3 }]);
    await expect(verifyHistoricalApprovalReplay(gap)).rejects.toThrow("index mismatch");
    const wrongCount = input();
    wrongCount.trustedEventCount = 1;
    await expect(verifyHistoricalApprovalReplay(wrongCount)).rejects.toThrow("inconsistent");
  });
});
