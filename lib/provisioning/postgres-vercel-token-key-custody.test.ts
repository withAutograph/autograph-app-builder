/* oxlint-disable eslint/require-await, typescript/no-unsafe-type-assertion, unicorn/no-thenable -- Query doubles implement the asynchronous database chain exercised by the adapter. */
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createPostgresVercelTokenKeyCustodyStore } from "./postgres-vercel-token-key-custody";
import {
  custodyActorDigest,
  custodyPlanDigest,
  custodyPlanSchema,
  custodyRecordSchema,
} from "./vercel-token-key-custody";
import type { CanonicalSourceActor, CustodyRecord } from "./vercel-token-key-custody";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const now = new Date("2026-10-10T12:00:00Z");
const operationRef = "11111111-1111-4111-8111-111111111111";
const leaseId = "22222222-2222-4222-8222-222222222222";
const recordFor = (actor: CanonicalSourceActor = authority, operation = operationRef) => {
  const plan = custodyPlanSchema.parse({
    action: "transfer-active-vercel-token-key-to-operator-preview",
    actorAuthorityDigest: custodyActorDigest(actor),
    approvalExpiresAt: "2026-10-10T13:00:00Z",
    destination: {
      environment: "preview",
      gitBranch: null,
      key: "VERCEL_INTEGRATION_TOKEN_KEY",
      projectId: "operator",
      requiredVersion: "v1",
      teamId: "team",
      type: "sensitive",
      versionKey: "VERCEL_INTEGRATION_TOKEN_KEY_VERSION",
      write: "create-only",
    },
    installationId: "installation",
    operationRef: operation,
    ownerSessionId: "session",
    source: {
      deploymentId: "source",
      environment: "production",
      key: "VERCEL_INTEGRATION_TOKEN_KEY",
      keyVersion: "v1",
      projectId: "builder",
      teamId: "team",
      versionKey: "VERCEL_INTEGRATION_TOKEN_KEY_VERSION",
    },
    version: 1,
  });
  return custodyRecordSchema.parse({
    approvalRef: "approval",
    fenceGeneration: 0,
    grantDigest: "a".repeat(64),
    grantRef: "grant",
    kind: "vercel-token-key-custody-v1",
    originalActor: actor,
    phase: "reserved",
    plan,
    planDigest: custodyPlanDigest(plan),
    version: 1,
  });
};
const rawRow = (record: CustodyRecord, revision = 1) => ({
  ...record.originalActor,
  createdAt: now,
  record,
  requestDigest: record.planDigest,
  requestId: record.plan.operationRef,
  revision,
  state: record.phase === "possession-verified" ? "settled" : "pending",
  updatedAt: now,
});
const fixture = (rows = [rawRow(recordFor())]) => {
  const queries: SQL[] = [];
  let updateCount = 0;
  let insertCount = 0;
  let values: ReturnType<typeof rawRow> | undefined;
  const chain = {
    from: () => chain,
    limit: async () => rows,
    onConflictDoNothing: () => chain,
    returning: async () => (values === undefined ? [] : [values]),
    set: (input: Partial<ReturnType<typeof rawRow>>) => {
      values = { ...rows[0], ...input };
      return chain;
    },
    then: (resolve: (result: typeof rows) => void) => {
      resolve(rows);
    },
    values: (input: ReturnType<typeof rawRow>) => {
      values = input;
      return chain;
    },
    where: (query: SQL) => {
      queries.push(query);
      return chain;
    },
  };
  const database = {
    insert: () => {
      insertCount += 1;
      return chain;
    },
    select: () => chain,
    update: () => {
      updateCount += 1;
      return chain;
    },
  };
  // SAFETY: The query double implements each chain method used by the adapter.
  const store = createPostgresVercelTokenKeyCustodyStore(database as never);
  return { counts: () => ({ insertCount, updateCount }), queries, store };
};

