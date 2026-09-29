import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { hostedEveOperationScopes } from "./hosted-auth";
import {
  hostedOperationRecordSchema,
  hostedSessionCreationDigest,
  succeededStartAlias,
} from "./hosted-store";
import type { HostedOperationRecord } from "./hosted-store";
import { createPostgresHostedEveStore } from "./postgres-hosted-store";

const principal = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner-one",
  scopes: Object.values(hostedEveOperationScopes),
  workspaceId: "workspace-one",
};
const session = {
  adapterSessionId: "adapter-one",
  createdAtEpochMs: 1000,
  principal,
  sessionId: "session-one",
  status: "waiting" as const,
  updatedAtEpochMs: 1000,
  version: 1 as const,
};
const operation = hostedOperationRecordSchema.parse({
  clientRequestId: "canonical",
  createdAtEpochMs: 1000,
  kind: "start",
  operationId: "canonical-operation",
  principal,
  requestDigest: `sha256:${"a".repeat(64)}`,
  result: { cursor: 0, events: [], sessionId: session.sessionId, status: "waiting" },
  sessionId: session.sessionId,
  sessionRecordDigest: hostedSessionCreationDigest(session),
  state: "succeeded",
  updatedAtEpochMs: 1000,
  version: 1,
});
const operationRow = (record: HostedOperationRecord) => ({
  audience: record.principal.audience,
  clientRequestId: record.clientRequestId,
  createdAt: new Date(record.createdAtEpochMs),
  issuer: record.principal.issuer,
  kind: record.kind,
  operationId: record.operationId,
  ownerUserId: record.principal.ownerUserId,
  record,
  requestDigest: record.requestDigest,
  sessionId: record.sessionId ?? null,
  state: record.state,
  updatedAt: new Date(record.updatedAtEpochMs),
  workspaceId: record.principal.workspaceId,
});
const sessionRow = {
  adapterGeneration: null,
  adapterSessionId: session.adapterSessionId,
  audience: principal.audience,
  checkpointDigest: null,
  checkpointId: null,
  checkpointProgressDigest: null,
  createdAt: new Date(1000),
  issuer: principal.issuer,
  lastProgressAt: null,
  ownerUserId: principal.ownerUserId,
  parentSessionId: null,
  record: session,
  resumabilityState: null,
  sessionId: session.sessionId,
  stage: null,
  title: null,
  updatedAt: new Date(1000),
  workspaceId: principal.workspaceId,
};
const alias = hostedOperationRecordSchema.parse({
  clientRequestId: "original",
  createdAtEpochMs: 1000,
  kind: "start",
  operationId: "original-operation",
  principal,
  requestDigest: `sha256:${"b".repeat(64)}`,
  startAlias: {
    canonicalClientRequestId: "canonical",
    sourceHandoffId: "123e4567-e89b-42d3-a456-426614174001",
  },
  state: "reserved",
  updatedAtEpochMs: 1000,
  version: 1,
});

type Database = Parameters<typeof createPostgresHostedEveStore>[0];
type OperationRow = ReturnType<typeof operationRow>;
type QueryRow = OperationRow | typeof sessionRow;

const databaseFixture = (input: {
  reads: QueryRow[][];
  inserted?: OperationRow[];
  updated?: OperationRow[];
}) => {
  const reads = [...input.reads];
  const predicates: ReturnType<PgDialect["sqlToQuery"]>[] = [];
  const lock = vi.fn();
  const values = vi.fn<(row: OperationRow) => void>();
  const set = vi.fn<(row: OperationRow) => void>();
  // oxlint-disable-next-line eslint/require-await -- Query return values retain the asynchronous Drizzle interface.
  const insertedRows = async () => input.inserted ?? [];
  // oxlint-disable-next-line eslint/require-await -- Query return values retain the asynchronous Drizzle interface.
  const updatedRows = async () => input.updated ?? [];
  const readWhere = (condition: SQL) => {
    predicates.push(new PgDialect().sqlToQuery(condition));
    const rows = reads.shift() ?? [];
    // Drizzle's limit is both awaitable and lockable; async would remove its .for method.
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the lockable Drizzle query shape.
    const limit = () =>
      Object.assign(Promise.resolve(rows), {
        // oxlint-disable-next-line eslint/require-await -- Query return values retain the asynchronous Drizzle interface.
        for: async (mode: string) => {
          lock(mode);
          return rows;
        },
      });
    return { limit };
  };
  const updateWhere = (condition: SQL) => {
    predicates.push(new PgDialect().sqlToQuery(condition));
    return { returning: updatedRows };
  };
  const setValues = (row: OperationRow) => {
    set(row);
    return { where: updateWhere };
  };
  const insertValues = (row: OperationRow) => {
    values(row);
    return { onConflictDoNothing: () => ({ returning: insertedRows }) };
  };
  const fake = {
    insert: () => ({ values: insertValues }),
    select: () => ({ from: () => ({ where: readWhere }) }),
    transaction: async <Result>(run: (transaction: Database) => Promise<Result>) =>
      // oxlint-disable-next-line eslint/no-use-before-define -- The transaction callback executes after the fixture database is initialized.
      await run(database),
    update: () => ({ set: setValues }),
  };
  // SAFETY: This fixture supplies only the Drizzle chains exercised below; production parsers validate every returned record.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- A deliberately partial SQL transport fixture, not runtime input.
  const database = fake as unknown as Database;
  return {
    lock,
    predicates,
    set,
    store: createPostgresHostedEveStore(database),
    values,
  };
};

