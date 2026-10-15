import { getTableName } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { hostedEveOperationScopes } from "./hosted-auth";
import type { PublicEveEvent } from "../mcp/contracts";

import {
  createPostgresHostedCheckpointHistory,
  encodeCheckpointJson,
} from "./postgres-hosted-checkpoint-history";

describe("paged checkpoint encoding", () => {
  it("encodes more than 100,000 event items without retaining encoded bodies", async () => {
    let itemCount = 0;
    let largestFragment = 0;
    for (let index = 0; index < 100_001; index += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each event is encoded and released before the next.
      for await (const fragment of encodeCheckpointJson({
        index,
        status: "working",
        type: "status",
      })) {
        largestFragment = Math.max(largestFragment, fragment.byteLength);
      }
      itemCount += 1;
    }
    expect(itemCount).toBe(100_001);
    expect(largestFragment).toBeLessThan(64 * 1024);
  });

  it("streams a large Unicode item into bounded fragments without changing JSON", async () => {
    const value = {
      description: "🧭\n\u0000\t".repeat(30_000),
      options: [{ id: "one", label: "A".repeat(100_000) }],
    };
    const fragments: Uint8Array[] = [];
    for await (const fragment of encodeCheckpointJson(value)) {
      expect(fragment.byteLength).toBeLessThan(64 * 1024);
      fragments.push(fragment);
    }
    expect(fragments.length).toBeGreaterThan(10);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(fragments));
    expect(JSON.parse(decoded)).toEqual(value);
    expect(decoded).toBe(JSON.stringify(value));
  });
});

type FixtureRow = Record<string, string | number | Date | null>;
type Database = Parameters<typeof createPostgresHostedCheckpointHistory>[0];
const principal = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner-one",
  scopes: Object.values(hostedEveOperationScopes),
  workspaceId: "workspace-one",
};
const metadata = { capturedAtEpochMs: 1000, status: "working", version: 1 };
const sessionId = "session-one";
const eventAt = (index: number, text = `Event ${index}`): PublicEveEvent => ({
  index,
  text,
  turnId: "turn-one",
  type: "assistant_message",
});
const eventStream = async function* eventStream(events: PublicEveEvent[]) {
  yield* events;
};

/** Run the real serializer, query predicates and publication verifier against a terminal transport. */
const columnName = (name: string) =>
  name.replaceAll(/_(?<letter>[a-z])/gu, (_, letter: string) => letter.toUpperCase());

