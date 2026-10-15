import { HostedCheckpointObservationConflictError } from "./hosted-checkpoint-observation-conflict-error";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Spy on only the checkpoint factory terminal boundary.
import * as checkpointHistory from "./postgres-hosted-checkpoint-history";
import { createHash, randomUUID } from "node:crypto";
import { getTableName } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";

import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { toDurableHostedSessionRecord } from "./hosted-store";
import type { HostedCheckpointPage, HostedSessionRecord } from "./hosted-store";
import { hostedEveOperationScopes } from "./hosted-auth";
import type { HostedPrincipal } from "./hosted-auth";
import {
  createPostgresHostedEveStore,
  parseHostedOperationRow,
  parseHostedSessionRow,
} from "./postgres-hosted-store";

const principal: HostedPrincipal = {
  audience: "eve-hosted",
  issuer: "https://identity.example.test",
  ownerUserId: "user_1",
  scopes: Object.values(hostedEveOperationScopes),
  workspaceId: "workspace_1",
};

const operationRecord = {
  clientRequestId: "request_1",
  createdAtEpochMs: 1000,
  kind: "start" as const,
  operationId: "operation_1",
  principal,
  requestDigest: `sha256:${"a".repeat(64)}`,
  state: "reserved" as const,
  updatedAtEpochMs: 1000,
  version: 1 as const,
};

const operationRow = {
  audience: principal.audience,
  clientRequestId: operationRecord.clientRequestId,
  createdAt: new Date(1000),
  issuer: principal.issuer,
  kind: operationRecord.kind,
  operationId: operationRecord.operationId,
  ownerUserId: principal.ownerUserId,
  record: operationRecord,
  requestDigest: operationRecord.requestDigest,
  sessionId: null,
  state: operationRecord.state,
  updatedAt: new Date(1000),
  workspaceId: principal.workspaceId,
};

const sessionRecord = {
  adapterSessionId: "adapter_1",
  createdAtEpochMs: 2000,
  principal,
  sessionId: "session_1",
  status: "waiting" as const,
  updatedAtEpochMs: 2000,
  version: 1 as const,
};

const sessionRow = {
  adapterGeneration: null,
  adapterSessionId: sessionRecord.adapterSessionId,
  audience: principal.audience,
  checkpointDigest: null,
  checkpointId: null,
  checkpointProgressDigest: null,
  createdAt: new Date(2000),
  issuer: principal.issuer,
  lastProgressAt: null,
  ownerUserId: principal.ownerUserId,
  parentSessionId: null,
  record: sessionRecord,
  resumabilityState: null,
  sessionId: sessionRecord.sessionId,
  stage: null,
  title: null,
  updatedAt: new Date(2000),
  workspaceId: principal.workspaceId,
};