const authorityValues = [
  principal.issuer,
  principal.audience,
  principal.workspaceId,
  principal.ownerUserId,
];

describe("PostgreSQL original start recovery queries", () => {
  it("reads only the original caller key and falls back to an adapter resume receipt without writes", async () => {
    if (operation.state !== "succeeded") {
      throw new Error("The resume fixture requires a succeeded operation receipt.");
    }
    const { sessionRecordDigest, ...resumeBase } = operation;
    void sessionRecordDigest;
    const resume = hostedOperationRecordSchema.parse({ ...resumeBase, kind: "resume" });
    const test = databaseFixture({ reads: [[], [operationRow(resume)]] });
    await expect(test.store.getStartOperation?.(principal, "canonical")).resolves.toEqual(resume);
    expect(test.predicates.map((query) => query.params)).toEqual([
      [...authorityValues, "start", "canonical"],
      [...authorityValues, "resume", "canonical"],
    ]);
    expect(test.values).not.toHaveBeenCalled();
    expect(test.set).not.toHaveBeenCalled();
  });

  it("settles an original alias under its exact caller and immutable request digest", async () => {
    const settled = succeededStartAlias(alias, operation);
    const test = databaseFixture({
      reads: [[operationRow(alias)], [operationRow(operation)]],
      updated: [operationRow(settled)],
    });
    await test.store.settleStartAlias?.({
      canonicalClientRequestId: "canonical",
      clientRequestId: "original",
      principal,
    });
    expect(test.predicates.map((query) => query.params)).toEqual([
      [...authorityValues, "start", "original"],
      [...authorityValues, "start", "canonical"],
      [...authorityValues, alias.operationId, alias.requestDigest],
    ]);
    expect(test.set).toHaveBeenCalledExactlyOnceWith(operationRow(settled));
    expect(test.values).not.toHaveBeenCalled();
  });

  it("rejects canonical authority substitution before writing an alias", async () => {
    const foreign = { ...operation, principal: { ...principal, ownerUserId: "another-owner" } };
    const test = databaseFixture({ reads: [[operationRow(alias)], [operationRow(foreign)]] });
    await expect(
      test.store.settleStartAlias?.({
        canonicalClientRequestId: "canonical",
        clientRequestId: "original",
        principal,
      }),
    ).rejects.toThrow("cannot bind");
    expect(test.set).not.toHaveBeenCalled();
  });

  it("locks and verifies the existing session before saving a healthy resume receipt", async () => {
    const test = databaseFixture({ inserted: [operationRow(operation)], reads: [[sessionRow]] });
    await expect(test.store.bindExistingStart?.(principal, operation)).resolves.toEqual(operation);
    expect(test.lock).toHaveBeenCalledExactlyOnceWith("update");
    expect(test.predicates[0]?.params).toEqual([...authorityValues, session.sessionId]);
    expect(test.values).toHaveBeenCalledExactlyOnceWith(operationRow(operation));
  });

  it("rejects an existing-session creation proof mismatch before inserting its receipt", async () => {
    const test = databaseFixture({
      reads: [
        [
          {
            ...sessionRow,
            createdAt: new Date(999),
            record: { ...session, createdAtEpochMs: 999 },
          },
        ],
      ],
    });
    await expect(test.store.bindExistingStart?.(principal, operation)).rejects.toThrow(
      "does not bind",
    );
    expect(test.values).not.toHaveBeenCalled();
  });
  it("recognizes an exact successful start retry after the journal acquired its session ID", async () => {
    const candidate = hostedOperationRecordSchema.parse({
      clientRequestId: operation.clientRequestId,
      createdAtEpochMs: 1000,
      kind: "start",
      operationId: operation.operationId,
      principal,
      requestDigest: operation.requestDigest,
      state: "reserved",
      updatedAtEpochMs: 1000,
      version: 1,
    });
    const test = databaseFixture({ reads: [[operationRow(operation)]] });
    await expect(test.store.reserveOperation(principal, candidate)).resolves.toEqual({
      disposition: "existing",
      operation,
    });
    expect(test.values).not.toHaveBeenCalled();
  });
});
