/* oxlint-disable sonarjs/no-nested-functions -- Terminal Drizzle doubles retain the fluent database contract. */
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { hostedEveOperationScopes } from "./hosted-auth";
import { hostedOperationRecordSchema, InMemoryHostedEveStore } from "./hosted-store";
import type { HostedOperationRecord } from "./hosted-store";
import { createPostgresHostedEveStore } from "./postgres-hosted-store";

const principal = {
  issuer: "https://identity.example.test",
  audience: "builder",
  workspaceId: "workspace",
  ownerUserId: "owner",
  scopes: Object.values(hostedEveOperationScopes),
};
const foreignOwner = { ...principal, ownerUserId: "other-owner" };
const foreignWorkspace = { ...principal, workspaceId: "other-workspace" };
const foreignIssuer = { ...principal, issuer: "https://other.example.test" };
const foreignAudience = { ...principal, audience: "other-audience" };
const operation = (id: string, options: Partial<HostedOperationRecord> = {}) => {
  const candidate = {
    version: 1,
    principal,
    kind: "respond",
    state: "submission_unknown",
    safeErrorCode: "submission_unknown",
    operationId: id,
    clientRequestId: `request-${id}`,
    requestDigest: `sha256:${"a".repeat(64)}`,
    sessionId: "session-1",
    createdAtEpochMs: 1000,
    updatedAtEpochMs: 1000,
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
  operation("rejected", { state: "rejected", safeErrorCode: "rejected" }),
];
const asRow = (record: HostedOperationRecord) => ({
  issuer: record.principal.issuer,
  audience: record.principal.audience,
  workspaceId: record.principal.workspaceId,
  ownerUserId: record.principal.ownerUserId,
  operationId: record.operationId,
  clientRequestId: record.clientRequestId,
  sessionId: record.sessionId ?? null,
  kind: record.kind,
  state: record.state,
  requestDigest: record.requestDigest,
  record,
  createdAt: new Date(record.createdAtEpochMs),
  updatedAt: new Date(record.updatedAtEpochMs),
  sendCancellationRevisionAtDispatch: null,
});
const postgresFixture = () => {
  const dialect = new PgDialect();
  const rows = examples.map(asRow);
  const fields = {
    issuer: "issuer",
    audience: "audience",
    workspace_id: "workspaceId",
    owner_user_id: "ownerUserId",
    session_id: "sessionId",
    kind: "kind",
    state: "state",
    operation_id: "operationId",
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
          orderBy: () => ({ limit: (limit: number) => Promise.resolve(matching.slice(0, limit)) }),
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
  ["Postgres query", () => Promise.resolve(postgresFixture())],
] as const)("unsettled RESPOND lookup: %s", (_label, build) => {
  it("scopes by exact tenant, owner and session and paginates deterministically with equal timestamps", async () => {
    const store = await build();
    if (!store.readUnsettledResponseOperations) {
      throw new Error("missing response reader");
    }
    const reader = store.readUnsettledResponseOperations.bind(store);
    const read = (cursor?: { createdAtEpochMs: number; operationId: string }) =>
      reader({
        principal,
        sessionId: "session-1",
        limit: 1,
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
      principal: foreignOwner,
      sessionId: "session-1",
      limit: 5,
    });
    expect(other.operations.map((item) => item.operationId)).toEqual(["foreign-owner"]);
    const session = await store.readUnsettledResponseOperations({
      principal,
      sessionId: "session-2",
      limit: 5,
    });
    expect(session.operations.map((item) => item.operationId)).toEqual(["other-session"]);
  });
  it("rejects empty session, nonpositive limit and invalid cursor", async () => {
    const store = await build();
    if (!store.readUnsettledResponseOperations) {
      throw new Error("missing response reader");
    }
    await expect(
      store.readUnsettledResponseOperations({ principal, sessionId: "", limit: 1 }),
    ).rejects.toThrow();
    await expect(
      store.readUnsettledResponseOperations({ principal, sessionId: "session-1", limit: 0 }),
    ).rejects.toThrow();
    await expect(
      store.readUnsettledResponseOperations({
        principal,
        sessionId: "session-1",
        limit: 1,
        cursor: { createdAtEpochMs: -1, operationId: "a" },
      }),
    ).rejects.toThrow();
  });
});
