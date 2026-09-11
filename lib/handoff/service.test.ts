import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  builderHandoffIntentSchema,
  builderHandoffRequestDigest,
} from "./contracts";
import type { BuilderHandoffRecord } from "./contracts";
import {
  BuilderHandoffConflictError,
  BuilderHandoffUnavailableError,
  createBuilderHandoffService,
} from "./service";
import type { BuilderHandoffStore } from "./service";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "user-one",
  workspaceId: "workspace-one",
};

function memoryStore(): BuilderHandoffStore {
  const byId = new Map<string, BuilderHandoffRecord>();
  const byRequest = new Map<string, BuilderHandoffRecord>();
  const readOwned = (input: {
    authority: BuilderHandoffRecord["authority"];
    handoffId: string;
  }) => {
    const record = byId.get(input.handoffId);
    return record &&
      JSON.stringify(record.authority) === JSON.stringify(input.authority)
      ? record
      : undefined;
  };
  return {
    async bindSession(input) {
      const record = readOwned(input);
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
        updated
      );
      return updated;
    },
    async read(input) {
      return readOwned(input);
    },
    async renewExpired(input) {
      const record = readOwned(input);
      if (!record || record.requestDigest !== input.requestDigest)
        return undefined;
      if (record.sessionId !== undefined || record.expiresAt > input.now)
        return { disposition: "existing", record };
      const updated = { ...record, expiresAt: input.expiresAt };
      byId.set(record.handoffId, updated);
      byRequest.set(
        JSON.stringify([record.authority, record.creationRequestId]),
        updated
      );
      return { disposition: "renewed", record: updated };
    },
    async reserve(record) {
      const key = JSON.stringify([record.authority, record.creationRequestId]);
      const existing = byRequest.get(key);
      if (existing) return { disposition: "existing", record: existing };
      byId.set(record.handoffId, record);
      byRequest.set(key, record);
      return { disposition: "created", record };
    },
  };
}

