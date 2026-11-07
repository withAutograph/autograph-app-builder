import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { builderProvisioningJournals } from "../db/schema";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Drizzle requires the complete database schema type.
import type * as databaseSchema from "../db/schema";
import { HostedOperatorError, workerEffectCheckpointFrameSchema } from "./hosted-operator-contract";
import {
  authOnlyOrganizationPlanSchema,
  authOnlySignupPolicyPlanSchema,
} from "./hosted-operator-sandbox-launcher";
import type { HostedOperatorWorkerEffectContext } from "./hosted-operator-service";
import { nativeTargetAuthOnlyApprovalSchema } from "./native-target-auth-only-dispatch";
import type { NativeTargetAuthOnlyApproval } from "./native-target-auth-only-dispatch";
import { builderAppIdSchema } from "./names";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z.string().min(1);
const effect = z.enum(["organization", "signup-policy"]);
const scopeSchema = z.strictObject({
  appId: builderAppIdSchema,
  sessionId: id,
  deliveryOperationRef: z.uuid(),
  deliveryPlanDigest: digest,
  resourcePlanDigest: digest,
  authResourceId: id,
  ownerProofSha256: digest,
  effect,
});
const keySchema = scopeSchema.extend({ authority: hostedTenantAuthoritySchema });
export type NativeTargetAuthOnlyEntryPlanKey = z.infer<typeof keySchema>;
export const nativeTargetAuthOnlyEntryApprovalInputSchema = z.strictObject({
  appId: builderAppIdSchema,
  deliveryOperationRef: z.uuid(),
  deliveryPlanDigest: digest,
  effect,
  childOperationRef: z.uuid(),
  childPlanDigest: digest,
});
export type NativeTargetAuthOnlyEntryApprovalInput = z.infer<
  typeof nativeTargetAuthOnlyEntryApprovalInputSchema
>;

const organization = authOnlyOrganizationPlanSchema.extend({ authOnlyEntry: scopeSchema });
const signupPolicy = authOnlySignupPolicyPlanSchema.extend({ authOnlyEntry: scopeSchema });
const planScope = (key: NativeTargetAuthOnlyEntryPlanKey) =>
  scopeSchema.parse({
    appId: key.appId,
    sessionId: key.sessionId,
    deliveryOperationRef: key.deliveryOperationRef,
    deliveryPlanDigest: key.deliveryPlanDigest,
    resourcePlanDigest: key.resourcePlanDigest,
    authResourceId: key.authResourceId,
    ownerProofSha256: key.ownerProofSha256,
    effect: key.effect,
  });
const mismatch = () => new HostedOperatorError("resource_mismatch");
const denied = () => new HostedOperatorError("authorization_required");
const uncertain = () => new HostedOperatorError("reconciliation_required");
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const parsePlan = (key: NativeTargetAuthOnlyEntryPlanKey, bytes: Buffer) => {
  const schema = key.effect === "organization" ? organization : signupPolicy;
  if (bytes.length === 0 || bytes.length > 1024 * 1024) {
    throw mismatch();
  }
  let plan: z.infer<typeof organization> | z.infer<typeof signupPolicy>;
  try {
    plan = schema.parse(JSON.parse(bytes.toString("utf-8")));
  } catch {
    // The approved list is private, including when plan parsing fails.
    throw mismatch();
  }
  if (!isDeepStrictEqual(plan.authOnlyEntry, planScope(key))) {
    throw mismatch();
  }
  if (
    plan.selection.sessionId !== key.sessionId ||
    plan.selection.workspaceId !== key.authority.workspaceId
  ) {
    throw mismatch();
  }
  if (
    plan.authDatabase.resourceId !== key.authResourceId ||
    plan.effects[0].resourceId !== key.authResourceId
  ) {
    throw mismatch();
  }
  if (
    plan.authMembership !== undefined &&
    (plan.authMembership.identityProof.sha256 !== key.ownerProofSha256 ||
      plan.authMembership.bootstrapPlanDigest !== key.resourcePlanDigest)
  ) {
    throw mismatch();
  }
  if (
    plan.authSignupPolicy !== undefined &&
    (plan.authSignupPolicy.appId !== key.appId ||
      plan.authSignupPolicy.authResourceId !== key.authResourceId)
  ) {
    throw mismatch();
  }
  return plan;
};

