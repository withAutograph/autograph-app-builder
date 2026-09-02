import { describe, expect, it } from "vitest";

import { type BuilderHandoffRecord } from "./contracts";
import {
  BuilderHandoffConflictError,
  BuilderHandoffUnavailableError,
  createBuilderHandoffService,
  type BuilderHandoffStore,
} from "./service";

const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace-one",
  ownerUserId: "user-one",
};

function memoryStore(): BuilderHandoffStore {
  const byId = new Map<string, BuilderHandoffRecord>();
  const byRequest = new Map<string, BuilderHandoffRecord>();
  const read: BuilderHandoffStore["read"] = async (input) => {
    const record = byId.get(input.handoffId);
    return record &&
      JSON.stringify(record.authority) === JSON.stringify(input.authority)
      ? record
      : undefined;
  };
  return {
    async reserve(record) {
      const key = JSON.stringify([record.authority, record.creationRequestId]);
      const existing = byRequest.get(key);
      if (existing) return { disposition: "existing", record: existing };
      byId.set(record.handoffId, record);
      byRequest.set(key, record);
      return { disposition: "created", record };
    },
    read,
    async bindSession(input) {
      const record = await read(input);
      if (
        !record ||
        record.requestDigest !== input.requestDigest ||
        input.now >= record.expiresAt
      )
        return undefined;
      if (record.sessionId !== undefined) return record;
      const updated = {
        ...record,
        redeemedAt: input.now,
        sessionId: input.sessionId,
      };
      byId.set(record.handoffId, updated);
      byRequest.set(
        JSON.stringify([record.authority, record.creationRequestId]),
        updated,
      );
      return updated;
    },
  };
}

const intent = {
  appName: "Vendor Onboarding",
  appId: "vendor-onboarding",
  brief: "Help operations review new vendors.",
  repository: {
    requestedName: "vendor-onboarding",
    private: true,
    resolvedFullName: "withAutograph/vendor-onboarding",
  },
  modelId: "openai/gpt-5.6-sol",
  connections: ["Ramp"],
};

describe("opaque App Builder handoffs", () => {
  it("returns one opaque handoff for an idempotent creation request", async () => {
    const service = createBuilderHandoffService({
      store: memoryStore(),
      now: () => new Date("2026-09-01T12:00:00.000Z"),
      createId: () => "9fd16a55-7818-4e34-93e8-7dd6f3b86d27",
    });
    const request = {
      authority,
      creationRequestId: "751cc095-54dc-4ac9-b5fe-066d077fc9c8",
      intent,
    };
    const first = await service.create(request);
    const retry = await service.create(request);

    expect(first.handoffId).toBe(retry.handoffId);
    expect(first.disposition).toBe("created");
    expect(retry.disposition).toBe("existing");
  });

  it("rejects request-id reuse for different product intent", async () => {
    const service = createBuilderHandoffService({
      store: memoryStore(),
      createId: () => "9fd16a55-7818-4e34-93e8-7dd6f3b86d27",
    });
    const request = {
      authority,
      creationRequestId: "751cc095-54dc-4ac9-b5fe-066d077fc9c8",
      intent,
    };
    await service.create(request);
    await expect(
      service.create({
        ...request,
        intent: { ...intent, brief: "A different product brief." },
      }),
    ).rejects.toBeInstanceOf(BuilderHandoffConflictError);
  });

  it("binds one session and returns it on a lost-response retry", async () => {
    const now = { value: new Date("2026-09-01T12:00:00.000Z") };
    const service = createBuilderHandoffService({
      store: memoryStore(),
      now: () => now.value,
      createId: () => "9fd16a55-7818-4e34-93e8-7dd6f3b86d27",
    });
    const created = await service.create({
      authority,
      creationRequestId: "751cc095-54dc-4ac9-b5fe-066d077fc9c8",
      intent,
    });
    const resolved = await service.resolve({
      authority,
      handoffId: created.handoffId,
    });
    expect(resolved.status).toBe("unredeemed");
    if (resolved.status !== "unredeemed") throw new Error("unexpected state");
    expect(resolved.prompt).not.toMatch(
      /installation(?: id)?|repository id|head sha|head tree/iu,
    );

    await service.bindSession({
      authority,
      handoffId: created.handoffId,
      requestDigest: resolved.record.requestDigest,
      sessionId: "session-one",
    });
    expect(
      await service.resolve({ authority, handoffId: created.handoffId }),
    ).toMatchObject({ status: "redeemed", sessionId: "session-one" });
  });

  it("keeps expired and cross-tenant handoffs indistinguishable", async () => {
    const now = { value: new Date("2026-09-01T12:00:00.000Z") };
    const service = createBuilderHandoffService({
      store: memoryStore(),
      now: () => now.value,
      createId: () => "9fd16a55-7818-4e34-93e8-7dd6f3b86d27",
      lifetimeMs: 60_000,
    });
    const created = await service.create({
      authority,
      creationRequestId: "751cc095-54dc-4ac9-b5fe-066d077fc9c8",
      intent,
    });
    await expect(
      service.resolve({
        authority: { ...authority, workspaceId: "workspace-two" },
        handoffId: created.handoffId,
      }),
    ).rejects.toBeInstanceOf(BuilderHandoffUnavailableError);
    now.value = new Date("2026-09-01T12:01:00.000Z");
    await expect(
      service.resolve({ authority, handoffId: created.handoffId }),
    ).rejects.toBeInstanceOf(BuilderHandoffUnavailableError);
  });
});
