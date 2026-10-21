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

import { hostedOperationRecordSchema, toDurableHostedSessionRecord } from "./hosted-store";
import type {
  HostedCheckpointPage,
  HostedOperationRecord,
  HostedSessionRecord,
} from "./hosted-store";
import { hostedEveOperationScopes } from "./hosted-auth";
import type { HostedPrincipal } from "./hosted-auth";
import {
  createPostgresHostedEveStore,
  parseHostedOperationRow,
  parseHostedSessionRow,
} from "./postgres-hosted-store";
import { nativeDeliveryForEvents } from "./native-delivery-state";

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
  sendCancellationRevisionAtDispatch: null,
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

const cancelledSendFixture = () => {
  const record = {
    ...toDurableHostedSessionRecord({ ...sessionRecord, status: "cancelled" }),
    cancellationRevision: 1,
  };
  let row = {
    ...sessionRow,
    adapterGeneration: record.adapterGeneration,
    lastProgressAt: new Date(record.lastProgressAtEpochMs),
    record,
    resumabilityState: record.resumability,
    stage: record.stage,
    title: record.title,
  };
  const operation = {
    ...operationRecord,
    kind: "send" as const,
    sessionId: record.sessionId,
    sendDelivery: {
      adapterGeneration: record.adapterGeneration,
      adapterSessionId: record.adapterSessionId,
      deliveryId: "accepted-send",
      requestDigest: operationRecord.requestDigest,
      resumeCancellationRevision: 1,
      sessionId: record.sessionId,
    },
  };
  const sendRow = {
    ...operationRow,
    kind: operation.kind,
    record: operation,
    sessionId: record.sessionId,
  };
  const selected = (table: PgTable) => {
    const rows = getTableName(table) === "agent_session" ? [row] : [sendRow];
    return Object.assign(Promise.resolve(rows), {
      // oxlint-disable-next-line eslint/require-await -- The terminal row-lock double preserves the database contract.
      for: async () => rows,
    });
  };
  const updates = vi.fn();
  const selectTable = (table: PgTable) => {
    const limit = () => selected(table);
    const where = () => ({ limit });
    return { where };
  };
  const updateValues = (values: typeof row) => {
    const returning = () => {
      updates(values);
      row = { ...row, ...values };
      return Promise.resolve([row]);
    };
    const where = () => ({ returning });
    return { where };
  };
  const transaction = {
    select: () => ({ from: selectTable }),
    update: () => ({ set: updateValues }),
  };
  const database = {
    transaction: <T>(execute: (input: typeof transaction) => Promise<T>) => execute(transaction),
  };
  // SAFETY: The terminal double implements only the tenant-scoped locked reads and UPDATEs exercised below.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- Provider-free database fixture.
  const db = database as unknown as Parameters<typeof createPostgresHostedEveStore>[0];
  const store = createPostgresHostedEveStore(db);
  const proof = nativeDeliveryForEvents([
    {
      data: { sequence: 1, turnId: "resumed-turn" },
      meta: {
        at: "2026-10-15T00:00:00Z",
        deliveryIds: ["accepted-send"],
        id: "resumed-turn-start",
      },
      type: "turn.started",
    },
  ]);
  const observe = (explicit = true, stamped = true) => {
    if (store.observeSession === undefined) {
      throw new Error("Expected the PostgreSQL observation writer");
    }
    return store.observeSession({
      checkpoint: {
        capturedAtEpochMs: 4000,
        events: [],
        ...(stamped ? { nativeDeliveryState: proof } : {}),
        status: "working",
        version: 1,
      },
      ...(explicit ? { explicitSendOperationId: operation.operationId } : {}),
      nowEpochMs: 4000,
      principal,
      resumability: "live",
      sessionId: record.sessionId,
      stage: "planning",
    });
  };
  return { observe, record, row: () => row, store, updates };
};