/** The private scope is included in the exact bytes. Both pinned workers accept this metadata. */
export const encodeNativeTargetAuthOnlyEntryPlan = (
  rawKey: NativeTargetAuthOnlyEntryPlanKey,
  plan:
    | z.infer<typeof authOnlyOrganizationPlanSchema>
    | z.infer<typeof authOnlySignupPolicyPlanSchema>,
) => {
  const key = keySchema.parse(rawKey);
  const bytes = Buffer.from(JSON.stringify({ ...plan, authOnlyEntry: planScope(key) }));
  parsePlan(key, bytes);
  return bytes;
};

const recordSchema = z.strictObject({
  kind: z.literal("native-target-auth-only-entry-plan"),
  version: z.literal(1),
  scope: scopeSchema,
  operationRef: z.uuid(),
  workerAttemptId: z.uuid(),
  // This child has one dispatch at most. The outer delivery lease is fenced independently.
  fenceGeneration: z.literal(1),
  planDigest: digest,
  planBase64: id,
  approval: nativeTargetAuthOnlyApprovalSchema.optional(),
  attempted: z.boolean(),
  workerContextDigest: digest.optional(),
  checkpoint: workerEffectCheckpointFrameSchema.optional(),
});
type EntryRecord = z.infer<typeof recordSchema>;
type Database = PostgresJsDatabase<typeof databaseSchema>;

