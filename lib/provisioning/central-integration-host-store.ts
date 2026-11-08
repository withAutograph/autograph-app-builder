/* oxlint-disable eslint/complexity, sonarjs/expression-complexity -- Stored intent, immutable authority and completed effect scopes are checked together before readiness may be returned. */
import { isDeepStrictEqual } from "node:util";
import { and, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import { builderProvisioningJournals } from "../db/schema";
import type { HostedDatabase as Database } from "../db/hosted-postgres";
import type { ReadCentralIntegrationHostReady } from "./app-integration-central-authority";
import {
  centralHostSetupPlanSchema,
  centralHostCallerPlanSchema,
  centralHostReadyReceiptSchema,
  centralHostPlanDigest,
  centralHostOperationRef,
} from "./central-integration-host-contract";
import { centralNativeDeploymentStateSchema } from "./central-integration-deployment-receipt";

import {
  centralExecutionLeaseSchema,
  centralEffectAttemptSchema,
  centralRuntimeBindingSchema,
  centralEffectReceiptMatches,
} from "./central-integration-host-checkpoint";

const CENTRAL_HOST_SETUP_KIND = "central-integration-host-setup-v1";

const phase = z.enum(["idle", "pending", "applied"]);
const receipt = z.strictObject({
  approvalId: z.string().min(1).optional(),
  approvedByCallId: z.string().min(1),
  approvedAt: z.string().min(1),
});
export const centralHostRecordSchema = z
  .strictObject({
    kind: z.literal("central-integration-host-journal-v1"),
    plan: z.union([centralHostSetupPlanSchema, centralHostCallerPlanSchema]),
    planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    effects: z.record(z.string(), phase),
    approvalReceipts: z.array(receipt).optional(),
    executionLease: centralExecutionLeaseSchema.optional(),
    attempts: z.record(z.string(), centralEffectAttemptSchema).optional(),
    runtimeBindings: z.record(z.string(), centralRuntimeBindingSchema).optional(),
    nativeDeployment: centralNativeDeploymentStateSchema.optional(),
    observation: centralHostReadyReceiptSchema.optional(),
  })
  .superRefine((record, ctx) => {
    const { plan } = record;
    const attempts = record.attempts ?? {};
    if (record.attempts !== undefined) {
      const firstUnfinished = plan.effects.findIndex(
        (effect) => record.effects[effect] !== "applied",
      );
      if (
        plan.effects.some(
          (effect, index) =>
            (record.effects[effect] !== "idle" && attempts[effect] === undefined) ||
            (firstUnfinished !== -1 &&
              index > firstUnfinished &&
              record.effects[effect] !== "idle"),
        ) ||
        (Object.keys(attempts).length > 0 && (record.approvalReceipts?.length ?? 0) === 0)
      ) {
        ctx.addIssue({ code: "custom", message: "Ordered approved effect attempts required" });
      }
    }

    if (
      Object.entries(attempts).some(
        ([effect, attempt]) =>
          record.executionLease === undefined ||
          attempt.attemptGeneration > record.executionLease.fenceGeneration ||
          !plan.effects.some((key) => key === effect) ||
          record.effects[effect] === "idle" ||
          (record.effects[effect] === "applied" && attempt.receipt === undefined) ||
          (attempt.receipt !== undefined &&
            (attempt.receipt.effect !== effect ||
              !centralEffectReceiptMatches(plan, attempt.receipt, attempt.attemptGeneration))) ||
          (attempt.grantAttempt !== undefined &&
            !["authorize-central-inspector", "authorize-app-central-caller"].includes(effect)),
      )
    ) {
      ctx.addIssue({ code: "custom", message: "Exact effect attempt custody required" });
    }
    if (
      record.runtimeBindings !== undefined &&
      (record.effects["bind-central-preview-runtime"] === "idle" ||
        plan.kind !== CENTRAL_HOST_SETUP_KIND ||
        Object.keys(record.runtimeBindings).some(
          (key) => !plan.environment.some((entry) => entry.key === key),
        ))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Only the frozen central branch binding keys may be retained",
      });
    }

    if (plan.kind === CENTRAL_HOST_SETUP_KIND) {
      const native = record.nativeDeployment;
      if (
        native === undefined ||
        (native.status === "accepted" &&
          native.events.some(
            (event) =>
              event.projectId !== plan.target.projectId ||
              event.teamId !== plan.target.teamId ||
              event.providerDeploymentId !== native.providerDeploymentId ||
              event.immutableOrigin !== native.immutableOrigin,
          ))
      ) {
        ctx.addIssue({ code: "custom", message: "Exact native deployment receipt scope required" });
      }
    } else if (record.nativeDeployment !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Caller setup cannot select native deployment identity",
      });
    }
    if (
      record.planDigest !== centralHostPlanDigest(plan) ||
      !isDeepStrictEqual(Object.keys(record.effects).toSorted(), [...plan.effects].toSorted()) ||
      (record.observation &&
        (Object.values(record.effects).some((value) => value !== "applied") ||
          (record.approvalReceipts?.length ?? 0) === 0 ||
          plan.kind !== "central-integration-host-caller-v1" ||
          !isDeepStrictEqual(record.observation.authority, plan.authority) ||
          !isDeepStrictEqual(record.observation.setup, plan.setup) ||
          record.observation.callerSetup.operationRef !== centralHostOperationRef(plan) ||
          record.observation.callerSetup.planDigest !== record.planDigest ||
          record.observation.deployment.projectId !== plan.central.projectId ||
          record.observation.deployment.teamId !== plan.central.teamId ||
          record.observation.deployment.providerDeploymentId !==
            plan.central.providerDeploymentId ||
          record.observation.deployment.immutableOrigin !== plan.central.immutableOrigin ||
          record.observation.deployment.configurationSha256 !== plan.central.configurationSha256 ||
          record.observation.caller.projectId !== plan.caller.projectId ||
          record.observation.caller.ownerId !== plan.caller.ownerId))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Exact completed central host setup and caller authority required",
      });
    }
  });
