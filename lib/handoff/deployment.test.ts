import { describe, expect, it, vi } from "vitest";

import type { BuilderProvisionJournalStore } from "../provisioning/journal";
import { createBuilderHandoffRouteHandler } from "./deployment";
import type { BuilderHandoffRecord } from "./contracts";
import { createBuilderHandoffService } from "./service";

const origin = "https://builder.example.test";
const authority = {
  issuer: `${origin}/api/auth`,
  audience: `${origin}/mcp`,
  workspaceId: "workspace-one",
  ownerUserId: "user-one",
};
const creationRequestId = "123e4567-e89b-42d3-a456-426614174000";
const handoffId = "123e4567-e89b-42d3-a456-426614174001";

function route(input: { authenticated?: boolean } = {}) {
  const rows = new Map<string, BuilderHandoffRecord>();
  const handoffs = createBuilderHandoffService({
    now: () => new Date("2026-09-01T12:00:00.000Z"),
    createId: () => handoffId,
    store: {
      async reserve(record) {
        const existing = [...rows.values()].find(
          (candidate) =>
            candidate.creationRequestId === record.creationRequestId,
        );
        if (existing) return { disposition: "existing", record: existing };
        rows.set(record.handoffId, record);
        return { disposition: "created", record };
      },
      async read({ handoffId: requested }) {
        return rows.get(requested);
      },
      async bindSession() {
        return undefined;
      },
    },
  });
  const journal = {
    read: vi.fn(async () => undefined),
    reserve: vi.fn(),
    compareAndSet: vi.fn(),
  } as unknown as BuilderProvisionJournalStore;
  return {
    journal,
    handler: createBuilderHandoffRouteHandler({
      origin,
      journal,
      handoffs,
      async authorityForRequest() {
        return input.authenticated === false ? undefined : authority;
      },
    }),
  };
}

function request(body: unknown, input: { origin?: string } = {}) {
  return new Request(`${origin}/api/builder/handoffs`, {
    method: "POST",
    headers: {
      origin: input.origin ?? origin,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const validBody = {
  version: 1,
  creationRequestId,
  appName: "Vendor Review",
  repository: { name: "vendor-review", private: true },
  brief: "Review new vendors before activation.",
  modelId: "openai/gpt-5.6-sol",
  connections: [],
};

describe("builder handoff deployment", () => {
  it("creates only an opaque tenant-owned handoff and is idempotent", async () => {
    const { handler, journal } = route();
    const first = await handler(request(validBody));
    const retry = await handler(request(validBody));

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    const expected = {
      version: 1,
      handoffId,
      expiresAt: "2026-09-08T12:00:00.000Z",
    };
    await expect(first.json()).resolves.toEqual(expected);
    await expect(retry.json()).resolves.toEqual(expected);
    expect(journal.read).not.toHaveBeenCalled();
  });

  it("accepts a canonical browser host behind an internal bind address", async () => {
    const response = await route().handler(
      new Request("https://0.0.0.0:3001/api/builder/handoffs", {
        method: "POST",
        headers: {
          host: new URL(origin).host,
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify(validBody),
      }),
    );

    expect(response.status).toBe(200);
  });

  it("rejects an internal bind address without the canonical browser host", async () => {
    const response = await route().handler(
      new Request("https://0.0.0.0:3001/api/builder/handoffs", {
        method: "POST",
        headers: {
          host: "evil.example.test",
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify(validBody),
      }),
    );

    expect(response.status).toBe(400);
  });

  it("rejects missing auth, cross-origin input, malformed JSON, and oversized streams", async () => {
    const unauthenticated = route({ authenticated: false }).handler;
    expect((await unauthenticated(request(validBody))).status).toBe(401);
    expect(
      (
        await route().handler(
          request(validBody, { origin: "https://evil.test" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await route().handler(
          new Request(`${origin}/api/builder/handoffs`, {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
            body: "{",
          }),
        )
      ).status,
    ).toBe(400);
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(70_000));
        controller.close();
      },
    });
    expect(
      (
        await route().handler(
          new Request(`${origin}/api/builder/handoffs`, {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
            body: oversized,
            duplex: "half",
          } as RequestInit & { duplex: "half" }),
        )
      ).status,
    ).toBe(400);
  });
});
