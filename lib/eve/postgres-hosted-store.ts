import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import * as databaseSchema from "../db/schema";
import { agentOperations, agentSessions } from "../db/schema";
import { eveSessionResultSchema } from "../mcp/contracts";
import {
  hostedPrincipalSchema,
  tenantKeyFor,
  type HostedPrincipal,
} from "./hosted-auth";
import {
  hostedOperationRecordSchema,
  hostedSessionRecordDigest,
  hostedSessionRecordSchema,
  type HostedEveStore,
  type HostedOperationRecord,
  type HostedSessionRecord,
} from "./hosted-store";

type Database = PostgresJsDatabase<typeof databaseSchema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const sessionRowSchema = z
  .object({
    issuer: z.string(),
    audience: z.string(),
    workspaceId: z.string(),
    ownerUserId: z.string(),
    sessionId: z.string(),
    adapterSessionId: z.string(),
    record: z.unknown(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();

const operationRowSchema = z
  .object({
    issuer: z.string(),
    audience: z.string(),
    workspaceId: z.string(),
    ownerUserId: z.string(),
    operationId: z.string(),
    sessionId: z.string().nullable(),
    kind: z.string(),
    clientRequestId: z.string(),
    requestDigest: z.string(),
    state: z.string(),
    record: z.unknown(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();

function tenantPredicate(principal: HostedPrincipal) {
  return and(
    eq(agentOperations.issuer, principal.issuer),
    eq(agentOperations.audience, principal.audience),
    eq(agentOperations.workspaceId, principal.workspaceId),
    eq(agentOperations.ownerUserId, principal.ownerUserId),
  );
}

function sessionTenantPredicate(principal: HostedPrincipal) {
  return and(
    eq(agentSessions.issuer, principal.issuer),
    eq(agentSessions.audience, principal.audience),
    eq(agentSessions.workspaceId, principal.workspaceId),
    eq(agentSessions.ownerUserId, principal.ownerUserId),
  );
}

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
    row.createdAt.getTime() !== record.createdAtEpochMs ||
    row.updatedAt.getTime() !== record.updatedAtEpochMs
  ) {
    throw new Error("Hosted session row is not canonically bound.");
  }
  return record;
}

function operationValues(record: HostedOperationRecord) {
  return {
    issuer: record.principal.issuer,
    audience: record.principal.audience,
    workspaceId: record.principal.workspaceId,
    ownerUserId: record.principal.ownerUserId,
    operationId: record.operationId,
    sessionId: record.sessionId ?? null,
    kind: record.kind,
    clientRequestId: record.clientRequestId,
    requestDigest: record.requestDigest,
    state: record.state,
    record,
    createdAt: new Date(record.createdAtEpochMs),
    updatedAt: new Date(record.updatedAtEpochMs),
  };
}

function sessionValues(record: HostedSessionRecord) {
  return {
    issuer: record.principal.issuer,
    audience: record.principal.audience,
    workspaceId: record.principal.workspaceId,
    ownerUserId: record.principal.ownerUserId,
    sessionId: record.sessionId,
    adapterSessionId: record.adapterSessionId,
    record,
    createdAt: new Date(record.createdAtEpochMs),
    updatedAt: new Date(record.updatedAtEpochMs),
  };
}

async function operationById(
  database: Database | Transaction,
  principal: HostedPrincipal,
  operationId: string,
  lock = false,
) {
  const query = database
    .select()
    .from(agentOperations)
    .where(
      and(
        tenantPredicate(principal),
        eq(agentOperations.operationId, operationId),
      ),
    )
    .limit(1);
  const rows = lock ? await query.for("update") : await query;
  return rows[0] === undefined ? null : parseHostedOperationRow(rows[0]);
}

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

function isExactReservation(
  existing: HostedOperationRecord,
  candidate: HostedOperationRecord,
) {
  return (
    existing.operationId === candidate.operationId &&
    existing.requestDigest === candidate.requestDigest &&
    existing.kind === candidate.kind &&
    existing.clientRequestId === candidate.clientRequestId &&
    existing.sessionId === candidate.sessionId
  );
}

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
export function createPostgresHostedEveStore(
  database: Database,
): HostedEveStore {
  return {
    async reserveOperation(principalInput, candidateInput) {
      const principal = hostedPrincipalSchema.parse(principalInput);
      const candidate = hostedOperationRecordSchema.parse(candidateInput);
      if (
        candidate.state !== "reserved" ||
        tenantKeyFor(candidate.principal) !== tenantKeyFor(principal)
      ) {
        return { disposition: "conflict" };
      }

      const existing = await operationById(
        database,
        principal,
        candidate.operationId,
      );
      if (existing !== null) {
        return isExactReservation(existing, candidate)
          ? { disposition: "existing", operation: existing }
          : { disposition: "conflict" };
      }
      const requestExisting = await operationByRequest(
        database,
        principal,
        candidate.kind,
        candidate.clientRequestId,
      );
      if (requestExisting !== null) {
        return isExactReservation(requestExisting, candidate)
          ? { disposition: "existing", operation: requestExisting }
          : { disposition: "conflict" };
      }

      try {
        const inserted = await database
          .insert(agentOperations)
          .values(operationValues(candidate))
          .returning();
        if (inserted.length !== 1) {
          throw new Error("Hosted operation reservation was not durable.");
        }
        return {
          disposition: "reserved",
          operation: parseHostedOperationRow(inserted[0]),
        };
      } catch (error) {
        const raced =
          (await operationById(database, principal, candidate.operationId)) ??
          (await operationByRequest(
            database,
            principal,
            candidate.kind,
            candidate.clientRequestId,
          ));
        if (raced === null) throw error;
        return isExactReservation(raced, candidate)
          ? { disposition: "existing", operation: raced }
          : { disposition: "conflict" };
      }
    },

    async settleSucceeded(input) {
      const principal = hostedPrincipalSchema.parse(input.principal);
      return database.transaction(async (transaction) => {
        const operation = await operationById(
          transaction,
          principal,
          input.operationId,
          true,
        );
        assertReserved(operation, input.requestDigest);
        const result = eveSessionResultSchema.parse(input.result);
        const session =
          input.session === undefined
            ? undefined
            : hostedSessionRecordSchema.parse(input.session);
        if (
          session !== undefined &&
          tenantKeyFor(session.principal) !== tenantKeyFor(principal)
        ) {
          throw new Error("Hosted store principal mismatch.");
        }
        if (operation.kind === "start" && session === undefined) {
          throw new Error(
            "A successful start must atomically persist its session.",
          );
        }
        if (operation.kind !== "start" && session !== undefined) {
          throw new Error("Only start may create a hosted session.");
        }
        const expectedSessionId = session?.sessionId ?? operation.sessionId;
        if (
          expectedSessionId === undefined ||
          result.sessionId !== expectedSessionId
        ) {
          throw new Error("Hosted operation result session mismatch.");
        }
        const settled = hostedOperationRecordSchema.parse({
          ...operation,
          state: "succeeded",
          sessionId: result.sessionId,
          result,
          ...(session === undefined
            ? {}
            : {
                sessionRecordDigest: hostedSessionRecordDigest(session),
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
              eq(agentOperations.state, "reserved"),
              eq(agentOperations.requestDigest, input.requestDigest),
            ),
          )
          .returning();
        if (updated.length !== 1) {
          throw new Error("Hosted operation settlement was not durable.");
        }
        return parseHostedOperationRow(updated[0]);
      });
    },

    async settleUnsuccessful(input) {
      const principal = hostedPrincipalSchema.parse(input.principal);
      return database.transaction(async (transaction) => {
        const operation = await operationById(
          transaction,
          principal,
          input.operationId,
          true,
        );
        assertReserved(operation, input.requestDigest);
        const settled = hostedOperationRecordSchema.parse({
          ...operation,
          state: input.state,
          safeErrorCode: input.safeErrorCode,
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
          throw new Error("Hosted operation settlement was not durable.");
        }
        return parseHostedOperationRow(updated[0]);
      });
    },

    async getSession(principalInput, sessionId) {
      const principal = hostedPrincipalSchema.parse(principalInput);
      const rows = await database
        .select()
        .from(agentSessions)
        .where(
          and(
            sessionTenantPredicate(principal),
            eq(agentSessions.sessionId, sessionId),
          ),
        )
        .limit(1);
      return rows[0] === undefined ? null : parseHostedSessionRow(rows[0]);
    },
  };
}