describe("PostgreSQL hosted Eve row authority", () => {
  it("accepts only an operation whose indexed authority matches its closed record", () => {
    expect(parseHostedOperationRow(operationRow)).toEqual(operationRecord);
    expect(() => parseHostedOperationRow({ ...operationRow, workspaceId: "workspace_2" })).toThrow(
      "canonically bound",
    );
    expect(() =>
      parseHostedOperationRow({
        ...operationRow,
        record: { ...operationRecord, untrustedRole: "admin" },
      }),
    ).toThrow();
  });

  it("preserves an original handoff alias in the existing start journal and rejects substitution of its caller index", () => {
    const startAlias = {
      canonicalClientRequestId: "canonical-handoff-start",
      sourceHandoffId: "123e4567-e89b-42d3-a456-426614174001",
    };
    const aliasRow = { ...operationRow, record: { ...operationRecord, startAlias } };
    expect(parseHostedOperationRow(aliasRow)).toMatchObject({ startAlias });
    expect(() => parseHostedOperationRow({ ...aliasRow, ownerUserId: "another-owner" })).toThrow(
      "canonically bound",
    );
    expect(() =>
      parseHostedOperationRow({
        ...aliasRow,
        record: {
          ...operationRecord,
          startAlias: { ...startAlias, canonicalClientRequestId: operationRecord.clientRequestId },
        },
      }),
    ).toThrow("distinct canonical");
  });

  it("accepts only a session whose tenant and adapter index match its record", () => {
    expect(parseHostedSessionRow(sessionRow)).toEqual(sessionRecord);
    expect(() => parseHostedSessionRow({ ...sessionRow, adapterSessionId: "substituted" })).toThrow(
      "canonically bound",
    );
  });

  it("binds a paged checkpoint pointer to its tenant, digest, and row index", () => {
    const checkpointDigest = `sha256:${"a".repeat(64)}`;
    const checkpointId = "1c65bd6d-0558-4863-afb7-891bd0742f47";
    const record = {
      adapterGeneration: 1,
      adapterSessionId: "adapter_1",
      checkpointDigest,
      checkpointProgressDigest: `sha256:${"b".repeat(64)}`,
      checkpointRef: { digest: checkpointDigest, eventCount: 100_001, id: checkpointId },
      createdAtEpochMs: 2000,
      lastProgressAtEpochMs: 2000,
      originAdapterSessionId: "adapter_1",
      principal,
      resumability: "live" as const,
      sessionId: "session_1",
      stage: "designing" as const,
      status: "waiting" as const,
      title: "Paged session",
      updatedAtEpochMs: 2000,
      version: 2 as const,
    };
    const row = {
      ...sessionRow,
      adapterGeneration: 1,
      checkpointDigest,
      checkpointId,
      checkpointProgressDigest: record.checkpointProgressDigest,
      lastProgressAt: new Date(2000),
      record,
      resumabilityState: "live",
      stage: "designing",
      title: "Paged session",
    };
    expect(parseHostedSessionRow(row)).toEqual(record);
    expect(() => parseHostedSessionRow({ ...row, checkpointId: "other" })).toThrow(
      "canonically bound",
    );
    expect(() =>
      parseHostedSessionRow({ ...row, checkpointDigest: `sha256:${"c".repeat(64)}` }),
    ).toThrow("canonically bound");
    expect(() => parseHostedSessionRow({ ...row, workspaceId: "other" })).toThrow(
      "canonically bound",
    );
  });

  it("keeps the checked-in migration tenant scoped and idempotency bound", async () => {
    const migration = await readFile(
      new URL("../../drizzle/0001_hosted_eve_bridge.sql", import.meta.url),
      "utf-8",
    );
    for (const required of [
      '"issuer" text NOT NULL',
      '"audience" text NOT NULL',
      '"workspace_id" text NOT NULL',
      '"owner_user_id" text NOT NULL',
      '"record" jsonb NOT NULL',
      '"agent_operation_idempotency_idx"',
      '"kind", "client_request_id"',
    ]) {
      expect(migration).toContain(required);
    }
    const journal = JSON.parse(
      await readFile(new URL("../../drizzle/meta/_journal.json", import.meta.url), "utf-8"),
    ) as unknown;
    expect(journal).toEqual({
      dialect: "postgresql",
      entries: [
        {
          breakpoints: true,
          idx: 0,
          tag: "0001_hosted_eve_bridge",
          version: "7",
          when: 1_787_626_800_000,
        },
        {
          breakpoints: true,
          idx: 1,
          tag: "0002_hosted_workspace_membership",
          version: "7",
          when: 1_787_755_200_000,
        },
        {
          breakpoints: true,
          idx: 2,
          tag: "0003_hosted_retention_indexes",
          version: "7",
          when: 1_787_795_200_000,
        },
        {
          breakpoints: true,
          idx: 3,
          tag: "0004_preview_oauth",
          version: "7",
          when: 1_787_800_800_000,
        },
        {
          breakpoints: true,
          idx: 4,
          tag: "0005_github_publication_journal",
          version: "7",
          when: 1_787_803_200_000,
        },
        {
          breakpoints: true,
          idx: 5,
          tag: "0006_tenant_github_publication",
          version: "7",
          when: 1_787_893_200_000,
        },
        {
          breakpoints: true,
          idx: 6,
          tag: "0007_github_installation_authorization",
          version: "7",
          when: 1_787_896_800_000,
        },
        {
          breakpoints: true,
          idx: 7,
          tag: "0008_sandbox_execution_lease",
          version: "7",
          when: 1_787_983_200_000,
        },
        {
          breakpoints: true,
          idx: 8,
          tag: "0009_builder_provider_integrations",
          version: "7",
          when: 1_788_066_000_000,
        },
        {
          breakpoints: true,
          idx: 9,
          tag: "0010_better_auth_organizations",
          version: "7",
          when: 1_788_069_600_000,
        },
        {
          breakpoints: true,
          idx: 10,
          tag: "0011_self_service_onboarding",
          version: "7",
          when: 1_788_080_400_000,
        },
        {
          breakpoints: true,
          idx: 11,
          tag: "0012_provider_connection_return_state",
          version: "7",
          when: 1_788_084_000_000,
        },
        {
          breakpoints: true,
          idx: 12,
          tag: "0013_passkey_onboarding",
          version: "7",
          when: 1_788_091_200_000,
        },
        {
          breakpoints: true,
          idx: 13,
          tag: "0014_tenant_github_installation_uniqueness",
          version: "7",
          when: 1_788_094_800_000,
        },
        {
          breakpoints: true,
          idx: 14,
          tag: "0015_builder_resource_provisioning",
          version: "7",
          when: 1_788_102_000_000,
        },
        {
          breakpoints: true,
          idx: 15,
          tag: "0016_emulate_preview_state",
          version: "7",
          when: 1_788_102_600_000,
        },
        {
          breakpoints: true,
          idx: 16,
          tag: "0017_chat_repository_access",
          version: "7",
          when: 1_788_261_600_000,
        },
        {
          breakpoints: true,
          idx: 17,
          tag: "0018_durable_session_resume",
          version: "7",
          when: 1_788_264_000_000,
        },
        {
          breakpoints: true,
          idx: 18,
          tag: "0019_opaque_builder_handoff",
          version: "7",
          when: 1_788_267_600_000,
        },
        {
          breakpoints: true,
          idx: 19,
          tag: "0020_durable_builder_draft",
          version: "7",
          when: 1_788_354_000_000,
        },
        {
          breakpoints: true,
          idx: 20,
          tag: "0021_builder_draft_active_revision",
          version: "7",
          when: 1_788_357_600_000,
        },
        {
          breakpoints: true,
          idx: 21,
          tag: "0022_hosted_github_draft_adoption",
          version: "7",
          when: 1_790_514_000_000,
        },
        {
          breakpoints: true,
          idx: 22,
          tag: "0023_paged_session_checkpoints",
          version: "7",
          when: 1_790_567_902_244,
        },
        {
          breakpoints: true,
          idx: 23,
          tag: "0024_prototype_chunks",
          version: "7",
          when: 1_790_567_902_245,
        },
        {
          breakpoints: true,
          idx: 24,
          tag: "0025_validation_logs",
          version: "7",
          when: 1_790_654_400_000,
        },
        {
          breakpoints: true,
          idx: 25,
          tag: "0026_validation_log_completion",
          version: "7",
          when: 1_790_654_400_001,
        },
        {
          breakpoints: true,
          idx: 26,
          tag: "0027_protected_access_fence_generation",
          version: "7",
          when: 1_791_329_366_000,
        },
        {
          breakpoints: true,
          idx: 27,
          tag: "0028_product_source_review_journal",
          version: "7",
          when: 1_791_504_000_000,
        },
      ],
      version: "7",
    });
  });

  it("adds bounded durable-session metadata without rewriting legacy rows", async () => {
    const migration = await readFile(
      new URL("../../drizzle/0018_durable_session_resume.sql", import.meta.url),
      "utf-8",
    );
    for (const required of [
      '"adapter_generation" integer',
      '"checkpoint_digest" text',
      '"checkpoint_progress_digest" text',
      '"parent_session_id" text',
      '"last_progress_at" timestamptz',
      '"agent_session_recent_idx"',
    ]) {
      expect(migration).toContain(required);
    }
    expect(migration).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE|UPDATE)\b/iu);
  });

  it("adds opaque handoffs without rewriting existing rows", async () => {
    const migration = await readFile(
      new URL("../../drizzle/0019_opaque_builder_handoff.sql", import.meta.url),
      "utf-8",
    );
    for (const required of [
      'CREATE TABLE "builder_handoff"',
      '"builder_handoff_creation_uidx"',
      '"builder_handoff_expiry_idx"',
      '"builder_handoff_redemption_check"',
    ]) {
      expect(migration).toContain(required);
    }
    expect(migration).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE|UPDATE)\b/iu);
  });

  it("adds tenant-scoped durable drafts without rewriting existing rows", async () => {
    const migration = await readFile(
      new URL("../../drizzle/0020_durable_builder_draft.sql", import.meta.url),
      "utf-8",
    );
    for (const required of [
      'CREATE TABLE "builder_draft"',
      '"builder_draft_pk"',
      '"builder_draft_updated_idx"',
      '"builder_draft_revision_check"',
      '"builder_draft_record_check"',
    ]) {
      expect(migration).toContain(required);
    }
    expect(migration).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE|UPDATE)\b/iu);
  });
});

