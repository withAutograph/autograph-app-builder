import { describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import {
  builderHandoffIntentSchema,
  builderHandoffRequestDigest,
  type BuilderHandoffRecord,
} from "./contracts";
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
  modelId: "openai/gpt-5.6-sol" as const,
  connections: ["Ramp"],
};

describe("opaque App Builder handoffs", () => {
  it("keeps legacy intents and digests stable while allowing destination and provider selections", () => {
    expect(builderHandoffIntentSchema.parse(intent)).toEqual(intent);
    const legacy = builderHandoffRequestDigest({
      authority,
      creationRequestId: "751cc095-54dc-4ac9-b5fe-066d077fc9c8",
      intent,
    });
    expect(legacy).toMatch(/^[a-f0-9]{64}$/u);
    const selected = {
      ...intent,
      destination: "cursor" as const,
      providers: {
        githubInstallationId: "123",
        vercelInstallationId: "icfg_selected",
      },
    };
    expect(builderHandoffIntentSchema.parse(selected)).toEqual(selected);
    expect(
      builderHandoffRequestDigest({
        authority,
        creationRequestId: "751cc095-54dc-4ac9-b5fe-066d077fc9c8",
        intent: selected,
      }),
    ).not.toBe(legacy);
  });

  it("allows owner status after expiry while still rejecting a new start", async () => {
    let time = new Date("2026-09-01T12:00:00Z");
    const service = createBuilderHandoffService({
      store: memoryStore(),
      now: () => time,
      lifetimeMs: 60_000,
    });
    const created = await service.create({
      authority,
      creationRequestId: randomUUID(),
      intent,
    });
    const lookup = { authority, handoffId: created.handoffId };
    expect(await service.status(lookup)).toMatchObject({ status: "prepared" });
    time = created.expiresAt;
    expect(await service.read(lookup)).toMatchObject({ intent });
    expect(await service.status(lookup)).toMatchObject({ status: "expired" });
    await expect(service.resolve(lookup)).rejects.toBeInstanceOf(
      BuilderHandoffUnavailableError,
    );
    for (const foreign of [
      { ...authority, ownerUserId: "user-two" },
      { ...authority, workspaceId: "workspace-two" },
    ]) {
      await expect(
        service.read({ ...lookup, authority: foreign }),
      ).rejects.toBeInstanceOf(BuilderHandoffUnavailableError);
      await expect(
        service.renew({
          ...lookup,
          authority: foreign,
          creationRequestId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(BuilderHandoffUnavailableError);
    }
  });

  it("renews an expired generation once across concurrent tabs, lost replies, and service restart", async () => {
    let time = new Date("2026-09-01T12:00:00Z");
    const store = memoryStore();
    const options = { store, now: () => time, lifetimeMs: 60_000 };
    const service = createBuilderHandoffService(options);
    const prepared = {
      ...intent,
      destination: "cursor" as const,
      providers: {
        githubInstallationId: "123",
        vercelInstallationId: "icfg_selected",
      },
    };
    const original = await service.create({
      authority,
      creationRequestId: randomUUID(),
      intent: prepared,
    });
    const request = {
      authority,
      handoffId: original.handoffId,
      creationRequestId: randomUUID(),
    };
    time = original.expiresAt;
    const renewed = await Promise.all([
      service.renew(request),
      service.renew(request),
      createBuilderHandoffService(options).renew({
        ...request,
        creationRequestId: randomUUID(),
      }),
    ]);
    expect(new Set(renewed.map((value) => value.handoffId)).size).toBe(1);
    expect(
      renewed.filter((value) => value.disposition === "created"),
    ).toHaveLength(1);
    expect(renewed[0].handoffId).not.toBe(original.handoffId);
    const successor = await service.read({
      authority,
      handoffId: renewed[0].handoffId,
    });
    expect(successor.intent).toEqual(prepared);
    expect(successor.expiresAt.getTime()).toBe(
      original.expiresAt.getTime() + 60_000,
    );
    expect(
      await createBuilderHandoffService(options).renew(request),
    ).toMatchObject({
      handoffId: successor.handoffId,
      disposition: "existing",
    });
    time = successor.expiresAt;
    // An old retry keeps its original result; renew the successor for the next generation.
    expect(await service.renew(request)).toMatchObject({
      handoffId: successor.handoffId,
    });
    const next = await service.renew({
      ...request,
      handoffId: successor.handoffId,
    });
    expect(next.handoffId).not.toBe(successor.handoffId);
  });

  it("does not fork live or continued handoffs even after the continued handoff expires", async () => {
    let time = new Date("2026-09-01T12:00:00Z");
    const service = createBuilderHandoffService({
      store: memoryStore(),
      now: () => time,
      lifetimeMs: 60_000,
    });
    const created = await service.create({
      authority,
      creationRequestId: randomUUID(),
      intent,
    });
    const lookup = { authority, handoffId: created.handoffId };
    const renewal = { ...lookup, creationRequestId: randomUUID() };
    expect(await service.renew(renewal)).toMatchObject({
      handoffId: created.handoffId,
      disposition: "existing",
    });
    const { requestDigest } = await service.read(lookup);
    await service.bindSession({
      ...lookup,
      requestDigest,
      sessionId: "private-engine-session",
    });
    time = created.expiresAt;
    expect(await service.status(lookup)).toMatchObject({ status: "continued" });
    expect(await service.resolve(lookup)).toMatchObject({
      status: "redeemed",
      sessionId: "private-engine-session",
    });
    expect(await service.renew(renewal)).toMatchObject({
      handoffId: created.handoffId,
      disposition: "existing",
    });
  });

  it("directs the session to load prepared provider context before other work", async () => {
    const service = createBuilderHandoffService({ store: memoryStore() });
    const created = await service.create({
      authority,
      creationRequestId: randomUUID(),
      intent,
    });
    const resolved = await service.resolve({
      authority,
      handoffId: created.handoffId,
    });
    expect(resolved.status).toBe("unredeemed");
    if (resolved.status === "unredeemed")
      expect(resolved.prompt).toMatch(
        /^Call prepared_app_context before any provider work/u,
      );
  });

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
