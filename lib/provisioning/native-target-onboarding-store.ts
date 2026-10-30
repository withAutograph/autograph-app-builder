/* oxlint-disable eslint/complexity, sonarjs/expression-complexity, unicorn/no-useless-undefined -- CAS transitions validate every retained authority/effect binding; absent rows intentionally return undefined. */
import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { builderProvisioningJournals } from "../db/schema";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Drizzle uses the complete existing schema as its database type.
import type * as databaseSchema from "../db/schema";
import { builderAppIdSchema } from "./names";
import {
  nativeTargetAcceptedCreationSchema,
  nativeTargetNoCreationReasonSchema,
  nativeTargetOnboardingApprovalSchema,
  nativeTargetOnboardingAttemptSchema,
  nativeTargetOnboardingCreationProofSchema,
  nativeTargetOnboardingPlanDigest,
  nativeTargetOnboardingPlanSchema,
  nativeTargetOnboardingRecordSchema,
  nativeTargetOnboardingRegistryId,
  nativeTargetOnboardingTableState,
} from "./native-target-onboarding-contract";
import type {
  NativeTargetAcceptedCreation,
  NativeTargetNoCreationReason,
  NativeTargetAuthority,
  NativeTargetOnboardingApproval,
  NativeTargetOnboardingAttempt,
  NativeTargetOnboardingCreationProof,
  NativeTargetOnboardingPlan,
  NativeTargetOnboardingRecord,
  NativeTargetReadyRegistration,
} from "./native-target-onboarding-contract";

export interface NativeTargetOnboardingKey {
  authority: NativeTargetAuthority;
  appId: string;
}
export interface NativeTargetOnboardingRow extends NativeTargetOnboardingKey {
  requestId: string;
  revision: number;
  record: NativeTargetOnboardingRecord;
  createdAt: Date;
  updatedAt: Date;
}

/** Trusted storage only. Public callers use the authorization-enforcing registry below. */
export interface NativeTargetOnboardingStore {
  read: (key: NativeTargetOnboardingKey) => Promise<NativeTargetOnboardingRow | undefined>;
  reserve: (
    input: NativeTargetOnboardingKey & {
      plan: NativeTargetOnboardingPlan;
      now: Date;
    },
  ) => Promise<NativeTargetOnboardingRow>;
  compareAndSet: (
    input: NativeTargetOnboardingKey & {
      expectedRevision: number;
      record: NativeTargetOnboardingRecord;
      now: Date;
    },
  ) => Promise<NativeTargetOnboardingRow | undefined>;
}

const unavailable = () => new Error("native_target_onboarding_unavailable");
const conflict = () => new Error("native_target_onboarding_conflict");
const identity = (key: NativeTargetOnboardingKey) =>
  nativeTargetOnboardingRegistryId(key.authority, key.appId);
const initialRecord = (plan: NativeTargetOnboardingPlan): NativeTargetOnboardingRecord =>
  nativeTargetOnboardingRecordSchema.parse({
    kind: "native-target-onboarding",
    version: 1,
    appId: plan.appId,
    stage: "planned",
    plan,
    planDigest: nativeTargetOnboardingPlanDigest(plan),
    previousAttempts: [],
    priorCancellations: [],
  });
const parseRecord = (key: NativeTargetOnboardingKey, value: NativeTargetOnboardingRecord) => {
  const record = nativeTargetOnboardingRecordSchema.parse(value);
  const authority = hostedTenantAuthoritySchema.parse(key.authority);
  if (
    record.appId !== builderAppIdSchema.parse(key.appId) ||
    (record.priorCancellations ?? []).some(
      (prior) => prior.approval.responderPrincipalId !== authority.ownerUserId,
    ) ||
    ("approval" in record && record.approval.responderPrincipalId !== authority.ownerUserId) ||
    (record.priorCancellations ?? []).some(
      (prior) => prior.approval.responderPrincipalId !== authority.ownerUserId,
    ) ||
    ("cancelledBy" in record &&
      record.cancelledBy !== undefined &&
      record.cancelledBy.responderPrincipalId !== authority.ownerUserId)
  ) {
    throw unavailable();
  }
  return record;
};