const checkpointA = {
  digest: `sha256:${"a".repeat(64)}`,
  eventCount: 1,
  id: "123e4567-e89b-42d3-a456-426614174001",
};
const checkpointB = {
  digest: `sha256:${"b".repeat(64)}`,
  eventCount: 2,
  id: "123e4567-e89b-42d3-a456-426614174002",
};

const ownedCheckpointRow = (
  checkpointRef = checkpointA,
  owner = principal,
  sessionId = sessionRecord.sessionId,
) => {
  const record = {
    ...toDurableHostedSessionRecord({ ...sessionRecord, principal: owner, sessionId }),
    checkpointDigest: checkpointRef.digest,
    checkpointProgressDigest: checkpointRef.digest,
    checkpointRef,
  };
  return {
    ...sessionRow,
    adapterGeneration: record.adapterGeneration,
    audience: owner.audience,
    checkpointDigest: record.checkpointDigest,
    checkpointId: checkpointRef.id,
    checkpointProgressDigest: record.checkpointProgressDigest,
    issuer: owner.issuer,
    lastProgressAt: new Date(record.lastProgressAtEpochMs),
    ownerUserId: owner.ownerUserId,
    record,
    resumabilityState: record.resumability,
    sessionId,
    stage: record.stage,
    title: record.title,
    workspaceId: owner.workspaceId,
  };
};

