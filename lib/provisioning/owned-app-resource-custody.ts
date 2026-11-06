/* oxlint-disable eslint/no-await-in-loop -- Each metadata page and owner/source check follows its durable cursor; no provider writes occur here. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { builderProvisioningJournals } from "../db/schema";
import type { openHostedPostgresDatabase } from "../mcp/hosted-route";
import type { VercelTokenKeyringConfig } from "../integrations/vercel-installation";
import { HostedOperatorError, operatorPlanDigest } from "./hosted-operator-contract";
import type { HostedOperatorPlan, OperatorAuthSchemaPreparation } from "./hosted-operator-contract";
import type {
  HostedOperatorContext,
  ProtectedHostedOperatorDependencies,
} from "./hosted-operator-service";
import {
  hostedRuntimeJournalRecordSchema,
  retainedOperatorAuthFromJournal,
} from "./hosted-runtime-journal";
import type {
  HostedRuntimeJournalStore,
  HostedRuntimeJournalRecord,
} from "./hosted-runtime-journal";
import { ownedAppResourceSourceSchema } from "./owned-app-resource-source-contract";
import type { OwnedAppResourceSource } from "./owned-app-resource-source-contract";
import {
  ownedAppResourceIdentity,
  rewrapOwnedAppResourceCredentials,
} from "./hosted-operator-resource-credentials";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const fail = () => new HostedOperatorError("reconciliation_required");
const recordSchema = z.strictObject({
  kind: z.literal("owned-app-resource-source-v1"),
  reference: ownedAppResourceSourceSchema,
  scope: z.record(z.string(), z.unknown()),
});

/** Private stable credential provenance; it never grants a resource effect or stores plaintext. */
export const createOwnedAppResourceCustody = (deps: {
  database: ReturnType<typeof openHostedPostgresDatabase>;
  configuration: Pick<HostedOperatorSourceConfiguration, "standardRuntime">;
  keyring: VercelTokenKeyringConfig;
  store: Pick<HostedRuntimeJournalStore, "read">;
  assertCurrentOwner: (context: HostedOperatorContext) => Promise<void>;
  sourceContext: (
    context: HostedOperatorContext,
    target: OwnedAppResourceSource["source"]["target"],
  ) => Promise<HostedOperatorContext>;
  readApproval: ProtectedHostedOperatorDependencies["readApproval"];
  isExistingRevision: (context: HostedOperatorContext) => Promise<boolean>;
}) => {
  const scopeFor = (context: HostedOperatorContext, plan: HostedOperatorPlan) => {
    const normal = deps.configuration.standardRuntime;
    if (
      normal === undefined ||
      plan.runtimePreparation !== "single-project-resources-v1" ||
      plan.authAdoption !== undefined
    ) {
      throw fail();
    }
    const scope = {
      appId: context.target.appId,
      authority: hostedTenantAuthoritySchema.parse(context.authority),
      installationId: context.target.installationId,
      projectId: context.target.projectId,
      provisioningDigest: normal.provisioningDigest,
      provisioningRequestId: normal.provisioningRequestId,
      resources: ownedAppResourceIdentity(plan),
      teamId: context.target.scopeId,
    };
    const digest = hash(JSON.stringify(["owned-app-resource-source-v1", scope]));
    const requestId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    return { digest, requestId, scope };
  };
  const readCustody = async (context: HostedOperatorContext, plan: HostedOperatorPlan) => {
    await deps.assertCurrentOwner(context);
    const identity = scopeFor(context, plan);
    const rows = await deps.database
      .select()
      .from(builderProvisioningJournals)
      .where(
        and(
          eq(builderProvisioningJournals.issuer, context.authority.issuer),
          eq(builderProvisioningJournals.audience, context.authority.audience),
          eq(builderProvisioningJournals.workspaceId, context.authority.workspaceId),
          eq(builderProvisioningJournals.ownerUserId, context.authority.ownerUserId),
          eq(builderProvisioningJournals.requestId, identity.requestId),
          sql`${builderProvisioningJournals.record}->>'kind' = 'owned-app-resource-source-v1'`,
        ),
      )
      .limit(1);
    await deps.assertCurrentOwner(context);
    const row = rows[0];
    if (row === undefined) {
      return { identity };
    }
    const record = recordSchema.parse(row.record);
    if (
      row.state !== "settled" ||
      row.requestDigest !== identity.digest ||
      !isDeepStrictEqual(record.scope, identity.scope) ||
      record.reference.scopeDigest !== identity.digest
    ) {
      throw fail();
    }
    return { identity, reference: record.reference };
  };
  const completed = (record: HostedRuntimeJournalRecord) =>
    record.retainedAuth ?? retainedOperatorAuthFromJournal(record);
  const sourceInput = async (
    context: HostedOperatorContext,
    plan: HostedOperatorPlan,
    reference: OwnedAppResourceSource,
  ) => {
    const sourceContext = await deps.sourceContext(context, reference.source.target);
    const row = await deps.store.read(sourceContext);
    const setup =
      row === undefined
        ? undefined
        : [row.record.retainedAuth, retainedOperatorAuthFromJournal(row.record)].find(
            (entry) =>
              entry?.operationRef === reference.source.operationRef &&
              entry.planDigest === reference.source.planDigest,
          );
    const sameTarget = isDeepStrictEqual(sourceContext.target, context.target);
    if (row === undefined || setup === undefined || row.record.privateState === undefined) {
      throw fail();
    }
    const same = [
      hash(JSON.stringify(row.record.privateState)) === reference.source.checkpointSha256,
      sameTarget ||
        (row.record.leaseId === undefined &&
          row.record.operator?.pendingEffectId === undefined &&
          row.record.operator?.pendingEffectAttempt === undefined),
      isDeepStrictEqual(sourceContext.authority, context.authority),
      isDeepStrictEqual(ownedAppResourceIdentity(setup.plan), ownedAppResourceIdentity(plan)),
      setup.plan.runtimePreparation === "single-project-resources-v1",
      setup.plan.selection.projectId === context.target.projectId,
    ].every(Boolean);
    if (!same) {
      throw fail();
    }
    const approval = await deps.readApproval({
      ...sourceContext,
      action: "prepare",
      callId: setup.approvedByCallId,
      planDigest: setup.planDigest,
    });
    if (
      ![
        approval?.approved === true,
        approval?.action === "prepare",
        approval?.approvalId === setup.approvalId,
        approval?.callId === setup.approvedByCallId,
        approval?.planDigest === setup.planDigest,
      ].every(Boolean)
    ) {
      throw new HostedOperatorError("authorization_required");
    }
    await deps.assertCurrentOwner(context);
    return { context: sourceContext, record: row.record, setup };
  };
  const fallback = async (
    context: HostedOperatorContext,
    plan: HostedOperatorPlan,
    scopeDigest: string,
  ) => {
    // Page all matching history, then demand one COMPLETE owned source. Pending
    // proposals never make an unrelated completed checkpoint ambiguous.
    let cursor: string | undefined;
    let selected: OwnedAppResourceSource | undefined;
    for (;;) {
      await deps.assertCurrentOwner(context);
      const rows = await deps.database
        .select({
          record: builderProvisioningJournals.record,
          requestId: builderProvisioningJournals.requestId,
        })
        .from(builderProvisioningJournals)
        .where(
          and(
            eq(builderProvisioningJournals.issuer, context.authority.issuer),
            eq(builderProvisioningJournals.audience, context.authority.audience),
            eq(builderProvisioningJournals.workspaceId, context.authority.workspaceId),
            eq(builderProvisioningJournals.ownerUserId, context.authority.ownerUserId),
            sql`${builderProvisioningJournals.record}->>'kind' = 'app-runtime'`,
            sql`${builderProvisioningJournals.record}->'request'->>'appId' = ${context.target.appId}`,
            sql`${builderProvisioningJournals.record}->'request'->>'projectId' = ${context.target.projectId}`,
            sql`${builderProvisioningJournals.record}->'operator'->'plan'->'appDatabase' = ${JSON.stringify(plan.appDatabase)}::jsonb`,
            sql`${builderProvisioningJournals.record}->'operator'->'plan'->'authDatabase' = ${JSON.stringify(plan.authDatabase)}::jsonb`,
            sql`${builderProvisioningJournals.record}->'operator'->'plan'->'neon'->>'projectId' = ${plan.neon.projectId}`,
            sql`${builderProvisioningJournals.record}->'operator'->'plan'->'neon'->>'branchId' = ${plan.neon.branchId}`,
            sql`${builderProvisioningJournals.record}->'operator'->'plan'->'neon'->>'endpoint' = ${plan.neon.endpoint}`,
            cursor === undefined ? undefined : gt(builderProvisioningJournals.requestId, cursor),
          ),
        )
        .orderBy(asc(builderProvisioningJournals.requestId))
        .limit(128);
      await deps.assertCurrentOwner(context);
      for (const row of rows) {
        const record = hostedRuntimeJournalRecordSchema.parse(row.record);
        const setup = completed(record);
        if (
          setup === undefined ||
          record.privateState === undefined ||
          setup.plan.runtimePreparation !== "single-project-resources-v1"
        ) {
          continue;
        }
        if (selected !== undefined) {
          throw fail();
        }
        selected = ownedAppResourceSourceSchema.parse({
          kind: "owned-app-resources-v1",
          scopeDigest,
          source: {
            checkpointSha256: hash(JSON.stringify(record.privateState)),
            operationRef: setup.operationRef,
            planDigest: setup.planDigest,
            target: record.request,
          },
        });
      }
      if (rows.length < 128) {
        break;
      }
      cursor = rows.at(-1)?.requestId;
    }
    if (selected === undefined) {
      throw fail();
    }
    await sourceInput(context, plan, selected);
    return selected;
  };
  const readReference = async (context: HostedOperatorContext, plan: HostedOperatorPlan) => {
    const { identity, reference } = await readCustody(context, plan);
    if (reference !== undefined) {
      await sourceInput(context, plan, reference);
      return reference;
    }
    if (!(await deps.isExistingRevision(context))) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- A new app has no prior resource custodian.
      return undefined;
    }
    return await fallback(context, plan, identity.digest);
  };
  const reserve = async (
    context: HostedOperatorContext,
    plan: HostedOperatorPlan,
    reference: OwnedAppResourceSource,
  ) => {
    const { identity, reference: known } = await readCustody(context, plan);
    if (known !== undefined) {
      if (!isDeepStrictEqual(known, reference)) {
        throw fail();
      }
      return;
    }
    await deps.database
      .insert(builderProvisioningJournals)
      .values({
        ...context.authority,
        createdAt: new Date(),
        record: { kind: "owned-app-resource-source-v1", reference, scope: identity.scope },
        requestDigest: identity.digest,
        requestId: identity.requestId,
        revision: 1,
        state: "settled",
        updatedAt: new Date(),
      })
      .onConflictDoNothing();
    const current = await readCustody(context, plan);
    if (!isDeepStrictEqual(current.reference, reference)) {
      throw fail();
    }
  };
  const assertFreshApproval = async (
    context: HostedOperatorContext,
    plan: HostedOperatorPlan,
    record: HostedRuntimeJournalRecord,
  ) => {
    const { operator } = record;
    if (
      operator === undefined ||
      operator.planDigest !== operatorPlanDigest(plan) ||
      record.approvedByCallId === "operator:unapproved-plan"
    ) {
      throw new HostedOperatorError("authorization_required");
    }
    const approval = await deps.readApproval({
      ...context,
      action: "prepare",
      callId: record.approvedByCallId,
      planDigest: operator.planDigest,
    });
    if (
      ![
        approval?.approved === true,
        approval?.action === "prepare",
        approval?.approvalId === operator.approvalId,
        approval?.callId === record.approvedByCallId,
        approval?.planDigest === operator.planDigest,
      ].every(Boolean)
    ) {
      throw new HostedOperatorError("authorization_required");
    }
  };
  return {
    checkpoint: async (
      context: HostedOperatorContext,
      plan: HostedOperatorPlan,
      preparation: OperatorAuthSchemaPreparation,
    ) => {
      const row = await deps.store.read(context);
      const operator = row?.record.operator;
      if (row === undefined || operator === undefined || row.record.privateState === undefined) {
        throw fail();
      }
      const matches = [
        operator.approvalId !== undefined,
        operator.planDigest === operatorPlanDigest(plan),
        plan.effects.every((effect) =>
          operator.receipts.some((receipt) => receipt.effectId === effect.id),
        ),
        preparation.database === plan.authDatabase.database,
        preparation.runtimeRole === plan.authDatabase.runtimeRole,
        preparation.targetDigest === plan.authSchema?.targetDigest,
      ].every(Boolean);
      if (!matches) {
        throw fail();
      }
      await assertFreshApproval(context, plan, row.record);
      const { identity, reference } = await readCustody(context, plan);
      if (reference !== undefined) {
        if (
          plan.existingResources !== undefined &&
          !isDeepStrictEqual(reference, plan.existingResources)
        ) {
          throw fail();
        }
        return;
      }
      const next =
        plan.existingResources ??
        ownedAppResourceSourceSchema.parse({
          kind: "owned-app-resources-v1",
          scopeDigest: identity.digest,
          source: {
            checkpointSha256: hash(JSON.stringify(row.record.privateState)),
            operationRef: operator.operationRef,
            planDigest: operator.planDigest,
            target: context.target,
          },
        });
      await reserve(context, plan, next);
    },
    readReference,
    async rewrap(
      context: HostedOperatorContext,
      plan: HostedOperatorPlan,
      record: HostedRuntimeJournalRecord,
    ) {
      await assertFreshApproval(context, plan, record);
      const reference = plan.existingResources;
      if (reference === undefined || reference.scopeDigest !== scopeFor(context, plan).digest) {
        throw fail();
      }
      const source = await sourceInput(context, plan, reference);
      const privateState = rewrapOwnedAppResourceCredentials({
        source: {
          ...source.context,
          config: deps.keyring,
          plan: source.setup.plan,
          record: source.record,
        },
        target: { ...context, config: deps.keyring, plan, record },
      });
      await sourceInput(context, plan, reference);
      await reserve(context, plan, reference);
      return privateState;
    },
  };
};