const intent = {
  appId: "vendor-onboarding",
  appName: "Vendor Onboarding",
  brief: "Help operations review new vendors.",
  connections: ["Ramp"],
  modelId: "openai/gpt-5.6-terra" as const,
  repository: {
    private: true,
    requestedName: "vendor-onboarding",
    resolvedFullName: "withAutograph/vendor-onboarding",
  },
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
      })
    ).not.toBe(legacy);
  });

  it("allows owner status after expiry while still rejecting a new start", async () => {
    let time = new Date("2026-09-01T12:00:00Z");
    const service = createBuilderHandoffService({
      lifetimeMs: 60_000,
      now: () => time,
      store: memoryStore(),
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
      BuilderHandoffUnavailableError
    );
    for (const foreign of [
      { ...authority, ownerUserId: "user-two" },
      { ...authority, workspaceId: "workspace-two" },
    ]) {
      await expect(
        service.read({ ...lookup, authority: foreign })
      ).rejects.toBeInstanceOf(BuilderHandoffUnavailableError);
      await expect(
        service.renew({
          ...lookup,
          authority: foreign,
          creationRequestId: randomUUID(),
        })
      ).rejects.toBeInstanceOf(BuilderHandoffUnavailableError);
    }
  });

  it("renews the same start identity across concurrent tabs, lost replies, and service restart", async () => {
    let time = new Date("2026-09-01T12:00:00Z");
    const store = memoryStore();
    const options = { lifetimeMs: 60_000, now: () => time, store };
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
      creationRequestId: randomUUID(),
      handoffId: original.handoffId,
    };
    const originalRecord = await service.read(request);
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
      renewed.filter((value) => value.disposition === "renewed")
    ).toHaveLength(1);
    expect(renewed[0].handoffId).toBe(original.handoffId);
    const extended = await service.read({
      authority,
      handoffId: renewed[0].handoffId,
    });
    expect(extended).toEqual({
      ...originalRecord,
      expiresAt: renewed[0].expiresAt,
    });
    expect(extended.intent).toEqual(prepared);
    expect(extended.expiresAt.getTime()).toBe(
      original.expiresAt.getTime() + 60_000
    );
    expect(
      await createBuilderHandoffService(options).renew(request)
    ).toMatchObject({
      disposition: "existing",
      handoffId: original.handoffId,
    });
    time = extended.expiresAt;
    const next = await service.renew(request);
    expect(next.handoffId).toBe(original.handoffId);
    expect(next.expiresAt.getTime()).toBe(
      extended.expiresAt.getTime() + 60_000
    );
    expect(await service.read(request)).toEqual({
      ...originalRecord,
      expiresAt: next.expiresAt,
    });
  });

  it("recovers the same durable start when its bind was lost across expiry", async () => {
    let time = new Date("2026-09-01T12:00:00Z");
    const store = memoryStore();
    const options = { lifetimeMs: 60_000, now: () => time, store };
    const service = createBuilderHandoffService(options);
    const created = await service.create({
      authority,
      creationRequestId: randomUUID(),
      intent,
    });
    const lookup = { authority, handoffId: created.handoffId };
    time = new Date(created.expiresAt.getTime() - 1);
    const before = await service.resolve(lookup);
    if (before.status !== "unredeemed") {
      throw new Error("unexpected state");
    }
    // Models a durable engine start, deduplicated by the supplied client key.
    const starts = new Map<string, string>();
    const start = (key: string) => {
      if (!starts.has(key)) {
        starts.set(key, randomUUID());
      }
      return starts.get(key)!;
    };
    const sessionId = start(before.deterministicClientRequestId);
    time = created.expiresAt;
    const binding = {
      ...lookup,
      requestDigest: before.record.requestDigest,
      sessionId,
    };
    await expect(service.bindSession(binding)).rejects.toBeInstanceOf(
      BuilderHandoffUnavailableError
    );
    await expect(service.resolve(lookup)).rejects.toBeInstanceOf(
      BuilderHandoffUnavailableError
    );
    await service.renew({ ...lookup, creationRequestId: randomUUID() });
    const restarted = createBuilderHandoffService(options);
    const after = await restarted.resolve(lookup);
    if (after.status !== "unredeemed") {
      throw new Error("unexpected state");
    }
    expect(after.deterministicClientRequestId).toBe(
      before.deterministicClientRequestId
    );
    expect(after.prompt).toBe(before.prompt);
    expect(after.record.handoffId).toBe(before.record.handoffId);
    expect(start(after.deterministicClientRequestId)).toBe(sessionId);
    expect(starts.size).toBe(1);
    await restarted.bindSession(binding);
    expect(await restarted.resolve(lookup)).toMatchObject({
      sessionId,
      status: "redeemed",
    });
    const continued = await restarted.read(lookup);
    time = continued.expiresAt;
    expect(
      await restarted.renew({ ...lookup, creationRequestId: randomUUID() })
    ).toMatchObject({
      disposition: "existing",
      expiresAt: continued.expiresAt,
      handoffId: created.handoffId,
    });
    expect(await restarted.read(lookup)).toEqual(continued);
  });

  it("fails closed on expired renewal when a legacy store has no atomic renewal", async () => {
    let time = new Date("2026-09-01T12:00:00Z");
    const store = memoryStore();
    delete store.renewExpired;
    const service = createBuilderHandoffService({
      lifetimeMs: 60_000,
      now: () => time,
      store,
    });
    const original = await service.create({
      authority,
      creationRequestId: randomUUID(),
      intent,
    });
    const request = {
      authority,
      creationRequestId: randomUUID(),
      handoffId: original.handoffId,
    };
    expect(await service.renew(request)).toMatchObject({
      handoffId: original.handoffId,
    });
    time = original.expiresAt;
    await expect(service.renew(request)).rejects.toBeInstanceOf(
      BuilderHandoffUnavailableError
    );
    expect((await service.read(request)).expiresAt).toEqual(original.expiresAt);
  });

  it.each(["renewed", "existing"] as const)(
    "rejects a %s store result that still leaves the handoff expired",
    async (disposition) => {
      let time = new Date("2026-09-01T12:00:00Z");
      const store = memoryStore();
      const service = createBuilderHandoffService({
        lifetimeMs: 60_000,
        now: () => time,
        store,
      });
      const created = await service.create({
        authority,
        creationRequestId: randomUUID(),
        intent,
      });
      const lookup = { authority, handoffId: created.handoffId };
      const record = await service.read(lookup);
      time = created.expiresAt;
      vi.spyOn(store, "renewExpired").mockResolvedValue({
        disposition,
        record,
      });
      await expect(
        service.renew({ ...lookup, creationRequestId: randomUUID() })
      ).rejects.toBeInstanceOf(BuilderHandoffUnavailableError);
    }
  );

  it.each(["handoffId", "issuer", "audience", "workspaceId", "ownerUserId"])(
    "rejects a store read that substitutes %s",
    async (field) => {
      const store = memoryStore();
      const service = createBuilderHandoffService({ store });
      const created = await service.create({
        authority,
        creationRequestId: randomUUID(),
        intent,
      });
      const lookup = { authority, handoffId: created.handoffId };
      const record = await service.read(lookup);
      const forged =
        field === "handoffId"
          ? { ...record, handoffId: randomUUID() }
          : {
              ...record,
              authority: {
                ...authority,
                [field]:
                  field === "issuer"
                    ? "https://builder.example:443/api/auth"
                    : field === "audience"
                      ? "https://builder.example:443/mcp"
                      : "other",
              },
            };
      vi.spyOn(store, "read").mockResolvedValue(forged);
      for (const read of [service.read, service.status, service.resolve]) {
        await expect(read(lookup)).rejects.toBeInstanceOf(
          BuilderHandoffUnavailableError
        );
      }
      await expect(
        service.renew({ ...lookup, creationRequestId: randomUUID() })
      ).rejects.toBeInstanceOf(BuilderHandoffUnavailableError);
    }
  );

  it("rejects substituted reserve, renewal, and bind results", async () => {
    let time = new Date("2026-09-01T12:00:00Z");
    const store = memoryStore();
    const service = createBuilderHandoffService({
      lifetimeMs: 60_000,
      now: () => time,
      store,
    });
    const creation = { authority, creationRequestId: randomUUID(), intent };
    const created = await service.create(creation);
    const lookup = { authority, handoffId: created.handoffId };
    const record = await service.read(lookup);
    const forged = {
      ...record,
      authority: { ...authority, ownerUserId: "other" },
    };
    vi.spyOn(store, "reserve").mockResolvedValue({
      disposition: "existing",
      record: forged,
    });
    await expect(service.create(creation)).rejects.toBeInstanceOf(
      BuilderHandoffUnavailableError
    );
    time = record.expiresAt;
    vi.spyOn(store, "renewExpired").mockResolvedValue({
      disposition: "renewed",
      record: forged,
    });
    await expect(
      service.renew({ ...lookup, creationRequestId: randomUUID() })
    ).rejects.toBeInstanceOf(BuilderHandoffUnavailableError);
    vi.spyOn(store, "bindSession").mockResolvedValue({
      ...forged,
      redeemedAt: record.createdAt,
      sessionId: "session-one",
    });
    await expect(
      service.bindSession({
        ...lookup,
        requestDigest: record.requestDigest,
        sessionId: "session-one",
      })
    ).rejects.toBeInstanceOf(BuilderHandoffUnavailableError);
    vi.mocked(store.bindSession).mockResolvedValue({
      ...record,
      redeemedAt: record.createdAt,
      requestDigest: "b".repeat(64),
      sessionId: "session-one",
    });
    await expect(
      service.bindSession({
        ...lookup,
        requestDigest: record.requestDigest,
        sessionId: "session-one",
      })
    ).rejects.toBeInstanceOf(BuilderHandoffConflictError);
  });

  it("does not fork live or continued handoffs even after the continued handoff expires", async () => {
    let time = new Date("2026-09-01T12:00:00Z");
    const service = createBuilderHandoffService({
      lifetimeMs: 60_000,
      now: () => time,
      store: memoryStore(),
    });
    const created = await service.create({
      authority,
      creationRequestId: randomUUID(),
      intent,
    });
    const lookup = { authority, handoffId: created.handoffId };
    const renewal = { ...lookup, creationRequestId: randomUUID() };
    expect(await service.renew(renewal)).toMatchObject({
      disposition: "existing",
      handoffId: created.handoffId,
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
      sessionId: "private-engine-session",
      status: "redeemed",
    });
    expect(await service.renew(renewal)).toMatchObject({
      disposition: "existing",
      handoffId: created.handoffId,
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
    if (resolved.status === "unredeemed") {
      expect(resolved.prompt.split("\n", 1)[0]).toBe(
        `Create ${intent.appName} with Autograph App Builder.`
      );
      expect(resolved.prompt).toContain(
        "Call prepared_app_context before any provider work"
      );
    }
  });

  it("returns one opaque handoff for an idempotent creation request", async () => {
    const service = createBuilderHandoffService({
      createId: () => "9fd16a55-7818-4e34-93e8-7dd6f3b86d27",
      now: () => new Date("2026-09-01T12:00:00.000Z"),
      store: memoryStore(),
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
      createId: () => "9fd16a55-7818-4e34-93e8-7dd6f3b86d27",
      store: memoryStore(),
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
      })
    ).rejects.toBeInstanceOf(BuilderHandoffConflictError);
  });

  it("binds one session and returns it on a lost-response retry", async () => {
    const now = { value: new Date("2026-09-01T12:00:00.000Z") };
    const service = createBuilderHandoffService({
      createId: () => "9fd16a55-7818-4e34-93e8-7dd6f3b86d27",
      now: () => now.value,
      store: memoryStore(),
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
    if (resolved.status !== "unredeemed") {
      throw new Error("unexpected state");
    }
    expect(resolved.prompt).not.toMatch(
      /installation(?: id)?|repository id|head sha|head tree/iu
    );

    await service.bindSession({
      authority,
      handoffId: created.handoffId,
      requestDigest: resolved.record.requestDigest,
      sessionId: "session-one",
    });
    expect(
      await service.resolve({ authority, handoffId: created.handoffId })
    ).toMatchObject({ sessionId: "session-one", status: "redeemed" });
  });

  it("keeps expired and cross-tenant handoffs indistinguishable", async () => {
    const now = { value: new Date("2026-09-01T12:00:00.000Z") };
    const service = createBuilderHandoffService({
      createId: () => "9fd16a55-7818-4e34-93e8-7dd6f3b86d27",
      lifetimeMs: 60_000,
      now: () => now.value,
      store: memoryStore(),
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
      })
    ).rejects.toBeInstanceOf(BuilderHandoffUnavailableError);
    now.value = new Date("2026-09-01T12:01:00.000Z");
    await expect(
      service.resolve({ authority, handoffId: created.handoffId })
    ).rejects.toBeInstanceOf(BuilderHandoffUnavailableError);
  });
});
