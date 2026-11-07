/* oxlint-disable sonarjs/no-nested-functions -- Terminal Drizzle doubles retain the fluent database contract. */
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { hostedEveOperationScopes } from "./hosted-auth";
import { hostedOperationRecordSchema, InMemoryHostedEveStore } from "./hosted-store";
import type { HostedOperationRecord } from "./hosted-store";
import { createPostgresHostedEveStore } from "./postgres-hosted-store";

const principal = {
  audience: "builder",
  issuer: "https://identity.example.test",
  ownerUserId: "owner",
  scopes: Object.values(hostedEveOperationScopes),
  workspaceId: "workspace",
};
const foreignOwner = { ...principal, ownerUserId: "other-owner" };
const foreignWorkspace = { ...principal, workspaceId: "other-workspace" };
const foreignIssuer = { ...principal, issuer: "https://other.example.test" };
const foreignAudience = { ...principal, audience: "other-audience" };
const operation = (id: string, options: Partial<HostedOperationRecord> = {}) => {
  const candidate = {
    clientRequestId: `request-${id}`,
    createdAtEpochMs: 1000,
    kind: "respond",
    operationId: id,
    principal,
    requestDigest: `sha256:${"a".repeat(64)}`,
    safeErrorCode: "submission_unknown",
    sessionId: "session-1",
    state: "submission_unknown",
    updatedAtEpochMs: 1000,
    version: 1,
    ...options,
  };
  if (candidate.state === "reserved") {
    const { safeErrorCode, ...reserved } = candidate;
    void safeErrorCode;
    return hostedOperationRecordSchema.parse(reserved);
  }
  return hostedOperationRecordSchema.parse(candidate);
};
const examples = [
  operation("a"),
  operation("b"),
  operation("c", { createdAtEpochMs: 2000, updatedAtEpochMs: 2000 }),
  operation("other-session", { sessionId: "session-2" }),
  operation("foreign-owner", { principal: foreignOwner }),
  operation("foreign-workspace", { principal: foreignWorkspace }),
  operation("foreign-issuer", { principal: foreignIssuer }),
  operation("foreign-audience", { principal: foreignAudience }),
  operation("other-kind", { kind: "send" }),
  operation("reserved", { state: "reserved" }),
  operation("rejected", { safeErrorCode: "rejected", state: "rejected" }),
];
const asRow = (record: HostedOperationRecord) => ({
  audience: record.principal.audience,
  clientRequestId: record.clientRequestId,
  createdAt: new Date(record.createdAtEpochMs),
  issuer: record.principal.issuer,
  kind: record.kind,
  operationId: record.operationId,
  ownerUserId: record.principal.ownerUserId,
  record,
  requestDigest: record.requestDigest,
  sendCancellationRevisionAtDispatch: null,
  sessionId: record.sessionId ?? null,
  state: record.state,
  updatedAt: new Date(record.updatedAtEpochMs),
  workspaceId: record.principal.workspaceId,
});
const postgresFixture = () => {
  const dialect = new PgDialect();
  const rows = examples.map(asRow);
  const fields = {
    audience: "audience",
    issuer: "issuer",
    kind: "kind",
    operation_id: "operationId",
    owner_user_id: "ownerUserId",
    session_id: "sessionId",
    state: "state",
    workspace_id: "workspaceId",
  } satisfies Record<string, keyof ReturnType<typeof asRow>>;
  const select = () => ({
    from: () => ({
      where: (predicate: SQL) => {
        const { sql, params } = dialect.sqlToQuery(predicate);
        const equalities = [...sql.matchAll(/"(?<column>[a-z_]+)" = \$(?<parameter>\d+)/gu)];
        const afterDate = /"created_at" > \$(?<parameter>\d+)/u.exec(sql);
        const afterId = /"operation_id" > \$(?<parameter>\d+)/u.exec(sql);
        const matching = rows
          .filter((row) => {
            for (const match of equalities) {
              const key = Object.entries(fields).find(
                ([column]) => column === match.groups?.column,
              )?.[1];
              if (key !== undefined && row[key] !== params[Number(match.groups?.parameter) - 1]) {
                return false;
              }
            }
            if (afterDate) {
              const date = new Date(
                String(params[Number(afterDate.groups?.parameter) - 1]),
              ).getTime();
              const id = String(params[Number(afterId?.groups?.parameter) - 1]);
              if (
                row.createdAt.getTime() < date ||
                (row.createdAt.getTime() === date && row.operationId <= id)
              ) {
                return false;
              }
            }
            return true;
          })
          .toSorted(
            (a, b) =>
              a.createdAt.getTime() - b.createdAt.getTime() ||
              a.operationId.localeCompare(b.operationId),
          );
        return {
          orderBy: () => ({
            limit: async (limit: number) => matching.slice(0, limit),
          }),
        };
      },
    }),
  });
  // SAFETY: This read-only double evaluates the generated tenant and cursor predicates and never mutates a database.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- Only the terminal SELECT path is exercised.
  const database = { select } as unknown as Parameters<typeof createPostgresHostedEveStore>[0];
  return createPostgresHostedEveStore(database);
};
const memoryFixture = async () => {
  const store = new InMemoryHostedEveStore();
  for (const item of examples) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each fixture reservation is observed before the next.
    await store.reserveOperation(item.principal, item);
  }
  return store;
};

describe.each([
  ["memory", memoryFixture],
  ["Postgres query", async () => postgresFixture()],
] as const)("unsettled RESPOND lookup: %s", (_label, build) => {
  it("scopes by exact tenant, owner and session and paginates deterministically with equal timestamps", async () => {
    const store = await build();
    if (!store.readUnsettledResponseOperations) {
      throw new Error("missing response reader");
    }
    const reader = store.readUnsettledResponseOperations.bind(store);
    const read = async (cursor?: { createdAtEpochMs: number; operationId: string }) =>
      await reader({
        limit: 1,
        principal,
        sessionId: "session-1",
        ...(cursor ? { cursor } : {}),
      });
    const first = await read();
    const second = await read(first.nextCursor);
    const third = await read(second.nextCursor);
    expect([
      first.operations[0]?.operationId,
      second.operations[0]?.operationId,
      third.operations[0]?.operationId,
    ]).toEqual(["a", "b", "c"]);
    expect(third.nextCursor).toBeUndefined();
    const other = await store.readUnsettledResponseOperations({
      limit: 5,
      principal: foreignOwner,
      sessionId: "session-1",
    });
    expect(other.operations.map((item) => item.operationId)).toEqual(["foreign-owner"]);
    const session = await store.readUnsettledResponseOperations({
      limit: 5,
      principal,
      sessionId: "session-2",
    });
    expect(session.operations.map((item) => item.operationId)).toEqual(["other-session"]);
  });
  it("rejects empty session, nonpositive limit and invalid cursor", async () => {
    const store = await build();
    if (!store.readUnsettledResponseOperations) {
      throw new Error("missing response reader");
    }
    await expect(
      store.readUnsettledResponseOperations({ limit: 1, principal, sessionId: "" }),
    ).rejects.toThrow();
    await expect(
      store.readUnsettledResponseOperations({ limit: 0, principal, sessionId: "session-1" }),
    ).rejects.toThrow();
    await expect(
      store.readUnsettledResponseOperations({
        cursor: { createdAtEpochMs: -1, operationId: "a" },
        limit: 1,
        principal,
        sessionId: "session-1",
      }),
    ).rejects.toThrow();
  });
});
