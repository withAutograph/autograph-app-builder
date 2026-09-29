import { describe, expect, it } from "vitest";

import { createBoundedAuthorizationRefresh } from "./automatic-refresh";

describe("authorization focus refresh", () => {
  it("rate-limits refreshes without exhausting an authorization request", () => {
    const refresh = createBoundedAuthorizationRefresh({
      minimumIntervalMs: 1000,
    });
    refresh.reset("request-one");
    expect(refresh.claim("request-one", 1000)).toBe(true);
    expect(refresh.claim("request-one", 1500)).toBe(false);
    expect(refresh.claim("request-one", 2000)).toBe(true);
    expect(refresh.claim("request-one", 3000)).toBe(true);
    expect(refresh.claim("request-one", 4000)).toBe(true);
    for (let attempt = 5; attempt <= 1000; attempt += 1) {
      expect(refresh.claim("request-one", attempt * 1000)).toBe(true);
    }
  });

  it("rejects an empty request key without consuming the refresh interval", () => {
    const refresh = createBoundedAuthorizationRefresh();
    refresh.reset("request-one");
    expect(refresh.claim("", 1000)).toBe(false);
    expect(refresh.claim("request-one", 1000)).toBe(true);
    expect(refresh.claim("request-one", 1999)).toBe(false);
    expect(refresh.claim("request-one", 2000)).toBe(true);
  });

  it("rejects stale batches and resets for a new authorization request", () => {
    const refresh = createBoundedAuthorizationRefresh();
    refresh.reset("request-one");
    expect(refresh.claim("request-two", 1000)).toBe(false);
    refresh.reset("request-two");
    expect(refresh.claim("request-two", 1000)).toBe(true);
  });
});
