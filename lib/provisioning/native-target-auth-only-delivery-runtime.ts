import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import type { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { builderProvisioningJournals } from "../db/schema";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Drizzle uses the complete schema type.
import type * as databaseSchema from "../db/schema";
import { HostedOperatorError, operatorDeploymentCandidateSchema } from "./hosted-operator-contract";
import { nativeTargetAuthOnlyApprovalSchema } from "./native-target-auth-only-dispatch";
import type { NativeTargetAuthOnlyApproval } from "./native-target-auth-only-dispatch";
import {
  nativeTargetAuthOnlyDeliveryPlanSchema,
  nativeTargetAuthOnlyDeliveryPlanDigest,
} from "./native-target-auth-only-delivery-plan";
import type { NativeTargetAuthOnlyDeliveryPlan } from "./native-target-auth-only-delivery-plan";
import {
  nativeTargetAuthOnlyFinalRoutingPlanSchema,
  nativeTargetAuthOnlyFinalRoutingPlanDigest,
} from "./native-target-auth-only-final-routing";
import type { NativeTargetAuthOnlyPlan } from "./native-target-auth-only-plan-schema";
import type {
  NativeTargetAuthOnlyPreviewDeliveryInput,
  createNativeTargetAuthOnlyPreviewDelivery,
} from "./native-target-auth-only-preview-delivery";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const ready = operatorDeploymentCandidateSchema.extend({ readyState: z.literal("READY") });
const effect = z.strictObject({
  attempted: z.boolean(),
  candidates: z.array(operatorDeploymentCandidateSchema),
  receipt: ready.optional(),
});
const recordSchema = z.strictObject({
  app: effect,
  approval: nativeTargetAuthOnlyApprovalSchema.optional(),
  deliveryPlanDigest: digest,
  fenceGeneration: z.number().int().nonnegative(),
  finalRoutingPlan: z
    .strictObject({ operationRef: z.uuid(), digest, base64: z.string().min(1) })
    .optional(),
  gateway: effect,
  kind: z.literal("native-target-auth-only-delivery"),
  lease: z.strictObject({ id: z.uuid(), expiresAt: z.iso.datetime({ offset: true }) }).optional(),
  operationRef: z.uuid(),
  phase: z.enum([
    "planned",
    "running",
    "unknown",
    "pending-owner",
    "routing-pending",
    "running-final",
    "unknown-final",
    "prepared",
  ]),
  planBase64: z.string().min(1),
  version: z.literal(1),
});
export type NativeTargetAuthOnlyDeliveryRecord = z.infer<typeof recordSchema>;
export interface NativeTargetAuthOnlyDeliveryRow {
  revision: number;
  record: NativeTargetAuthOnlyDeliveryRecord;
}
/** Keep callback readiness and the fenced deployment lease as distinct authorization modes. */
export const nativeTargetAuthOnlyDeliveryAllowsReadyBinding = (input: {
  record: NativeTargetAuthOnlyDeliveryRecord;
  gateway: NonNullable<NativeTargetAuthOnlyDeliveryRecord["gateway"]["receipt"]>;
  runningLease?: { fenceGeneration: number };
  entryMode?: { mode: "retained" | "fenced"; fenceGeneration: number };
  now?: number;
}) => {
  if (!isDeepStrictEqual(input.record.gateway.receipt, input.gateway)) {
    return false;
  }
  if (input.runningLease === undefined && input.entryMode === undefined) {
    return [
      "pending-owner",
      "routing-pending",
      "running-final",
      "unknown-final",
      "prepared",
    ].includes(input.record.phase);
  }
  if (input.entryMode !== undefined) {
    if (input.record.phase === "unknown" && input.record.app.attempted) {
      return false;
    }
    if (
      ![
        "running",
        "pending-owner",
        "prepared",
        "routing-pending",
        "running-final",
        "unknown-final",
        "unknown",
      ].includes(input.record.phase)
    ) {
      return false;
    }
    if (input.record.fenceGeneration !== input.entryMode.fenceGeneration) {
      return false;
    }
    const leaseIsLive =
      input.record.lease !== undefined &&
      Date.parse(input.record.lease.expiresAt) > (input.now ?? Date.now());
    if (input.entryMode.mode === "retained") {
      return !leaseIsLive;
    }
    return leaseIsLive;
  }
  if (input.runningLease === undefined || input.record.lease === undefined) {
    return false;
  }
  return [
    input.record.phase === "running",
    input.record.fenceGeneration === input.runningLease.fenceGeneration,
    Date.parse(input.record.lease.expiresAt) > (input.now ?? Date.now()),
  ].every(Boolean);
};
export interface NativeTargetAuthOnlyDeliveryKey {
  authority: z.infer<typeof hostedTenantAuthoritySchema>;
  appId: string;
  sessionId: string;
  operationRef: string;
}
export interface NativeTargetAuthOnlyDeliveryStore {
  read: (
    key: NativeTargetAuthOnlyDeliveryKey,
  ) => Promise<NativeTargetAuthOnlyDeliveryRow | undefined>;
  retain: (
    key: NativeTargetAuthOnlyDeliveryKey,
    bytes: Buffer,
  ) => Promise<NativeTargetAuthOnlyDeliveryRow>;
  compareAndSet: (
    key: NativeTargetAuthOnlyDeliveryKey,
    revision: number,
    record: NativeTargetAuthOnlyDeliveryRecord,
  ) => Promise<NativeTargetAuthOnlyDeliveryRow | undefined>;
}
export interface NativeTargetAuthOnlyDeliveryEnvironmentInput {
  authority: NativeTargetAuthOnlyDeliveryKey["authority"];
  target: NativeTargetAuthOnlyDeliveryPlan["target"];
  plan: NativeTargetAuthOnlyPlan;
  deliveryPlan: NativeTargetAuthOnlyDeliveryPlan;
  operationRef: string;
  approval: NativeTargetAuthOnlyApproval;
  fenceGeneration: number;
  effect: "gateway" | "app";
  assertCurrent: () => Promise<void>;
  signal: AbortSignal;
}
export const nativeTargetAuthOnlyEntryReadinessSchema = z.discriminatedUnion("status", [
  z.strictObject({
    authIdentityLink: z.url().refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    }),
    authIdentityLinkExpiresAt: z.iso.datetime({ offset: true }),
    status: z.literal("pending-owner"),
  }),
  z.strictObject({
    organizationId: z.string().min(1),
    signupPolicyDigest: digest,
    status: z.literal("ready"),
  }),
]);
/** Must verify consumed owner confirmation and independently observed organization/signup-policy readiness before returning ready. */
export type NativeTargetAuthOnlyAfterGatewayReadyInput = Omit<
  NativeTargetAuthOnlyDeliveryEnvironmentInput,
  "effect"