type CheckpointFixtureRow = Record<
  string,
  string | number | Date | null | HostedSessionRecord | readonly string[]
>;

const terminalReadRows = (rows: CheckpointFixtureRow[]) => {
  const result = Object.assign(Promise.resolve(rows), {
    // oxlint-disable-next-line eslint/require-await -- Terminal database double preserves the async read contract.
    limit: async (limit: number) => rows.slice(0, limit),
    orderBy: () => result,
  });
  return result;
};

/** Terminal query doubles exercise the real store, history reader, and Drizzle predicates. */
const checkpointReadFixture = () => {
  const dialect = new PgDialect();
  const queries: { params: unknown[]; sql: string }[] = [];
  const rows = new Map<string, CheckpointFixtureRow[]>();
  rows.set("agent_session", [ownedCheckpointRow()]);
  rows.set("agent_session_checkpoint_manifest", [
    {
      ...principal,
      checkpointDigest: checkpointA.digest,
      checkpointId: checkpointA.id,
      eventCount: checkpointA.eventCount,
      publishedAt: new Date(3000),
      sessionId: sessionRecord.sessionId,
    },
  ]);
  const metadata: HostedCheckpointPage["metadata"] = {
    capturedAtEpochMs: 3000,
    status: "working",
    version: 1,
  };
  const event: HostedCheckpointPage["events"][number] = {
    index: 0,
    text: "Checkpoint A retained history",
    turnId: "turn_1",
    type: "assistant_message",
  };
  const items = [metadata, event].map((value, index) => {
    const bytes = Buffer.from(JSON.stringify(value));
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    return {
      ...principal,
      byteLength: bytes.byteLength,
      checkpointId: checkpointA.id,
      chunkDigest: digest,
      digest,
      itemIndex: index - 1,
      partCount: 1,
      partIndex: 0,
      payload: bytes.toString("base64"),
      sessionId: sessionRecord.sessionId,
    };
  });
  rows.set("agent_session_checkpoint_item", items);
  rows.set("agent_session_checkpoint_chunk", items);
  const selectRows = (table: PgTable, predicate: SQL) => {
    const query = dialect.sqlToQuery(predicate);
    queries.push(query);
    const name = getTableName(table);
    const keys = ["issuer", "audience", "workspaceId", "ownerUserId", "sessionId"];
    if (name !== "agent_session") {
      keys.push("checkpointId");
    }
    const itemIndexes = /"item_index" in \((?<indexes>[^)]+)\)/u.exec(query.sql);
    const indexes =
      itemIndexes === null
        ? undefined
        : [...(itemIndexes.groups?.indexes ?? "").matchAll(/\$(?<parameter>\d+)/gu)].map(
            (match) => query.params[Number(match.groups?.parameter) - 1],
          );
    const afterItem = /"item_index" > \$(?<parameter>\d+)/u.exec(query.sql);
    const afterPart = /"part_index" > \$(?<parameter>\d+)/u.exec(query.sql);
    const selected = (rows.get(name) ?? []).filter((row) => {
      if (!keys.every((key, index) => row[key] === query.params[index])) return false;
      if (indexes !== undefined && !indexes.includes(row.itemIndex)) return false;
      if (afterItem === null) return true;
      const itemCursor = Number(query.params[Number(afterItem.groups?.parameter) - 1]);
      return (
        Number(row.itemIndex) > itemCursor ||
        (row.itemIndex === itemCursor &&
          afterPart !== null &&
          Number(row.partIndex) > Number(query.params[Number(afterPart.groups?.parameter) - 1]))
      );
    });
    return terminalReadRows(selected);
  };
  const database = {
    select: () => ({
      from: (table: PgTable) => ({
        where: (predicate: SQL) => selectRows(table, predicate),
      }),
    }),
  };
  // SAFETY: This terminal double implements every SELECT chain reached by these read-only store/history calls.
  const store = createPostgresHostedEveStore(
    // SAFETY: The read-only terminal fixture implements every exercised SELECT chain; writes and provider calls are not exercised.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- Deliberate partial database transport fixture.
    database as unknown as Parameters<typeof createPostgresHostedEveStore>[0],
  );
  const read = async (
    overrides: Partial<Parameters<NonNullable<typeof store.readCheckpointPage>>[0]> = {},
  ) => {
    if (store.readCheckpointPage === undefined) {
      throw new Error("Expected the PostgreSQL checkpoint reader.");
    }
    return await store.readCheckpointPage({
      checkpointRef: checkpointA,
      cursor: 0,
      limit: 1,
      principal,
      sessionId: sessionRecord.sessionId,
      ...overrides,
    });
  };
  return { event, metadata, queries, read, rows, store };
};

