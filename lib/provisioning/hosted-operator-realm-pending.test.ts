import { describe, expect, it } from "vitest";
import { realmContinuationPendingBaseline } from "./hosted-operator-realm-pending";

const request = (requestId: string) => ({
  kind: "question" as const,
  optionIds: [],
  requestId,
  toolName: "prepare-app-hosted-runtime",
});

describe("Realm continuation pending baseline", () => {
  it("retains older-turn private requests and omits resolved requests in partial batches", () => {
    const batch = {
      requests: [request("old_auth"), request("already_resolved")],
      sequence: 1,
      stepIndex: 9,
      turnId: "older_turn",
    };
    expect(
      realmContinuationPendingBaseline({
        nextNativeIndex: 304_875,
        pendingRequests: [],
        privateInputState: {
          pending: [batch],
          resolved: [
            {
              batch,
              resolutions: [
                {
                  kind: "question",
                  outcome: "answered",
                  requestId: "already_resolved",
                },
              ],
            },
          ],
          version: 1,
        },
      }),
    ).toEqual({ nextNativeIndex: 304_875, pendingRequestIds: ["old_auth"] });
  });

  it("does not infer idle or authorize a send from an empty pending set", () => {
    expect(realmContinuationPendingBaseline({ nextNativeIndex: 10, pendingRequests: [] })).toEqual({
      nextNativeIndex: 10,
      pendingRequestIds: [],
    });
  });
});