/* oxlint-disable eslint/require-await, sonarjs/no-nested-functions -- The terminal fixture mirrors asynchronous query chains while sharing isolated row state. */
const historyFixture = () => {
  const rows = new Map<string, FixtureRow[]>([
    ["agent_session", [{ ...principal, scopes: "", sessionId }]],
  ]);
  const calls: { kind: string; table: string; rowCount: number }[] = [];
  let failTable: string | undefined;
  const dialect = new PgDialect();
  const matches = (row: FixtureRow, predicate: SQL) => {
    const query = dialect.sqlToQuery(predicate);
    for (const column of [
      "issuer",
      "audience",
      "workspace_id",
      "owner_user_id",
      "session_id",
      "checkpoint_id",
    ]) {
      const equality = new RegExp(`"${column}" = \\$(?<parameter>\\d+)`, "u").exec(query.sql);
      if (
        equality !== null &&
        row[columnName(column)] !== query.params[Number(equality.groups?.parameter) - 1]
      ) {
        return false;
      }
    }
    const inIndexes = /"item_index" in \((?<indexes>[^)]+)\)/u.exec(query.sql);
    if (inIndexes !== null) {
      const indexes = [...(inIndexes.groups?.indexes ?? "").matchAll(/\$(?<parameter>\d+)/gu)].map(
        (match) => query.params[Number(match.groups?.parameter) - 1],
      );
      if (!indexes.includes(row.itemIndex)) {
        return false;
      }
    }
    const afterIndex = /"item_index" > \$(?<parameter>\d+)/u.exec(query.sql);
    if (afterIndex !== null) {
      const after = Number(query.params[Number(afterIndex.groups?.parameter) - 1]);
      const afterPart = /"part_index" > \$(?<parameter>\d+)/u.exec(query.sql);
      if (afterPart !== null) {
        if (
          !(
            Number(row.itemIndex) > after ||
            (row.itemIndex === after &&
              Number(row.partIndex) > Number(query.params[Number(afterPart.groups?.parameter) - 1]))
          )
        ) {
          return false;
        }
      } else if (Number(row.itemIndex) <= after) {
        return false;
      }
    }
    return !query.sql.includes('"published_at" is null') || row.publishedAt === null;
  };
  const select = (selection?: { chunkCount?: SQL }) => ({
    from: (table: Parameters<typeof getTableName>[0]) => {
      const name = getTableName(table);
      let predicate: SQL;
      let maximum = Number.POSITIVE_INFINITY;
      const query = {
        where: (condition: SQL) => {
          predicate = condition;
          return query;
        },
        orderBy: () => query,
        limit: (limit: number) => {
          maximum = limit;
          return query;
        },
        // oxlint-disable-next-line unicorn/no-thenable -- Drizzle query builders are awaitable as well as chainable.
        then: <Result>(resolve: (value: FixtureRow[]) => Result) => {
          const selected = (rows.get(name) ?? [])
            .filter((row) => matches(row, predicate))
            .toSorted(
              (a, b) =>
                Number(a.itemIndex) - Number(b.itemIndex) ||
                Number(a.partIndex) - Number(b.partIndex),
            );
          const result =
            selection !== undefined && "chunkCount" in selection
              ? [{ chunkCount: selected.length }]
              : selected.slice(0, maximum);
          calls.push({ kind: "select", rowCount: result.length, table: name });
          // oxlint-disable-next-line github/no-then -- Implement the query builder thenable boundary.
          return Promise.resolve(result).then(resolve);
        },
      };
      return query;
    },
  });
  const fake = {
    select,
    insert: (table: Parameters<typeof getTableName>[0]) => ({
      values: async (input: FixtureRow | FixtureRow[]) => {
        const name = getTableName(table);
        if (name === failTable) {
          failTable = undefined;
          throw new Error("Injected database write failure.");
        }
        const values = (Array.isArray(input) ? input : [input]).map((row) => ({
          ...row,
          ...(name === "agent_session_checkpoint_manifest" ? { publishedAt: null } : {}),
        }));
        calls.push({ kind: "insert", rowCount: values.length, table: name });
        rows.set(name, [...(rows.get(name) ?? []), ...values]);
      },
    }),
    update: (table: Parameters<typeof getTableName>[0]) => ({
      set: (values: FixtureRow) => ({
        where: (predicate: SQL) => {
          const name = getTableName(table);
          const selected = (rows.get(name) ?? []).filter((row) => matches(row, predicate));
          for (const row of selected) {
            Object.assign(row, values);
          }
          calls.push({ kind: "update", rowCount: selected.length, table: name });
          return Object.assign(Promise.resolve(selected), { returning: async () => selected });
        },
      }),
    }),
    delete: (table: Parameters<typeof getTableName>[0]) => ({
      where: (predicate: SQL) => {
        const name = getTableName(table);
        const selected = (rows.get(name) ?? []).filter((row) => matches(row, predicate));
        rows.set(
          name,
          (rows.get(name) ?? []).filter((row) => !selected.includes(row)),
        );
        if (name === "agent_session_checkpoint_manifest") {
          for (const child of ["agent_session_checkpoint_item", "agent_session_checkpoint_chunk"]) {
            rows.set(
              child,
              (rows.get(child) ?? []).filter(
                (row) =>
                  !selected.some((manifest) =>
                    [
                      "issuer",
                      "audience",
                      "workspaceId",
                      "ownerUserId",
                      "sessionId",
                      "checkpointId",
                    ].every((key) => row[key] === manifest[key]),
                  ),
              ),
            );
          }
        }
        return Object.assign(Promise.resolve(selected), { returning: async () => selected });
      },
    }),
  };
  // SAFETY: This terminal fixture implements all query chains exercised by the real history reader and publisher.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- Deliberate database transport boundary.
  const database = fake as unknown as Database;
  const history = createPostgresHostedCheckpointHistory(database);
  const stage = async (events: PublicEveEvent[]) =>
    await history.stage({
      events: eventStream(events),
      metadata,
      nowEpochMs: 1000,
      principal,
      sessionId,
    });
  const publish = async (staged: Awaited<ReturnType<typeof stage>>) =>
    await history.publishInTransaction(
      // SAFETY: Publication uses the same SELECT/UPDATE chains implemented by this fixture; no transaction lifecycle is exercised.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- Deliberate transaction transport boundary.
      database as unknown as Parameters<typeof history.publishInTransaction>[0],
      { ...staged, nowEpochMs: 2000, principal, sessionId },
    );
  const read = async (checkpointId: string, cursor = 0, limit = 250) =>
    await history.readPage({ checkpointId, cursor, limit, principal, sessionId });
  return {
    calls,
    database,
    failNextInsert: (table: string) => {
      failTable = table;
    },
    history,
    publish,
    read,
    rows,
    stage,
  };
};