describe("published checkpoint reference reads across concurrent pointer advancement", () => {
  it("reads captured A after the owned session advances to B, retaining A's metadata and event", async () => {
    const fixture = checkpointReadFixture();
    const captured = await fixture.store.getSession(principal, sessionRecord.sessionId);
    if (captured?.version !== 2 || captured.checkpointRef === undefined) {
      throw new Error("Expected a captured durable checkpoint reference.");
    }
    // Model a concurrent committed publication at the terminal database boundary.
    fixture.rows.set("agent_session", [ownedCheckpointRow(checkpointB)]);
    expect(await fixture.read({ checkpointRef: captured.checkpointRef })).toEqual({
      checkpointDigest: checkpointA.digest,
      cursor: 1,
      events: [fixture.event],
      metadata: fixture.metadata,
      totalEvents: 1,
    });
    expect(await fixture.store.getSession(principal, sessionRecord.sessionId)).toMatchObject({
      checkpointRef: checkpointB,
    });
    const historyQueries = fixture.queries.filter(({ sql }) => sql.includes("checkpoint_manifest"));
    expect(historyQueries.length).toBeGreaterThan(0);
    for (const query of historyQueries) {
      expect(query.params).toEqual([
        principal.issuer,
        principal.audience,
        principal.workspaceId,
        principal.ownerUserId,
        sessionRecord.sessionId,
        checkpointA.id,
      ]);
      for (const column of [
        "issuer",
        "audience",
        "workspace_id",
        "owner_user_id",
        "session_id",
        "checkpoint_id",
      ]) {
        expect(query.sql).toContain(`"${column}" =`);
      }
    }
  });

  it.each(["issuer", "audience", "workspaceId", "ownerUserId"] as const)(
    "rejects a foreign %s even when that principal has its own same-ID durable session",
    async (field) => {
      const fixture = checkpointReadFixture();
      const foreign = { ...principal, [field]: `${principal[field]}/foreign` };
      fixture.rows.set("agent_session", [ownedCheckpointRow(checkpointB, foreign)]);
      await expect(fixture.read({ principal: foreign })).rejects.toThrow("selected reference");
      await expect(fixture.read()).rejects.toThrow("session was not found");
    },
  );

  it("rejects another owned session's reference and a missing session", async () => {
    const fixture = checkpointReadFixture();
    fixture.rows.set("agent_session", [ownedCheckpointRow(checkpointB, principal, "session_2")]);
    await expect(fixture.read({ sessionId: "session_2" })).rejects.toThrow("selected reference");
    await expect(fixture.read()).rejects.toThrow("session was not found");
  });

  it("requires a durable session version", async () => {
    const fixture = checkpointReadFixture();
    fixture.rows.set("agent_session", [sessionRow]);
    await expect(fixture.read()).rejects.toThrow("not durable");
  });

  it.each(["unpublished", "missing", "no-event-count"] as const)(
    "rejects a %s manifest",
    async (kind) => {
      const fixture = checkpointReadFixture();
      const manifests = fixture.rows.get("agent_session_checkpoint_manifest") ?? [];
      fixture.rows.set(
        "agent_session_checkpoint_manifest",
        kind === "missing"
          ? []
          : manifests.map((manifest) => ({
              ...manifest,
              ...(kind === "unpublished" ? { publishedAt: null } : { eventCount: null }),
            })),
      );
      await expect(fixture.read()).rejects.toThrow("selected reference");
    },
  );

  it("rejects supplied digest and event-count mismatches", async () => {
    const fixture = checkpointReadFixture();
    await expect(
      fixture.read({ checkpointRef: { ...checkpointA, digest: checkpointB.digest } }),
    ).rejects.toThrow("selected reference");
    await expect(
      fixture.read({ checkpointRef: { ...checkpointA, eventCount: 2 } }),
    ).rejects.toThrow("selected reference");
  });

  it("rejects malformed supplied references and corrupted retained chunks", async () => {
    const fixture = checkpointReadFixture();
    await expect(
      fixture.read({ checkpointRef: { ...checkpointA, id: "invalid" } }),
    ).rejects.toThrow();
    await expect(
      fixture.read({ checkpointRef: { ...checkpointA, digest: "invalid" } }),
    ).rejects.toThrow();
    await expect(
      fixture.read({ checkpointRef: { ...checkpointA, eventCount: -1 } }),
    ).rejects.toThrow();
    fixture.rows.set(
      "agent_session_checkpoint_chunk",
      (fixture.rows.get("agent_session_checkpoint_chunk") ?? []).map((chunk) => ({
        ...chunk,
        chunkDigest: checkpointB.digest,
      })),
    );
    await expect(fixture.read()).rejects.toThrow("chunk digest mismatch");
  });
});

