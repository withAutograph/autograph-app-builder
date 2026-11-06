import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { activeBuilderModelId } from "../integrations/active-model";
import { builderHandoffRecordSchema } from "./contracts";
import type { BuilderHandoffRecord } from "./contracts";
import { createBuilderHandoffService } from "./service";
import type { BuilderHandoffStore } from "./service";
import { createBuilderHandoffStatusRouteHandler } from "./deployment";

const handoffId = "123e4567-e89b-42d3-a456-426614174001";
const authority = {
  audience: "https://builder.example.test/mcp",
  issuer: "https://builder.example.test/api/auth",
  ownerUserId: "user-one",
  workspaceId: "workspace-one",
};
const prepared = builderHandoffRecordSchema.parse({
  authority,
  createdAt: new Date("2026-09-01T12:00:00Z"),
  creationRequestId: "123e4567-e89b-42d3-a456-426614174002",
  expiresAt: new Date("2026-09-08T12:00:00Z"),
  handoffId,
  intent: {
    appId: "vendor-review",
    appName: "Vendor Review",
    brief: "Review new vendors.",
    connections: [],
    modelId: activeBuilderModelId,
    providers: {
      githubInstallationId: "123",
      vercelInstallationId: "icfg_selected",
    },
    repository: { private: true, requestedName: "vendor-review" },
  },
  requestDigest: "a".repeat(64),
  version: 1,
});
const memoryStore = (records: BuilderHandoffRecord[] = [prepared]): BuilderHandoffStore => {
  const byId = new Map(records.map((record) => [record.handoffId, record]));
  return {
    bindSession: async () => {
      await Promise.resolve();
    },
    findLatestPending: async ({ authority: requestedAuthority }) => {
      await Promise.resolve();
      return [...byId.values()].find(
        (record) => JSON.stringify(record.authority) === JSON.stringify(requestedAuthority),
      );
    },
    read: async ({ authority: requestedAuthority, handoffId: requestedId }) => {
      await Promise.resolve();
      const record = byId.get(requestedId);
      return record && JSON.stringify(record.authority) === JSON.stringify(requestedAuthority)
        ? record
        : undefined;
    },
    reserve: async (record) => {
      await Promise.resolve();
      byId.set(record.handoffId, record);
      return { disposition: "created", record };
    },
  };
};

const pageData = (store = memoryStore()) => {
  const service = createBuilderHandoffService({ now: () => new Date(), store });
  return createBuilderHandoffStatusRouteHandler({
    pageData: async (_request, requestedId) => {
      const { record, status } = await service.status({ authority, handoffId: requestedId });
      return {
        cursorInstallReady: false,
        destination: record.intent.destination ?? "codex",
        expiresAt: record.expiresAt.toISOString(),
        handoffId: record.handoffId,
        intent: record.intent,
        mcpUrl: authority.audience,
        status,
        version: 1,
      };
    },
  });
};

describe("owner-only handoff browser data", () => {
  afterEach(() => vi.useRealTimers());

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T12:00:00Z"));
  });

  it("returns only public fields and uses the exact web session authority", async () => {
    const response = await pageData()(new Request(`${authority.audience}/unused`), handoffId);
    const data: unknown = await response.json();
    expect(data).toEqual({
      cursorInstallReady: false,
      destination: "codex",
      expiresAt: prepared.expiresAt.toISOString(),
      handoffId,
      intent: prepared.intent,
      mcpUrl: authority.audience,
      status: "prepared",
      version: 1,
    });
    expect(JSON.stringify(data)).not.toMatch(
      /private-password|private-session-cookie|ownerUserId|workspaceId|requestDigest|sessionId/u,
    );
  });

  it("returns undefined without login before reading any handoff or checking Cursor readiness", async () => {
    const unauthenticatedHandler = createBuilderHandoffStatusRouteHandler({
      pageData: async () => {},
    });
    expect(
      await unauthenticatedHandler(new Request(`${authority.audience}/unused`), handoffId),
    ).toHaveProperty("status", 401);
  });

  it("returns only an owner-scoped pending handoff ID for builder resume", async () => {
    const service = createBuilderHandoffService({ now: () => new Date(), store: memoryStore() });
    await expect(service.findLatestPending({ authority })).resolves.toEqual(prepared);
  });

  it("does not expose pending handoffs without an authenticated authority", async () => {
    const service = createBuilderHandoffService({ now: () => new Date(), store: memoryStore() });
    await expect(service.findLatestPending({ authority })).resolves.toEqual(prepared);
  });

  it.each(["other-owner", "other-workspace", "missing", "invalid-id"])(
    "hides %s rows with the same generic 404",
    async (scenario) => {
      let id: string = handoffId;
      let row = prepared;
      if (scenario === "other-owner") {
        row = { ...prepared, authority: { ...authority, ownerUserId: "user-two" } };
      } else if (scenario === "other-workspace") {
        row = { ...prepared, authority: { ...authority, workspaceId: "workspace-two" } };
      } else if (scenario === "missing") {
        id = "123e4567-e89b-42d3-a456-426614174099";
      } else if (scenario === "invalid-id") {
        id = "invalid";
      }
      const response = await pageData(memoryStore([row]))(
        new Request(`${authority.audience}/unused`),
        id,
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: "handoff_unavailable" });
    },
  );

  it("reads expired records and exposes a bound session as continued without its engine ID", async () => {
    vi.setSystemTime(new Date("2026-09-09T12:00:00Z"));
    expect(await pageData()(new Request(`${authority.audience}/unused`), handoffId)).toMatchObject({
      status: "expired",
    });
    const continued = {
      ...prepared,
      redeemedAt: new Date("2026-09-02T12:00:00Z"),
      sessionId: "private-engine-id",
    };
    const response = await pageData(memoryStore([continued]))(
      new Request(`${authority.audience}/unused`),
      handoffId,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const data = z.object({ status: z.string() }).parse(await response.json());
    expect(data.status).toBe("continued");
    expect(JSON.stringify(data)).not.toMatch(/sessionId|private-engine-id|redeemedAt/u);
  });

  it("reports Cursor destination separately from registration readiness", async () => {
    const cursorRecord = {
      ...prepared,
      intent: { ...prepared.intent, destination: "cursor" as const },
    };
    expect(
      await pageData(memoryStore([cursorRecord]))(
        new Request(`${authority.audience}/unused`),
        handoffId,
      ),
    ).toMatchObject({
      cursorInstallReady: false,
      destination: "cursor",
    });
  });
});