const assertAttemptHistory = (
  before: NativeTargetOnboardingRecord,
  after: NativeTargetOnboardingRecord,
) => {
  const retired =
    (before.stage === "creating" || before.stage === "unknown") &&
    (after.stage === "approved" || after.stage === "cancelled");
  if (retired) {
    const last = after.previousAttempts.at(-1);
    if (
      last === undefined ||
      !isDeepStrictEqual(after.previousAttempts.slice(0, -1), before.previousAttempts)
    ) {
      throw conflict();
    }
    const priorAttempt = nativeTargetOnboardingAttemptSchema.strip().parse(last);
    if (!isDeepStrictEqual(priorAttempt, before.attempt)) {
      throw conflict();
    }
  } else if (!isDeepStrictEqual(before.previousAttempts, after.previousAttempts)) {
    throw conflict();
  }
};

const assertUndispatchedReplan = (
  before: Extract<NativeTargetOnboardingRecord, { stage: "cancelled" }>,
  after: Extract<NativeTargetOnboardingRecord, { stage: "planned" }>,
) => {
  if (
    before.previousAttempts.some((attempt) => attempt.reason !== "not_dispatched") ||
    after.previousAttempts.length !== 0
  ) {
    throw conflict();
  }
  const expected = [
    ...(before.priorCancellations ?? []),
    {
      plan: before.plan,
      planDigest: before.planDigest,
      approval: before.approval,
      previousAttempts: before.previousAttempts,
    },
  ];
  if (!isDeepStrictEqual(expected, after.priorCancellations)) {
    throw conflict();
  }
};

const assertPlannedScopeSupersession = (
  before: Extract<NativeTargetOnboardingRecord, { stage: "planned" }>,
  after: Extract<NativeTargetOnboardingRecord, { stage: "planned" }>,
) => {
  const target = (plan: NativeTargetOnboardingPlan) => ({
    appId: plan.appId,
    project: plan.project,
    branch: plan.branch,
    productRoles: plan.productRoles,
    release: plan.origin.release,
    appSpecDigest: plan.origin.appSpecDigest,
    publicSessionId: plan.origin.publicSessionId,
    database: plan.appDatabase.database,
    migratorRole: plan.appDatabase.migratorRole,
    runtimeRole: plan.appDatabase.runtimeRole,
    cost: plan.cost,
    retention: plan.retention,
    conflictPolicy: plan.conflictPolicy,
  });
  const prior = after.priorPlannedScopes?.at(-1);
  if (
    before.previousAttempts.length !== 0 ||
    after.previousAttempts.length !== 0 ||
    after.plan.resourceProfileId === undefined ||
    (after.plan.resourceSelectionRevision ?? 0) !==
      (before.plan.resourceSelectionRevision ?? 0) + 1 ||
    isDeepStrictEqual(
      {
        profile: before.plan.resourceProfileId,
        authority: before.plan.resourceProfileAuthorityDigest,
        nativeNeon: before.plan.nativeNeon,
        resourceId: before.plan.appDatabase.resourceId,
      },
      {
        profile: after.plan.resourceProfileId,
        authority: after.plan.resourceProfileAuthorityDigest,
        nativeNeon: after.plan.nativeNeon,
        resourceId: after.plan.appDatabase.resourceId,
      },
    ) ||
    !isDeepStrictEqual(target(before.plan), target(after.plan)) ||
    !isDeepStrictEqual(before.priorCancellations, after.priorCancellations) ||
    !isDeepStrictEqual(before.priorPlannedScopes ?? [], after.priorPlannedScopes?.slice(0, -1)) ||
    prior === undefined ||
    !isDeepStrictEqual(prior.plan, before.plan) ||
    prior.planDigest !== before.planDigest
  ) {
    throw conflict();
  }
};

/** A planned rescope completes its transition; other paths preserve its scope audit. */
const assertPlannedScopeTransition = (
  before: NativeTargetOnboardingRecord,
  after: NativeTargetOnboardingRecord,
): boolean => {
  if (
    before.stage === "planned" &&
    after.stage === "planned" &&
    before.planDigest !== after.planDigest
  ) {
    assertPlannedScopeSupersession(before, after);
    return true;
  }
  if (!isDeepStrictEqual(before.priorPlannedScopes, after.priorPlannedScopes)) {
    throw conflict();
  }
  return false;
};

const assertRetainedTargetUnchanged = (
  before: NativeTargetOnboardingRecord,
  after: NativeTargetOnboardingRecord,
) => {
  if (
    !isDeepStrictEqual(before.plan, after.plan) ||
    before.planDigest !== after.planDigest ||
    before.appId !== after.appId ||
    before.stage === "ready" ||
    before.stage === "cancelled"
  ) {
    throw conflict();
  }
};

