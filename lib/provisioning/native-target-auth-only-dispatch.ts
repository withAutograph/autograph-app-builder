import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { builderProvisioningJournals } from "../db/schema";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Drizzle database needs the complete schema type.
import type * as databaseSchema from "../db/schema";
import {
  nativeTargetAuthOnlyPlanDigest,
  nativeTargetAuthOnlyPlanSchema,
  nativeTargetAuthOnlySchemaEffectDigest,
} from "./native-target-auth-only-plan-schema";
import type { NativeTargetAuthOnlyPlan } from "./native-target-auth-only-plan-schema";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const instant = z.iso.datetime({ offset: true });
export const nativeTargetAuthOnlyApprovalSchema = z.strictObject({
  requestId: z.string().min(1),
  callId: z.string().min(1),
  planDigest: digest,
  sourceDigest: digest,
  responderPrincipalId: z.string().min(1),
  publicSessionId: z.string().min(1),
  outcome: z.enum(["approved", "cancelled"]),
  observedAt: instant,
});
export type NativeTargetAuthOnlyApproval = z.infer<typeof nativeTargetAuthOnlyApprovalSchema>;

const stateSchema = z.discriminatedUnion("stage", [
  z.strictObject({
    kind: z.literal("native-target-auth-only-dispatch"), version: z.literal(1),
    plan: nativeTargetAuthOnlyPlanSchema, planDigest: digest, stage: z.literal("planned"),
  }),
  z.strictObject({
    kind: z.literal("native-target-auth-only-dispatch"), version: z.literal(1),
    plan: nativeTargetAuthOnlyPlanSchema, planDigest: digest, stage: z.literal("approved"),
    approval: nativeTargetAuthOnlyApprovalSchema,
  }),
  z.strictObject({
    kind: z.literal("native-target-auth-only-dispatch"), version: z.literal(1),
    plan: nativeTargetAuthOnlyPlanSchema, planDigest: digest, stage: z.literal("dispatching"),
    approval: nativeTargetAuthOnlyApprovalSchema, attemptId: z.uuid(), leaseId: z.uuid(),
    leaseExpiresAt: instant, dispatchAuthorizedAt: instant.optional(), acceptedProjectId: z.string().min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal("native-target-auth-only-dispatch"), version: z.literal(1),
    plan: nativeTargetAuthOnlyPlanSchema, planDigest: digest, stage: z.literal("unknown"),
    approval: nativeTargetAuthOnlyApprovalSchema, attemptId: z.uuid(), leaseId: z.uuid(),
    leaseExpiresAt: instant, dispatchAuthorizedAt: instant, acceptedProjectId: z.string().min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal("native-target-auth-only-dispatch"), version: z.literal(1),
    plan: nativeTargetAuthOnlyPlanSchema, planDigest: digest, stage: z.literal("created"),
    approval: nativeTargetAuthOnlyApprovalSchema, projectId: z.string().min(1),
  }),
]);
export type NativeTargetAuthOnlyDispatchState = z.infer<typeof stateSchema>;

export interface NativeTargetAuthOnlyDispatchStore {
  read: (key: { authority: z.infer<typeof hostedTenantAuthoritySchema>; appId: string }) => Promise<{ revision: number; state: NativeTargetAuthOnlyDispatchState } | undefined>;
  reserve: (key: { authority: z.infer<typeof hostedTenantAuthoritySchema>; appId: string }, state: NativeTargetAuthOnlyDispatchState) => Promise<{ revision: number; state: NativeTargetAuthOnlyDispatchState }>;
  compareAndSet: (key: { authority: z.infer<typeof hostedTenantAuthoritySchema>; appId: string }, expectedRevision: number, state: NativeTargetAuthOnlyDispatchState) => Promise<{ revision: number; state: NativeTargetAuthOnlyDispatchState } | undefined>;
}

