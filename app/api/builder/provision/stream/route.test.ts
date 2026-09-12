import { afterEach, describe, expect, it, vi } from "vitest";

import type { BuilderProvisionProjection } from "@/lib/provisioning/contracts";
import { GET } from "./route";

const deployment = vi.hoisted(() => ({
  handler: vi.fn(),
}));

vi.mock("@/lib/provisioning/deployment", () => ({
  getBuilderProvisioningDeploymentHandler: vi.fn(() => deployment.handler),
}));

const requestId = "123e4567-e89b-42d3-a456-426614174000";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function projection(
  revision: number,
  status: "pending" | "settled" = "settled",
): BuilderProvisionProjection {
  return {
    revision,
    provisioning: {
      version: 1,
      requestId,
      requestDigest: "f".repeat(64),
      appId: "streamed-app",
      status,
      github: { status: "skipped", code: "not_selected", retryable: false },
      vercel: { status: "skipped", code: "not_selected", retryable: false },
      updatedAt: "2026-09-11T00:00:00.000Z",
    },
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function mockProjection(value: BuilderProvisionProjection) {
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  deployment.handler.mockImplementation(async () => Response.json(value));
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function readAll(response: Response) {
  return await response.text();
}

afterEach(() => {
  deployment.handler.mockReset();
  vi.useRealTimers();
});

describe("GET /api/builder/provision/stream", () => {
  it("rejects requests without a durable journal id", async () => {
    const response = await GET(
      new Request("https://builder.example.test/api/builder/provision/stream"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "request_invalid" });
    expect(deployment.handler).not.toHaveBeenCalled();
  });

  it("frames the initial durable projection and its terminal event", async () => {
    mockProjection(projection(4));

    const response = await GET(
      new Request(
        `https://builder.example.test/api/builder/provision/stream?requestId=${requestId}`,
      ),
    );

    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-store");
    expect(await readAll(response)).toBe(
      `id: 4\nevent: snapshot\ndata: ${JSON.stringify(projection(4))}\n\n` +
        `id: 4\nevent: end\ndata: ${JSON.stringify(projection(4))}\n\n`,
    );
  });

  it("uses a valid Last-Event-ID as the reconnect cursor and safely ignores an invalid one", async () => {
    mockProjection(projection(4));
    const resumed = await GET(
      new Request(
        `https://builder.example.test/api/builder/provision/stream?requestId=${requestId}`,
        { headers: { "Last-Event-ID": "4" } },
      ),
    );
    expect(await readAll(resumed)).toBe(
      `id: 4\nevent: end\ndata: ${JSON.stringify(projection(4))}\n\n`,
    );

    mockProjection(projection(4));
    const invalid = await GET(
      new Request(
        `https://builder.example.test/api/builder/provision/stream?requestId=${requestId}`,
        { headers: { "Last-Event-ID": "not-a-revision" } },
      ),
    );
    expect(await readAll(invalid)).toContain("event: snapshot");
  });

  it("keeps a pending stream alive with heartbeats until a later revision arrives", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T00:00:00.000Z"));
    mockProjection(projection(1, "pending"));

    const response = await GET(
      new Request(
        `https://builder.example.test/api/builder/provision/stream?requestId=${requestId}`,
      ),
    );
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain("event: snapshot");

    await vi.advanceTimersByTimeAsync(10_000);
    const keepAlive = await reader?.read();
    expect(new TextDecoder().decode(keepAlive?.value)).toBe(": keep-alive\n\n");

    await reader?.cancel();
  });

  it("resumes a newly created EventSource by query cursor but lets the native header advance it", async () => {
    mockProjection(projection(4));
    for (const [query, headers] of [
      ["4", undefined],
      ["1", { "Last-Event-ID": "4" }],
    ] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      const response = await GET(
        new Request(
          `https://builder.example.test/api/builder/provision/stream?requestId=${requestId}&afterRevision=${query}`,
          { headers },
        ),
      );
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      expect(await readAll(response)).toBe(
        `id: 4\nevent: end\ndata: ${JSON.stringify(projection(4))}\n\n`,
      );
    }
  });

  it.each(["-1", "NaN", "Infinity", "1.5", "9007199254740992", "1e2"])(
    "ignores malformed query cursor %s",
    async (cursor) => {
      mockProjection(projection(4));
      const response = await GET(
        new Request(
          `https://builder.example.test/api/builder/provision/stream?requestId=${requestId}&afterRevision=${cursor}`,
        ),
      );
      expect(await readAll(response)).toContain("event: snapshot");
    },
  );
});
