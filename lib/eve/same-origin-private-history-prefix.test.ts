/* oxlint-disable eslint/require-await -- Controlled fetch and authority ports retain asynchronous production contracts. */
import { describe, expect, it, vi } from "vitest";
import { createSameOriginEveTransport } from "./same-origin-http";
import { hostedEveOperationScopes } from "./hosted-auth";

const principal = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace",
  ownerUserId: "owner",
  scopes: Object.values(hostedEveOperationScopes),
};
const native = [0, 1, 2].map((index) => ({
  type: "session.waiting",
  meta: { id: `event-${index}`, at: "2026-11-09T00:00:00Z" },
  data: { wait: "next-user-message", continuationToken: "retained" },
}));
const fixture = (sent = native, tail = native.length - 1, authorized = true) => {
  const cancel = vi.fn();
  const fetchImplementation = vi.fn<typeof fetch>(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `${sent.map((event) => JSON.stringify(event)).join("\n")}\n`,
              ),
            );
            controller.close();
          },
          cancel,
        }),
        {
          headers: {
            "content-type": "application/x-ndjson",
            "x-eve-session-id": "adapter",
            "x-eve-stream-format": "ndjson",
            "x-eve-stream-version": "25",
            "x-eve-stream-tail-index": String(tail),
          },
        },
      ),
  );
  const verifyReadAuthority = vi.fn(async () => authorized);
  const reader = createSameOriginEveTransport({
    config: { baseUrl: "https://builder.example" },
    workloadIdentity: { token: async () => "synthetic" },
    fetchImplementation,
    verifyReadAuthority,
  }).observePrivateHistory;
  if (reader === undefined) {
    throw new Error("Expected authorized reader");
  }
  const onEvent = vi.fn();
  const read = async (endIndexExclusive?: number) =>
    await reader({
      principal,
      sessionId: "public-session",
      adapterSessionId: "adapter",
      startIndex: 0,
      endIndexExclusive,
      onEvent,
    });
  return { read, onEvent, fetchImplementation, verifyReadAuthority, cancel };
};

describe("internal private-history diagnostic prefix", () => {
  it("stops after the exclusive cursor while retaining the real tail and incomplete approval history", async () => {
    const f = fixture();
    expect(await f.read(1)).toEqual({ nextNativeIndex: 1, nativeTailIndex: 2, complete: false });
    expect(f.onEvent).toHaveBeenCalledOnce();
    expect(f.verifyReadAuthority).toHaveBeenCalledOnce();
  });
  it("keeps complete history semantics at the real tail and for ordinary unbounded callers", async () => {
    const bounded = fixture();
    expect(await bounded.read(3)).toEqual({
      nextNativeIndex: 3,
      nativeTailIndex: 2,
      complete: true,
    });
    expect(bounded.onEvent).toHaveBeenCalledTimes(3);
    expect(await fixture().read()).toEqual({
      nextNativeIndex: 3,
      nativeTailIndex: 2,
      complete: true,
    });
  });
  it("still rejects an early EOF before the requested real tail", async () => {
    const f = fixture(native.slice(0, 1));
    await expect(f.read(3)).rejects.toThrow("ended before its durable tail");
    expect(f.onEvent).toHaveBeenCalledOnce();
  });
  it("denies foreign authority and invalid prefix bounds before any fetch", async () => {
    const denied = fixture(native, 2, false);
    await expect(denied.read(1)).rejects.toMatchObject({ code: "session_access_denied" });
    expect(denied.fetchImplementation).not.toHaveBeenCalled();
    const invalid = fixture();
    await expect(invalid.read(0)).rejects.toThrow();
    expect(invalid.fetchImplementation).not.toHaveBeenCalled();
  });
});