/** Terminal targets and effect provenance cannot be replaced through the CAS adapter. */
const assertTransition = (
  before: NativeTargetOnboardingRecord,
  after: NativeTargetOnboardingRecord,
) => {
  if (assertPlannedScopeTransition(before, after)) {
    return;
  }
  if (before.stage === "cancelled" && after.stage === "planned") {
    assertUndispatchedReplan(before, after);
    return;
  }
  if (!isDeepStrictEqual(before.priorCancellations, after.priorCancellations)) {
    throw conflict();
  }
  if (isDeepStrictEqual(before, after)) {
    return;
  }
  assertRetainedTargetUnchanged(before, after);
  if (
    "approval" in before &&
    "approval" in after &&
    !isDeepStrictEqual(before.approval, after.approval) &&
    !(after.stage === "cancelled" && after.approval.outcome === "cancelled")
  ) {
    throw conflict();
  }
  const allowed: Record<
    NativeTargetOnboardingRecord["stage"],
    readonly NativeTargetOnboardingRecord["stage"][]
  > = {
    planned: ["approved", "cancelled"],
    approved: ["creating", "cancelled"],
    creating: ["creating", "unknown", "ready", "approved", "cancelled"],
    unknown: ["unknown", "ready", "approved", "cancelled"],
    ready: [],
    cancelled: [],
  };
  if (!allowed[before.stage].includes(after.stage)) {
    throw conflict();
  }
  if (
    after.stage === "cancelled" &&
    "dispatchAuthorizedAt" in before &&
    before.dispatchAuthorizedAt !== undefined
  ) {
    throw conflict();
  }
  if (
    "attempt" in before &&
    "attempt" in after &&
    !isDeepStrictEqual(before.attempt, after.attempt)
  ) {
    throw conflict();
  }
  if (
    "dispatchAuthorizedAt" in before &&
    before.dispatchAuthorizedAt !== undefined &&
    (!("dispatchAuthorizedAt" in after) ||
      before.dispatchAuthorizedAt !== after.dispatchAuthorizedAt) &&
    after.stage !== "approved"
  ) {
    throw conflict();
  }
  if (
    "acceptedCreation" in before &&
    before.acceptedCreation !== undefined &&
    (!("acceptedCreation" in after) ||
      !isDeepStrictEqual(before.acceptedCreation, after.acceptedCreation))
  ) {
    throw conflict();
  }
  if (
    "cancelledBy" in before &&
    before.cancelledBy !== undefined &&
    (!("cancelledBy" in after) || !isDeepStrictEqual(before.cancelledBy, after.cancelledBy))
  ) {
    throw conflict();
  }
  assertAttemptHistory(before, after);
};

export const createInMemoryNativeTargetOnboardingStore = (): NativeTargetOnboardingStore => {
  const rows = new Map<string, NativeTargetOnboardingRow>();
  return {
    read: (key) => Promise.resolve(structuredClone(rows.get(identity(key)))),
    reserve(input) {
      const requestId = identity(input);
      const existing = rows.get(requestId);
      if (existing !== undefined) {
        return Promise.resolve(structuredClone(existing));
      }
      const record = parseRecord(input, initialRecord(input.plan));
      const row = {
        authority: hostedTenantAuthoritySchema.parse(input.authority),
        appId: record.appId,
        requestId,
        revision: 1,
        record,
        createdAt: input.now,
        updatedAt: input.now,
      };
      rows.set(requestId, structuredClone(row));
      return Promise.resolve(structuredClone(row));
    },
    compareAndSet(input) {
      const requestId = identity(input);
      const current = rows.get(requestId);
      if (current === undefined || current.revision !== input.expectedRevision) {
        return Promise.resolve(undefined);
      }
      const record = parseRecord(input, input.record);
      assertTransition(current.record, record);
      const row = { ...current, revision: current.revision + 1, record, updatedAt: input.now };
      rows.set(requestId, structuredClone(row));
      return Promise.resolve(structuredClone(row));
    },
  };
};