/* oxlint-enable eslint/require-await, sonarjs/no-nested-functions */

describe("batched checkpoint persistence", () => {
  it("round trips multiple pages with bounded database calls and retains published history", async () => {
    const fixture = historyFixture();
    const events = Array.from({ length: 520 }, (_, index) => eventAt(index));
    const staged = await fixture.stage(events);
    expect(await fixture.read(staged.checkpointId)).toBeNull();
    const writeCalls = fixture.calls.filter((call) => call.kind !== "select");
    expect(writeCalls.length).toBeLessThan(40);
    await fixture.publish(staged);
    const start = fixture.calls.length;
    const observed: PublicEveEvent[] = [];
    let cursor = 0;
    while (cursor < events.length) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Follow the durable public page cursor.
      const page = await fixture.read(staged.checkpointId, cursor);
      expect(page?.metadata).toEqual(metadata);
      expect(page?.totalEvents).toBe(events.length);
      expect(page?.checkpointDigest).toBe(staged.checkpointDigest);
      observed.push(...(page?.events ?? []));
      cursor = page?.cursor ?? events.length;
    }
    expect(observed).toEqual(events);
    expect(fixture.calls.length - start).toBeLessThan(30);
    expect(
      await fixture.history.discardStage({
        checkpointId: staged.checkpointId,
        principal,
        sessionId,
      }),
    ).toBe(false);
    await expect(fixture.publish(staged)).rejects.toThrow("already published");
    const next = await fixture.stage([eventAt(0, "New checkpoint")]);
    await fixture.publish(next);
    const retainedPage = await fixture.read(staged.checkpointId);
    expect(retainedPage?.events).toEqual(events.slice(0, 250));
  });

  it("verifies an item spanning chunk pages without truncating following events", async () => {
    const fixture = historyFixture();
    const events = [eventAt(0, "🧭".repeat(64 * 1024 * 65)), eventAt(1, "After the large item")];
    const staged = await fixture.stage(events);
    await fixture.publish(staged);
    const page = await fixture.read(staged.checkpointId);
    expect(page?.events).toEqual(events);
    const chunks = fixture.rows.get("agent_session_checkpoint_chunk") ?? [];
    expect(chunks.filter((chunk) => chunk.itemIndex === 0).length).toBeGreaterThan(256);
  });

  it.each([
    "issuer",
    "audience",
    "workspaceId",
    "ownerUserId",
    "sessionId",
    "checkpointId",
  ] as const)("keeps batched reads isolated by %s", async (field) => {
    const fixture = historyFixture();
    const staged = await fixture.stage([eventAt(0), eventAt(1)]);
    await fixture.publish(staged);
    const input = {
      checkpointId: staged.checkpointId,
      cursor: 0,
      limit: 250,
      principal,
      sessionId,
    };
    const foreignInput =
      field === "sessionId" || field === "checkpointId"
        ? { ...input, [field]: "other" }
        : { ...input, principal: { ...principal, [field]: `${principal[field]}/other` } };
    expect(await fixture.history.readPage(foreignInput)).toBeNull();
    // Foreign rows with the same item positions must not join an owned checkpoint page.
    for (const table of ["agent_session_checkpoint_item", "agent_session_checkpoint_chunk"]) {
      const original = fixture.rows.get(table) ?? [];
      fixture.rows.set(table, [
        ...original.map((row) => ({ ...row, [field]: `${String(row[field])}/other` })),
        ...original,
      ]);
    }
    const page = await fixture.read(staged.checkpointId);
    expect(page?.events).toEqual([eventAt(0), eventAt(1)]);
  });

  it.each([
    "missing-item",
    "missing-chunk",
    "part-order",
    "chunk-digest",
    "item-digest",
    "byte-length",
    "event-index",
  ] as const)("rejects %s corruption in a multi-event page", async (kind) => {
    const fixture = historyFixture();
    const staged = await fixture.stage([eventAt(0), eventAt(1)]);
    await fixture.publish(staged);
    const items = fixture.rows.get("agent_session_checkpoint_item") ?? [];
    const chunks = fixture.rows.get("agent_session_checkpoint_chunk") ?? [];
    const targetItem = items.find((item) => item.itemIndex === 1);
    const targetChunk = chunks.find((chunk) => chunk.itemIndex === 1);
    const sourceItem = items.find((item) => item.itemIndex === 0);
    const sourceChunk = chunks.find((chunk) => chunk.itemIndex === 0);
    if (
      targetItem === undefined ||
      targetChunk === undefined ||
      sourceItem === undefined ||
      sourceChunk === undefined
    ) {
      throw new Error("Expected both persisted fixture events.");
    }
    if (kind === "missing-item") {
      fixture.rows.set(
        "agent_session_checkpoint_item",
        items.filter((item) => item.itemIndex !== 1),
      );
    } else if (kind === "missing-chunk") {
      fixture.rows.set(
        "agent_session_checkpoint_chunk",
        chunks.filter((chunk) => chunk.itemIndex !== 1),
      );
    } else if (kind === "part-order") {
      targetChunk.partIndex = 2;
    } else if (kind === "chunk-digest") {
      targetChunk.payload = "Y29ycnVwdA==";
    } else if (kind === "item-digest") {
      targetItem.digest = `sha256:${"0".repeat(64)}`;
    } else if (kind === "byte-length") {
      targetItem.byteLength = 1;
    } else {
      Object.assign(targetItem, { byteLength: sourceItem.byteLength, digest: sourceItem.digest });
      Object.assign(targetChunk, {
        chunkDigest: sourceChunk.chunkDigest,
        payload: sourceChunk.payload,
      });
    }
    await expect(fixture.read(staged.checkpointId)).rejects.toThrow(/checkpoint/iu);
  });

  it("cleans partially flushed rows after a database failure and preserves published history", async () => {
    const fixture = historyFixture();
    const retained = await fixture.stage([eventAt(0, "Retained")]);
    await fixture.publish(retained);
    fixture.failNextInsert("agent_session_checkpoint_item");
    await expect(
      fixture.stage(Array.from({ length: 600 }, (_, index) => eventAt(index))),
    ).rejects.toThrow("Injected database");
    for (const table of [
      "agent_session_checkpoint_manifest",
      "agent_session_checkpoint_item",
      "agent_session_checkpoint_chunk",
    ]) {
      expect(
        (fixture.rows.get(table) ?? []).every((row) => row.checkpointId === retained.checkpointId),
      ).toBe(true);
    }
    const page = await fixture.read(retained.checkpointId);
    expect(page?.events).toEqual([eventAt(0, "Retained")]);
  });

  it("cleans a previously flushed batch when the event stream aborts", async () => {
    const fixture = historyFixture();
    const abortedEvents = async function* abortedEvents() {
      for (let index = 0; index < 300; index += 1) {
        yield eventAt(index);
      }
      throw new Error("Event stream aborted.");
    };
    await expect(
      fixture.history.stage({
        events: abortedEvents(),
        metadata,
        nowEpochMs: 1000,
        principal,
        sessionId,
      }),
    ).rejects.toThrow("aborted");
    for (const table of [
      "agent_session_checkpoint_manifest",
      "agent_session_checkpoint_item",
      "agent_session_checkpoint_chunk",
    ]) {
      expect(fixture.rows.get(table)).toEqual([]);
    }
  });
});
