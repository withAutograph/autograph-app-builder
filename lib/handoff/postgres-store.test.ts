import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import type { builderHandoffs } from "../db/schema";
import { createPostgresBuilderHandoffStore } from "./postgres-store";

const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace-one",
  ownerUserId: "user-one",
};
const row = {
  ...authority,
  handoffId: "123e4567-e89b-42d3-a456-426614174001",
  creationRequestId: "123e4567-e89b-42d3-a456-426614174002",
  requestDigest: "a".repeat(64),
  intent: {
    appName: "Vendor Review",
    appId: "vendor-review",
    brief: "Review new vendors.",
    repository: { requestedName: "vendor-review", private: true },
    modelId: "openai/gpt-5.6-terra",
    connections: [],
  },
  createdAt: new Date("2026-09-01T12:00:00Z"),
  expiresAt: new Date("2026-09-01T12:01:00Z"),
  redeemedAt: null,
  sessionId: null,
} satisfies typeof builderHandoffs.$inferSelect;
const renewal = {
  authority,
  handoffId: row.handoffId,
  requestDigest: row.requestDigest,
  now: row.expiresAt,
  expiresAt: new Date("2026-09-01T12:02:00Z"),
};

function store(input: {
  updated?: (typeof builderHandoffs.$inferSelect)[];
  current?: (typeof builderHandoffs.$inferSelect)[];
}) {
  const set = vi.fn();
  const updateWhere = vi.fn();
  const readWhere = vi.fn();
  const select = vi.fn(() => ({
    from: () => ({
      where: (condition: SQL) => {
        readWhere(new PgDialect().sqlToQuery(condition));
        return { limit: async () => input.current ?? [] };
      },
    }),
  }));
  const database = {
    update: () => ({
      set: (values: unknown) => {
        set(values);
        return {
          where: (condition: SQL) => {
            updateWhere(new PgDialect().sqlToQuery(condition));
            return { returning: async () => input.updated ?? [] };
          },
        };
      },
    }),
    select,
  } as unknown as Parameters<typeof createPostgresBuilderHandoffStore>[0];
  return {
    handoffs: createPostgresBuilderHandoffStore(database),
    set,
    updateWhere,
    readWhere,
    select,
  };
}

describe("PostgreSQL handoff renewal", () => {
  it("only extends expiry under an owner-bound expired-and-unbound CAS", async () => {
    const test = store({ updated: [{ ...row, expiresAt: renewal.expiresAt }] });
    const result = await test.handoffs.renewExpired!(renewal);
    expect(result).toMatchObject({
      disposition: "renewed",
      record: {
        handoffId: row.handoffId,
        creationRequestId: row.creationRequestId,
        requestDigest: row.requestDigest,
        expiresAt: renewal.expiresAt,
      },
    });
    expect(test.set).toHaveBeenCalledExactlyOnceWith({
      expiresAt: renewal.expiresAt,
    });
    const [[query]] = test.updateWhere.mock.calls;
    for (const column of [
      "issuer",
      "audience",
      "workspace_id",
      "owner_user_id",
      "handoff_id",
      "request_digest",
    ])
      expect(query.sql).toContain(`"builder_handoff"."${column}" =`);
    expect(query.sql).not.toContain('"builder_handoff"."expires_at" =');
    expect(query.sql).toContain('"builder_handoff"."expires_at" <=');
    expect(query.sql).toContain('"builder_handoff"."redeemed_at" is null');
    expect(query.sql).toContain('"builder_handoff"."session_id" is null');
    expect(query.params).toEqual([
      authority.issuer,
      authority.audience,
      authority.workspaceId,
      authority.ownerUserId,
      row.handoffId,
      row.requestDigest,
      renewal.now.toISOString(),
    ]);
    expect(test.select).not.toHaveBeenCalled();
  });

  it("does not compare PostgreSQL microseconds against a rounded Date readback", async () => {
    const databaseExpiry = "2026-09-01T12:01:00.000789Z";
    const readback = new Date(databaseExpiry);
    expect(readback.toISOString()).toBe("2026-09-01T12:01:00.000Z");
    const test = store({ updated: [{ ...row, expiresAt: renewal.expiresAt }] });
    const timestamp = new Date("2026-09-01T12:01:00.001Z");
    expect(await test.handoffs.renewExpired!({ ...renewal, now: timestamp })).toMatchObject({
      disposition: "renewed",
    });
    const [[query]] = test.updateWhere.mock.calls;
    // The SQL must compare expiry only against current time, not the lossy
    // readback. The stored .000789 timestamp is already before .001000.
    expect(query.sql.match(/"expires_at"/gu)).toHaveLength(1);
    expect(query.sql).toContain('"expires_at" <=');
    expect(query.params).toContain(timestamp.toISOString());
    expect(query.params).not.toContain(readback.toISOString());
  });

  it("fails closed when a missed update reads back an expired unbound row", async () => {
    expect(await store({ current: [row] }).handoffs.renewExpired!(renewal)).toBeUndefined();
    // A previously bound session remains recoverable even after expiry.
    expect(
      await store({
        current: [{ ...row, redeemedAt: row.createdAt, sessionId: "session-one" }],
      }).handoffs.renewExpired!(renewal),
    ).toMatchObject({
      disposition: "existing",
      record: { sessionId: "session-one" },
    });
  });

  it.each([false, true])(
    "returns the winner when a concurrent renewal or bind wins (bound=%s)",
    async (bound) => {
      const current = {
        ...row,
        expiresAt: renewal.expiresAt,
        ...(bound ? { redeemedAt: row.createdAt, sessionId: "existing-session" } : {}),
      };
      const test = store({ current: [current] });
      expect(await test.handoffs.renewExpired!(renewal)).toMatchObject({
        disposition: "existing",
        record: {
          handoffId: row.handoffId,
          expiresAt: current.expiresAt,
          ...(bound ? { sessionId: "existing-session" } : {}),
        },
      });
      expect(test.readWhere.mock.calls[0][0].params).toEqual([
        authority.issuer,
        authority.audience,
        authority.workspaceId,
        authority.ownerUserId,
        row.handoffId,
      ]);
    },
  );

  it("does not treat a missing row or mismatched digest as renewal success", async () => {
    expect(await store({}).handoffs.renewExpired!(renewal)).toBeUndefined();
    expect(
      await store({ current: [{ ...row, requestDigest: "b".repeat(64) }] }).handoffs.renewExpired!(
        renewal,
      ),
    ).toBeUndefined();
  });

  it("still rejects an unbound start at expiry instead of weakening initial authorization", async () => {
    const test = store({ current: [row] });
    expect(
      await test.handoffs.bindSession({
        authority,
        handoffId: row.handoffId,
        requestDigest: row.requestDigest,
        sessionId: "session-one",
        now: row.expiresAt,
      }),
    ).toBeUndefined();
    expect(test.updateWhere.mock.calls[0][0].sql).toContain('"builder_handoff"."expires_at" >');
    expect(test.updateWhere.mock.calls[0][0].params).toContain(row.expiresAt.toISOString());
  });
});