const lockedSessionQuery = {
  from: () => ({
    where: () => ({
      limit: () => ({
        // oxlint-disable-next-line eslint/require-await -- Terminal locked SELECT double preserves its async contract.
        for: async () => [sessionRow],
      }),
    }),
  }),
};

it("throws the specific observation digest conflict and discards only its staged checkpoint", async () => {
  const readTransaction = { select: () => lockedSessionQuery };
  const database = {
    transaction: async (
      execute: (transaction: typeof readTransaction) => Promise<HostedSessionRecord>,
    ) => await execute(readTransaction),
  };
  // SAFETY: This double implements the locked session SELECT used before the store's digest comparison; history I/O is separately doubled below.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- The terminal database fake implements only the verified prepublication conflict path.
  const db = database as unknown as Parameters<typeof createPostgresHostedEveStore>[0];
  const history = checkpointHistory.createPostgresHostedCheckpointHistory(db);
  const staged = {
    checkpointDigest: checkpointA.digest,
    checkpointId: randomUUID(),
    checkpointProgressDigest: checkpointA.digest,
    eventCount: 1,
    itemCount: 2,
  };
  const stage = vi.fn<typeof history.stage>().mockResolvedValue(staged);
  const discardStage = vi.fn<typeof history.discardStage>().mockResolvedValue(true);
  const publish = vi.fn<typeof history.publishInTransaction>();
  const factory = vi
    .spyOn(checkpointHistory, "createPostgresHostedCheckpointHistory")
    .mockReturnValue({ ...history, discardStage, publishInTransaction: publish, stage });
  try {
    const store = createPostgresHostedEveStore(db);
    if (store.observeSessionPaged === undefined) {
      throw new Error("Expected the PostgreSQL paged observation writer.");
    }
    await expect(
      store.observeSessionPaged({
        events: (async function* stagedEvents() {
          yield {
            index: 0,
            text: staged.checkpointId,
            turnId: "turn_1",
            type: "assistant_message" as const,
          };
        })(),
        expectedCheckpointDigest: checkpointB.digest,
        metadata: { capturedAtEpochMs: 3000, status: "working", version: 1 },
        nowEpochMs: 3000,
        principal,
        resumability: "live",
        sessionId: sessionRecord.sessionId,
        stage: "planning",
      }),
    ).rejects.toBeInstanceOf(HostedCheckpointObservationConflictError);
    expect(stage).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
    expect(discardStage).toHaveBeenCalledExactlyOnceWith({
      checkpointId: staged.checkpointId,
      principal,
      sessionId: sessionRecord.sessionId,
    });
  } finally {
    factory.mockRestore();
  }
});