type Database = PostgresJsDatabase<typeof databaseSchema>;
const predicate = (key: NativeTargetOnboardingKey) =>
  and(
    eq(builderProvisioningJournals.issuer, key.authority.issuer),
    eq(builderProvisioningJournals.audience, key.authority.audience),
    eq(builderProvisioningJournals.workspaceId, key.authority.workspaceId),
    eq(builderProvisioningJournals.ownerUserId, key.authority.ownerUserId),
    eq(builderProvisioningJournals.requestId, identity(key)),
    sql`${builderProvisioningJournals.record} ->> 'kind' = 'native-target-onboarding'`,
  );
const parseRow = (
  raw: typeof builderProvisioningJournals.$inferSelect,
): NativeTargetOnboardingRow => {
  const authority = hostedTenantAuthoritySchema.parse({
    issuer: raw.issuer,
    audience: raw.audience,
    workspaceId: raw.workspaceId,
    ownerUserId: raw.ownerUserId,
  });
  const record = parseRecord(
    { authority, appId: nativeTargetOnboardingRecordSchema.parse(raw.record).appId },
    nativeTargetOnboardingRecordSchema.parse(raw.record),
  );
  if (
    raw.requestId !== identity({ authority, appId: record.appId }) ||
    raw.requestDigest !== record.planDigest ||
    raw.state !== nativeTargetOnboardingTableState(record)
  ) {
    throw unavailable();
  }
  return {
    authority,
    appId: record.appId,
    requestId: raw.requestId,
    revision: raw.revision,
    record,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
};

export const createPostgresNativeTargetOnboardingStore = (
  database: Database,
): NativeTargetOnboardingStore => {
  const read: NativeTargetOnboardingStore["read"] = async (key) => {
    hostedTenantAuthoritySchema.parse(key.authority);
    const rows = await database
      .select()
      .from(builderProvisioningJournals)
      .where(predicate(key))
      .limit(1);
    return rows[0] === undefined ? undefined : parseRow(rows[0]);
  };
  return {
    read,
    async reserve(input) {
      const authority = hostedTenantAuthoritySchema.parse(input.authority);
      const record = parseRecord(input, initialRecord(input.plan));
      const rows = await database
        .insert(builderProvisioningJournals)
        .values({
          ...authority,
          requestId: identity(input),
          requestDigest: record.planDigest,
          record,
          revision: 1,
          state: nativeTargetOnboardingTableState(record),
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoNothing()
        .returning();
      const row = rows[0] === undefined ? await read(input) : parseRow(rows[0]);
      if (row === undefined) {
        throw unavailable();
      }
      return row;
    },
    async compareAndSet(input) {
      const current = await read(input);
      if (current === undefined || current.revision !== input.expectedRevision) {
        return undefined;
      }
      const record = parseRecord(input, input.record);
      assertTransition(current.record, record);
      const rows = await database
        .update(builderProvisioningJournals)
        .set({
          record,
          requestDigest: record.planDigest,
          state: nativeTargetOnboardingTableState(record),
          revision: input.expectedRevision + 1,
          updatedAt: input.now,
        })
        .where(
          and(predicate(input), eq(builderProvisioningJournals.revision, input.expectedRevision)),
        )
        .returning();
      return rows[0] === undefined ? undefined : parseRow(rows[0]);
    },
  };
};

export interface NativeTargetCurrentOwner {
  authority: NativeTargetAuthority;
  publicSessionId: string;
  adapterSessionId: string;
  adapterGeneration: number;
}
export interface NativeTargetOnboardingRegistryPorts<Invocation> {
  store: NativeTargetOnboardingStore;
  /** Re-read canonical owner/app linkage and active membership; never trust owner fields in an invocation. */
  authorize: (invocation: Invocation, appId: string) => Promise<NativeTargetCurrentOwner>;
  /** Read exact accepted source/release under that owner for the initial effect plan only. */
  assertPlanOrigin: (
    owner: NativeTargetCurrentOwner,
    plan: NativeTargetOnboardingPlan,
  ) => Promise<void>;
  /** Independently read authenticated native approval; callers cannot supply an approval outcome. */
  readApproval: (
    owner: NativeTargetCurrentOwner,
    record: NativeTargetOnboardingRecord,
  ) => Promise<NativeTargetOnboardingApproval | null>;
  now?: () => Date;
}

/** Read-only consumers need current owner authority, with no fabricated mutation ports. */
export interface NativeTargetOnboardingReaderPorts<Invocation> {
  store: Pick<NativeTargetOnboardingStore, "read">;
  authorize: NativeTargetOnboardingRegistryPorts<Invocation>["authorize"];
}
export const createNativeTargetOnboardingReader = <Invocation>(
  ports: NativeTargetOnboardingReaderPorts<Invocation>,
) => {
  const read = async (
    invocation: Invocation,
    appId: string,
  ): Promise<NativeTargetOnboardingRow | undefined> => {
    const owner = await ports.authorize(invocation, builderAppIdSchema.parse(appId));
    return await ports.store.read({
      appId,
      authority: hostedTenantAuthoritySchema.parse(owner.authority),
    });
  };
  return {
    read,
    async readReady(
      invocation: Invocation,
      appId: string,
    ): Promise<NativeTargetReadyRegistration | undefined> {
      const row = await read(invocation, appId);
      return row?.record.stage === "ready" ? structuredClone(row.record) : undefined;
    },
  };
};
export type NativeTargetOnboardingReader<Invocation> = ReturnType<
  typeof createNativeTargetOnboardingReader<Invocation>
>;

/** No provider/model/tool execution. Integration owns provider calls behind the durable attempt callbacks. */
export const createNativeTargetOnboardingRegistry = <Invocation>(
  ports: NativeTargetOnboardingRegistryPorts<Invocation>,
) => {
  const now = ports.now ?? (() => new Date());
  const current = async (invocation: Invocation, appId: string) => {
    const owner = await ports.authorize(invocation, builderAppIdSchema.parse(appId));
    const authority = hostedTenantAuthoritySchema.parse(owner.authority);
    return { owner: { ...owner, authority }, key: { authority, appId } };
  };
  const load = async (invocation: Invocation, appId: string) => {
    const result = await current(invocation, appId);
    const row = await ports.store.read(result.key);
    if (row === undefined) {
      throw unavailable();
    }
    return { ...result, row };
  };
  const save = async (row: NativeTargetOnboardingRow, record: NativeTargetOnboardingRecord) => {
    const saved = await ports.store.compareAndSet({
      ...row,
      expectedRevision: row.revision,
      record,
      now: now(),
    });
    if (saved === undefined) {
      throw conflict();
    }
    return saved;
  };
  const approval = async (
    owner: NativeTargetCurrentOwner,
    record: NativeTargetOnboardingRecord,
  ) => {
    const raw = await ports.readApproval(owner, structuredClone(record));
    if (raw === null) {
      throw unavailable();
    }
    const receipt = nativeTargetOnboardingApprovalSchema.parse(raw);
    if (
      receipt.planDigest !== record.planDigest ||
      receipt.publicSessionId !== record.plan.origin.publicSessionId ||
      receipt.responderPrincipalId !== owner.authority.ownerUserId
    ) {
      throw unavailable();
    }
    if (
      (record.priorCancellations ?? []).some(
        (prior) =>
          prior.approval.requestId === receipt.requestId ||
          prior.approval.callId === receipt.callId,
      )
    ) {
      throw unavailable();
    }
    if (
      "approval" in record &&
      record.approval.outcome === "approved" &&
      receipt.outcome === "approved" &&
      !isDeepStrictEqual(record.approval, receipt)
    ) {
      throw unavailable();
    }
    return receipt;
  };
  const active = async (
    invocation: Invocation,
    appId: string,
    attemptId: string,
    leaseId?: string,
  ) => {
    const loaded = await load(invocation, appId);
    const { record } = loaded.row;
    if (
      (record.stage !== "creating" && record.stage !== "unknown") ||
      record.attempt.attemptId !== attemptId ||
      record.cancelledBy !== undefined
    ) {
      throw conflict();
    }
    if (
      leaseId !== undefined &&
      (record.attempt.leaseId !== leaseId ||
        Date.parse(record.attempt.leaseExpiresAt) <= now().getTime())
    ) {
      throw conflict();
    }
    const receipt = await approval(loaded.owner, record);
    if (receipt.outcome !== "approved") {
      throw unavailable();
    }
    return { ...loaded, record };
  };
  return {
    ...createNativeTargetOnboardingReader(ports),
    async authorizeAttempt(
      invocation: Invocation,
      appId: string,
      attemptId: string,
      leaseId: string,
    ) {
      const { row, record } = await active(invocation, appId, attemptId, leaseId);
      if (
        record.stage !== "creating" ||
        record.dispatchAuthorizedAt !== undefined ||
        record.acceptedCreation !== undefined
      ) {
        throw conflict();
      }
      return await save(row, { ...record, dispatchAuthorizedAt: now().toISOString() });
    },
    async supersedePlannedScope(
      invocation: Invocation,
      rawPlan: NativeTargetOnboardingPlan,
      expectedPlanDigest: string,
    ) {
      const plan = nativeTargetOnboardingPlanSchema.parse(rawPlan);
      const { owner, row } = await load(invocation, plan.appId);
      if (
        row.record.stage !== "planned" ||
        row.record.planDigest !== expectedPlanDigest ||
        row.record.previousAttempts.length !== 0 ||
        plan.origin.publicSessionId !== owner.publicSessionId ||
        plan.origin.adapterSessionId !== owner.adapterSessionId ||
        plan.origin.adapterGeneration !== owner.adapterGeneration
      ) {
        throw conflict();
      }
      await ports.assertPlanOrigin(owner, plan);
      const latest = await current(invocation, plan.appId);
      if (!isDeepStrictEqual(latest.owner, owner)) {
        throw unavailable();
      }
      return await save(row, {
        ...initialRecord(plan),
        priorCancellations: row.record.priorCancellations,
        priorPlannedScopes: [
          ...(row.record.priorPlannedScopes ?? []),
          {
            plan: row.record.plan,
            planDigest: row.record.planDigest,
            supersededAt: now().toISOString(),
          },
        ],
      });
    },
    async reservePlan(invocation: Invocation, rawPlan: NativeTargetOnboardingPlan) {
      const plan = nativeTargetOnboardingPlanSchema.parse(rawPlan);
      const { owner, key } = await current(invocation, plan.appId);
      const existing = await ports.store.read(key);
      if (existing !== undefined && existing.record.stage !== "cancelled") {
        if (
          existing.record.stage !== "ready" &&
          existing.record.planDigest !== nativeTargetOnboardingPlanDigest(plan)
        ) {
          throw conflict();
        }
        return existing;
      }
      if (
        plan.origin.publicSessionId !== owner.publicSessionId ||
        plan.origin.adapterSessionId !== owner.adapterSessionId ||
        plan.origin.adapterGeneration !== owner.adapterGeneration
      ) {
        throw unavailable();
      }
      await ports.assertPlanOrigin(owner, plan);
      if (existing?.record.stage === "cancelled") {
        const prior = existing.record;
        return await save(existing, {
          ...initialRecord(plan),
          priorPlannedScopes: prior.priorPlannedScopes,
          priorCancellations: [
            ...(prior.priorCancellations ?? []),
            {
              plan: prior.plan,
              planDigest: prior.planDigest,
              approval: prior.approval,
              previousAttempts: prior.previousAttempts,
            },
          ],
        });
      }
      const reserved = await ports.store.reserve({ ...key, plan, now: now() });
      if (
        reserved.record.stage !== "ready" &&
        reserved.record.planDigest !== nativeTargetOnboardingPlanDigest(plan)
      ) {
        throw conflict();
      }
      return reserved;
    },
    async recordApproval(invocation: Invocation, appId: string) {
      const { owner, row } = await load(invocation, appId);
      if (row.record.stage === "ready" || row.record.stage === "cancelled") {
        return row;
      }
      const receipt = await approval(owner, row.record);
      if (
        receipt.outcome === "cancelled" &&
        (row.record.stage === "creating" || row.record.stage === "unknown")
      ) {
        if (
          row.record.dispatchAuthorizedAt === undefined &&
          row.record.acceptedCreation === undefined
        ) {
          return await save(row, {
            ...initialRecord(row.record.plan),
            priorCancellations: row.record.priorCancellations,
            priorPlannedScopes: row.record.priorPlannedScopes,
            stage: "cancelled",
            approval: receipt,
            previousAttempts: [
              ...row.record.previousAttempts,
              { ...row.record.attempt, reason: "not_dispatched" },
            ],
          });
        }
        return await save(row, { ...row.record, stage: "unknown", cancelledBy: receipt });
      }
      if (row.record.stage !== "planned" && row.record.stage !== "approved") {
        return row;
      }
      return await save(row, {
        ...row.record,
        stage: receipt.outcome === "approved" ? "approved" : "cancelled",
        approval: receipt,
      });
    },
    async claimAttempt(
      invocation: Invocation,
      appId: string,
      rawAttempt: NativeTargetOnboardingAttempt,
    ) {
      const { owner, row } = await load(invocation, appId);
      if (row.record.stage !== "approved") {
        throw conflict();
      }
      const receipt = await approval(owner, row.record);
      if (receipt.outcome !== "approved") {
        throw unavailable();
      }
      const attempt = nativeTargetOnboardingAttemptSchema.parse(rawAttempt);
      const previous = row.record.previousAttempts.at(-1);
      if (previous === undefined && attempt.candidateName !== row.record.plan.project.name) {
        throw conflict();
      }
      if (
        previous !== undefined &&
        previous.reason !== "name_conflict" &&
        attempt.candidateName !== previous.candidateName
      ) {
        throw conflict();
      }
      if (
        previous?.reason === "name_conflict" &&
        (row.record.plan.conflictPolicy !== "suffix-on-confirmed-conflict" ||
          row.record.previousAttempts.some(
            (prior) =>
              prior.reason === "name_conflict" && prior.candidateName === attempt.candidateName,
          ))
      ) {
        throw conflict();
      }

      if (
        Date.parse(attempt.leaseExpiresAt) <= now().getTime() ||
        row.record.previousAttempts.some((prior) => prior.attemptId === attempt.attemptId)
      ) {
        throw conflict();
      }
      return await save(row, { ...row.record, stage: "creating", attempt });
    },
    /** Required callback after authenticated create2xx, before the independent GET. */
    async acceptProjectId(
      invocation: Invocation,
      appId: string,
      leaseId: string,
      rawAccepted: NativeTargetAcceptedCreation,
    ) {
      const acceptedCreation = nativeTargetAcceptedCreationSchema.parse(rawAccepted);
      const { row } = await load(invocation, appId);
      const { record } = row;
      if (
        (record.stage !== "creating" && record.stage !== "unknown") ||
        record.attempt.attemptId !== acceptedCreation.attemptId ||
        record.attempt.leaseId !== leaseId ||
        record.dispatchAuthorizedAt === undefined
      ) {
        throw conflict();
      }
      if (record.acceptedCreation !== undefined) {
        if (record.acceptedCreation.projectId !== acceptedCreation.projectId) {
          throw conflict();
        }
        return row;
      }
      return await save(row, { ...record, acceptedCreation });
    },
    async recordUnknown(invocation: Invocation, appId: string, attemptId: string) {
      const { row } = await load(invocation, appId);
      if (
        (row.record.stage !== "creating" && row.record.stage !== "unknown") ||
        row.record.attempt.attemptId !== attemptId
      ) {
        throw conflict();
      }
      return await save(row, { ...row.record, stage: "unknown" });
    },
    /** Only a trusted, definitive no-create outcome can retire an attempt and allow another POST. */
    async recordNotCreated(
      invocation: Invocation,
      appId: string,
      attemptId: string,
      rawReason: NativeTargetNoCreationReason,
    ) {
      const { row, record } = await active(invocation, appId, attemptId);
      if (record.acceptedCreation !== undefined) {
        throw conflict();
      }
      const reason = nativeTargetNoCreationReasonSchema.parse(rawReason);
      if ((reason === "not_dispatched") !== (record.dispatchAuthorizedAt === undefined)) {
        throw conflict();
      }
      return await save(row, {
        kind: record.kind,
        version: record.version,
        appId,
        plan: record.plan,
        planDigest: record.planDigest,
        stage: "approved",
        approval: record.approval,
        previousAttempts: [...record.previousAttempts, { ...record.attempt, reason }],
        priorCancellations: record.priorCancellations,
        priorPlannedScopes: record.priorPlannedScopes,
      });
    },
    /** Trusted independent GET adapter supplies proof; matching GET without a saved2xx cannot register. */
    async recordReady(
      invocation: Invocation,
      appId: string,
      rawProof: NativeTargetOnboardingCreationProof,
    ) {
      const registration = nativeTargetOnboardingCreationProofSchema.parse(rawProof);
      const { row, record } = await active(invocation, appId, registration.attemptId);
      if (record.acceptedCreation === undefined || record.dispatchAuthorizedAt === undefined) {
        throw unavailable();
      }
      return await save(row, {
        ...record,
        stage: "ready",
        dispatchAuthorizedAt: record.dispatchAuthorizedAt,
        acceptedCreation: record.acceptedCreation,
        registration,
      });
    },
  };
};

export type NativeTargetOnboardingRegistry<Invocation> = ReturnType<
  typeof createNativeTargetOnboardingRegistry<Invocation>
>;