> & {
  gateway: z.infer<typeof ready>;
  deliveryPlanDigest: string;
};
export type NativeTargetAuthOnlyEntryReadiness = z.infer<
  typeof nativeTargetAuthOnlyEntryReadinessSchema
>;
const mismatch = () => new HostedOperatorError("resource_mismatch");
const uncertain = () => new HostedOperatorError("reconciliation_required");
const requestIdFor = (key: NativeTargetAuthOnlyDeliveryKey) => {
  const hex = createHash("sha256")
    .update(
      JSON.stringify([
        "native-target-auth-only-delivery-v1",
        key.authority.issuer,
        key.authority.audience,
        key.authority.workspaceId,
        key.authority.ownerUserId,
        key.appId,
        key.sessionId,
        key.operationRef,
      ]),
    )
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const stateFor = (record: NativeTargetAuthOnlyDeliveryRecord) =>
  record.phase === "prepared" ? "settled" : "pending";
const assertRetainedApproval = (
  key: NativeTargetAuthOnlyDeliveryKey,
  record: NativeTargetAuthOnlyDeliveryRecord,
) => {
  const approval = record.approval;
  if (approval === undefined) {
    return;
  }
  if (
    ![
      approval.outcome === "approved",
      approval.planDigest === record.deliveryPlanDigest,
      approval.sourceDigest === record.deliveryPlanDigest,
      approval.publicSessionId === key.sessionId,
      approval.responderPrincipalId === key.authority.ownerUserId,
    ].every(Boolean)
  ) {
    throw mismatch();
  }
};
const assertRetainedRouting = (
  key: NativeTargetAuthOnlyDeliveryKey,
  record: NativeTargetAuthOnlyDeliveryRecord,
  plan: NativeTargetAuthOnlyDeliveryPlan,
) => {
  const retained = record.finalRoutingPlan;
  if (retained === undefined) {
    return;
  }
  const bytes = Buffer.from(retained.base64, "base64");
  const routing = nativeTargetAuthOnlyFinalRoutingPlanSchema.parse(
    JSON.parse(bytes.toString("utf-8")),
  );
  if (
    ![
      bytes.toString("base64") === retained.base64,
      nativeTargetAuthOnlyFinalRoutingPlanDigest(bytes) === retained.digest,
      routing.operationRef === retained.operationRef,
      routing.deliveryOperationRef === key.operationRef,
      routing.deliveryPlanDigest === record.deliveryPlanDigest,
      isDeepStrictEqual(routing.target, plan.target),
      isDeepStrictEqual(routing.bootstrap, record.gateway.receipt),
      isDeepStrictEqual(routing.app, record.app.receipt),
    ].every(Boolean)
  ) {
    throw mismatch();
  }
};
export const readNativeTargetAuthOnlyDeliveryPlan = (
  key: NativeTargetAuthOnlyDeliveryKey,
  raw: NativeTargetAuthOnlyDeliveryRecord,
) => {
  const record = recordSchema.parse(raw);
  const bytes = Buffer.from(record.planBase64, "base64");
  const plan = nativeTargetAuthOnlyDeliveryPlanSchema.parse(JSON.parse(bytes.toString("utf-8")));
  const exactPlan = [
    bytes.toString("base64") === record.planBase64,
    nativeTargetAuthOnlyDeliveryPlanDigest(bytes) === record.deliveryPlanDigest,
    record.operationRef === key.operationRef,
    plan.target.appId === key.appId,
    plan.target.sessionId === key.sessionId,
    plan.target.environment === "preview",
    plan.target.scopeType === "team",
  ].every(Boolean);
  if (!exactPlan) {
    throw mismatch();
  }
  if (
    ["routing-pending", "running-final", "unknown-final", "prepared"].includes(record.phase) &&
    (record.gateway.receipt === undefined || record.app.receipt === undefined)
  ) {
    throw mismatch();
  }
  assertRetainedApproval(key, record);
  assertRetainedRouting(key, record, plan);
  for (const target of ["gateway", "app"] as const) {
    const source = target === "gateway" ? plan.delivery.gatewayDelivery : plan.delivery.delivery;
    if (source === undefined || source.gitSha === undefined) {
      throw mismatch();
    }
    for (const candidate of [
      ...record[target].candidates,
      ...(record[target].receipt === undefined ? [] : [record[target].receipt]),
    ]) {
      const expectedBranch =
        target === "gateway"
          ? (plan.delivery.gatewayDelivery?.gitRef ?? source.branch)
          : source.branch;
      if (
        ![
          candidate.operationRef === key.operationRef,
          candidate.projectId === source.projectId,
          candidate.branch === expectedBranch,
          candidate.repoId === source.repoId,
        ].every(Boolean)
      ) {
        throw mismatch();
      }
    }
  }
  return { bytes, plan };
};

/** Exact approved bytes, attempt intent and verified candidate receipts share the existing constrained journal. */
export const createPostgresNativeTargetAuthOnlyDeliveryStore = (
  database: PostgresJsDatabase<typeof databaseSchema>,
): NativeTargetAuthOnlyDeliveryStore => {
  const predicate = (key: NativeTargetAuthOnlyDeliveryKey) =>
    and(
      eq(builderProvisioningJournals.issuer, key.authority.issuer),
      eq(builderProvisioningJournals.audience, key.authority.audience),
      eq(builderProvisioningJournals.workspaceId, key.authority.workspaceId),
      eq(builderProvisioningJournals.ownerUserId, key.authority.ownerUserId),
      eq(builderProvisioningJournals.requestId, requestIdFor(key)),
    );
  const parse = (
    key: NativeTargetAuthOnlyDeliveryKey,
    row: typeof builderProvisioningJournals.$inferSelect,
  ) => {
    const record = recordSchema.parse(row.record);
    readNativeTargetAuthOnlyDeliveryPlan(key, record);
    if (
      row.requestDigest !== record.deliveryPlanDigest ||
      row.state !== stateFor(record) ||
      row.requestId !== requestIdFor(key)
    ) {
      throw mismatch();
    }
    return { record, revision: row.revision };
  };
  const read: NativeTargetAuthOnlyDeliveryStore["read"] = async (key) => {
    const [row] = await database
      .select()
      .from(builderProvisioningJournals)
      .where(predicate(key))
      .limit(1);
    return row === undefined ? undefined : parse(key, row);
  };
  return {
    async compareAndSet(key, revision, raw) {
      const record = recordSchema.parse(raw);
      readNativeTargetAuthOnlyDeliveryPlan(key, record);
      const [row] = await database
        .update(builderProvisioningJournals)
        .set({ record, revision: revision + 1, state: stateFor(record), updatedAt: new Date() })
        .where(
          and(
            predicate(key),
            eq(builderProvisioningJournals.revision, revision),
            eq(builderProvisioningJournals.requestDigest, record.deliveryPlanDigest),
          ),
        )
        .returning();
      return row === undefined ? undefined : parse(key, row);
    },
    read,
    async retain(key, bytes) {
      const record = recordSchema.parse({
        kind: "native-target-auth-only-delivery",
        version: 1,
        operationRef: key.operationRef,
        deliveryPlanDigest: nativeTargetAuthOnlyDeliveryPlanDigest(bytes),
        planBase64: bytes.toString("base64"),
        phase: "planned",
        fenceGeneration: 0,
        gateway: { attempted: false, candidates: [] },
        app: { attempted: false, candidates: [] },
      });
      readNativeTargetAuthOnlyDeliveryPlan(key, record);
      const now = new Date();
      await database
        .insert(builderProvisioningJournals)
        .values({
          ...key.authority,
          requestId: requestIdFor(key),
          requestDigest: record.deliveryPlanDigest,
          record,
          revision: 1,
          state: "pending",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
      const retained = await read(key);
      if (retained === undefined || retained.record.planBase64 !== record.planBase64) {
        throw mismatch();
      }
      return retained;
    },
  };
};

export const nativeTargetAuthOnlyRoutingRequired = (
  key: NativeTargetAuthOnlyDeliveryKey,
  record: NativeTargetAuthOnlyDeliveryRecord,
) => {
  readNativeTargetAuthOnlyDeliveryPlan(key, record);
  if (record.finalRoutingPlan === undefined) {
    throw mismatch();
  }
  return {
    app: ready.parse(record.app.receipt),
    deliveryPlanDigest: record.deliveryPlanDigest,
    finalRoutingPlan: {
      appId: key.appId,
      deliveryPlanDigest: record.deliveryPlanDigest,
      operationRef: key.operationRef,
      routingOperationRef: record.finalRoutingPlan.operationRef,
      routingPlanDigest: record.finalRoutingPlan.digest,
    },
    gateway: ready.parse(record.gateway.receipt),
    status: "routing-required" as const,
  };
};

type Adapter = ReturnType<typeof createNativeTargetAuthOnlyPreviewDelivery>;
/** One fenced attempt; an uncertain create is reconciled and never blindly repeated. */
export const prepareNativeTargetAuthOnlyDelivery = async (input: {
  store: NativeTargetAuthOnlyDeliveryStore;
  key: NativeTargetAuthOnlyDeliveryKey;
  approval: NativeTargetAuthOnlyApproval;
  assertCurrent: () => Promise<void>;
  afterGatewayReady: (input: {
    gateway: z.infer<typeof ready>;
    deliveryPlanDigest: string;
    fenceGeneration: number;
    assertCurrent: () => Promise<void>;
  }) => Promise<NativeTargetAuthOnlyEntryReadiness>;
  prepareFinalRoutingPlan?: (input: {
    gateway: z.infer<typeof ready>;
    app: z.infer<typeof ready>;
    deliveryPlanDigest: string;
    fenceGeneration: number;
    assertCurrent: () => Promise<void>;
  }) => Promise<Buffer>;
  adapter: (
    target: "gateway" | "app",
    assertCurrent: () => Promise<void>,
    fenceGeneration: number,
  ) => Adapter;
  signal?: AbortSignal;
  now?: () => number;
}) => {
  const now = input.now ?? Date.now;
  // Auth-only delivery is not settled until the separately approved routing
  // refresh has produced its own retained READY receipt.
  if (input.prepareFinalRoutingPlan === undefined) {
    throw new HostedOperatorError("operator_unavailable");
  }
  await input.assertCurrent();
  const retained = await input.store.read(input.key);
  if (retained === undefined) {
    throw mismatch();
  }
  let row: NativeTargetAuthOnlyDeliveryRow = retained;
  const { plan } = readNativeTargetAuthOnlyDeliveryPlan(input.key, row.record);
  if (
    row.record.approval !== undefined &&
    !isDeepStrictEqual(row.record.approval, input.approval)
  ) {
    throw mismatch();
  }
  if (row.record.lease !== undefined && Date.parse(row.record.lease.expiresAt) > now()) {
    throw uncertain();
  }
  // Final routing owns its own retained plan/receipt. Never revisit bootstrap
  // deployment or alias reconciliation once that plan has been retained.
  if (row.record.finalRoutingPlan !== undefined) {
    return nativeTargetAuthOnlyRoutingRequired(input.key, row.record);
  }
  if (
    ["routing-pending", "running-final", "unknown-final", "prepared"].includes(row.record.phase)
  ) {
    throw mismatch();
  }
  const lease = { expiresAt: new Date(now() + 10 * 60_000).toISOString(), id: randomUUID() };
  const claimed = await input.store.compareAndSet(input.key, row.revision, {
    ...row.record,
    approval: input.approval,
    fenceGeneration: row.record.fenceGeneration + 1,
    lease,
    phase: "running",
  });
  if (claimed === undefined) {
    throw uncertain();
  }
  row = claimed;
  const { fenceGeneration } = row.record;
  const assertCurrent = async () => {
    input.signal?.throwIfAborted();
    await input.assertCurrent();
    const current = await input.store.read(input.key);
    if (
      current === undefined ||
      current.record.lease?.id !== lease.id ||
      current.record.fenceGeneration !== fenceGeneration ||
      Date.parse(lease.expiresAt) <= now()
    ) {
      throw uncertain();
    }
    row = current;
  };
  const update = async (record: NativeTargetAuthOnlyDeliveryRecord) => {
    const saved = await input.store.compareAndSet(input.key, row.revision, record);
    if (saved === undefined) {
      throw uncertain();
    }
    row = saved;
  };
  let entryReadiness: Extract<NativeTargetAuthOnlyEntryReadiness, { status: "ready" }> | undefined;
  const assertEntryReady = async () => {
    await assertCurrent();
    const observed = nativeTargetAuthOnlyEntryReadinessSchema.parse(
      await input.afterGatewayReady({
        assertCurrent,
        deliveryPlanDigest: row.record.deliveryPlanDigest,
        fenceGeneration,
        gateway: ready.parse(row.record.gateway.receipt),
      }),
    );
    if (observed.status !== "ready" || !isDeepStrictEqual(observed, entryReadiness)) {
      throw new HostedOperatorError("auth_identity_required");
    }
    await assertCurrent();
  };
  const prepareEffect = async (target: "gateway" | "app") => {
    const assertEffectCurrent = target === "gateway" ? assertCurrent : assertEntryReady;
    await assertEffectCurrent();
    const adapter = input.adapter(target, assertEffectCurrent, fenceGeneration);
    const context = (): NativeTargetAuthOnlyPreviewDeliveryInput => ({
      approval: input.approval,
      approvedPlanDigest: row.record.deliveryPlanDigest,
      assertCurrent: assertEffectCurrent,
      authority: input.key.authority,
      checkpointDelivery: async (candidates) => {
        await assertEffectCurrent();
        await update({ ...row.record, [target]: { ...row.record[target], candidates } });
      },
      deliveryCandidates: structuredClone(row.record[target].candidates),
      effectId: target === "gateway" ? "auth-only-gateway-preview" : "auth-only-app-preview",
      fenceGeneration,
      operationRef: input.key.operationRef,
      plan: plan.delivery,
      signal: input.signal,
      target: plan.target,
    });
    let result = await adapter.reconcile(context());
    await assertEffectCurrent();
    if (
      result.status === "retryable" &&
      (!row.record[target].attempted ||
        (target === "gateway" &&
          result.candidates.some((candidate) => candidate.readyState === "READY")))
    ) {
      if (!row.record[target].attempted) {
        await update({ ...row.record, [target]: { ...row.record[target], attempted: true } });
      }
      result = await adapter.deliver(context());
      await assertEffectCurrent();
    }
    if (result.status !== "applied") {
      throw uncertain();
    }
    const receipt = ready.parse(result.selected);
    await update({
      ...row.record,
      [target]: { ...row.record[target], candidates: result.candidates, receipt },
    });
    return receipt;
  };
  try {
    const receipt = await prepareEffect("gateway");
    await assertCurrent();
    const readiness = nativeTargetAuthOnlyEntryReadinessSchema.parse(
      await input.afterGatewayReady({
        assertCurrent,
        deliveryPlanDigest: row.record.deliveryPlanDigest,
        fenceGeneration,
        gateway: receipt,
      }),
    );
    await assertCurrent();
    if (readiness.status === "pending-owner") {
      if (Date.parse(readiness.authIdentityLinkExpiresAt) <= now()) {
        throw mismatch();
      }
      await update({ ...row.record, lease: undefined, phase: "pending-owner" });
      return { ...readiness, deliveryPlanDigest: row.record.deliveryPlanDigest };
    }
    entryReadiness = readiness;
    await prepareEffect("app");
    await assertEntryReady();
    const gateway = ready.parse(row.record.gateway.receipt);
    const app = ready.parse(row.record.app.receipt);
    {
      const routingBytes = await input.prepareFinalRoutingPlan({
        app,
        assertCurrent,
        deliveryPlanDigest: row.record.deliveryPlanDigest,
        fenceGeneration,
        gateway,
      });
      await assertCurrent();
      const routing = nativeTargetAuthOnlyFinalRoutingPlanSchema.parse(
        JSON.parse(routingBytes.toString("utf-8")),
      );
      const finalRoutingPlan = {
        base64: routingBytes.toString("base64"),
        digest: nativeTargetAuthOnlyFinalRoutingPlanDigest(routingBytes),
        operationRef: routing.operationRef,
      };
      const record = {
        ...row.record,
        finalRoutingPlan,
        lease: undefined,
        phase: "routing-pending" as const,
      };
      readNativeTargetAuthOnlyDeliveryPlan(input.key, record);
      await update(record);
      return nativeTargetAuthOnlyRoutingRequired(input.key, row.record);
    }
  } catch (error) {
    const current = await input.store.read(input.key);
    if (current?.record.lease?.id === lease.id) {
      await input.store.compareAndSet(input.key, current.revision, {
        ...current.record,
        lease: undefined,
        phase: "unknown",
      });
    }
    throw error;
  }
};

/** The separate Gateway routing lease is the only path from routing-pending to prepared. */
export const withNativeTargetAuthOnlyFinalRoutingLease = async <T>(input: {
  store: NativeTargetAuthOnlyDeliveryStore;
  key: NativeTargetAuthOnlyDeliveryKey;
  deliveryPlanDigest: string;
  approval: NativeTargetAuthOnlyApproval;
  gateway: z.infer<typeof ready>;
  app: z.infer<typeof ready>;
  run: (context: {
    fenceGeneration: number;
    assertCurrent: () => Promise<void>;
    reconcileOnly: boolean;
  }) => Promise<T>;
  assertAuthorized?: () => Promise<void>;
  withExecutionLease?: (
    context: { fenceGeneration: number; assertCurrent: () => Promise<void> },
    run: (assertPhysical: () => Promise<void>) => Promise<T>,
  ) => Promise<T>;
  now?: () => number;
}) => {
  const now = input.now ?? Date.now;
  await input.assertAuthorized?.();
  const current = await input.store.read(input.key);
  if (
    current === undefined ||
    ![
      ["routing-pending", "unknown-final", "running-final", "prepared"].includes(
        current.record.phase,
      ),
      current.record.deliveryPlanDigest === input.deliveryPlanDigest,
      isDeepStrictEqual(current.record.approval, input.approval),
      isDeepStrictEqual(current.record.gateway.receipt, input.gateway),
      isDeepStrictEqual(current.record.app.receipt, input.app),
      !(current.record.lease !== undefined && Date.parse(current.record.lease.expiresAt) > now()),
    ].every(Boolean)
  ) {
    throw uncertain();
  }
  const lease = { expiresAt: new Date(now() + 10 * 60_000).toISOString(), id: randomUUID() };
  const fenceGeneration = current.record.fenceGeneration + 1;
  const claimed = await input.store.compareAndSet(input.key, current.revision, {
    ...current.record,
    fenceGeneration,
    lease,
    phase: "running-final",
  });
  if (claimed === undefined) {
    throw uncertain();
  }
  let row = claimed;
  const assertCurrent = async () => {
    await input.assertAuthorized?.();
    const fresh = await input.store.read(input.key);
    const leaseExpired = Date.parse(lease.expiresAt) <= now();
    if (
      fresh === undefined ||
      leaseExpired ||
      ![
        fresh.record.phase === "running-final",
        fresh.record.lease?.id === lease.id,
        fresh.record.fenceGeneration === fenceGeneration,
        fresh.record.deliveryPlanDigest === input.deliveryPlanDigest,
        isDeepStrictEqual(fresh.record.approval, input.approval),
        isDeepStrictEqual(fresh.record.gateway.receipt, input.gateway),
        isDeepStrictEqual(fresh.record.app.receipt, input.app),
      ].every(Boolean)
    ) {
      throw uncertain();
    }
    row = fresh;
  };
  try {
    await assertCurrent();
    // A retained running/unknown routing attempt may only reconcile its original
    // effect. The caller receives this bit so it cannot issue a fresh refresh.
    const complete = async (assertPhysical?: () => Promise<void>) => {
      const result = await input.run({
        assertCurrent,
        fenceGeneration,
        reconcileOnly: current.record.phase !== "routing-pending",
      });
      await assertCurrent();
      await assertPhysical?.();
      const prepared = await input.store.compareAndSet(input.key, row.revision, {
        ...row.record,
        lease: undefined,
        phase: "prepared",
      });
      if (prepared === undefined) {
        throw uncertain();
      }
      return result;
    };
    return input.withExecutionLease === undefined
      ? await complete()
      : await input.withExecutionLease({ assertCurrent, fenceGeneration }, complete);
  } catch (error) {
    const latest = await input.store.read(input.key);
    if (latest?.record.lease?.id === lease.id) {
      await input.store.compareAndSet(input.key, latest.revision, {
        ...latest.record,
        lease: undefined,
        phase: "unknown-final",
      });
    }
    throw error;
  }
};