describe("Postgres key custody journal", () => {
  it("requires exact kind and captured tenant on ordinary reads", async () => {
    const { queries, store } = fixture();
    await store.read({ authority, operationRef });
    const query = new PgDialect().sqlToQuery(queries[0]);
    expect(query.sql).toContain("->> 'kind' =");
    expect(query.params).toEqual([
      authority.issuer,
      authority.audience,
      authority.workspaceId,
      authority.ownerUserId,
      operationRef,
      "vercel-token-key-custody-v1",
    ]);
  });
  it("finds foreign actor slot claims with fixed scope and both key names", async () => {
    const foreign = recordFor(
      { ...authority, ownerUserId: "other" },
      "33333333-3333-4333-8333-333333333333",
    );
    const { queries, store } = fixture([rawRow(foreign)]);
    expect(await store.findSlotClaims({ plan: recordFor().plan })).toHaveLength(1);
    const query = new PgDialect().sqlToQuery(queries[0]);
    expect(query.params).toEqual(["vercel-token-key-custody-v1", "team", "operator"]);
    expect(query.sql).toContain("'null'::jsonb");
    expect(query.sql).toContain("VERCEL_INTEGRATION_TOKEN_KEY_VERSION");
    expect(query.sql).not.toContain('"owner_user_id"');
  });
  it("refuses reservation over a foreign slot claim before inserting", async () => {
    const { counts, store } = fixture([
      rawRow(recordFor({ ...authority, workspaceId: "foreign" })),
    ]);
    await expect(store.reserve({ authority, now, record: recordFor() })).rejects.toThrow(
      "requires reconciliation",
    );
    expect(counts().insertCount).toBe(0);
  });
  it("claims a fence using revision CAS and preserves it across attempted checkpoint commits", async () => {
    const initial = recordFor();
    const leased = {
      ...initial,
      fenceGeneration: 1,
      leaseExpiresAt: "2026-10-10T12:00:30Z",
      leaseId,
    };
    const first = fixture([rawRow(initial)]);
    const claimed = await first.store.compareAndSet({
      authority,
      expectedRevision: 1,
      now,
      operationRef,
      record: leased,
    });
    expect(claimed?.revision).toBe(2);
    const second = fixture([rawRow(leased, 2)]);
    const attempted = { ...leased, attemptedAt: now.toISOString(), phase: "attempted" as const };
    const result = await second.store.compareAndSet({
      authority,
      expectedRevision: 2,
      now,
      operationRef,
      record: attempted,
    });
    expect(result?.revision).toBe(3);
    expect(result?.record.fenceGeneration).toBe(1);
    const query = new PgDialect().sqlToQuery(second.queries[1]);
    expect(query.params.at(-1)).toBe(2);
    expect(query.params).toContain(authority.ownerUserId);
  });
  it("does not advance stale revisions or reset a durable attempted phase", async () => {
    const attempted = {
      ...recordFor(),
      attemptedAt: now.toISOString(),
      phase: "attempted" as const,
    };
    const { counts, store } = fixture([rawRow(attempted, 4)]);
    expect(
      await store.compareAndSet({
        authority,
        expectedRevision: 3,
        now,
        operationRef,
        record: attempted,
      }),
    ).toBeUndefined();
    await expect(
      store.compareAndSet({
        authority,
        expectedRevision: 4,
        now,
        operationRef,
        record: recordFor(),
      }),
    ).rejects.toThrow("unavailable");
    expect(counts().updateCount).toBe(0);
  });
  it("denies a new fence while the old lease remains live", async () => {
    const leased = {
      ...recordFor(),
      fenceGeneration: 1,
      leaseExpiresAt: "2026-10-10T12:00:30Z",
      leaseId,
    };
    const { store } = fixture([rawRow(leased)]);
    await expect(
      store.compareAndSet({
        authority,
        expectedRevision: 1,
        now,
        operationRef,
        record: { ...leased, fenceGeneration: 2, leaseId: "33333333-3333-4333-8333-333333333333" },
      }),
    ).rejects.toThrow("unavailable");
  });
  it("reserves an initial same-table metadata row with a bare digest", async () => {
    const { counts, store } = fixture([]);
    const record = recordFor();
    const row = await store.reserve({ authority, now, record });
    expect(row).toEqual({ record, revision: 1 });
    expect(counts().insertCount).toBe(1);
  });
  it("consumes a persisted nonce once and preserves the terminal receipt", async () => {
    const pending = custodyRecordSchema.parse({
      ...recordFor(),
      attemptedAt: now.toISOString(),
      fenceGeneration: 1,
      leaseExpiresAt: "2026-10-10T12:00:30Z",
      leaseId,
      nonce: "a".repeat(43),
      nonceExpiresAt: "2026-10-10T12:01:00Z",
      phase: "possession-pending",
      receivingDeploymentId: "recipient",
      secret: {
        gitBranch: null,
        id: "secret-row",
        key: "VERCEL_INTEGRATION_TOKEN_KEY",
        projectId: "operator",
        target: ["preview"],
        teamId: "team",
        type: "sensitive",
      },
    });
    const verified = custodyRecordSchema.parse({
      ...pending,
      nonceConsumedAt: now.toISOString(),
      phase: "possession-verified",
      receipt: {
        approvalRef: pending.approvalRef,
        grantDigest: pending.grantDigest,
        keyVersion: "v1",
        operationRef,
        planDigest: pending.planDigest,
        possession: "verified",
        providerRowId: "secret-row",
        receivingDeploymentId: "recipient",
        verifiedAt: now.toISOString(),
      },
    });
    const { store } = fixture([rawRow(pending, 6)]);
    const saved = await store.compareAndSet({
      authority,
      expectedRevision: 6,
      now,
      operationRef,
      record: verified,
    });
    expect(saved?.record.nonceConsumedAt).toBe(now.toISOString());
    expect(saved?.revision).toBe(7);
    const terminal = fixture([rawRow(verified, 7)]);
    await expect(
      terminal.store.compareAndSet({
        authority,
        expectedRevision: 7,
        now,
        operationRef,
        record: { ...verified, nonceConsumedAt: "2026-10-10T12:00:01Z" },
      }),
    ).rejects.toThrow("unavailable");
  });
});