describe("PostgreSQL explicit SEND cancellation authority", () => {
  it("records every later Stop even while cancelled without replacing its checkpoint or identity", async () => {
    const f = cancelledSendFixture();
    if (f.store.recordCancellationIntent === undefined) {
      throw new Error("Expected the PostgreSQL cancellation intent writer");
    }
    await f.store.recordCancellationIntent({
      nowEpochMs: 3000,
      principal,
      sessionId: f.record.sessionId,
    });
    await f.store.recordCancellationIntent({
      nowEpochMs: 3000,
      principal,
      sessionId: f.record.sessionId,
    });
    expect(f.row().record).toMatchObject({
      adapterSessionId: f.record.adapterSessionId,
      cancellationRevision: 3,
      sessionId: f.record.sessionId,
      status: "cancelled",
    });
    expect(f.row().record.checkpointDigest).toBe(f.record.checkpointDigest);
  });
  it("requires explicit canonical operation authority and a stamped delivery, preserving the same IDs on revival", async () => {
    const f = cancelledSendFixture();
    expect(await f.observe(false)).toMatchObject({ status: "cancelled" });
    expect(await f.observe(true, false)).toMatchObject({ status: "cancelled" });
    expect(f.updates).not.toHaveBeenCalled();
    expect(await f.observe()).toMatchObject({
      adapterGeneration: f.record.adapterGeneration,
      adapterSessionId: f.record.adapterSessionId,
      cancellationRevision: 1,
      resumedCancellationRevision: 1,
      resumability: "live",
      sessionId: f.record.sessionId,
      status: "working",
    });
  });
  it("preserves server resume proof through observations and fences the next Stop", async () => {
    const f = cancelledSendFixture();
    await f.observe();
    expect(await f.observe(false)).toMatchObject({
      cancellationRevision: 1,
      resumedCancellationRevision: 1,
      status: "working",
    });
    if (f.store.recordCancellationIntent === undefined)
      throw new Error("Missing cancellation writer");
    await f.store.recordCancellationIntent({
      principal,
      sessionId: f.record.sessionId,
      nowEpochMs: 5000,
    });
    expect(f.row().record).toMatchObject({
      cancellationRevision: 2,
      resumedCancellationRevision: 1,
    });
  });
  it("does not let a first or duplicate observation of an older SEND overrule a newer Stop", async () => {
    const f = cancelledSendFixture();
    if (f.store.recordCancellationIntent === undefined) {
      throw new Error("Expected the PostgreSQL cancellation intent writer");
    }
    await f.store.recordCancellationIntent({
      nowEpochMs: 3000,
      principal,
      sessionId: f.record.sessionId,
    });
    expect(await f.observe()).toMatchObject({ cancellationRevision: 2, status: "cancelled" });
    expect(await f.observe()).toMatchObject({ cancellationRevision: 2, status: "cancelled" });
  });
});

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
    expect(journal).toMatchObject({
      dialect: "postgresql",
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- Vitest asymmetric matcher keeps additive migrations compatible.
      entries: expect.arrayContaining([
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
      ]),
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

type SendFixtureOperationRow = Omit<
  typeof operationRow,
  "kind" | "record" | "sessionId" | "sendCancellationRevisionAtDispatch" | "state"
> & {
  kind: HostedOperationRecord["kind"];
  record: HostedOperationRecord;
  sendCancellationRevisionAtDispatch: number | null;
  sessionId: string | null;
  state: HostedOperationRecord["state"];
};

const queuedSendFixture = () => {
  const dialect = new PgDialect();
  const session = ownedCheckpointRow();
  const operations: SendFixtureOperationRow[] = [];
  const locks: string[] = [];
  const writes: { locks: string[]; values: Partial<SendFixtureOperationRow> }[] = [];
  const columnKeys = {
    audience: "audience",
    created_at: "createdAt",
    issuer: "issuer",
    kind: "kind",
    operation_id: "operationId",
    owner_user_id: "ownerUserId",
    session_id: "sessionId",
    state: "state",
    workspace_id: "workspaceId",
  } satisfies Record<string, keyof SendFixtureOperationRow>;
  const columnKey = (name: string) =>
    Object.entries(columnKeys).find(([column]) => column === name)?.[1];
  // Interpret only the real Drizzle predicates used by this terminal database fixture.
  const selectedRows = (
    table: PgTable,
    predicate: SQL,
  ): (SendFixtureOperationRow | typeof session)[] => {
    if (getTableName(table) === "agent_session") return [session];
    const { params, sql } = dialect.sqlToQuery(predicate);
    const equalities = [...sql.matchAll(/"(?<column>[a-z_]+)" = \$(?<parameter>\d+)/gu)];
    const afterDate = /"created_at" > \$(?<parameter>\d+)/u.exec(sql);
    const afterId = /"operation_id" > \$(?<parameter>\d+)/u.exec(sql);
    return operations.filter((row) => {
      for (const match of equalities) {
        const column = match.groups?.column ?? "";
        if (column === "created_at") continue;
        const key = columnKey(column);
        if (key !== undefined && row[key] !== params[Number(match.groups?.parameter) - 1]) {
          return false;
        }
      }
      if (sql.includes('"state" in') && !["reserved", "submission_unknown"].includes(row.state)) {
        return false;
      }
      if (sql.includes("->'sendDelivery' IS NOT NULL") && row.record.sendDelivery === undefined) {
        return false;
      }
      if (
        sql.includes("->'internalBuildContinuation' IS NULL") &&
        row.record.internalBuildContinuation !== undefined
      ) {
        return false;
      }
      if (afterDate !== null) {
        const cursorDate = new Date(
          String(params[Number(afterDate.groups?.parameter) - 1]),
        ).getTime();
        const cursorId = String(params[Number(afterId?.groups?.parameter) - 1]);
        return (
          row.createdAt.getTime() > cursorDate ||
          (row.createdAt.getTime() === cursorDate && row.operationId > cursorId)
        );
      }
      return true;
    });
  };
  const select = () => ({
    from: (table: PgTable) => ({
      where: (predicate: SQL) => {
        let selected = selectedRows(table, predicate);
        const query = {
          // oxlint-disable-next-line sonarjs/no-nested-functions -- Terminal SELECT double mirrors Drizzle fluent ordering.
          orderBy: (...ordering: SQL[]) => {
            for (const order of ordering.toReversed()) {
              const key = columnKey(
                /"(?<column>[a-z_]+)" asc/u.exec(dialect.sqlToQuery(order).sql)?.groups?.column ??
                  "",
              );
              if (key === "createdAt") {
                selected = selected.toSorted(
                  (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
                );
              } else if (key === "operationId") {
                selected = selected.toSorted((a, b) =>
                  ("operationId" in a ? a.operationId : "").localeCompare(
                    "operationId" in b ? b.operationId : "",
                  ),
                );
              }
            }
            return query;
          },
          // oxlint-disable-next-line sonarjs/no-nested-functions -- Terminal SELECT double mirrors Drizzle fluent limit.
          limit: (limit: number) => {
            const rows = selected.slice(0, limit);
            return Object.assign(Promise.resolve(rows), {
              // oxlint-disable-next-line eslint/require-await, sonarjs/no-nested-functions -- Terminal SELECT double mirrors the asynchronous Drizzle row-lock contract.
              for: async () => {
                locks.push(getTableName(table));
                return rows;
              },
            });
          },
        };
        return query;
      },
    }),
  });
  const transaction = {
    select,
    update: (table: PgTable) => ({
      set: (values: Partial<SendFixtureOperationRow>) => ({
        where: (predicate: SQL) => ({
          // oxlint-disable-next-line sonarjs/no-nested-functions -- Terminal UPDATE double mirrors Drizzle fluent returning.
          returning: () => {
            const rows = selectedRows(table, predicate);
            writes.push({ locks: [...locks], values });
            for (const row of rows) Object.assign(row, values);
            return Promise.resolve(rows);
          },
        }),
      }),
    }),
  };
  const database = {
    ...transaction,
    transaction: <T>(execute: (input: typeof transaction) => Promise<T>) => execute(transaction),
  };
  // SAFETY: The terminal double interprets the real tenant/keyset predicates and row locks used by these source tests.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- No provider or live database is involved.
  const db = database as unknown as Parameters<typeof createPostgresHostedEveStore>[0];
  const store = createPostgresHostedEveStore(db);
  const add = (overrides: Partial<HostedOperationRecord> = {}, baseline: number | null = null) => {
    const record = hostedOperationRecordSchema.parse({
      ...operationRecord,
      kind: "send",
      operationId: `send_${operations.length}`,
      sessionId: session.sessionId,
      ...overrides,
    });
    const row: SendFixtureOperationRow = {
      ...operationRow,
      audience: record.principal.audience,
      clientRequestId: record.clientRequestId,
      createdAt: new Date(record.createdAtEpochMs),
      issuer: record.principal.issuer,
      kind: record.kind,
      operationId: record.operationId,
      ownerUserId: record.principal.ownerUserId,
      record,
      sendCancellationRevisionAtDispatch: baseline,
      sessionId: record.sessionId ?? null,
      state: record.state,
      updatedAt: new Date(record.updatedAtEpochMs),
      workspaceId: record.principal.workspaceId,
    };
    operations.push(row);
    return row;
  };
  const delivery = {
    adapterGeneration: session.record.adapterGeneration,
    adapterSessionId: session.adapterSessionId,
    deliveryId: "durable-queued-send",
    requestDigest: operationRecord.requestDigest,
    sessionId: session.sessionId,
  };
  const acknowledge = (row: SendFixtureOperationRow, cancellationRevisionAtDispatch?: number) => {
    if (store.recordSendDelivery === undefined) throw new Error("Expected ACK writer.");
    return store.recordSendDelivery({
      cancellationRevisionAtDispatch,
      delivery,
      nowEpochMs: 3000,
      operationId: row.operationId,
      principal,
    });
  };
  const read = (
    input: {
      operationId?: string;
      principal?: HostedPrincipal;
      sessionId?: string;
      cursor?: { createdAtEpochMs: number; operationId: string };
      limit?: number;
    } = {},
  ) => {
    if (store.readUnsettledSendAcknowledgements === undefined)
      throw new Error("Expected ACK reader.");
    return store.readUnsettledSendAcknowledgements({
      limit: 2,
      principal,
      sessionId: session.sessionId,
      ...input,
    });
  };
  return { acknowledge, add, delivery, operations, read, session, store, writes };
};

describe("PostgreSQL queued SEND acknowledgement sidecar", () => {
  it("atomically records the original dispatch revision with the ACK under both row locks", async () => {
    const f = queuedSendFixture();
    const row = f.add();
    const result = await f.acknowledge(row, 0);
    expect(result).toMatchObject({ sendDelivery: f.delivery, state: "reserved" });
    expect(result).not.toHaveProperty("cancellationRevisionAtDispatch");
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toMatchObject({
      locks: ["agent_operation", "agent_session"],
      values: { record: { sendDelivery: f.delivery }, sendCancellationRevisionAtDispatch: 0 },
    });
    expect(await f.read({ operationId: row.operationId })).toEqual({
      acknowledgements: [{ cancellationRevisionAtDispatch: 0, operation: result }],
    });
    await f.acknowledge(row, 0);
    expect(f.writes[1]?.values).not.toHaveProperty("sendCancellationRevisionAtDispatch");
    expect(row.sendCancellationRevisionAtDispatch).toBe(0);
  });

  it("rejects a Stop that commits before ACK and cannot rewrite the baseline on retry", async () => {
    const f = queuedSendFixture();
    const row = f.add();
    f.session.record = { ...f.session.record, cancellationRevision: 1 };
    await expect(f.acknowledge(row, 0)).rejects.toThrow("cancellation revision changed");
    expect(row.record.sendDelivery).toBeUndefined();
    expect(row.sendCancellationRevisionAtDispatch).toBeNull();
    expect(f.writes).toHaveLength(0);
    await f.acknowledge(row, 1);
    f.session.record = { ...f.session.record, cancellationRevision: 2 };
    await expect(f.acknowledge(row, 1)).rejects.toThrow("cancellation revision changed");
    await expect(f.acknowledge(row, 2)).rejects.toThrow("cancellation revision changed");
    expect(row.sendCancellationRevisionAtDispatch).toBe(1);
    expect(f.writes).toHaveLength(1);
  });

  it("preserves NULL for a legacy ACK and does not interpret missing history as revision zero", async () => {
    const f = queuedSendFixture();
    const row = f.add({ sendDelivery: f.delivery });
    await f.acknowledge(row, 0);
    expect(row.sendCancellationRevisionAtDispatch).toBeNull();
    expect(f.writes[0]?.values).not.toHaveProperty("sendCancellationRevisionAtDispatch");
    expect(await f.read()).toMatchObject({
      acknowledgements: [
        { cancellationRevisionAtDispatch: null, operation: { sendDelivery: f.delivery } },
      ],
    });
  });

  it("keeps the existing ACK API nullable when no dispatch revision was supplied", async () => {
    const f = queuedSendFixture();
    const row = f.add();
    await f.acknowledge(row);
    expect(row.sendCancellationRevisionAtDispatch).toBeNull();
    expect(row.record.sendDelivery).toEqual(f.delivery);
  });

  it("does not persist either ACK field if the adapter binding changed", async () => {
    const f = queuedSendFixture();
    const row = f.add();
    f.delivery.adapterGeneration += 1;
    await expect(f.acknowledge(row, 0)).rejects.toThrow("binding changed");
    expect(row.record.sendDelivery).toBeUndefined();
    expect(row.sendCancellationRevisionAtDispatch).toBeNull();
    expect(f.writes).toHaveLength(0);
  });

  it("retains explicit resume cancellation authority separately from the dispatch sidecar", async () => {
    const f = queuedSendFixture();
    const row = f.add();
    f.session.record = { ...f.session.record, cancellationRevision: 3, status: "cancelled" };
    if (f.store.recordSendDelivery === undefined) throw new Error("Expected ACK writer.");
    const result = await f.store.recordSendDelivery({
      cancellationRevisionAtDispatch: 3,
      delivery: { ...f.delivery, resumeCancellationRevision: 3 },
      nowEpochMs: 3000,
      operationId: row.operationId,
      principal,
    });
    expect(result.sendDelivery?.resumeCancellationRevision).toBe(3);
    expect(row.sendCancellationRevisionAtDispatch).toBe(3);
    expect(f.session.record.status).toBe("cancelled");
  });

  it("preserves the sidecar through generic operation updates and requires native SEND proof", async () => {
    const f = queuedSendFixture();
    const row = f.add();
    await f.acknowledge(row, 0);
    await expect(
      f.store.settleSucceeded({
        nowEpochMs: 3500,
        operationId: row.operationId,
        principal,
        requestDigest: row.requestDigest,
        result: { cursor: 0, events: [], sessionId: f.session.sessionId, status: "working" },
      }),
    ).rejects.toThrow("Canonical SEND delivery is not proved");
    expect(row.state).toBe("reserved");
    await f.store.settleUnsuccessful({
      nowEpochMs: 4000,
      operationId: row.operationId,
      principal,
      requestDigest: row.requestDigest,
      safeErrorCode: "submission_unknown",
      state: "submission_unknown",
    });
    expect(row.sendCancellationRevisionAtDispatch).toBe(0);
    expect(f.writes[1]?.values).not.toHaveProperty("sendCancellationRevisionAtDispatch");
    await expect(
      f.store.settleSucceeded({
        nowEpochMs: 5000,
        operationId: row.operationId,
        principal,
        requestDigest: row.requestDigest,
        result: { cursor: 0, events: [], sessionId: f.session.sessionId, status: "working" },
        sendDeliveryResolution: {
          turns: [{ deliveryIds: [f.delivery.deliveryId], turnId: "unstamped-turn" }],
          version: 1,
        },
      }),
    ).rejects.toThrow("Canonical SEND delivery is not proved");
    expect(row.state).toBe("submission_unknown");
    await f.store.settleSucceeded({
      nowEpochMs: 5000,
      operationId: row.operationId,
      principal,
      requestDigest: row.requestDigest,
      result: { cursor: 0, events: [], sessionId: f.session.sessionId, status: "working" },
      sendDeliveryResolution: {
        turns: [
          {
            deliveryIds: [f.delivery.deliveryId],
            startedDeliveryIds: [f.delivery.deliveryId],
            turnId: "stamped-turn",
          },
        ],
        version: 1,
      },
    });
    expect(row.state).toBe("succeeded");
    expect(row.sendCancellationRevisionAtDispatch).toBe(0);
    const settledPage = await f.read();
    expect(settledPage.acknowledgements).toEqual([]);
  });

  it("scopes exact lookup and pages ordinary unsettled ACKs by creation time and operation ID", async () => {
    const f = queuedSendFixture();
    const third = f.add({ createdAtEpochMs: 2000, sendDelivery: f.delivery }, 0);
    const first = f.add({ operationId: "send_a", sendDelivery: f.delivery }, 0);
    const second = f.add({
      operationId: "send_b",
      sendDelivery: f.delivery,
      state: "submission_unknown",
      safeErrorCode: "submission_unknown",
    });
    f.add({ sendDelivery: f.delivery, state: "rejected", safeErrorCode: "rejected" });
    f.add({
      sendDelivery: f.delivery,
      state: "succeeded",
      result: { cursor: 0, events: [], sessionId: f.session.sessionId, status: "working" },
    });
    f.add();
    f.add({ kind: "respond" });
    f.add({
      internalBuildContinuation: {
        decision: {
          adapterSessionId: f.delivery.adapterSessionId,
          decision: "runnable",
          turnId: "private-continuation",
          turnSequence: 1,
          version: 1,
          workflowPhase: "applied",
        },
        nonce: "a".repeat(64),
      },
      sendDelivery: f.delivery,
    });
    f.add({
      sessionId: "another_session",
      sendDelivery: { ...f.delivery, sessionId: "another_session" },
    });
    const missingPages = await Promise.all(
      (["issuer", "audience", "workspaceId", "ownerUserId"] as const).map((field) => {
        f.add({
          principal: { ...principal, [field]: `${principal[field]}/foreign` },
          sendDelivery: f.delivery,
        });
        return f.read({ principal: { ...principal, [field]: `${principal[field]}/missing` } });
      }),
    );
    for (const missingPage of missingPages) expect(missingPage.acknowledgements).toEqual([]);
    const page = await f.read();
    expect(page.acknowledgements.map(({ operation }) => operation.operationId)).toEqual([
      first.operationId,
      second.operationId,
    ]);
    expect(page.nextCursor).toEqual({ createdAtEpochMs: 1000, operationId: second.operationId });
    const next = await f.read({ cursor: page.nextCursor });
    expect(next.acknowledgements.map(({ operation }) => operation.operationId)).toEqual([
      third.operationId,
    ]);
    expect(next.nextCursor).toBeUndefined();
    const exactPage = await f.read({ operationId: second.operationId });
    expect(exactPage.acknowledgements.map(({ operation }) => operation.operationId)).toEqual([
      second.operationId,
    ]);
    const missingOperationPage = await f.read({ operationId: "missing" });
    expect(missingOperationPage.acknowledgements).toEqual([]);
    const missingSessionPage = await f.read({ sessionId: "missing" });
    expect(missingSessionPage.acknowledgements).toEqual([]);
  });

  it("rejects corrupted indexed bindings and invalid sidecar values", async () => {
    const f = queuedSendFixture();
    const row = f.add({ sendDelivery: f.delivery });
    row.record = { ...row.record, clientRequestId: "different-request" };
    await expect(f.read()).rejects.toThrow("canonically bound");
    row.record = { ...row.record, clientRequestId: row.clientRequestId };
    row.sendCancellationRevisionAtDispatch = -1;
    await expect(f.read()).rejects.toThrow();
  });
});
