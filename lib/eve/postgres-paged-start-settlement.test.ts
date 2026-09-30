import { getTableName } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";

import type {
  agentSessions,
  agentSessionCheckpointManifests,
  agentSessionCheckpointItems,
  agentSessionCheckpointChunks,
} from "../db/schema";
import { hostedEveOperationScopes } from "./hosted-auth";
import { hostedOperationRecordSchema } from "./hosted-store";
import { createPostgresHostedEveStore } from "./postgres-hosted-store";

it("generates a paged start checkpoint-pointer update scoped only to its session tenant", async () => {
  const principal = {
    audience: "https://builder.example/mcp",
    issuer: "https://builder.example/api/auth",
    ownerUserId: "owner-one",
    scopes: Object.values(hostedEveOperationScopes),
    workspaceId: "workspace-one",
  };
  const operation = hostedOperationRecordSchema.parse({
    clientRequestId: "original",
    createdAtEpochMs: 1000,
    kind: "start",
    operationId: "original-operation",
    principal,
    requestDigest: `sha256:${"c".repeat(64)}`,
    state: "reserved",
    updatedAtEpochMs: 1000,
    version: 1,
  });
  const operationRow = {
    audience: principal.audience,
    clientRequestId: operation.clientRequestId,
    createdAt: new Date(1000),
    issuer: principal.issuer,
    kind: operation.kind,
    operationId: operation.operationId,
    ownerUserId: principal.ownerUserId,
    record: operation,
    requestDigest: operation.requestDigest,
    sessionId: null,
    state: operation.state,
    updatedAt: new Date(1000),
    workspaceId: principal.workspaceId,
  };
  type Database = Parameters<typeof createPostgresHostedEveStore>[0];
  const updates: { table: string; query: ReturnType<PgDialect["sqlToQuery"]> }[] = [];
  const stopAfterPointer = new Error("Captured session checkpoint pointer update.");
  type SessionRow =
    | typeof agentSessions.$inferInsert
    | typeof agentSessionCheckpointManifests.$inferInsert
    | typeof agentSessionCheckpointItems.$inferInsert
    | typeof agentSessionCheckpointChunks.$inferInsert;
  let insertedSession: SessionRow | undefined;
  const insertValues = (table: string, row: SessionRow) => {
    if (table === "agent_session") {
      insertedSession = row;
    }
    // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous Drizzle interface.
    return { returning: async () => [row] };
  };
  // oxlint-disable-next-line typescript/promise-function-async -- Preserve the lockable query promise.
  const readRows = (table: string) => {
    const rows = table === "agent_operation" ? [operationRow] : [insertedSession];
    // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous Drizzle interface.
    return Object.assign(Promise.resolve(rows), { for: async () => rows });
  };
  const writeWhere = (table: string, condition: SQL) => {
    updates.push({ query: new PgDialect().sqlToQuery(condition), table });
    if (table === "agent_session") {
      throw stopAfterPointer;
    }
    return [];
  };
  const fake = {
    insert: (table: Parameters<typeof getTableName>[0]) => ({
      values: (row: SessionRow) => insertValues(getTableName(table), row),
    }),
    select: () => ({
      from: (table: Parameters<typeof getTableName>[0]) => ({
        where: () => ({
          // oxlint-disable-next-line typescript/promise-function-async -- Preserve the lockable query promise.
          limit: () => readRows(getTableName(table)),
        }),
      }),
    }),
    transaction: async <Result>(run: (transaction: Database) => Promise<Result>) =>
      // oxlint-disable-next-line eslint/no-use-before-define -- The callback executes after initialization.
      await run(database),
    update: (table: Parameters<typeof getTableName>[0]) => ({
      set: () => ({ where: (condition: SQL) => writeWhere(getTableName(table), condition) }),
    }),
  };
  // SAFETY: The partial fixture implements only the exercised Drizzle chains;
  // the real session parser and checkpoint serializer still run before the
  // checkpoint-pointer query is captured; no module implementation is replaced.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- Deliberate SQL transport fixture.
  const database = fake as unknown as Database;
  const store = createPostgresHostedEveStore(database);
  const result = { cursor: 0, events: [], sessionId: "session-one", status: "waiting" as const };
  const settlement = store.settleSucceededPaged?.({
    events: {
      [Symbol.asyncIterator]: () => ({
        // oxlint-disable-next-line eslint/require-await -- The event source exposes the asynchronous iterator contract.
        next: async () => ({ done: true, value: null }),
      }),
    },
    metadata: { capturedAtEpochMs: 1000, status: "waiting", version: 1 },
    nowEpochMs: 1000,
    operationId: operation.operationId,
    principal,
    requestDigest: operation.requestDigest,
    result,
    session: {
      adapterGeneration: 1,
      adapterSessionId: "adapter-one",
      createdAtEpochMs: 1000,
      lastProgressAtEpochMs: 1000,
      originAdapterSessionId: "adapter-one",
      principal,
      resumability: "live",
      sessionId: result.sessionId,
      stage: "designing",
      status: "waiting",
      title: "Spend Review repair",
      updatedAtEpochMs: 1000,
      version: 2,
    },
  });
  await expect(settlement).rejects.toBe(stopAfterPointer);
  const sessionUpdate = updates.find((update) => update.table === "agent_session");
  expect(sessionUpdate?.query.sql).toBe(
    '(("agent_session"."issuer" = $1 and "agent_session"."audience" = $2 and "agent_session"."workspace_id" = $3 and "agent_session"."owner_user_id" = $4) and "agent_session"."session_id" = $5)',
  );
  expect(sessionUpdate?.query.params).toEqual([
    principal.issuer,
    principal.audience,
    principal.workspaceId,
    principal.ownerUserId,
    result.sessionId,
  ]);
  expect(sessionUpdate?.query.sql).not.toContain("agent_operation");
});