export type CentralHostRecord = z.infer<typeof centralHostRecordSchema>;
export interface CentralHostRow {
  operationRef: string;
  revision: number;
  record: CentralHostRecord;
}
type Authority = CentralHostRecord["plan"]["authority"];
const nativeTransitionAllowed = (
  before: CentralHostRecord["nativeDeployment"],
  after: CentralHostRecord["nativeDeployment"],
) => {
  if (before === undefined) {
    return after === undefined;
  }
  if (after === undefined) {
    return false;
  }
  if (before.status === "conflict") {
    return isDeepStrictEqual(before, after);
  }
  if (before.status === "empty") {
    return after.status !== "conflict";
  }
  if (after.status === "empty") {
    return false;
  }
  if (after.status === "conflict") {
    return after.providerDeploymentIds.includes(before.providerDeploymentId);
  }
  return (
    before.providerDeploymentId === after.providerDeploymentId &&
    before.immutableOrigin === after.immutableOrigin &&
    isDeepStrictEqual(after.events.slice(0, before.events.length), before.events)
  );
};
export const assertCentralHostTransition = (
  before: CentralHostRecord,
  after: CentralHostRecord,
) => {
  const old = centralHostRecordSchema.parse(before);
  const next = centralHostRecordSchema.parse(after);
  if (
    !isDeepStrictEqual(old.plan, next.plan) ||
    old.planDigest !== next.planDigest ||
    !nativeTransitionAllowed(old.nativeDeployment, next.nativeDeployment) ||
    Object.entries(old.effects).some(([key, value]) =>
      value === "applied"
        ? next.effects[key] !== "applied"
        : value === "pending" && next.effects[key] === "idle",
    ) ||
    (old.approvalReceipts !== undefined &&
      !isDeepStrictEqual(
        next.approvalReceipts?.slice(0, old.approvalReceipts.length),
        old.approvalReceipts,
      )) ||
    (old.observation !== undefined && !isDeepStrictEqual(old.observation, next.observation)) ||
    (old.executionLease !== undefined &&
      (next.executionLease === undefined ||
        next.executionLease.fenceGeneration < old.executionLease.fenceGeneration ||
        (next.executionLease.fenceGeneration === old.executionLease.fenceGeneration &&
          next.executionLease.leaseId !== old.executionLease.leaseId)))
  ) {
    throw new Error("central_host_transition_rejected");
  }
  for (const [key, attempt] of Object.entries(old.attempts ?? {})) {
    const current = next.attempts?.[key];
    if (
      current === undefined ||
      current.attemptId !== attempt.attemptId ||
      current.attemptGeneration !== attempt.attemptGeneration ||
      (attempt.grantAttempt !== undefined &&
        !isDeepStrictEqual(current.grantAttempt, attempt.grantAttempt)) ||
      (attempt.receipt !== undefined && !isDeepStrictEqual(current.receipt, attempt.receipt))
    ) {
      throw new Error("central_host_transition_rejected");
    }
  }
  for (const [key, binding] of Object.entries(old.runtimeBindings ?? {})) {
    const current = next.runtimeBindings?.[key];
    if (
      current === undefined ||
      (binding.state !== "idle" &&
        (current.state === "idle" ||
          current.attemptGeneration !== binding.attemptGeneration ||
          (binding.acceptedEnvId !== undefined &&
            current.acceptedEnvId !== binding.acceptedEnvId))) ||
      (binding.state === "applied" && current.state !== "applied")
    ) {
      throw new Error("central_host_transition_rejected");
    }
  }
};
const fail = () => new Error("central_integration_host_unavailable");
const authorityWhere = (authority: Authority) =>
  and(
    eq(builderProvisioningJournals.issuer, authority.issuer),
    eq(builderProvisioningJournals.audience, authority.audience),
    eq(builderProvisioningJournals.workspaceId, authority.workspaceId),
    eq(builderProvisioningJournals.ownerUserId, authority.ownerUserId),
    sql`${builderProvisioningJournals.record}->>'kind'='central-integration-host-journal-v1'`,
  );
