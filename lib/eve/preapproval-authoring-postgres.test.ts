/* oxlint-disable sonarjs/publicly-writable-directories -- Each cluster uses an exclusive mkdtemp root and private Unix socket, never an existing database. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- The production factory consumes the actual full Drizzle schema.
import * as schema from "../db/schema";
import { createPostgresHostedEveStore } from "./postgres-hosted-store";
import { hostedOperationRecordSchema, toDurableHostedSessionRecord } from "./hosted-store";
import type { HostedEveStore } from "./hosted-store";
import { hostedEveOperationScopes } from "./hosted-auth";
import { authoringScopeDigest } from "../agent/preapproval-authoring";

// An explicit local tool directory is only a fixture executable selection, never a connection URL.
const fixtureEnvironment = {
  LANG: "C",
  LC_ALL: "C",
  NODE_ENV: "test" as const,
  PATH: process.env.PATH,
};
const tools = [
  process.env.BUILDER_TEST_POSTGRES_BIN,
  "/Applications/Postgres.app/Contents/Versions/17/bin",
  "/opt/homebrew/opt/postgresql@17/bin",
  "/usr/lib/postgresql/17/bin",
].find((candidate): candidate is string => {
  if (candidate === undefined || !path.isAbsolute(candidate)) {
    return false;
  }
  try {
    return /PostgreSQL\) 17\./u.test(
      execFileSync(path.join(candidate, "postgres"), ["--version"], {
        encoding: "utf-8",
        env: fixtureEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch {
    return false;
  }
});
const principal = {
  audience: "https://fixture.example/mcp",
  issuer: "https://fixture.example/auth",
  ownerUserId: "owner",
  scopes: Object.values(hostedEveOperationScopes),
  workspaceId: "workspace",
};
const scope = {
  acceptedByCallId: "accept",
  appId: "fixture",
  appSpecDigest: "a".repeat(64),
  artifactPath: "fixture.md",
  artifactRevision: "revision",
  authoritySessionId: "logical",
  planningStateDigest: "d".repeat(64),
  sourceReceiptDigest: "b".repeat(64),
  workspaceDigest: "c".repeat(64),
  workspaceId: "sandbox",
};
const decision = {
  adapterSessionId: "logical",
  decision: "runnable" as const,
  kind: "preapproval-authoring-decision-v1" as const,
  scope,
  scopeDigest: authoringScopeDigest(scope),
  turnId: "turn1",
  turnSequence: 1,
  version: 1 as const,
};
const result = { cursor: 0, events: [], sessionId: "public", status: "waiting" as const };
let root: string | undefined;
let started = false;
let client: ReturnType<typeof postgres> | undefined;
let store: HostedEveStore;
const command = (name: string, args: string[]) => {
  if (tools === undefined) {
    throw new Error("Owned PostgreSQL17 tools required.");
  }
  execFileSync(path.join(tools, name), args, { env: fixtureEnvironment, stdio: "pipe" });
};
const operation = (id: string) =>
  hostedOperationRecordSchema.parse({
    clientRequestId: id,
    createdAtEpochMs: 2,
    internalAuthoringContinuation: { decision, nonce: "f".repeat(64) },
    kind: "send",
    operationId: id,
    principal,
    requestDigest: `sha256:${"e".repeat(64)}`,
    sessionId: "public",
    state: "reserved",
    updatedAtEpochMs: 2,
    version: 1,
  });
const claim = (id: string) => ({
  logicalSessionId: "logical",
  messageSequence: 0,
  nonce: "f".repeat(64),
  operationId: id,
  principal,
  scopeDigest: decision.scopeDigest,
  sessionId: "public",
  turnId: "turn2",
  turnSequence: 2,
});
const reserveUnknown = async (id: string) => {
  const op = operation(id);
  const reservation = await store.reserveOperation(principal, op);
  expect(reservation.disposition).toBe("reserved");
  await store.settleUnsuccessful({
    nowEpochMs: 3,
    operationId: id,
    principal,
    requestDigest: op.requestDigest,
    safeErrorCode: "lost_ack",
    state: "submission_unknown",
  });
  return op;
};

describe.skipIf(tools === undefined)("authoring custody against actual PostgreSQL17", () => {
  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "authoring-pg-")));
    command("initdb", [
      "-D",
      path.join(root, "data"),
      "--auth-local=trust",
      "--auth-host=reject",
      "--no-locale",
      "-E",
      "utf-8",
    ]);
    command("pg_ctl", [
      "-D",
      path.join(root, "data"),
      "-l",
      path.join(root, "postgres.log"),
      "-o",
      `-h '' -k ${root} -p 54329`,
      "-w",
      "start",
    ]);
    started = true;
    client = postgres({
      database: "postgres",
      host: root,
      max: 5,
      onnotice: () => {
        // Fixture migration notices are not retained.
      },
      port: 54_329,
      ssl: false,
      username: userInfo().username,
    });
    const database = drizzle(client, { schema });
    await migrate(database, {
      migrationsFolder: path.resolve(import.meta.dirname, "../../drizzle"),
    });
    store = createPostgresHostedEveStore(database);
    const start = hostedOperationRecordSchema.parse({
      clientRequestId: "start",
      createdAtEpochMs: 1,
      kind: "start",
      operationId: "start",
      principal,
      requestDigest: `sha256:${"a".repeat(64)}`,
      state: "reserved",
      updatedAtEpochMs: 1,
      version: 1,
    });
    await store.reserveOperation(principal, start);
    await store.settleSucceeded({
      nowEpochMs: 1,
      operationId: "start",
      principal,
      requestDigest: start.requestDigest,
      result,
      session: {
        adapterSessionId: "logical",
        createdAtEpochMs: 1,
        principal,
        sessionId: "public",
        status: "waiting",
        updatedAtEpochMs: 1,
        version: 1,
      },
    });
  }, 30_000);
  afterAll(async () => {
    await client?.end({ timeout: 5 });
    if (started && root !== undefined) {
      command("pg_ctl", ["-D", path.join(root, "data"), "-m", "immediate", "-w", "stop"]);
    }
    if (root !== undefined) {
      await rm(root, { force: true, recursive: true });
    }
  });
  it("persists actual decision, ignores older turn, and rejects foreign owner/adapter", async () => {
    const record = store.recordPreapprovalAuthoringDecision;
    expect(record).toBeTypeOf("function");
    if (record === undefined) {
      throw new Error("Actual authoring store port required.");
    }
    await record({ decision, principal, sessionId: "public" });
    await record({
      decision: { ...decision, decision: "blocked", turnSequence: 0 },
      principal,
      sessionId: "public",
    });
    const current = await store.getSession(principal, "public");
    assert.ok(current);
    expect(toDurableHostedSessionRecord(current).privateAuthoringDecision).toEqual(decision);
    await expect(
      record({
        decision,
        principal: { ...principal, ownerUserId: "foreign" },
        sessionId: "public",
      }),
    ).rejects.toThrow();
    await expect(
      record({
        decision: { ...decision, adapterSessionId: "foreign" },
        principal,
        sessionId: "public",
      }),
    ).rejects.toThrow();
    const unchanged = await store.getSession(principal, "public");
    assert.ok(unchanged);
    expect(toDurableHostedSessionRecord(unchanged).privateAuthoringDecision).toEqual(decision);
  });
  it("retains unknown operation and refuses settlement without actual delivery claim", async () => {
    const op = await reserveUnknown("unknown-unclaimed");
    const before = await store.getPrivateOperation?.(principal, op.operationId);
    await expect(
      store.settleSucceeded({
        nowEpochMs: 4,
        operationId: op.operationId,
        principal,
        requestDigest: op.requestDigest,
        result,
      }),
    ).rejects.toThrow();
    expect(await store.getPrivateOperation?.(principal, op.operationId)).toEqual(before);
    const repeated = await store.reserveOperation(principal, op);
    expect(repeated.disposition).toBe("existing");
  });
  it("serializes competing delivery claims and reconciles exact original unknown receipt", async () => {
    const op = await reserveUnknown("unknown-delivered");
    const accept = store.claimInternalAuthoringMessage;
    if (accept === undefined) {
      throw new Error("Actual marker claim port required.");
    }
    await Promise.all(
      [
        { nonce: "0".repeat(64) },
        { scopeDigest: "0".repeat(64) },
        { logicalSessionId: "foreign" },
        { principal: { ...principal, ownerUserId: "foreign" } },
      ].map(async (bad) => {
        let accepted = false;
        try {
          accepted = await accept({ ...claim(op.operationId), ...bad });
        } catch {
          // Unknown/foreign ownership is a denial.
        }
        expect(accepted).toBe(false);
      }),
    );
    const outcomes = await Promise.all([
      accept(claim(op.operationId)),
      accept({ ...claim(op.operationId), messageSequence: 1 }),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const claimed = await store.getPrivateOperation?.(principal, op.operationId);
    const delivered = claimed?.internalAuthoringContinuation;
    expect(delivered?.deliveredTurnId).toBe("turn2");
    assert.ok(delivered);
    assert.notEqual(delivered.deliveredMessageSequence, undefined);
    expect(
      await accept({
        ...claim(op.operationId),
        messageSequence: delivered.deliveredMessageSequence ?? -1,
      }),
    ).toBe(true);
    await store.settleSucceeded({
      nowEpochMs: 5,
      operationId: op.operationId,
      principal,
      requestDigest: op.requestDigest,
      result,
    });
    const completed = await store.getPrivateOperation?.(principal, op.operationId);
    expect(completed?.state).toBe("succeeded");
    expect(completed?.internalAuthoringContinuation).toEqual(delivered);
  });
  it("cannot authenticate a late authoring delivery after owner cancellation", async () => {
    const op = await reserveUnknown("cancelled-delivery");
    const cancel = store.recordCancellationIntent;
    const accept = store.claimInternalAuthoringMessage;
    assert.ok(cancel);
    assert.ok(accept);
    await cancel({ nowEpochMs: 6, principal, sessionId: "public" });
    expect(await accept(claim(op.operationId))).toBe(false);
    const retained = await store.getPrivateOperation?.(principal, op.operationId);
    expect(retained?.state).toBe("submission_unknown");
    expect(retained?.internalAuthoringContinuation?.deliveredTurnId).toBeUndefined();
  });
  it("preserves the exact declined-correction binding through real SQL custody without granting Build", async () => {
    const sessionId = "correction-public";
    const logicalSessionId = "correction-logical";
    const start = hostedOperationRecordSchema.parse({
      clientRequestId: "correction-start",
      createdAtEpochMs: 1,
      kind: "start",
      operationId: "correction-start",
      principal,
      requestDigest: `sha256:${"a".repeat(64)}`,
      state: "reserved",
      updatedAtEpochMs: 1,
      version: 1,
    });
    await store.reserveOperation(principal, start);
    await store.settleSucceeded({
      nowEpochMs: 1,
      operationId: start.operationId,
      principal,
      requestDigest: start.requestDigest,
      result: { ...result, sessionId },
      session: {
        adapterSessionId: logicalSessionId,
        createdAtEpochMs: 1,
        principal,
        sessionId,
        status: "waiting",
        updatedAtEpochMs: 1,
        version: 1,
      },
    });
    const correction = {
      denialEvidenceDigest: "2".repeat(64),
      inspectionCallId: "actual-inspection",
      proposalDigest: "1".repeat(64),
      requestMessageDigest: "3".repeat(64),
      requestMessageSequence: 0,
      requestTurnId: "user-correction",
      requestTurnSequence: 0,
    };
    const correctedScope = { ...scope, authoritySessionId: logicalSessionId, correction };
    const correctedDecision = {
      ...decision,
      adapterSessionId: logicalSessionId,
      scope: correctedScope,
      scopeDigest: authoringScopeDigest(correctedScope),
    };
    const retain = store.recordPreapprovalAuthoringDecision;
    const accept = store.claimInternalAuthoringMessage;
    assert.ok(retain);
    assert.ok(accept);
    await retain({ decision: correctedDecision, principal, sessionId });
    const op = hostedOperationRecordSchema.parse({
      ...operation("correction-send"),
      internalAuthoringContinuation: { decision: correctedDecision, nonce: "f".repeat(64) },
      sessionId,
    });
    await store.reserveOperation(principal, op);
    const before = await store.getPrivateOperation?.(principal, op.operationId);
    expect(before?.internalAuthoringContinuation?.decision.scope?.correction).toEqual(correction);
    expect(before?.internalBuildContinuation).toBeUndefined();
    const delivery = {
      ...claim(op.operationId),
      logicalSessionId,
      scopeDigest: correctedDecision.scopeDigest,
      sessionId,
    };
    expect(await accept({ ...delivery, scopeDigest: decision.scopeDigest })).toBe(false);
    expect(await accept(delivery)).toBe(true);
    const persisted = await store.getPrivateOperation?.(principal, op.operationId);
    expect(persisted?.internalAuthoringContinuation?.decision.scope?.correction).toEqual(
      correction,
    );
    expect(persisted?.internalBuildContinuation).toBeUndefined();
  });
});
