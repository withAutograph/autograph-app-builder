import {
  isProvedSessionLimitResponse,
  isProvedResourceApprovalResponse,
  isProvedSendDelivery,
  mayReviveCancelledSession,
  bindSendDelivery,
  hostedOperationRecordSchema,
  hostedCheckpointRefSchema,
  durableHostedSessionRecordSchema,
  hostedSessionCheckpointDigest,
  hostedSessionCheckpointProgressDigest,
  hostedSessionCreationDigest,
  hostedSessionRecordSchema,
  toDurableHostedSessionRecord,
  withoutHostedOperationError,
  succeededStartAlias,
  assertExistingStartSession,
  sendAcknowledgementCursorSchema,
  unsettledSendAcknowledgementPageSchema,
  assertNativeRecoverySourceBinding,
  assertNativeRecoverySessionReceipt,
  assertRecoveredBuildContinuationChild,
  recoveredBuildDecision,
  inheritRecoveryBuildDecision,
} from "./hosted-store";
import {
  nativeRecoveryDescriptorSchema,
  nativeRecoveryBindingSchema,
  assertNativeRecoveryReceipt,
} from "./native-recovery-contract";
import { HostedCheckpointObservationConflictError } from "./hosted-checkpoint-observation-conflict-error";
import { approvedBuildDecisionSchema } from "../agent/approved-build-continuation";
import { and, asc, count, desc, eq, gt, inArray, lte, ne, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import type * as databaseSchema from "../db/schema";
import { agentOperations, agentSessions } from "../db/schema";
import { eveSessionResultSchema, sessionStatusSchema } from "../mcp/contracts";
import { hostedPrincipalSchema, tenantKeyFor } from "./hosted-auth";
import type { HostedPrincipal } from "./hosted-auth";
import type { HostedEveStore, HostedOperationRecord, HostedSessionRecord } from "./hosted-store";
import { mergePrivateHostedApprovalReceipts } from "./private-hosted-approval";
import { createPostgresHostedCheckpointHistory } from "./postgres-hosted-checkpoint-history";

type Database = PostgresJsDatabase<typeof databaseSchema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const SESSION_NOT_FOUND = "Hosted session was not found.";
const OPERATION_CANNOT_SETTLE = "Hosted operation cannot settle at this digest.";
const OPERATION_SETTLEMENT_NOT_DURABLE = "Hosted operation settlement was not durable.";

const sessionRowSchema = z
  .object({
    adapterGeneration: z.number().int().nullable(),
    adapterSessionId: z.string(),
    audience: z.string(),
    checkpointDigest: z.string().nullable(),
    checkpointId: z.string().nullable(),
    checkpointProgressDigest: z.string().nullable(),
    createdAt: z.date(),
    issuer: z.string(),
    lastProgressAt: z.date().nullable(),
    ownerUserId: z.string(),
    parentSessionId: z.string().nullable(),
    record: z.unknown(),
    resumabilityState: z.string().nullable(),
    sessionId: z.string(),
    stage: z.string().nullable(),
    title: z.string().nullable(),
    updatedAt: z.date(),
    workspaceId: z.string(),
  })
  .strict();

const operationRowSchema = z
  .object({
    audience: z.string(),
    clientRequestId: z.string(),
    createdAt: z.date(),
    issuer: z.string(),
    kind: z.string(),
    operationId: z.string(),
    ownerUserId: z.string(),
    record: z.unknown(),
    requestDigest: z.string(),
    sendCancellationRevisionAtDispatch: z.number().int().nonnegative().nullable(),
    sessionId: z.string().nullable(),
    state: z.string(),
    updatedAt: z.date(),
    workspaceId: z.string(),
  })
  .strict();

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function tenantPredicate(principal: HostedPrincipal) {
  return and(
    eq(agentOperations.issuer, principal.issuer),
    eq(agentOperations.audience, principal.audience),
    eq(agentOperations.workspaceId, principal.workspaceId),
    eq(agentOperations.ownerUserId, principal.ownerUserId),
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function sessionTenantPredicate(principal: HostedPrincipal) {
  return and(
    eq(agentSessions.issuer, principal.issuer),
    eq(agentSessions.audience, principal.audience),
    eq(agentSessions.workspaceId, principal.workspaceId),
    eq(agentSessions.ownerUserId, principal.ownerUserId),
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function parseHostedOperationRow(input: unknown): HostedOperationRecord {
  const row = operationRowSchema.parse(input);
  const record = hostedOperationRecordSchema.parse(row.record);
  if (
    row.issuer !== record.principal.issuer ||
    row.audience !== record.principal.audience ||
    row.workspaceId !== record.principal.workspaceId ||
    row.ownerUserId !== record.principal.ownerUserId ||
    row.operationId !== record.operationId ||
    row.sessionId !== (record.sessionId ?? null) ||
    row.kind !== record.kind ||
    row.clientRequestId !== record.clientRequestId ||
    row.requestDigest !== record.requestDigest ||
    row.state !== record.state ||
    row.createdAt.getTime() !== record.createdAtEpochMs ||
    row.updatedAt.getTime() !== record.updatedAtEpochMs
  ) {
    throw new Error("Hosted operation row is not canonically bound.");
  }
  return record;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function parseHostedSessionRow(input: unknown): HostedSessionRecord {
  const row = sessionRowSchema.parse(input);
  const record = hostedSessionRecordSchema.parse(row.record);
  if (
    row.issuer !== record.principal.issuer ||
    row.audience !== record.principal.audience ||
    row.workspaceId !== record.principal.workspaceId ||
    row.ownerUserId !== record.principal.ownerUserId ||
    row.sessionId !== record.sessionId ||
    row.adapterSessionId !== record.adapterSessionId ||
    (record.version === 1
      ? row.adapterGeneration !== null ||
        row.title !== null ||
        row.stage !== null ||
        row.resumabilityState !== null ||
        row.checkpointDigest !== null ||
        row.checkpointId !== null ||
        row.checkpointProgressDigest !== null ||
        row.parentSessionId !== null ||
        row.lastProgressAt !== null
      : row.adapterGeneration !== record.adapterGeneration ||
        row.title !== record.title ||
        row.stage !== record.stage ||
        row.resumabilityState !== record.resumability ||
        row.checkpointDigest !== (record.checkpointDigest ?? null) ||
        row.checkpointId !== (record.checkpointRef?.id ?? null) ||
        row.checkpointProgressDigest !== (record.checkpointProgressDigest ?? null) ||
        row.parentSessionId !== (record.parentSessionId ?? null) ||
        row.lastProgressAt?.getTime() !== record.lastProgressAtEpochMs) ||
    row.createdAt.getTime() !== record.createdAtEpochMs ||
    row.updatedAt.getTime() !== record.updatedAtEpochMs
  ) {
    throw new Error("Hosted session row is not canonically bound.");
  }
  return record;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function operationValues(record: HostedOperationRecord) {
  return {
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
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function sessionValues(record: HostedSessionRecord) {
  return {
    adapterGeneration: record.version === 1 ? null : record.adapterGeneration,
    adapterSessionId: record.adapterSessionId,
    audience: record.principal.audience,
    checkpointDigest: record.version === 1 ? null : (record.checkpointDigest ?? null),
    checkpointId: record.version === 1 ? null : (record.checkpointRef?.id ?? null),
    checkpointProgressDigest:
      record.version === 1 ? null : (record.checkpointProgressDigest ?? null),
    createdAt: new Date(record.createdAtEpochMs),
    issuer: record.principal.issuer,
    lastProgressAt: record.version === 1 ? null : new Date(record.lastProgressAtEpochMs),
    ownerUserId: record.principal.ownerUserId,
    parentSessionId: record.version === 1 ? null : (record.parentSessionId ?? null),
    record,
    resumabilityState: record.version === 1 ? null : record.resumability,
    sessionId: record.sessionId,
    stage: record.version === 1 ? null : record.stage,
    title: record.version === 1 ? null : record.title,
    updatedAt: new Date(record.updatedAtEpochMs),
    workspaceId: record.principal.workspaceId,
  };
}

// eslint-disable-next-line eslint/func-style -- The locked ACK writer also needs the sidecar outside the strict operation JSON.
async function operationRowById(
  database: Database | Transaction,
  principal: HostedPrincipal,
  operationId: string,
  lock = false,
) {
  const query = database
    .select()
    .from(agentOperations)
    .where(and(tenantPredicate(principal), eq(agentOperations.operationId, operationId)))
    .limit(1);
  const rows = lock ? await query.for("update") : await query;
  return rows[0] === undefined ? null : operationRowSchema.parse(rows[0]);
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function operationById(
  database: Database | Transaction,
  principal: HostedPrincipal,
  operationId: string,
  lock = false,
) {
  const row = await operationRowById(database, principal, operationId, lock);
  return row === null ? null : parseHostedOperationRow(row);
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function operationByRequest(
  database: Database | Transaction,
  principal: HostedPrincipal,
  kind: HostedOperationRecord["kind"],
  clientRequestId: string,
) {
  const rows = await database
    .select()
    .from(agentOperations)
    .where(
      and(
        tenantPredicate(principal),
        eq(agentOperations.kind, kind),
        eq(agentOperations.clientRequestId, clientRequestId),
      ),
    )
    .limit(1);
  return rows[0] === undefined ? null : parseHostedOperationRow(rows[0]);
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function sessionById(
  database: Database | Transaction,
  principal: HostedPrincipal,
  sessionId: string,
  lock = false,
) {
  const query = database
    .select()
    .from(agentSessions)
    .where(and(sessionTenantPredicate(principal), eq(agentSessions.sessionId, sessionId)))
    .limit(1);
  const rows = lock ? await query.for("update") : await query;
  return rows[0] === undefined ? null : parseHostedSessionRow(rows[0]);
}

// eslint-disable-next-line eslint/func-style -- Keep lookup adjacent to the tenant-scoped session query.
async function sessionByAdapterSessionId(
  database: Database | Transaction,
  principal: HostedPrincipal,
  adapterSessionId: string,
) {
  const rows = await database
    .select()
    .from(agentSessions)
    .where(
      and(sessionTenantPredicate(principal), eq(agentSessions.adapterSessionId, adapterSessionId)),
    )
    .limit(2);
  if (rows.length > 1) {
    throw new Error("Hosted adapter session binding is ambiguous.");
  }
  return rows[0] === undefined ? null : parseHostedSessionRow(rows[0]);
}

/** Resolve only a tenant-owned recovered child with its exact committed native receipt. */
// oxlint-disable-next-line eslint/func-style -- Keep the tenant-scoped transactional lookup adjacent to other store lookups.
async function currentBuildSession(
  transaction: Transaction,
  principal: HostedPrincipal,
  authoritySessionId: string,
  logicalSessionId: string,
) {
  const authority = await sessionById(transaction, principal, authoritySessionId, true);
  if (authority === null) {
    throw new Error(SESSION_NOT_FOUND);
  }
  const rows = await transaction
    .select()
    .from(agentSessions)
    .where(
      and(
        sessionTenantPredicate(principal),
        sql`${agentSessions.record}->'nativeRecoveryBinding'->>'originalAuthoritySessionId' = ${authoritySessionId}`,
        sql`${agentSessions.record}->'nativeRecoveryBinding'->>'logicalSessionId' = ${logicalSessionId}`,
      ),
    )
    .for("update");
  const children = rows.map(parseHostedSessionRow);
  for (const child of children) {
    if (child.version !== 2 || child.nativeRecoveryBinding === undefined) {
      throw new Error(SESSION_NOT_FOUND);
    }
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Lock each receipt and source in this transaction before accepting a child.
    const source = await sessionById(transaction, principal, child.parentSessionId ?? "", true);
    // oxlint-disable-next-line eslint/no-await-in-loop -- This follows the locked source for the same child.
    const operation = await operationById(
      transaction,
      principal,
      child.nativeRecoveryBinding.operationId,
      true,
    );
    assertRecoveredBuildContinuationChild(
      authoritySessionId,
      logicalSessionId,
      source,
      child,
      operation,
    );
  }
  const leaves = children.filter(
    (candidate) =>
      !children.some(
        (child) => child.version === 2 && child.parentSessionId === candidate.sessionId,
      ),
  );
  if (leaves.length > 1) {
    throw new Error("Recovered build continuation owner is ambiguous.");
  }
  const current = leaves[0] ?? authority;
  if (leaves.length === 0 && current.adapterSessionId !== logicalSessionId) {
    throw new Error(SESSION_NOT_FOUND);
  }
  return toDurableHostedSessionRecord(current);
}

/** Carry a decision written during parked-child activation into the atomic child creation. */
// oxlint-disable-next-line eslint/func-style -- The settlement calls this transaction-scoped helper before inserting its child.
async function withRecoveryBuildDecision(
  transaction: Transaction,
  principal: HostedPrincipal,
  operation: HostedOperationRecord,
  child: HostedSessionRecord,
): Promise<HostedSessionRecord> {
  const descriptor = operation.nativeRecovery;
  if (descriptor === undefined) {
    return child;
  }
  const authority = await sessionById(
    transaction,
    principal,
    descriptor.originalAuthoritySessionId,
    true,
  );
  // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Lock the original authority first so early projection and child creation serialize.
  const source = await sessionById(transaction, principal, descriptor.sourcePublicSessionId, true);
  if (authority === null || source === null) {
    throw new Error(SESSION_NOT_FOUND);
  }
  assertNativeRecoverySourceBinding(operation, source, descriptor);
  assertNativeRecoverySessionReceipt(operation, child);
  return inheritRecoveryBuildDecision(source, authority, child);
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function isExactReservation(existing: HostedOperationRecord, candidate: HostedOperationRecord) {
  return (
    existing.operationId === candidate.operationId &&
    existing.requestDigest === candidate.requestDigest &&
    existing.kind === candidate.kind &&
    existing.clientRequestId === candidate.clientRequestId &&
    (candidate.kind === "start" || existing.sessionId === candidate.sessionId) &&
    existing.resumeSessionId === candidate.resumeSessionId &&
    JSON.stringify(existing.nativeRecovery) === JSON.stringify(candidate.nativeRecovery) &&
    existing.startAlias?.canonicalClientRequestId ===
      candidate.startAlias?.canonicalClientRequestId &&
    existing.startAlias?.sourceHandoffId === candidate.startAlias?.sourceHandoffId
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function assertReserved(
  operation: HostedOperationRecord | null,
  requestDigest: string,
): asserts operation is Extract<HostedOperationRecord, { state: "reserved" }> {
  if (
    operation === null ||
    operation.state !== "reserved" ||
    operation.requestDigest !== requestDigest
  ) {
    throw new Error("Hosted operation is not reserved at this digest.");
  }
}

/**
 * Durable tenant-scoped store. The JSON record is the closed authority; every
 * duplicated index column is re-bound to it on read before it can be used.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createPostgresHostedEveStore(database: Database): HostedEveStore {
  const checkpointHistory = createPostgresHostedCheckpointHistory(database);
  return {
    async bindExistingStart(principalInput, candidateInput) {
      const principal = hostedPrincipalSchema.parse(principalInput);
      const candidate = hostedOperationRecordSchema.parse(candidateInput);
      if (
        candidate.sessionId === undefined ||
        tenantKeyFor(principal) !== tenantKeyFor(candidate.principal)
      ) {
        throw new Error("Hosted store principal mismatch.");
      }
      const { sessionId } = candidate;
      return await database.transaction(async (transaction) => {
        const session = await sessionById(transaction, principal, sessionId, true);
        if (session === null) {
          throw new Error(SESSION_NOT_FOUND);
        }
        assertExistingStartSession(candidate, session);
        const inserted = await transaction
          .insert(agentOperations)
          .values(operationValues(candidate))
          .onConflictDoNothing()
          .returning();
        if (inserted[0] !== undefined) {
          return parseHostedOperationRow(inserted[0]);
        }
        const existing = await operationByRequest(
          transaction,
          principal,
          "start",
          candidate.clientRequestId,
        );
        if (existing === null || !isExactReservation(existing, candidate)) {
          throw new Error("The existing-session start request conflicts with its saved receipt.");
        }
        return existing;
      });
    },
    async claimInternalBuildMessage(input) {
      const principal = hostedPrincipalSchema.parse(input.principal);
      return await database.transaction(async (transaction) => {
        const priorOperation =
          input.logicalSessionId === undefined
            ? await operationById(transaction, principal, input.operationId, false)
            : null;
        const logicalSessionId =
          input.logicalSessionId ??
          priorOperation?.internalBuildContinuation?.decision.adapterSessionId;
        if (logicalSessionId === undefined) {
          return false;
        }
        const current = await currentBuildSession(
          transaction,
          principal,
          input.sessionId,
          logicalSessionId,
        );
        // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Lock the current owner before the marker operation to keep a consistent transaction order.
        const operation = await operationById(transaction, principal, input.operationId, true);
        const marker = operation?.internalBuildContinuation;
        if (
          operation === null ||
          marker === undefined ||
          operation.state === "rejected" ||
          operation.sessionId !== current.sessionId ||
          marker.decision.adapterSessionId !== current.adapterSessionId ||
          marker.nonce !== input.nonce ||
          input.turnSequence <= marker.decision.turnSequence
        ) {
          return false;
        }
        if (marker.deliveredTurnId !== undefined) {
          return (
            marker.deliveredTurnId === input.turnId &&
            marker.deliveredMessageSequence === input.messageSequence
          );
        }
        const updated = hostedOperationRecordSchema.parse({
          ...operation,
          internalBuildContinuation: {
            ...marker,
            deliveredMessageSequence: input.messageSequence,
            deliveredTurnId: input.turnId,
          },
        });
        const rows = await transaction
          .update(agentOperations)
          .set(operationValues(updated))
          .where(
            and(tenantPredicate(principal), eq(agentOperations.operationId, input.operationId)),
          )
          .returning();
        if (rows.length !== 1) {
          throw new Error("Internal continuation receipt was not durable.");
        }
        parseHostedOperationRow(rows[0]);
        return true;
      });
    },

    async getPrivateOperation(principal, operationId) {
      return await operationById(database, hostedPrincipalSchema.parse(principal), operationId);
    },
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
    async readCurrentBuildSession(input) {
      const principal = hostedPrincipalSchema.parse(input.principal);
      return await database.transaction(
        async (transaction) =>
          await currentBuildSession(
            transaction,
            principal,
            input.authoritySessionId,
            input.logicalSessionId,
          ),
      );
    },
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
    async getSession(principalInput, sessionId) {
      const principal = hostedPrincipalSchema.parse(principalInput);
      return sessionById(database, principal, sessionId);
    },

    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning store interface.
    async getSessionByAdapterSessionId(principalInput, adapterSessionId) {
      const principal = hostedPrincipalSchema.parse(principalInput);
      return sessionByAdapterSessionId(database, principal, adapterSessionId);
    },

    async getStartOperation(principalInput, clientRequestId) {
      const principal = hostedPrincipalSchema.parse(principalInput);
      return (
        (await operationByRequest(database, principal, "start", clientRequestId)) ??
        (await operationByRequest(database, principal, "resume", clientRequestId))
      );
    },

    async listSessions(input) {
      const principal = hostedPrincipalSchema.parse(input.principal);
      const rows = await database
        .select()
        .from(agentSessions)
        .where(sessionTenantPredicate(principal))
        .orderBy(desc(agentSessions.updatedAt), desc(agentSessions.sessionId))
        .offset(input.cursor)
        .limit(input.limit);
      return {
        cursor: input.cursor + rows.length,
        sessions: rows.map(parseHostedSessionRow),
      };
    },

    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
    async observeSession(input) {
      const principal = hostedPrincipalSchema.parse(input.principal);
      return database.transaction(async (transaction) => {
        const rows = await transaction
          .select()
          .from(agentSessions)
          .where(
            and(sessionTenantPredicate(principal), eq(agentSessions.sessionId, input.sessionId)),
          )
          .limit(1)
          .for("update");
        if (rows[0] === undefined) {
          throw new Error(SESSION_NOT_FOUND);
        }
        const current = toDurableHostedSessionRecord(parseHostedSessionRow(rows[0]));
        const explicitSend =
          input.explicitSendOperationId === undefined
            ? null
            : await operationById(transaction, principal, input.explicitSendOperationId);
        const provedResume = mayReviveCancelledSession(
          explicitSend,
          current,
          input.checkpoint.nativeDeliveryState,
        );
        // Passive observations never undo Stop; exact native SEND proof is required.
        if (current.status === "cancelled" && !provedResume) {
          return current;
        }
        const checkpointDigest = hostedSessionCheckpointDigest(input.checkpoint);
        const checkpointProgressDigest = hostedSessionCheckpointProgressDigest(input.checkpoint);
        const { checkpointRef: priorCheckpointRef, ...inlineBase } = current;
        void priorCheckpointRef;
        const observed = durableHostedSessionRecordSchema.parse({
          ...inlineBase,
          ...(provedResume
            ? { resumedCancellationRevision: current.cancellationRevision ?? 0 }
            : {}),
          checkpoint: input.checkpoint,
          checkpointDigest,
          checkpointProgressDigest,
          ...(input.appId === undefined ? {} : { appId: input.appId }),
          lastProgressAtEpochMs:
            current.checkpointProgressDigest === checkpointProgressDigest
              ? current.lastProgressAtEpochMs
              : input.nowEpochMs,
          resumability: input.resumability,
          stage: input.stage,
          status: input.checkpoint.status,
          updatedAtEpochMs: input.nowEpochMs,
        });
        const updated = await transaction
          .update(agentSessions)
          .set(sessionValues(observed))
          .where(
            and(
              sessionTenantPredicate(principal),
              eq(agentSessions.sessionId, input.sessionId),
              eq(agentSessions.updatedAt, new Date(current.updatedAtEpochMs)),
            ),
          )
          .returning();
        if (updated.length !== 1) {
          throw new Error("Hosted session observation was not durable.");
        }
        return parseHostedSessionRow(updated[0]);
      });
    },

    async observeSessionPaged(input) {
      const principal = hostedPrincipalSchema.parse(input.principal);
      const metadataStatus = sessionStatusSchema.parse(
        z.object({ status: sessionStatusSchema }).parse(input.metadata).status,
      );
      const staged = await checkpointHistory.stage({
        events: input.events,
        metadata: input.metadata,
        nowEpochMs: input.nowEpochMs,
        principal,
        sessionId: input.sessionId,
      });
      try {
        const result = await database.transaction(async (transaction) => {
          const current = await sessionById(transaction, principal, input.sessionId, true);
          if (current === null) {
            throw new Error(SESSION_NOT_FOUND);
          }
          const durable = toDurableHostedSessionRecord(current);
          const explicitSend =
            input.explicitSendOperationId === undefined
              ? null
              : await operationById(transaction, principal, input.explicitSendOperationId);
          const provedResume = mayReviveCancelledSession(
            explicitSend,
            durable,
            input.metadata.nativeObservationState?.nativeDeliveryState ??
              input.metadata.coldReadProgress?.nativeObservationState.nativeDeliveryState ??
              input.metadata.nativeDeliveryState,
          );
          if (durable.status === "cancelled" && !provedResume) {
            return durable;
          }
          if (durable.checkpointDigest !== input.expectedCheckpointDigest) {
            throw new HostedCheckpointObservationConflictError();
          }
          await checkpointHistory.publishInTransaction(transaction, {
            checkpointDigest: staged.checkpointDigest,
            checkpointId: staged.checkpointId,
            eventCount: staged.eventCount,
            itemCount: staged.itemCount,
            nowEpochMs: input.nowEpochMs,
            principal,
            sessionId: input.sessionId,
          });
          const { checkpoint: priorInlineCheckpoint, ...pagedBase } = durable;
          void priorInlineCheckpoint;
          const observed = durableHostedSessionRecordSchema.parse({
            ...pagedBase,
            ...(provedResume
              ? { resumedCancellationRevision: durable.cancellationRevision ?? 0 }
              : {}),
            checkpointDigest: staged.checkpointDigest,
            checkpointProgressDigest: staged.checkpointProgressDigest,
            checkpointRef: {
              digest: staged.checkpointDigest,
              eventCount: staged.eventCount,
              id: staged.checkpointId,
            },
            ...(input.appId === undefined ? {} : { appId: input.appId }),
            lastProgressAtEpochMs:
              durable.checkpointProgressDigest === staged.checkpointProgressDigest
                ? durable.lastProgressAtEpochMs
                : input.nowEpochMs,
            resumability: input.resumability,
            stage: input.stage,
            status: metadataStatus,
            updatedAtEpochMs: input.nowEpochMs,
          });
          const updated = await transaction
            .update(agentSessions)
            .set(sessionValues(observed))
            .where(
              and(
                sessionTenantPredicate(principal),
                eq(agentSessions.sessionId, input.sessionId),
                eq(agentSessions.updatedAt, new Date(durable.updatedAtEpochMs)),
              ),
            )
            .returning();
          if (updated.length !== 1) {
            throw new Error("Hosted paged checkpoint observation was not durable.");
          }
          return parseHostedSessionRow(updated[0]);
        });
        if (result.version !== 2 || result.checkpointRef?.id !== staged.checkpointId) {
          await checkpointHistory.discardStage({
            checkpointId: staged.checkpointId,
            principal,
            sessionId: input.sessionId,
          });
        }
        return result;
      } catch (error) {
        await checkpointHistory.discardStage({
          checkpointId: staged.checkpointId,
          principal,
          sessionId: input.sessionId,
        });
        throw error;
      }
    },

    async readCheckpointPage(input) {
      const principal = hostedPrincipalSchema.parse(input.principal);
      const checkpointRef = hostedCheckpointRefSchema.parse(input.checkpointRef);
      const current = await sessionById(database, principal, input.sessionId);
      if (current?.version !== 2) {
        throw new Error("Hosted checkpoint session was not found or is not durable.");
      }
      // A reader retains one immutable published manifest while concurrent
      // observations advance the session's active pointer. History independently
      // binds that selected manifest to the same tenant, owner, and session.
      const page = await checkpointHistory.readPage({
        checkpointId: checkpointRef.id,
        cursor: input.cursor,
        limit: input.limit,
        principal,
        sessionId: input.sessionId,
      });
      if (
        page === null ||
        page.checkpointDigest !== checkpointRef.digest ||
        page.totalEvents !== checkpointRef.eventCount
      ) {
        throw new Error("Hosted checkpoint manifest does not match the selected reference.");
      }
      return { ...page, checkpointDigest: checkpointRef.digest };
    },

    async recordPrivateApprovalReceipts(input) {
      const principal = hostedPrincipalSchema.parse(input.principal);
      await database.transaction(async (transaction) => {
        const current = await sessionById(transaction, principal, input.sessionId, true);
        if (current === null) {
          throw new Error(SESSION_NOT_FOUND);
        }
        const durable = toDurableHostedSessionRecord(current);
        const updated = durableHostedSessionRecordSchema.parse({
          ...durable,
          privateApprovalReceipts: mergePrivateHostedApprovalReceipts(
            input.sessionId,
            durable.privateApprovalReceipts,
            input.receipts,
          ),
        });
        const rows = await transaction
          .update(agentSessions)
          .set(sessionValues(updated))
          .where(
            and(
              sessionTenantPredicate(principal),
              eq(agentSessions.sessionId, input.sessionId),
              eq(agentSessions.updatedAt, new Date(durable.updatedAtEpochMs)),
            ),
          )
          .returning();
        if (rows.length !== 1) {
          throw new Error("Private Eve approval receipt was not durable.");
        }
        parseHostedSessionRow(rows[0]);
      });
    },
    async recordPrivateBuildDecision(input) {
      const principal = hostedPrincipalSchema.parse(input.principal);
      await database.transaction(async (transaction) => {
        const decision = approvedBuildDecisionSchema.parse(input.decision);
        const current = await currentBuildSession(
          transaction,
          principal,
          input.sessionId,
          decision.adapterSessionId,
        );
        const boundDecision = recoveredBuildDecision(decision, current);
        if (boundDecision === undefined) {
          throw new Error(SESSION_NOT_FOUND);
        }
        if ((current.privateBuildDecision?.turnSequence ?? -1) > decision.turnSequence) {
          return;
        }
        const updated = durableHostedSessionRecordSchema.parse({
          ...current,
          privateBuildDecision: boundDecision,
        });
        const rows = await transaction
          .update(agentSessions)
          .set(sessionValues(updated))
          .where(
            and(sessionTenantPredicate(principal), eq(agentSessions.sessionId, current.sessionId)),
          )
          .returning();
        if (rows.length !== 1) {
          throw new Error("Private build decision was not durable.");
        }
        parseHostedSessionRow(rows[0]);
      });
    },

    recordCancellationIntent(input) {
      const principal = hostedPrincipalSchema.parse(input.principal);
      return database.transaction(async (transaction) => {
        const row = await sessionById(transaction, principal, input.sessionId, true);
        if (row === null) {
          throw new Error(SESSION_NOT_FOUND);
        }
        const current = toDurableHostedSessionRecord(row);
        const updated = durableHostedSessionRecordSchema.parse({
          ...current,
          cancellationRevision: (current.cancellationRevision ?? 0) + 1,
          updatedAtEpochMs: Math.max(current.updatedAtEpochMs, input.nowEpochMs),
        });
        const rows = await transaction
          .update(agentSessions)
          .set(sessionValues(updated))
          .where(
            and(sessionTenantPredicate(principal), eq(agentSessions.sessionId, input.sessionId)),
          )
          .returning();
        if (rows.length !== 1) {
          throw new Error("Cancellation intent was not durable.");
        }
        return parseHostedSessionRow(rows[0]);
      });
    },

    // oxlint-disable-next-line eslint/require-await -- Keep the canonical asynchronous transaction API, including validation rejection.
    async recordSendDelivery(input) {
      const principal = hostedPrincipalSchema.parse(input.principal);
      return database.transaction(async (transaction) => {
        const operationRow = await operationRowById(
          transaction,
          principal,
          input.operationId,
          true,
        );
        if (operationRow === null) {
          throw new Error(OPERATION_CANNOT_SETTLE);
        }
        const operation = parseHostedOperationRow(operationRow);
        const current = await sessionById(transaction, principal, input.delivery.sessionId, true);
        const revision =
          input.cancellationRevisionAtDispatch === undefined
            ? undefined
            : z.number().int().nonnegative().parse(input.cancellationRevisionAtDispatch);
        if (
          revision !== undefined &&
          (current === null ||
            revision !== (toDurableHostedSessionRecord(current).cancellationRevision ?? 0) ||
            (operationRow.sendCancellationRevisionAtDispatch !== null &&
              operationRow.sendCancellationRevisionAtDispatch !== revision))
        ) {
          throw new Error("Canonical SEND acknowledgement cancellation revision changed.");
        }
        const updated = hostedOperationRecordSchema.parse({
          ...bindSendDelivery(operation, current, input.delivery),
          updatedAtEpochMs: input.nowEpochMs,
        });
        const rows = await transaction
          .update(agentOperations)
          .set({
            ...operationValues(updated),
            // An old ACK has no dispatch baseline; retries must never invent one.
            ...(operation.sendDelivery === undefined && revision !== undefined
              ? { sendCancellationRevisionAtDispatch: revision }
              : {}),
          })
          .where(
            and(
              tenantPredicate(principal),
              eq(agentOperations.operationId, input.operationId),
              eq(agentOperations.requestDigest, input.delivery.requestDigest),
            ),
          )
          .returning();
        if (rows.length !== 1) {
          throw new Error(OPERATION_CANNOT_SETTLE);
        }
        return parseHostedOperationRow(rows[0]);
      });
    },

    async readUnsettledSendAcknowledgements(input) {
      const principal = hostedPrincipalSchema.parse(input.principal);
      // Leave one exactly representable slot for the pagination lookahead.
      const limit = z
        .number()
        .int()
        .positive()
        .max(Number.MAX_SAFE_INTEGER - 1)
        .parse(input.limit);
      const cursor =
        input.cursor === undefined
          ? undefined
          : sendAcknowledgementCursorSchema.parse(input.cursor);
      const rows = await database
        .select()
        .from(agentOperations)
        .where(
          and(
            tenantPredicate(principal),
            eq(agentOperations.sessionId, input.sessionId),
            eq(agentOperations.kind, "send"),
            inArray(agentOperations.state, ["reserved", "submission_unknown"]),
            sql`${agentOperations.record}->'sendDelivery' IS NOT NULL`,
            sql`${agentOperations.record}->'internalBuildContinuation' IS NULL`,
            input.operationId === undefined
              ? undefined
              : eq(agentOperations.operationId, input.operationId),
            cursor === undefined
              ? undefined
              : or(
                  gt(agentOperations.createdAt, new Date(cursor.createdAtEpochMs)),
                  and(
                    eq(agentOperations.createdAt, new Date(cursor.createdAtEpochMs)),
                    gt(agentOperations.operationId, cursor.operationId),
                  ),
                ),
          ),
        )
        .orderBy(asc(agentOperations.createdAt), asc(agentOperations.operationId))
        .limit(limit + 1);
      const acknowledgements = rows.slice(0, limit).map((inputRow) => {
        const row = operationRowSchema.parse(inputRow);
        return {
          operation: parseHostedOperationRow(row),
          cancellationRevisionAtDispatch: row.sendCancellationRevisionAtDispatch,
        };
      });
      const last = acknowledgements.at(-1)?.operation;
      return unsettledSendAcknowledgementPageSchema.parse({
        acknowledgements,
        ...(rows.length > limit && last !== undefined
          ? {
              nextCursor: {
                createdAtEpochMs: last.createdAtEpochMs,
                operationId: last.operationId,
              },
            }
          : {}),
      });
    },

    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
    async replaceSessionAdapter(input) {
      const principal = hostedPrincipalSchema.parse(input.principal);
      return database.transaction(async (transaction) => {
        const row = await sessionById(transaction, principal, input.sessionId, true);
        if (row === null) {
          throw new Error(SESSION_NOT_FOUND);
        }
        const current = toDurableHostedSessionRecord(row);
        if (
          current.adapterGeneration !== input.expectedAdapterGeneration ||
          current.checkpointDigest !== input.expectedCheckpointDigest
        ) {
          throw new Error("Hosted session recovery raced another continuation.");
        }
        const { checkpointRef: priorCheckpointRef, ...inlineBase } = current;
        void priorCheckpointRef;
        const replaced = durableHostedSessionRecordSchema.parse({
          ...inlineBase,
          adapterGeneration: current.adapterGeneration + 1,
          adapterSessionId: input.adapterSessionId,
          checkpoint: input.checkpoint,
          checkpointDigest: hostedSessionCheckpointDigest(input.checkpoint),
          checkpointProgressDigest: hostedSessionCheckpointProgressDigest(input.checkpoint),
          ...(input.appId === undefined ? {} : { appId: input.appId }),
          lastProgressAtEpochMs: input.nowEpochMs,
          resumability: input.resumability,
          stage: input.stage,
          status: input.checkpoint.status,
          updatedAtEpochMs: input.nowEpochMs,
        });
        const updated = await transaction
          .update(agentSessions)
          .set(sessionValues(replaced))
          .where(
            and(
              sessionTenantPredicate(principal),
              eq(agentSessions.sessionId, input.sessionId),
              eq(agentSessions.adapterSessionId, current.adapterSessionId),
              eq(agentSessions.updatedAt, new Date(current.updatedAtEpochMs)),
            ),
          )
          .returning();
        if (updated.length !== 1) {
          throw new Error("Hosted session recovery was not durable.");
        }
        return parseHostedSessionRow(updated[0]);
      });
    },

    async replaceSessionAdapterPaged(input) {
      const principal = hostedPrincipalSchema.parse(input.principal);
      const metadataStatus = sessionStatusSchema.parse(
        z.object({ status: sessionStatusSchema }).parse(input.metadata).status,
      );
      const staged = await checkpointHistory.stage({
        events: input.events,
        metadata: input.metadata,
        nowEpochMs: input.nowEpochMs,
        principal,
        sessionId: input.sessionId,
      });
      try {
        const result = await database.transaction(async (transaction) => {
          const row = await sessionById(transaction, principal, input.sessionId, true);
          if (row === null) {
            throw new Error(SESSION_NOT_FOUND);
          }
          const current = toDurableHostedSessionRecord(row);
          if (
            current.adapterGeneration !== input.expectedAdapterGeneration ||
            current.checkpointDigest !== input.expectedCheckpointDigest
          ) {
            throw new Error("Hosted session recovery raced another continuation.");
          }
          await checkpointHistory.publishInTransaction(transaction, {
            checkpointDigest: staged.checkpointDigest,
            checkpointId: staged.checkpointId,
            eventCount: staged.eventCount,
            itemCount: staged.itemCount,
            nowEpochMs: input.nowEpochMs,
            principal,
            sessionId: input.sessionId,
          });
          const { checkpoint: priorInlineCheckpoint, ...pagedBase } = current;
          void priorInlineCheckpoint;
          const replaced = durableHostedSessionRecordSchema.parse({
            ...pagedBase,
            adapterGeneration: current.adapterGeneration + 1,
            adapterSessionId: input.adapterSessionId,
            checkpointDigest: staged.checkpointDigest,
            checkpointProgressDigest: staged.checkpointProgressDigest,
            checkpointRef: {
              digest: staged.checkpointDigest,
              eventCount: staged.eventCount,
              id: staged.checkpointId,
            },
            ...(input.appId === undefined ? {} : { appId: input.appId }),
            lastProgressAtEpochMs: input.nowEpochMs,
            resumability: input.resumability,
            stage: input.stage,
            status: metadataStatus,
            updatedAtEpochMs: input.nowEpochMs,
          });
          const updated = await transaction
            .update(agentSessions)
            .set(sessionValues(replaced))
            .where(
              and(
                sessionTenantPredicate(principal),
                eq(agentSessions.sessionId, input.sessionId),
                eq(agentSessions.adapterSessionId, current.adapterSessionId),
                eq(agentSessions.updatedAt, new Date(current.updatedAtEpochMs)),
              ),
            )
            .returning();
          if (updated.length !== 1) {
            throw new Error("Hosted session recovery was not durable.");
          }
          return parseHostedSessionRow(updated[0]);
        });
        return result;
      } catch (error) {
        await checkpointHistory.discardStage({
          checkpointId: staged.checkpointId,
          principal,
          sessionId: input.sessionId,
        });
        throw error;
      }
    },

    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
    async reserveOperation(principalInput, candidateInput) {
      const principal = hostedPrincipalSchema.parse(principalInput);
      const candidate = hostedOperationRecordSchema.parse(candidateInput);
      if (
        candidate.state !== "reserved" ||
        tenantKeyFor(candidate.principal) !== tenantKeyFor(principal)
      ) {
        return { disposition: "conflict" };
      }

      return database.transaction(async (transaction) => {
        const existing = await operationById(transaction, principal, candidate.operationId);
        if (existing !== null) {
          return isExactReservation(existing, candidate)
            ? { disposition: "existing" as const, operation: existing }
            : { disposition: "conflict" as const };
        }
        const requestExisting = await operationByRequest(
          transaction,
          principal,
          candidate.kind,
          candidate.clientRequestId,
        );
        if (requestExisting !== null) {
          return isExactReservation(requestExisting, candidate)
            ? { disposition: "existing" as const, operation: requestExisting }
            : { disposition: "conflict" as const };
        }
        if (candidate.kind !== "start") {
          if (
            candidate.sessionId === undefined ||
            (await sessionById(transaction, principal, candidate.sessionId, true)) === null
          ) {
            return { disposition: "conflict" as const };
          }
          const active = await transaction
            .select({ value: count() })
            .from(agentOperations)
            .where(
              and(
                tenantPredicate(principal),
                eq(agentOperations.sessionId, candidate.sessionId),
                eq(agentOperations.state, "reserved"),
                ne(agentOperations.operationId, candidate.operationId),
              ),
            );
          if ((active[0]?.value ?? 0) > 0) {
            return {
              disposition: "rejected" as const,
              reason: "session_busy" as const,
            };
          }
        }
        if (candidate.kind === "start" && candidate.resumeSessionId !== undefined) {
          const source = await sessionById(transaction, principal, candidate.resumeSessionId, true);
          if (source === null) {
            return { disposition: "conflict" as const };
          }
          if (candidate.nativeRecovery !== undefined) {
            assertNativeRecoverySourceBinding(candidate, source, candidate.nativeRecovery);
          }
          const activeResume = await transaction
            .select({ value: count() })
            .from(agentOperations)
            .where(
              and(
                tenantPredicate(principal),
                eq(agentOperations.kind, "start"),
                or(
                  inArray(agentOperations.state, ["reserved", "submission_unknown"]),
                  ...(candidate.nativeRecovery === undefined
                    ? []
                    : [sql`${agentOperations.record}->'nativeRecoveryReceipt' is not null`]),
                ),
                sql`${agentOperations.record}->>'resumeSessionId' = ${candidate.resumeSessionId}`,
                ne(agentOperations.operationId, candidate.operationId),
              ),
            );
          if ((activeResume[0]?.value ?? 0) > 0) {
            return {
              disposition: "rejected" as const,
              reason: "session_busy" as const,
            };
          }
        }
        try {
          const inserted = await transaction
            .insert(agentOperations)
            .values(operationValues(candidate))
            .returning();
          if (inserted.length !== 1) {
            throw new Error("Hosted operation reservation was not durable.");
          }
          return {
            disposition: "reserved" as const,
            operation: parseHostedOperationRow(inserted[0]),
          };
        } catch (error) {
          const raced =
            (await operationById(transaction, principal, candidate.operationId)) ??
            (await operationByRequest(
              transaction,
              principal,
              candidate.kind,
              candidate.clientRequestId,
            ));
          if (raced === null) {
            throw error;
          }
          return isExactReservation(raced, candidate)
            ? { disposition: "existing" as const, operation: raced }
            : { disposition: "conflict" as const };
        }
      });
    },

    // oxlint-disable-next-line eslint/require-await -- Transaction ownership is returned as the store's async contract.
    async commitNativeRecoveryReceipt(input) {
      const principal = hostedPrincipalSchema.parse(input.principal);
      const descriptor = nativeRecoveryDescriptorSchema.parse(input.descriptor);
      const receipt = nativeRecoveryBindingSchema.parse(input.recoveryBinding);
      assertNativeRecoveryReceipt(descriptor, receipt);
      return database.transaction(async (transaction) => {
        const operation = await operationById(transaction, principal, descriptor.operationId, true);
        if (operation === null) {
          throw new Error("Native recovery reservation is unavailable.");
        }
        const source = await sessionById(
          transaction,
          principal,
          descriptor.sourcePublicSessionId,
          true,
        );
        assertNativeRecoverySourceBinding(operation, source, descriptor);
        if (operation.nativeRecoveryReceipt !== undefined) {
          if (JSON.stringify(operation.nativeRecoveryReceipt) !== JSON.stringify(receipt)) {
            throw new Error("Native recovery owner receipt conflicts.");
          }
          return operation.nativeRecoveryReceipt;
        }
        if (operation.state === "succeeded") {
          throw new Error("Native recovery receipt was not committed before activation.");
        }
        const updated = hostedOperationRecordSchema.parse({
          ...operation,
          nativeRecoveryReceipt: receipt,
          updatedAtEpochMs: Math.max(operation.updatedAtEpochMs, input.nowEpochMs),
        });
        const rows = await transaction
          .update(agentOperations)
          .set(operationValues(updated))
          .where(
            and(tenantPredicate(principal), eq(agentOperations.operationId, operation.operationId)),
          )
          .returning();
        if (rows.length !== 1) {
          throw new Error("Native recovery owner receipt was not durable.");
        }
        const committed = parseHostedOperationRow(rows[0]).nativeRecoveryReceipt;
        if (committed === undefined) {
          throw new Error("Native recovery owner receipt was not durable.");
        }
        return committed;
      });
    },

    async settleIdleReservations(input) {
      const principal = hostedPrincipalSchema.parse(input.principal);
      return await database.transaction(async (transaction) => {
        if ((await sessionById(transaction, principal, input.sessionId, true)) === null) {
          throw new Error(SESSION_NOT_FOUND);
        }
        const rows = await transaction
          .select()
          .from(agentOperations)
          .where(
            and(
              tenantPredicate(principal),
              eq(agentOperations.sessionId, input.sessionId),
              eq(agentOperations.state, "reserved"),
              ne(agentOperations.kind, "start"),
              lte(agentOperations.updatedAt, new Date(input.beforeEpochMs)),
            ),
          )
          .for("update");
        await Promise.all(
          rows.map(async (row) => {
            const operation = parseHostedOperationRow(row);
            const settled = hostedOperationRecordSchema.parse({
              ...operation,
              safeErrorCode: "submission_unknown",
              state: "submission_unknown",
              updatedAtEpochMs: input.nowEpochMs,
            });
            const updated = await transaction
              .update(agentOperations)
              .set(operationValues(settled))
              .where(
                and(
                  tenantPredicate(principal),
                  eq(agentOperations.operationId, operation.operationId),
                  eq(agentOperations.state, "reserved"),
                ),
              )
              .returning();
            if (updated.length !== 1) {
              throw new Error("Hosted idle operation settlement was not durable.");
            }
            parseHostedOperationRow(updated[0]);
          }),
        );
        return rows.length;
      });
    },

    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
    async settleStartAlias(input) {
      const principal = hostedPrincipalSchema.parse(input.principal);
      await database.transaction(async (transaction) => {
        const [alias, canonical] = await Promise.all([
          operationByRequest(transaction, principal, "start", input.clientRequestId),
          operationByRequest(transaction, principal, "start", input.canonicalClientRequestId),
        ]);
        if (alias === null || canonical === null) {
          throw new Error("The original start request binding is unavailable.");
        }
        const settled = succeededStartAlias(alias, canonical);
        const updated = await transaction
          .update(agentOperations)
          .set(operationValues(settled))
          .where(
            and(
              tenantPredicate(principal),
              eq(agentOperations.operationId, alias.operationId),
              eq(agentOperations.requestDigest, alias.requestDigest),
            ),
          )
          .returning();
        if (updated.length !== 1) {
          throw new Error("The original start request binding was not durable.");
        }
        parseHostedOperationRow(updated[0]);
      });
    },

    // oxlint-disable-next-line eslint/require-await -- Preserve the existing Promise-returning store interface.
    async settleSucceeded(input) {
      const principal = hostedPrincipalSchema.parse(input.principal);
      return database.transaction(async (transaction) => {
        const operation = await operationById(transaction, principal, input.operationId, true);
        if (operation === null || operation.requestDigest !== input.requestDigest) {
          throw new Error(OPERATION_CANNOT_SETTLE);
        }
        const replayableStart =
          operation.kind === "start" && operation.state === "submission_unknown";
        const deliveredInternal =
          operation.kind === "send" &&
          operation.state === "submission_unknown" &&
          operation.internalBuildContinuation?.deliveredTurnId !== undefined &&
          operation.internalBuildContinuation.deliveredMessageSequence !== undefined;
        const current =
          (operation.internalSessionLimitResponse !== undefined ||
            operation.kind === "send" ||
            input.resourceApprovalResolution !== undefined) &&
          operation.sessionId !== undefined
            ? await sessionById(transaction, principal, operation.sessionId, true)
            : null;
        const provedResponse = isProvedSessionLimitResponse(
          operation,
          current,
          input.sessionLimitResolution,
        );
        const provedSend = isProvedSendDelivery(operation, current, input.sendDeliveryResolution);
        let provedApproval = false;
        if (
          input.resourceApprovalResolution !== undefined &&
          current?.version === 2 &&
          current.checkpointRef !== undefined
        ) {
          const page = await checkpointHistory.readPage({
            principal,
            sessionId: current.sessionId,
            checkpointId: current.checkpointRef.id,
            cursor: current.checkpointRef.eventCount,
            limit: 1,
            transaction,
          });
          if (
            page !== null &&
            page.checkpointDigest === current.checkpointRef.digest &&
            page.totalEvents === current.checkpointRef.eventCount
          ) {
            provedApproval = isProvedResourceApprovalResponse(
              operation,
              current,
              input.resourceApprovalResolution,
              page.metadata,
            );
          }
        }

        if (input.resourceApprovalResolution !== undefined && !provedApproval) {
          throw new Error("Resource approval settlement is not proved.");
        }
        if (
          operation.kind === "send" &&
          operation.internalBuildContinuation === undefined &&
          !provedSend
        ) {
          throw new Error("Canonical SEND delivery is not proved.");
        }
        if (
          operation.state !== "reserved" &&
          !replayableStart &&
          !deliveredInternal &&
          !(
            operation.state === "submission_unknown" &&
            (provedResponse || provedSend || provedApproval)
          )
        ) {
          throw new Error(OPERATION_CANNOT_SETTLE);
        }
        const result = eveSessionResultSchema.parse(input.result);
        let session =
          input.session === undefined ? undefined : hostedSessionRecordSchema.parse(input.session);
        if (session !== undefined && tenantKeyFor(session.principal) !== tenantKeyFor(principal)) {
          throw new Error("Hosted store principal mismatch.");
        }
        if (operation.kind === "start" && session === undefined) {
          throw new Error("A successful start must atomically persist its session.");
        }
        if (session !== undefined && operation.nativeRecovery !== undefined) {
          session = await withRecoveryBuildDecision(transaction, principal, operation, session);
        }
        if (operation.kind !== "start" && session !== undefined) {
          throw new Error("Only start may create a hosted session.");
        }
        const expectedSessionId = session?.sessionId ?? operation.sessionId;
        if (expectedSessionId === undefined || result.sessionId !== expectedSessionId) {
          throw new Error("Hosted operation result session mismatch.");
        }
        const settled = hostedOperationRecordSchema.parse({
          ...withoutHostedOperationError(operation),
          result,
          sessionId: result.sessionId,
          state: "succeeded",
          ...(session === undefined
            ? {}
            : {
                sessionRecordDigest: hostedSessionCreationDigest(session),
              }),
          updatedAtEpochMs: input.nowEpochMs,
        });
        if (session !== undefined) {
          const insertedSession = await transaction
            .insert(agentSessions)
            .values(sessionValues(session))
            .returning();
          if (insertedSession.length !== 1) {
            throw new Error("Hosted session creation was not durable.");
          }
          parseHostedSessionRow(insertedSession[0]);
        }
        const updated = await transaction
          .update(agentOperations)
          .set(operationValues(settled))
          .where(
            and(
              tenantPredicate(principal),
              eq(agentOperations.operationId, input.operationId),
              inArray(agentOperations.state, ["reserved", "submission_unknown"]),
              eq(agentOperations.requestDigest, input.requestDigest),
            ),
          )
          .returning();
        if (updated.length !== 1) {
          throw new Error(OPERATION_SETTLEMENT_NOT_DURABLE);
        }
        return parseHostedOperationRow(updated[0]);
      });
    },

    // oxlint-disable-next-line eslint/require-await -- Async keeps this Promise-returning store contract consistent.
    async settleSucceededPaged(input) {
      const principal = hostedPrincipalSchema.parse(input.principal);
      let base = durableHostedSessionRecordSchema.parse(input.session);
      if (
        base.version !== 2 ||
        base.checkpoint !== undefined ||
        base.checkpointRef !== undefined ||
        base.checkpointDigest !== undefined ||
        base.checkpointProgressDigest !== undefined ||
        tenantKeyFor(base.principal) !== tenantKeyFor(principal)
      ) {
        throw new Error("Paged hosted session creation needs an uncheckpointed tenant session.");
      }
      return database.transaction(async (transaction) => {
        const operation = await operationById(transaction, principal, input.operationId, true);
        if (operation === null || operation.requestDigest !== input.requestDigest) {
          throw new Error(OPERATION_CANNOT_SETTLE);
        }
        const replayableStart =
          operation.kind === "start" && operation.state === "submission_unknown";
        const deliveredInternal =
          operation.kind === "send" &&
          operation.state === "submission_unknown" &&
          operation.internalBuildContinuation?.deliveredTurnId !== undefined &&
          operation.internalBuildContinuation.deliveredMessageSequence !== undefined;
        if (operation.state !== "reserved" && !replayableStart && !deliveredInternal) {
          throw new Error(OPERATION_CANNOT_SETTLE);
        }
        if (operation.kind !== "start") {
          throw new Error("Only start may atomically create a paged hosted session.");
        }
        const result = eveSessionResultSchema.parse(input.result);
        if (result.sessionId !== base.sessionId) {
          throw new Error("Hosted operation result session mismatch.");
        }
        if (operation.nativeRecovery !== undefined) {
          base = durableHostedSessionRecordSchema.parse(
            await withRecoveryBuildDecision(transaction, principal, operation, base),
          );
        }
        const insertedBase = await transaction
          .insert(agentSessions)
          .values(sessionValues(base))
          .returning();
        if (insertedBase.length !== 1) {
          throw new Error("Hosted session creation was not durable.");
        }
        parseHostedSessionRow(insertedBase[0]);
        const staged = await checkpointHistory.stage({
          events: input.events,
          metadata: input.metadata,
          nowEpochMs: input.nowEpochMs,
          principal,
          sessionId: base.sessionId,
          transaction,
        });
        const session = durableHostedSessionRecordSchema.parse({
          ...base,
          checkpointDigest: staged.checkpointDigest,
          checkpointProgressDigest: staged.checkpointProgressDigest,
          checkpointRef: {
            digest: staged.checkpointDigest,
            eventCount: staged.eventCount,
            id: staged.checkpointId,
          },
        });
        const updatedSession = await transaction
          .update(agentSessions)
          .set(sessionValues(session))
          .where(
            and(sessionTenantPredicate(principal), eq(agentSessions.sessionId, session.sessionId)),
          )
          .returning();
        if (updatedSession.length !== 1) {
          throw new Error("Hosted session checkpoint pointer was not durable.");
        }
        parseHostedSessionRow(updatedSession[0]);
        await checkpointHistory.publishInTransaction(transaction, {
          checkpointDigest: staged.checkpointDigest,
          checkpointId: staged.checkpointId,
          eventCount: staged.eventCount,
          itemCount: staged.itemCount,
          nowEpochMs: input.nowEpochMs,
          principal,
          sessionId: session.sessionId,
        });
        const settledOperation = hostedOperationRecordSchema.parse({
          ...withoutHostedOperationError(operation),
          result,
          sessionId: result.sessionId,
          sessionRecordDigest: hostedSessionCreationDigest(session),
          state: "succeeded",
          updatedAtEpochMs: input.nowEpochMs,
        });
        const updatedOperation = await transaction
          .update(agentOperations)
          .set(operationValues(settledOperation))
          .where(
            and(
              tenantPredicate(principal),
              eq(agentOperations.operationId, input.operationId),
              inArray(agentOperations.state, ["reserved", "submission_unknown"]),
              eq(agentOperations.requestDigest, input.requestDigest),
            ),
          )
          .returning();
        if (updatedOperation.length !== 1) {
          throw new Error(OPERATION_SETTLEMENT_NOT_DURABLE);
        }
        return parseHostedOperationRow(updatedOperation[0]);
      });
    },

    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
    async settleUnsuccessful(input) {
      const principal = hostedPrincipalSchema.parse(input.principal);
      return database.transaction(async (transaction) => {
        const operation = await operationById(transaction, principal, input.operationId, true);
        assertReserved(operation, input.requestDigest);
        const settled = hostedOperationRecordSchema.parse({
          ...operation,
          safeErrorCode: input.safeErrorCode,
          state: input.state,
          updatedAtEpochMs: input.nowEpochMs,
        });
        const updated = await transaction
          .update(agentOperations)
          .set(operationValues(settled))
          .where(
            and(
              tenantPredicate(principal),
              eq(agentOperations.operationId, input.operationId),
              eq(agentOperations.state, "reserved"),
              eq(agentOperations.requestDigest, input.requestDigest),
            ),
          )
          .returning();
        if (updated.length !== 1) {
          throw new Error(OPERATION_SETTLEMENT_NOT_DURABLE);
        }
        return parseHostedOperationRow(updated[0]);
      });
    },
  };
}