const parse = (raw: typeof builderProvisioningJournals.$inferSelect): CentralHostRow => {
  const record = centralHostRecordSchema.parse(raw.record);
  if (
    raw.requestId !== centralHostOperationRef(record.plan) ||
    raw.requestDigest !== record.planDigest ||
    raw.issuer !== record.plan.authority.issuer ||
    raw.audience !== record.plan.authority.audience ||
    raw.workspaceId !== record.plan.authority.workspaceId ||
    raw.ownerUserId !== record.plan.authority.ownerUserId
  ) {
    throw fail();
  }
  return { operationRef: raw.requestId, revision: raw.revision, record };
};
export const createPostgresCentralHostStore = (database: Database) => {
  const read = async (authority: Authority, operationRef: string) => {
    const rows = await database
      .select()
      .from(builderProvisioningJournals)
      .where(
        and(authorityWhere(authority), eq(builderProvisioningJournals.requestId, operationRef)),
      )
      .limit(1);
    const selectedRaw = rows.at(0);
    return selectedRaw === undefined ? undefined : parse(selectedRaw);
  };
  return {
    read,
    async reserve(plan: CentralHostRecord["plan"]) {
      const record = centralHostRecordSchema.parse({
        kind: "central-integration-host-journal-v1",
        plan,
        planDigest: centralHostPlanDigest(plan),
        effects: Object.fromEntries(plan.effects.map((effect) => [effect, "idle"])),
        attempts: {},
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Preserve conditional fields and evaluation order.
        ...(plan.kind === CENTRAL_HOST_SETUP_KIND ? { nativeDeployment: { status: "empty" } } : {}),
      });
      const operationRef = centralHostOperationRef(plan);
      const now = new Date();
      const rows = await database
        .insert(builderProvisioningJournals)
        .values({
          ...plan.authority,
          requestId: operationRef,
          requestDigest: record.planDigest,
          record,
          revision: 1,
          state: "pending",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning();
      const selectedRaw = rows.at(0);
      const row =
        selectedRaw === undefined ? await read(plan.authority, operationRef) : parse(selectedRaw);
      if (row === undefined || !isDeepStrictEqual(row.record.plan, record.plan)) {
        throw fail();
      }
      return row;
    },
    async compareAndSet(row: CentralHostRow, raw: CentralHostRecord) {
      const record = centralHostRecordSchema.parse(raw);
      assertCentralHostTransition(row.record, record);
      const rows = await database
        .update(builderProvisioningJournals)
        .set({
          record,
          revision: row.revision + 1,
          state: record.observation ? "settled" : "pending",
          updatedAt: new Date(),
        })
        .where(
          and(
            authorityWhere(record.plan.authority),
            eq(builderProvisioningJournals.requestId, row.operationRef),
            eq(builderProvisioningJournals.revision, row.revision),
            eq(builderProvisioningJournals.requestDigest, row.record.planDigest),
          ),
        )
        .returning();
      const selectedRaw = rows.at(0);
      return selectedRaw === undefined ? undefined : parse(selectedRaw);
    },
    async readSetupForSubscription(owners: readonly Authority[], subscriptionRef: string) {
      if (owners.length === 0) {
        throw fail();
      }
      const rows = await database
        .select()
        .from(builderProvisioningJournals)
        .where(
          and(
            or(...owners.map(authorityWhere)),
            sql`${builderProvisioningJournals.record}->'plan'->>'kind'='central-integration-host-setup-v1'`,
            sql`${builderProvisioningJournals.record}->'plan'->'receiver'->>'subscriptionRef'=${subscriptionRef}`,
          ),
        )
        .limit(2);
      if (rows.length > 1) {
        throw fail();
      }
      return rows[0] === undefined ? undefined : parse(rows[0]);
    },
    async findSetupForProfile(
      owners: readonly Authority[],
      profileDigest: string,
      projectId: string,
    ) {
      if (owners.length === 0) {
        throw fail();
      }
      const rows = await database
        .select()
        .from(builderProvisioningJournals)
        .where(
          and(
            or(...owners.map(authorityWhere)),
            sql`${builderProvisioningJournals.record}->'plan'->>'kind'='central-integration-host-setup-v1'`,
            sql`${builderProvisioningJournals.record}->'plan'->'profile'->>'digest'=${profileDigest}`,
            sql`${builderProvisioningJournals.record}->'plan'->'target'->>'projectId'=${projectId}`,
          ),
        )
        .limit(2);
      if (rows.length > 1) {
        throw fail();
      }
      return rows[0] === undefined ? undefined : parse(rows[0]);
    },
    async readReadyCaller(authority: Authority, appProjectId: string) {
      const rows = await database
        .select()
        .from(builderProvisioningJournals)
        .where(
          and(
            authorityWhere(authority),
            sql`${builderProvisioningJournals.record}->'plan'->>'kind'='central-integration-host-caller-v1'`,
            sql`${builderProvisioningJournals.record}->'plan'->'caller'->>'projectId'=${appProjectId}`,
            sql`${builderProvisioningJournals.record}->'observation' IS NOT NULL`,
          ),
        )
        .limit(2);
      // Multiple retained destinations need explicit supported reconciliation, never latest-row election.
      if (rows.length > 1) {
        throw fail();
      }
      const selectedRaw = rows.at(0);
      return selectedRaw === undefined ? undefined : parse(selectedRaw);
    },
  };
};
/** Reads only canonical retained state and reobserves actual provider/SQL/caller authority before returning readiness. */
export const createReadCentralIntegrationHostReady =
  (input: {
    store: Pick<ReturnType<typeof createPostgresCentralHostStore>, "read" | "readReadyCaller">;
    assertSetupAuthorized: (
      request: Parameters<ReadCentralIntegrationHostReady>[0],
      setup: CentralHostRow,
    ) => Promise<void>;
    observe: (
      request: Parameters<ReadCentralIntegrationHostReady>[0],
      caller: CentralHostRow,
      setup: CentralHostRow,
    ) => Promise<z.infer<typeof centralHostReadyReceiptSchema>>;
  }): ReadCentralIntegrationHostReady =>
  async (request) => {
    request.signal.throwIfAborted();
    await request.assertCurrentOwner();
    const caller = await input.store.readReadyCaller(request.authority, request.appProjectId);
    if (caller === undefined) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Absence is explicit in the optional readiness port.
      return undefined;
    }
    if (
      caller.record.plan.kind !== "central-integration-host-caller-v1" ||
      !isDeepStrictEqual(caller.record.plan.authority, request.authority) ||
      caller.record.plan.caller.projectId !== request.appProjectId ||
      caller.record.plan.selection.initiatingAppId !== request.appId ||
      caller.record.observation === undefined
    ) {
      throw fail();
    }
    const setup = await input.store.read(
      caller.record.plan.setupAuthority,
      caller.record.plan.setup.operationRef,
    );
    if (
      setup === undefined ||
      setup.record.plan.kind !== CENTRAL_HOST_SETUP_KIND ||
      setup.record.planDigest !== caller.record.plan.setup.planDigest ||
      setup.record.nativeDeployment?.status !== "accepted" ||
      setup.record.nativeDeployment.providerDeploymentId !==
        caller.record.observation.deployment.providerDeploymentId ||
      setup.record.nativeDeployment.immutableOrigin !==
        caller.record.observation.deployment.immutableOrigin ||
      Object.values(setup.record.effects).some((value) => value !== "applied") ||
      (setup.record.approvalReceipts?.length ?? 0) === 0 ||
      setup.record.plan.target.teamId !== request.teamId ||
      caller.record.plan.central.teamId !== request.teamId
    ) {
      throw fail();
    }
    await input.assertSetupAuthorized(request, setup);
    const retained = caller.record.observation;
    const frozen = setup.record.plan;
    if (
      !isDeepStrictEqual(retained.control, frozen.control) ||
      !isDeepStrictEqual(retained.activation, frozen.activation) ||
      !isDeepStrictEqual(retained.provider, frozen.provider) ||
      !isDeepStrictEqual(retained.profile, frozen.profile) ||
      retained.resourceProfileId !== frozen.resourceProfileId ||
      retained.deployment.serviceId !== frozen.target.serviceId ||
      retained.deployment.projectId !== frozen.target.projectId ||
      retained.deployment.teamId !== frozen.target.teamId ||
      retained.deployment.installationId !== frozen.target.installationId ||
      retained.deployment.configurationRef !== frozen.source.configurationRef ||
      retained.deployment.configurationSha256 !== frozen.source.configurationSha256
    ) {
      throw fail();
    }
    const actual = centralHostReadyReceiptSchema.parse(await input.observe(request, caller, setup));
    request.signal.throwIfAborted();
    await request.assertCurrentOwner();
    await input.assertSetupAuthorized(request, setup);
    if (!isDeepStrictEqual(actual, caller.record.observation)) {
      throw fail();
    }
    return actual;
  };
