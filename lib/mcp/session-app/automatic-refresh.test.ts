import { describe, expect, it } from "vitest";

import {
  createBoundedAuthorizationRefresh,
  sessionAuthorizationRefreshKey,
} from "./automatic-refresh";

describe("authorization focus refresh", () => {
  it("refreshes pending app identity links even without a human response request", () => {
    const result = { cursor: 1, events: [], sessionId: "session", status: "working" as const };
    const key = sessionAuthorizationRefreshKey(result, [
      {
        callId: "call",
        expiresAt: "2099-01-01T00:00:00Z",
        url: "https://apps.example.com/sign-in",
      },
    ]);
    const refresh = createBoundedAuthorizationRefresh();
    refresh.reset(key);
    expect(refresh.claim(key, 1000)).toBe(true);
    expect(sessionAuthorizationRefreshKey(result, [])).toBe("");
  });
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
