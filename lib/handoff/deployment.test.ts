import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

import type { BuilderProvisionJournalStore } from "../provisioning/journal";
import { initialBuilderProvisionJournalRecord } from "../provisioning/journal";
import {
  createBuilderHandoffRouteHandler,
  createBuilderHandoffRenewRouteHandler,
  createBuilderHandoffStatusRouteHandler,
} from "./deployment";
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
  const clock = { now: new Date("2026-09-01T12:00:00.000Z") };
  const handoffs = createBuilderHandoffService({
    now: () => clock.now,
    createId: () => (rows.size === 0 ? handoffId : randomUUID()),
    store: {
      async reserve(record) {
        const existing = [...rows.values()].find(
          (candidate) => candidate.creationRequestId === record.creationRequestId,
        );
        if (existing) return { disposition: "existing", record: existing };
        rows.set(record.handoffId, record);
        return { disposition: "created", record };
      },
      async read({ handoffId: requested, authority: owner }) {
        const row = rows.get(requested);
        return row && JSON.stringify(row.authority) === JSON.stringify(owner) ? row : undefined;
      },
      async bindSession() {
        return undefined;
      },
      async renewExpired(input) {
        const record = rows.get(input.handoffId);
        if (
          !record ||
          JSON.stringify(record.authority) !== JSON.stringify(input.authority) ||
          record.requestDigest !== input.requestDigest
        )
          return undefined;
        if (record.sessionId !== undefined || record.expiresAt > input.now)
          return { disposition: "existing", record };
        const updated = { ...record, expiresAt: input.expiresAt };
        rows.set(record.handoffId, updated);
        return { disposition: "renewed", record: updated };
      },
    },
  });
  const journal = {
    read: vi.fn(async () => undefined),
    reserve: vi.fn(),
    compareAndSet: vi.fn(),
  } as unknown as BuilderProvisionJournalStore;
  return {
    clock,
    rows,
    handoffs,
    journal,
    renew: createBuilderHandoffRenewRouteHandler({
      origin,
      handoffs,
      async authorityForRequest() {
        return input.authenticated === false ? undefined : authority;
      },
    }),
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
  modelId: "openai/gpt-5.6-terra",
  connections: [],
};

describe("builder handoff deployment", () => {
  it("stores the destination and journal selections even when provisioning failed", async () => {
    const { handler, journal, rows } = route();
    const provisionRequest = {
      version: 1 as const,
      requestId: randomUUID(),
      operation: "github" as const,
      appName: "Saved App",
      repository: { name: "saved-app", private: false },
      providers: {
        githubInstallationId: "123",
        vercelInstallationId: "icfg_saved",
      },
    };
    const record = initialBuilderProvisionJournalRecord(
      provisionRequest,
      new Date("2026-09-01T12:00:00Z"),
    );
    vi.mocked(journal.read).mockResolvedValue({
      authority,
      requestId: provisionRequest.requestId,
      requestDigest: record.response.requestDigest,
      state: "pending",
      revision: 0,
      record,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const response = await handler(
      request({
        ...validBody,
        destination: "cursor",
        provisioningRequestId: provisionRequest.requestId,
      }),
    );
    expect(response.status).toBe(200);
    expect(journal.read).toHaveBeenCalledWith({
      authority,
      requestId: provisionRequest.requestId,
    });
    expect(rows.get(handoffId)?.intent).toMatchObject({
      destination: "cursor",
      appName: "Saved App",
      appId: "saved-app",
      repository: { requestedName: "saved-app", private: false },
      providers: provisionRequest.providers,
      provisioning: record.response,
    });
    expect(rows.get(handoffId)?.intent.repository.resolvedFullName).toBeUndefined();
    expect(journal.reserve).not.toHaveBeenCalled();
    expect(journal.compareAndSet).not.toHaveBeenCalled();
  });

  it("does not accept caller-supplied provider selections or another owner's provisioning request", async () => {
    const { handler } = route();
    expect(
      (await handler(request({ ...validBody, providers: { githubInstallationId: "999" } }))).status,
    ).toBe(400);
    expect(
      (await handler(request({ ...validBody, provisioningRequestId: randomUUID() }))).status,
    ).toBe(404);
    expect((await handler(request({ ...validBody, destination: "other-client" }))).status).toBe(
      400,
    );
  });

  it("extends the same reference and never calls provisioning", async () => {
    const { handler, renew, rows, clock, journal } = route();
    await handler(request({ ...validBody, destination: "cursor" }));
    const original = rows.get(handoffId)!;
    clock.now = original.expiresAt;
    const renewal = request({ creationRequestId: randomUUID() });
    const first = await renew(renewal, handoffId);
    const retry = await renew(request({ creationRequestId: randomUUID() }), handoffId);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const reference = await first.json();
    expect(reference).toEqual(await retry.json());
    expect(Object.keys(reference).sort()).toEqual(["expiresAt", "handoffId", "version"]);
    expect(reference.handoffId).toBe(handoffId);
    expect(rows.size).toBe(1);
    expect(rows.get(handoffId)).toEqual({
      ...original,
      expiresAt: new Date(reference.expiresAt),
    });
    expect(rows.get(reference.handoffId)?.intent).toEqual(original.intent);
    expect(journal.read).not.toHaveBeenCalled();
    expect(journal.reserve).not.toHaveBeenCalled();
    expect(journal.compareAndSet).not.toHaveBeenCalled();
  });

  it("returns 401 without auth and the same no-store 404 for foreign, absent, or malformed IDs", async () => {
    const renewBody = { creationRequestId: randomUUID() };
    const unauthenticated = await route({ authenticated: false }).renew(
      request(renewBody),
      handoffId,
    );
    expect(unauthenticated.status).toBe(401);
    const { handler, renew, rows } = route();
    await handler(request(validBody));
    rows.get(handoffId)!.authority = { ...authority, ownerUserId: "user-two" };
    for (const id of [handoffId, randomUUID(), "not-a-uuid"]) {
      const response = await renew(request(renewBody), id);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: "handoff_unavailable" });
    }
  });

  it("protects renewal against CSRF, invalid JSON, unexpected fields, and oversized bodies", async () => {
    const { renew, rows } = route();
    const attempts = [
      request({ creationRequestId: randomUUID() }, { origin: "https://evil.test" }),
      request({ creationRequestId: "invalid" }),
      request({ creationRequestId: randomUUID(), intent: validBody }),
      new Request(`${origin}/api/builder/handoffs/${handoffId}/renew`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: "{",
      }),
      new Request(`${origin}/api/builder/handoffs/${handoffId}/renew`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: "x".repeat(70_000),
      }),
      new Request(`${origin}/api/builder/handoffs/${handoffId}/renew`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ creationRequestId: randomUUID() }),
      }),
    ];
    for (const attempt of attempts) {
      const response = await renew(attempt, handoffId);
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(rows.size).toBe(0);
  });

  it("maps status authentication and failures without exposing internal errors", async () => {
    const pageData = vi.fn();
    const status = createBuilderHandoffStatusRouteHandler({ pageData });
    const get = new Request(`${origin}/api/builder/handoffs/${handoffId}`);
    pageData.mockResolvedValue(undefined);
    expect((await status(get, handoffId)).status).toBe(401);
    pageData.mockRejectedValue(new Error("database secret"));
    const failed = await status(get, handoffId);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "handoff_unavailable" });
    expect(failed.headers.get("cache-control")).toBe("no-store");
  });

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
      (await route().handler(request(validBody, { origin: "https://evil.test" }))).status,
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