const requestIdFor = (key: NativeTargetAuthOnlyEntryPlanKey) => {
  const hex = sha256(
    JSON.stringify([
      "native-target-auth-only-entry-plan-v1",
      key.appId,
      key.sessionId,
      key.deliveryOperationRef,
      key.effect,
    ]),
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const validateApproval = (
  key: NativeTargetAuthOnlyEntryPlanKey,
  record: EntryRecord,
  rawApproval: NativeTargetAuthOnlyApproval,
) => {
  const approval = nativeTargetAuthOnlyApprovalSchema.parse(rawApproval);
  const expected = {
    planDigest: key.deliveryPlanDigest,
    sourceDigest: record.planDigest,
    publicSessionId: key.sessionId,
    responderPrincipalId: key.authority.ownerUserId,
  };
  if (!isDeepStrictEqual({ ...approval, ...expected }, approval)) {
    throw denied();
  }
  return approval;
};
const approvalInput = (key: NativeTargetAuthOnlyEntryPlanKey, record: EntryRecord) =>
  nativeTargetAuthOnlyEntryApprovalInputSchema.parse({
    appId: key.appId,
    deliveryOperationRef: key.deliveryOperationRef,
    deliveryPlanDigest: key.deliveryPlanDigest,
    effect: key.effect,
    childOperationRef: record.operationRef,
    childPlanDigest: record.planDigest,
  });
const stateFor = (record: EntryRecord) => (record.approval === undefined ? "pending" : "settled");
const validateFrame = (
  record: EntryRecord,
  frame: z.infer<typeof workerEffectCheckpointFrameSchema>,
  effectId: string,
) => {
  if (
    frame.operationId !== record.operationRef ||
    frame.fenceGeneration !== record.fenceGeneration
  ) {
    throw mismatch();
  }
  if (frame.contextDigest !== record.workerContextDigest || frame.effectId !== effectId) {
    throw mismatch();
  }
  const targetsTenant = frame.tenantId !== null && frame.tenantId !== undefined;
  if (frame.resourceId !== record.scope.authResourceId || targetsTenant || frame.sequence !== 1) {
    throw mismatch();
  }
};

/** Retain exact private bytes and the one child dispatch intent in an owner-scoped CAS journal. */
export const createPostgresNativeTargetAuthOnlyEntryPlanStore = (input: {
  database: Database;
  assertCurrentOwner: (key: NativeTargetAuthOnlyEntryPlanKey) => Promise<void>;
}) => {
  const whereFor = (key: NativeTargetAuthOnlyEntryPlanKey) =>
    and(
      eq(builderProvisioningJournals.issuer, key.authority.issuer),
      eq(builderProvisioningJournals.audience, key.authority.audience),
      eq(builderProvisioningJournals.workspaceId, key.authority.workspaceId),
      eq(builderProvisioningJournals.ownerUserId, key.authority.ownerUserId),
      eq(builderProvisioningJournals.requestId, requestIdFor(key)),
      sql`${builderProvisioningJournals.record}->>'kind' = 'native-target-auth-only-entry-plan'`,
    );
  const read = async (rawKey: NativeTargetAuthOnlyEntryPlanKey) => {
    const key = keySchema.parse(rawKey);
    await input.assertCurrentOwner(key);
    const [row] = await input.database
      .select()
      .from(builderProvisioningJournals)
      .where(whereFor(key))
      .limit(1);
    await input.assertCurrentOwner(key);
    if (row === undefined) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- The store distinguishes a missing row from rejected authority.
      return undefined;
    }
    const record = recordSchema.parse(row.record);
    const approvedPlanBytes = Buffer.from(record.planBase64, "base64");
    if (!isDeepStrictEqual(record.scope, planScope(key)) || row.state !== stateFor(record)) {
      throw mismatch();
    }
    if (
      row.requestDigest !== record.planDigest ||
      sha256(approvedPlanBytes) !== record.planDigest
    ) {
      throw mismatch();
    }
    const hasWorkerEvidence =
      record.workerContextDigest !== undefined || record.checkpoint !== undefined;
    if (
      (!record.attempted && hasWorkerEvidence) ||
      (record.attempted && record.approval === undefined)
    ) {
      throw mismatch();
    }
    const plan = parsePlan(key, approvedPlanBytes);
    if (record.approval !== undefined) {
      validateApproval(key, record, record.approval);
    }
    if (record.checkpoint !== undefined) {
      validateFrame(record, record.checkpoint, plan.effects[0].id);
    }
    return {
      record,
      approvedPlanBytes,
      revision: row.revision,
      approvalInput: approvalInput(key, record),
      effectId: plan.effects[0].id,
    };
  };
  const update = async (
    key: NativeTargetAuthOnlyEntryPlanKey,
    revision: number,
    next: EntryRecord,
  ) => {
    await input.assertCurrentOwner(key);
    const [row] = await input.database
      .update(builderProvisioningJournals)
      .set({ record: next, revision: revision + 1, state: stateFor(next), updatedAt: new Date() })
      .where(
        and(
          whereFor(key),
          eq(builderProvisioningJournals.revision, revision),
          eq(builderProvisioningJournals.requestDigest, next.planDigest),
        ),
      )
      .returning();
    await input.assertCurrentOwner(key);
    return row !== undefined;
  };
  const retain = async (rawKey: NativeTargetAuthOnlyEntryPlanKey, rawBytes: Buffer) => {
    const key = keySchema.parse(rawKey);
    const approvedPlanBytes = Buffer.from(rawBytes);
    parsePlan(key, approvedPlanBytes);
    const record = recordSchema.parse({
      kind: "native-target-auth-only-entry-plan",
      version: 1,
      scope: planScope(key),
      operationRef: randomUUID(),
      workerAttemptId: randomUUID(),
      fenceGeneration: 1,
      planDigest: sha256(approvedPlanBytes),
      planBase64: approvedPlanBytes.toString("base64"),
      attempted: false,
    });
    await input.assertCurrentOwner(key);
    const now = new Date();
    await input.database
      .insert(builderProvisioningJournals)
      .values({
        ...key.authority,
        requestId: requestIdFor(key),
        requestDigest: record.planDigest,
        record,
        revision: 1,
        state: stateFor(record),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    const retained = await read(key);
    if (retained === undefined || !retained.approvedPlanBytes.equals(approvedPlanBytes)) {
      throw mismatch();
    }
    return retained;
  };
  const settle = async (
    key: NativeTargetAuthOnlyEntryPlanKey,
    rawApproval: NativeTargetAuthOnlyApproval,
  ) => {
    const current = await read(key);
    if (current === undefined) {
      throw denied();
    }
    const approval = validateApproval(key, current.record, rawApproval);
    const prior = current.record.approval;
    if (prior !== undefined && isDeepStrictEqual(prior, approval)) {
      return;
    }
    if (prior !== undefined) {
      const sameRequest =
        prior.requestId === approval.requestId && prior.callId === approval.callId;
      if (!sameRequest || prior.outcome !== "approved" || approval.outcome !== "cancelled") {
        throw denied();
      }
    }
    if (!(await update(key, current.revision, { ...current.record, approval }))) {
      throw uncertain();
    }
  };
  const openApprovedEffect = async (
    key: NativeTargetAuthOnlyEntryPlanKey,
    approval: NativeTargetAuthOnlyApproval,
    assertCurrentApprovalAndDeliveryLease: () => Promise<void>,
  ) => {
    const readCurrent = async () => {
      await assertCurrentApprovalAndDeliveryLease();
      const current = await read(key);
      if (
        current?.record.approval?.outcome !== "approved" ||
        !isDeepStrictEqual(current.record.approval, approval)
      ) {
        throw denied();
      }
      await assertCurrentApprovalAndDeliveryLease();
      return current;
    };
    const initial = await readCurrent();
    let claimedHere = false;
    let workerBoundHere = false;
    const assertCurrent = async () => {
      await readCurrent();
    };
    const claimFirstDispatch = async () => {
      const current = await readCurrent();
      if (current.record.attempted) {
        return false;
      }
      const claimed = await update(key, current.revision, { ...current.record, attempted: true });
      if (claimed) {
        claimedHere = true;
      }
      await assertCurrent();
      return claimed;
    };
    const bindWorkerContext: HostedOperatorWorkerEffectContext["bindWorkerContext"] = async ({
      contextDigest,
    }) => {
      if (!claimedHere || workerBoundHere) {
        throw denied();
      }
      workerBoundHere = true;
      const current = await readCurrent();
      if (!current.record.attempted) {
        throw denied();
      }
      if (current.record.workerContextDigest === undefined) {
        const next = { ...current.record, workerContextDigest: digest.parse(contextDigest) };
        if (!(await update(key, current.revision, next))) {
          throw uncertain();
        }
      } else if (current.record.workerContextDigest !== contextDigest) {
        throw mismatch();
      }
      await assertCurrent();
      return async (rawFrame) => {
        const row = await readCurrent();
        const frame = workerEffectCheckpointFrameSchema.parse(rawFrame);
        validateFrame(row.record, frame, row.effectId);
        if (row.record.checkpoint !== undefined) {
          if (!isDeepStrictEqual(row.record.checkpoint, frame)) {
            throw mismatch();
          }
          return;
        }
        if (!(await update(key, row.revision, { ...row.record, checkpoint: frame }))) {
          throw uncertain();
        }
        await assertCurrent();
      };
    };
    return {
      approval,
      approvedPlanBytes: initial.approvedPlanBytes,
      operationRef: initial.record.operationRef,
      workerAttemptId: initial.record.workerAttemptId,
      fenceGeneration: initial.record.fenceGeneration,
      assertCurrent,
      claimFirstDispatch,
      bindWorkerContext,
    };
  };
  return { read, retain, settle, openApprovedEffect };
};
