/* oxlint-disable sonarjs/expression-complexity -- Immutable approval, owner, physical target and receipt comparisons remain explicit at each custody read. */
import {
  readIntegrationCapabilityEffect,
  appIntegrationCapabilityPlanDigest,
  appIntegrationCapabilityOperationRef,
  appIntegrationCapabilityRecordSchema,
} from "./app-integration-capability-contract";
import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { builderProvisioningJournals } from "../db/schema";
import type {
  AppIntegrationCapabilityPlan,
  AppIntegrationCapabilityRecord,
  AppIntegrationCapabilityEffectState,
} from "./app-integration-capability-contract";

export interface AppIntegrationCapabilityRow {
  operationRef: string;
  revision: number;
  record: AppIntegrationCapabilityRecord;
}
export interface AppIntegrationCapabilityStore {
  read: (
    authority: AppIntegrationCapabilityPlan["authority"],
    operationRef: string,
  ) => Promise<AppIntegrationCapabilityRow | undefined>;
  reserve: (plan: AppIntegrationCapabilityPlan) => Promise<AppIntegrationCapabilityRow>;
  compareAndSet: (
    row: AppIntegrationCapabilityRow,
    record: AppIntegrationCapabilityRecord,
  ) => Promise<AppIntegrationCapabilityRow | undefined>;
  claimLease: (
    row: AppIntegrationCapabilityRow,
  ) => Promise<AppIntegrationCapabilityRow | undefined>;
}
const unavailable = () => new Error("app_integration_capability_unavailable");
const preservesEffect = (
  before: AppIntegrationCapabilityEffectState,
  after: AppIntegrationCapabilityEffectState,
  fence?: number,
) => {
  if (
    !isDeepStrictEqual(
      after.retiredAttempts.slice(0, before.retiredAttempts.length),
      before.retiredAttempts,
    )
  ) {
    return false;
  }
  if (before.state === "applied") {
    return isDeepStrictEqual(before, after);
  }
  if (before.state === "idle") {
    return (
      isDeepStrictEqual(before.retiredAttempts, after.retiredAttempts) &&
      (after.state !== "pending" || after.attemptGeneration === fence)
    );
  }
  if (after.state === "idle") {
    return false;
  }
  if (before.attemptGeneration === after.attemptGeneration) {
    return (
      isDeepStrictEqual(before.retiredAttempts, after.retiredAttempts) &&
      (before.receipt === undefined || isDeepStrictEqual(before.receipt, after.receipt))
    );
  }
  return (
    before.receipt === undefined &&
    after.state === "pending" &&
    after.receipt === undefined &&
    after.attemptGeneration === fence &&
    after.retiredAttempts.length === before.retiredAttempts.length + 1 &&
    isDeepStrictEqual(after.retiredAttempts.at(-1), {
      attemptGeneration: before.attemptGeneration,
      proof: "authoritative-effect-not-applied",
    })
  );
};
export const initialAppIntegrationCapabilityRecord = (
  plan: AppIntegrationCapabilityPlan,
): AppIntegrationCapabilityRecord =>
  appIntegrationCapabilityRecordSchema.parse({
    approvalReceipts: [],
    effects: Object.fromEntries(plan.effects.map((effect) => [effect, { state: "idle" }])),
    kind: "app-integrations-capability-v1",
    plan,
    planDigest: appIntegrationCapabilityPlanDigest(plan),
  });
const matches = (authority: AppIntegrationCapabilityPlan["authority"], operationRef: string) =>
  and(
    eq(builderProvisioningJournals.issuer, authority.issuer),
    eq(builderProvisioningJournals.audience, authority.audience),
    eq(builderProvisioningJournals.workspaceId, authority.workspaceId),
    eq(builderProvisioningJournals.ownerUserId, authority.ownerUserId),
    eq(builderProvisioningJournals.requestId, operationRef),
    sql`${builderProvisioningJournals.record}->>'kind' = 'app-integrations-capability-v1'`,
  );