type Database = PostgresJsDatabase<typeof databaseSchema>;
const requestIdFor = (key: { authority: z.infer<typeof hostedTenantAuthoritySchema>; appId: string }) => {
  const hex = createHash("sha256").update(JSON.stringify([
    "native-target-auth-only-dispatch-v1", key.authority.issuer, key.authority.audience,
    key.authority.workspaceId, key.authority.ownerUserId, key.appId,
  ])).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const journalState = (state: NativeTargetAuthOnlyDispatchState) => state.stage === "created" ? "settled" : "pending";

/** Separate kind and identity prevent collisions with generated database onboarding rows. */
export const createPostgresNativeTargetAuthOnlyDispatchStore = (database: Database): NativeTargetAuthOnlyDispatchStore => {
  const predicate = (key: { authority: z.infer<typeof hostedTenantAuthoritySchema>; appId: string }) => and(
    eq(builderProvisioningJournals.issuer, key.authority.issuer),
    eq(builderProvisioningJournals.audience, key.authority.audience),
    eq(builderProvisioningJournals.workspaceId, key.authority.workspaceId),
    eq(builderProvisioningJournals.ownerUserId, key.authority.ownerUserId),
    eq(builderProvisioningJournals.requestId, requestIdFor(key)),
    sql`${builderProvisioningJournals.record} ->> 'kind' = 'native-target-auth-only-dispatch'`,
  );
  const parseRow = (row: typeof builderProvisioningJournals.$inferSelect) => {
    const authority = hostedTenantAuthoritySchema.parse({ issuer: row.issuer, audience: row.audience, workspaceId: row.workspaceId, ownerUserId: row.ownerUserId });
    const state = stateSchema.parse(row.record);
    if (row.requestId !== requestIdFor({ authority, appId: state.plan.appId }) || row.requestDigest !== state.planDigest || row.state !== journalState(state) || !isDeepStrictEqual(authority, state.plan.origin.authority)) throw mismatch();
    return { revision: row.revision, state };
  };
  const read = async (key: { authority: z.infer<typeof hostedTenantAuthoritySchema>; appId: string }) => {
    hostedTenantAuthoritySchema.parse(key.authority);
    const rows = await database.select().from(builderProvisioningJournals).where(predicate(key)).limit(1);
    return rows[0] === undefined ? undefined : parseRow(rows[0]);
  };
  return {
    read,
    async reserve(key, rawState) {
      const authority = hostedTenantAuthoritySchema.parse(key.authority);
      const state = stateSchema.parse(rawState);
      if (state.plan.appId !== key.appId || !isDeepStrictEqual(authority, state.plan.origin.authority)) throw mismatch();
      const now = new Date();
      const rows = await database.insert(builderProvisioningJournals).values({
        ...authority, requestId: requestIdFor(key), requestDigest: state.planDigest,
        record: state, revision: 1, state: journalState(state), createdAt: now, updatedAt: now,
      }).onConflictDoNothing().returning();
      const inserted = rows[0] === undefined ? await read(key) : parseRow(rows[0]);
      if (inserted === undefined || inserted.state.planDigest !== state.planDigest) throw conflict();
      return inserted;
    },
    async compareAndSet(key, expectedRevision, rawState) {
      const state = stateSchema.parse(rawState);
      const current = await read(key);
      const allowedUnknownSettlement = current?.state.stage === "unknown" && state.stage === "created" && current.state.acceptedProjectId === state.projectId && current.state.acceptedProjectId !== undefined;
      if (current === undefined || current.revision !== expectedRevision || current.state.planDigest !== state.planDigest || current.state.stage === "created" || (current.state.stage === "unknown" && !allowedUnknownSettlement)) return undefined;
      const rows = await database.update(builderProvisioningJournals).set({ record: state, state: journalState(state), revision: expectedRevision + 1, updatedAt: new Date() })
        .where(and(predicate(key), eq(builderProvisioningJournals.revision, expectedRevision))).returning();
      return rows[0] === undefined ? undefined : parseRow(rows[0]);
    },
  };
};

const conflict = () => new Error("native_target_auth_only_conflict");
const mismatch = () => new Error("native_target_auth_only_mismatch");

/** Auth-only dispatcher has project creation ports only: no DB, installer, or grant ports. */
export const createNativeTargetAuthOnlyDispatch = <Invocation>(ports: {
  store: NativeTargetAuthOnlyDispatchStore;
  authorize: (invocation: Invocation, appId: string) => Promise<{ authority: z.infer<typeof hostedTenantAuthoritySchema>; ownerUserId: string; publicSessionId: string }>;
  readApproval: (invocation: Invocation, plan: NativeTargetAuthOnlyPlan) => Promise<NativeTargetAuthOnlyApproval | null>;
  revalidate: (invocation: Invocation, plan: NativeTargetAuthOnlyPlan) => Promise<void>;
  createProject: (input: { plan: NativeTargetAuthOnlyPlan; authorizeAttempt: () => Promise<void>; acceptProjectId: (id: string) => Promise<void> }) => Promise<{ status: "created"; projectId: string } | { status: "uncertain"; projectId?: string } | { status: "rejected"; reason: "authorization_denied" | "collision" | "permission_denied" | "provider_rejected" | "rate_limited" }>;
  observeProject: (input: { plan: NativeTargetAuthOnlyPlan; projectId: string }) => Promise<{ status: "verified"; projectId: string } | { status: "uncertain" }>;
  now?: () => Date;
  leaseMs?: number;
}) => {
  const now = ports.now ?? (() => new Date());
  const keyFor = async (invocation: Invocation, plan: NativeTargetAuthOnlyPlan) => {
    const owner = await ports.authorize(invocation, plan.appId);
    if (!isDeepStrictEqual(hostedTenantAuthoritySchema.parse(owner.authority), plan.origin.authority) || owner.ownerUserId !== plan.origin.authority.ownerUserId || owner.publicSessionId !== plan.origin.publicSessionId) throw mismatch();
    return { owner, key: { authority: owner.authority, appId: plan.appId } };
  };
  const approve = async (invocation: Invocation, rawPlan: NativeTargetAuthOnlyPlan) => {
    const plan = nativeTargetAuthOnlyPlanSchema.parse(rawPlan);
    const { owner, key } = await keyFor(invocation, plan);
    await ports.revalidate(invocation, plan);
    const planDigest = nativeTargetAuthOnlyPlanDigest(plan);
    const existing = await ports.store.read(key);
    if (existing !== undefined) {
      if (existing.state.planDigest !== planDigest) throw conflict();
      // Retained approval belongs to this exact frozen plan and owner across resumes.
      if ("approval" in existing.state) return existing;
      throw conflict();
    }
    const approval = nativeTargetAuthOnlyApprovalSchema.parse(await ports.readApproval(invocation, plan));
    if (approval.outcome !== "approved" || approval.responderPrincipalId !== owner.ownerUserId || approval.publicSessionId !== owner.publicSessionId || approval.planDigest !== planDigest || approval.sourceDigest !== nativeTargetAuthOnlySchemaEffectDigest(plan, plan.publishedSource)) throw mismatch();
    const state = stateSchema.parse({ kind: "native-target-auth-only-dispatch", version: 1, plan, planDigest, stage: "approved", approval });
    return await ports.store.reserve(key, state);
  };
  const dispatch = async (invocation: Invocation, rawPlan: NativeTargetAuthOnlyPlan) => {
    const plan = nativeTargetAuthOnlyPlanSchema.parse(rawPlan);
    const { owner, key } = await keyFor(invocation, plan);
    const current = await ports.store.read(key);
    const planDigest = nativeTargetAuthOnlyPlanDigest(plan);
    if (current?.state.stage === "created" && current.state.planDigest === planDigest) {
      return { status: "created" as const, projectId: current.state.projectId };
    }
    if (current?.state.stage === "dispatching" && current.state.planDigest === planDigest) {
      if (Date.parse(current.state.leaseExpiresAt) > now().getTime()) throw conflict();
      if (current.state.dispatchAuthorizedAt === undefined) {
        const released = await ports.store.compareAndSet(key, current.revision, stateSchema.parse({
          kind: "native-target-auth-only-dispatch", version: 1, plan, planDigest, stage: "approved", approval: current.state.approval,
        }));
        if (released === undefined) throw conflict();
        return await dispatch(invocation, plan);
      }
      const uncertain = await ports.store.compareAndSet(key, current.revision, stateSchema.parse({
        ...current.state, stage: "unknown", dispatchAuthorizedAt: current.state.dispatchAuthorizedAt,
      }));
      if (uncertain === undefined) throw conflict();
      return await dispatch(invocation, plan);
    }
    if (current?.state.planDigest !== planDigest || (current.state.stage !== "approved" && current.state.stage !== "unknown") || current.state.approval.responderPrincipalId !== owner.ownerUserId) throw conflict();
    await ports.revalidate(invocation, plan);
    if (current.state.stage === "unknown") {
      const projectId = current.state.acceptedProjectId;
      if (projectId === undefined) throw conflict();
      const observed = await ports.observeProject({ plan, projectId });
      const latestOwner = await ports.authorize(invocation, plan.appId);
      if (!isDeepStrictEqual(latestOwner.authority, owner.authority) || latestOwner.ownerUserId !== owner.ownerUserId || latestOwner.publicSessionId !== owner.publicSessionId) throw mismatch();
      await ports.revalidate(invocation, plan);
      if (observed.status !== "verified" || observed.projectId !== projectId) return { status: "unknown" as const, projectId };
      const saved = await ports.store.compareAndSet(key, current.revision, stateSchema.parse({ kind: "native-target-auth-only-dispatch", version: 1, plan, planDigest, stage: "created", approval: current.state.approval, projectId }));
      if (saved === undefined) throw conflict();
      return { status: "created" as const, projectId };
    }
    const attemptId = crypto.randomUUID(); const leaseId = crypto.randomUUID();
    const leaseExpiresAt = new Date(now().getTime() + (ports.leaseMs ?? 60_000)).toISOString();
    let row = await ports.store.compareAndSet(key, current.revision, stateSchema.parse({ ...current.state, stage: "dispatching", attemptId, leaseId, leaseExpiresAt }));
    if (row === undefined) throw conflict();
    const assertFence = async () => {
      const latestOwner = await ports.authorize(invocation, plan.appId);
      if (!isDeepStrictEqual(latestOwner.authority, owner.authority) || latestOwner.ownerUserId !== owner.ownerUserId || latestOwner.publicSessionId !== owner.publicSessionId) throw mismatch();
      await ports.revalidate(invocation, plan);
      const latest = await ports.store.read(key);
      if (latest?.state.stage !== "dispatching" || latest.state.attemptId !== attemptId || latest.state.leaseId !== leaseId || Date.parse(latest.state.leaseExpiresAt) <= now().getTime()) throw conflict();
      row = latest;
    };
    const authorizeAttempt = async () => {
      await assertFence();
      const latest = row!;
      if (latest.state.stage !== "dispatching" || latest.state.dispatchAuthorizedAt !== undefined) throw conflict();
      const saved = await ports.store.compareAndSet(key, latest.revision, stateSchema.parse({ ...latest.state, dispatchAuthorizedAt: now().toISOString() }));
      if (saved === undefined) throw conflict(); row = saved;
    };
    const acceptProjectId = async (projectId: string) => {
      await assertFence(); const latest = row!;
      if (latest.state.stage !== "dispatching" || latest.state.dispatchAuthorizedAt === undefined || (latest.state.acceptedProjectId !== undefined && latest.state.acceptedProjectId !== projectId)) throw conflict();
      const saved = await ports.store.compareAndSet(key, latest.revision, stateSchema.parse({ ...latest.state, acceptedProjectId: z.string().min(1).parse(projectId) }));
      if (saved === undefined) throw conflict(); row = saved;
    };
    try {
      const result = await ports.createProject({ plan, authorizeAttempt, acceptProjectId });
      await assertFence(); const latest = row!;
      if (latest.state.stage !== "dispatching") throw conflict();
      if (result.status === "uncertain") {
        await ports.store.compareAndSet(key, latest.revision, stateSchema.parse({ ...latest.state, stage: "unknown", dispatchAuthorizedAt: latest.state.dispatchAuthorizedAt ?? now().toISOString(), ...(latest.state.acceptedProjectId === undefined && result.projectId !== undefined ? { acceptedProjectId: result.projectId } : {}) }));
        return { status: "unknown" as const, ...(result.projectId === undefined ? {} : { projectId: result.projectId }) };
      }
      if (result.status === "rejected") {
        const saved = await ports.store.compareAndSet(key, latest.revision, stateSchema.parse({
          kind: "native-target-auth-only-dispatch", version: 1, plan, planDigest,
          stage: "approved", approval: latest.state.approval,
        }));
        if (saved === undefined) throw conflict();
        return { status: "rejected" as const, reason: result.reason };
      }
      const projectId = latest.state.acceptedProjectId;
      if (projectId !== result.projectId) throw mismatch();
      const saved = await ports.store.compareAndSet(key, latest.revision, stateSchema.parse({ kind: "native-target-auth-only-dispatch", version: 1, plan, planDigest, stage: "created", approval: latest.state.approval, projectId }));
      if (saved === undefined) throw conflict();
      return { status: "created" as const, projectId };
    } catch (error) {
      const latest = row;
      if (latest?.state.stage === "dispatching" && latest.state.dispatchAuthorizedAt === undefined) {
        await ports.store.compareAndSet(key, latest.revision, stateSchema.parse({
          kind: "native-target-auth-only-dispatch", version: 1, plan, planDigest,
          stage: "approved", approval: latest.state.approval,
        }));
      } else if (latest?.state.stage === "dispatching" && latest.state.dispatchAuthorizedAt !== undefined) {
        await ports.store.compareAndSet(key, latest.revision, stateSchema.parse({ ...latest.state, stage: "unknown", dispatchAuthorizedAt: latest.state.dispatchAuthorizedAt }));
      }
      throw error;
    }
  };
  return { approve, dispatch };
};
