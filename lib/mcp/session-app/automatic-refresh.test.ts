import { describe, expect, it } from "vitest";

import { createBoundedAuthorizationRefresh } from "./automatic-refresh";

describe("authorization focus refresh", () => {
  it("rate-limits and bounds refreshes for one exact request batch", () => {
    const refresh = createBoundedAuthorizationRefresh({
      maximumAttempts: 3,
      minimumIntervalMs: 1000,
    });
    refresh.reset("request-one");
    expect(refresh.claim("request-one", 1000)).toBe(true);
    expect(refresh.claim("request-one", 1500)).toBe(false);
    expect(refresh.claim("request-one", 2000)).toBe(true);
    expect(refresh.claim("request-one", 3000)).toBe(true);
    expect(refresh.claim("request-one", 4000)).toBe(false);
  });

  it("rejects stale batches and resets for a new authorization request", () => {
    const refresh = createBoundedAuthorizationRefresh();
    refresh.reset("request-one");
    expect(refresh.claim("request-two", 1000)).toBe(false);
    refresh.reset("request-two");
    expect(refresh.claim("request-two", 1000)).toBe(true);
  });
});