const parse = (
  row: typeof builderProvisioningJournals.$inferSelect,
): AppIntegrationCapabilityRow => {
  const record = appIntegrationCapabilityRecordSchema.parse(row.record);
  if (
    row.requestDigest !== record.planDigest ||
    row.requestId !== appIntegrationCapabilityOperationRef(record.plan) ||
    row.issuer !== record.plan.authority.issuer ||
    row.audience !== record.plan.authority.audience ||
    row.workspaceId !== record.plan.authority.workspaceId ||
    row.ownerUserId !== record.plan.authority.ownerUserId
  ) {
    throw unavailable();
  }
  return { operationRef: row.requestId, record, revision: row.revision };
};
/** The existing typed provision journal is the only effect ledger. Credentials live in separate encrypted custody kinds. */
export const createPostgresAppIntegrationCapabilityStore = (
  database: ReturnType<typeof openHostedPostgresDatabase>,
): AppIntegrationCapabilityStore => {
  const read: AppIntegrationCapabilityStore["read"] = async (authority, operationRef) => {
    const rows = await database
      .select()
      .from(builderProvisioningJournals)
      .where(matches(authority, operationRef))
      .limit(1);
    return rows[0] === undefined ? undefined : parse(rows[0]);
  };
  return {
    claimLease: async (row) => {
      const leaseId = randomUUID();
      const rows = await database
        .update(builderProvisioningJournals)
        .set({
          record: sql`jsonb_set(${builderProvisioningJournals.record},'{executionLease}',jsonb_build_object('leaseId',${leaseId},'fenceGeneration',nextval('public.builder_protected_access_fence_generation_seq'::regclass)),true)`,
          revision: row.revision + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            matches(row.record.plan.authority, row.operationRef),
            eq(builderProvisioningJournals.revision, row.revision),
            eq(builderProvisioningJournals.requestDigest, row.record.planDigest),
          ),
        )
        .returning();
      return rows[0] === undefined ? undefined : parse(rows[0]);
    },
    compareAndSet: async (row, value) => {
      const record = appIntegrationCapabilityRecordSchema.parse(value);
      const previous = row.record;
      if (
        !isDeepStrictEqual(record.plan, previous.plan) ||
        record.planDigest !== previous.planDigest ||
        !isDeepStrictEqual(record.executionLease, previous.executionLease) ||
        !isDeepStrictEqual(
          record.approvalReceipts.slice(0, previous.approvalReceipts.length),
          previous.approvalReceipts,
        ) ||
        new Set(record.approvalReceipts.map((receipt) => receipt.approvedByCallId)).size !==
          record.approvalReceipts.length ||
        (previous.prepared !== undefined &&
          !isDeepStrictEqual(previous.prepared, record.prepared)) ||
        previous.plan.effects.some(
          (effect) =>
            !preservesEffect(
              readIntegrationCapabilityEffect(previous, effect),
              readIntegrationCapabilityEffect(record, effect),
              previous.executionLease?.fenceGeneration,
            ),
        )
      ) {
        throw unavailable();
      }
      const rows = await database
        .update(builderProvisioningJournals)
        .set({
          record,
          revision: row.revision + 1,
          state: record.prepared === undefined ? "pending" : "settled",
          updatedAt: new Date(),
        })
        .where(
          and(
            matches(record.plan.authority, row.operationRef),
            eq(builderProvisioningJournals.revision, row.revision),
            eq(builderProvisioningJournals.requestDigest, record.planDigest),
          ),
        )
        .returning();
      return rows[0] === undefined ? undefined : parse(rows[0]);
    },
    read,
    reserve: async (plan) => {
      const record = initialAppIntegrationCapabilityRecord(plan);
      const operationRef = appIntegrationCapabilityOperationRef(plan);
      await database
        .insert(builderProvisioningJournals)
        .values({
          ...plan.authority,
          createdAt: new Date(),
          record,
          requestDigest: record.planDigest,
          requestId: operationRef,
          revision: 1,
          state: "pending",
          updatedAt: new Date(),
        })
        .onConflictDoNothing();
      const row = await read(plan.authority, operationRef);
      if (row === undefined || !isDeepStrictEqual(row.record.plan, plan)) {
        throw unavailable();
      }
      return row;
    },
  };
};
