import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { VercelTokenKeyringConfig } from "../integrations/vercel-installation";
import {
  HostedOperatorError,
  operatorOwnerContextSchema,
  operatorPlanDigest,
  sameOperatorSelection,
} from "./hosted-operator-contract";
import type {
  HostedOperatorContext,
  HostedOperatorEffectContext,
  ProtectedHostedOperatorDependencies,
} from "./hosted-operator-service";
import { hostedRuntimeTargetSchema } from "./hosted-runtime-journal";
import type {
  HostedRuntimeJournalStore,
  HostedRuntimeJournalRecord,
  HostedRuntimeJournalRow,
} from "./hosted-runtime-journal";
import {
  describeHostedOperatorSharedAuth,
  sealHostedOperatorSharedAuth,
  verifyPendingHostedOperatorSharedAuth,
} from "./hosted-operator-resource-credentials";

import type { SharedAuthReadinessVerifier } from "./hosted-operator-resource-credentials";

/** Deployment-owned lookup hints. Authority is re-read for both journals on every use. */
export const hostedOperatorAuthAdoptionSourceSchema = z.strictObject({
  ownerContext: operatorOwnerContextSchema,
  target: hostedRuntimeTargetSchema,
});
export type HostedOperatorAuthAdoptionSource = z.infer<
  typeof hostedOperatorAuthAdoptionSourceSchema
>;

interface Input {
  context: HostedOperatorContext;
  source: HostedOperatorAuthAdoptionSource;
}
/** assertCurrent renews this same lease; every other checkpoint and ownership field must stay fixed. */
export const sameSharedAuthTargetCheckpoint = (
  left: HostedRuntimeJournalRecord,
  right: HostedRuntimeJournalRecord,
) => {
  const { leaseExpiresAt: leftExpiry, ...leftState } = left;
  const { leaseExpiresAt: rightExpiry, ...rightState } = right;
  void leftExpiry;
  void rightExpiry;
  return isDeepStrictEqual(leftState, rightState);
};
const cloneContext = (context: HostedOperatorContext): HostedOperatorContext =>
  structuredClone({
    authority: context.authority,
    ownerContext: context.ownerContext,
    target: context.target,
  });
const capture = (input: Input) => {
  const context = cloneContext(input.context);
  const hint = hostedOperatorAuthAdoptionSourceSchema.parse(input.source);
  const source: HostedOperatorContext = { authority: hint.ownerContext.authority, ...hint };
  const foreign = [
    !isDeepStrictEqual(context.authority, source.authority),
    source.target.appId === context.target.appId,
    source.target.installationId !== context.target.installationId,
    source.target.scopeId !== context.target.scopeId,
    source.target.scopeType !== context.target.scopeType,
  ].some(Boolean);
  if (foreign) {
    throw new HostedOperatorError("authorization_required");
  }
  return { context, source };
};

/** Uses the sole journal, existing owner checks, target CAS checkpoint and physical resource lease. */
export const createHostedOperatorSharedAuthAdoption = (deps: {
  config: VercelTokenKeyringConfig;
  store: Pick<HostedRuntimeJournalStore, "read">;
  assertPlanningAuthorized: (context: HostedOperatorContext) => Promise<void>;
  assertAuthorized: ProtectedHostedOperatorDependencies["assertAuthorized"];
  readApproval: ProtectedHostedOperatorDependencies["readApproval"];
  readCurrentTarget: (input: HostedOperatorEffectContext) => Promise<HostedRuntimeJournalRecord>;
  checkpointTarget: (input: {
    effect: HostedOperatorEffectContext;
    expected: HostedRuntimeJournalRecord["privateState"];
    privateState: NonNullable<HostedRuntimeJournalRecord["privateState"]>;
  }) => Promise<void>;
}) => {
  const readSource = async (owned: ReturnType<typeof capture>) => {
    await deps.assertPlanningAuthorized(owned.context);
    await deps.assertPlanningAuthorized(owned.source);
    const row = await deps.store.read(owned.source);
    if (row?.record.operator === undefined) {
      throw new HostedOperatorError("reconciliation_required");
    }
    const snapshot = structuredClone(row);
    const { record } = snapshot;
    const { operator } = record;
    if (operator === undefined) {
      throw new HostedOperatorError("reconciliation_required");
    }
    await deps.assertAuthorized({ ...owned.source, plan: operator.plan });
    const approval = await deps.readApproval({
      ...owned.source,
      action: "prepare",
      callId: record.approvedByCallId,
      planDigest: operator.planDigest,
    });
    if (approval?.approved !== true) {
      throw new HostedOperatorError("authorization_required");
    }
    const invalidApproval = [
      approval.approvalId !== operator.approvalId,
      approval.callId !== record.approvedByCallId,
      approval.planDigest !== operator.planDigest,
      approval.action !== "prepare",
    ].some(Boolean);
    if (invalidApproval) {
      throw new HostedOperatorError("authorization_required");
    }
    const description = describeHostedOperatorSharedAuth({
      ...owned.source,
      config: deps.config,
      plan: operator.plan,
      record,
    });
    await deps.assertPlanningAuthorized(owned.source);
    await deps.assertPlanningAuthorized(owned.context);
    return { description, row: snapshot };
  };
  const assertSourceUnchanged = async (
    owned: ReturnType<typeof capture>,
    prior: HostedRuntimeJournalRow,
  ) => {
    const latest = await readSource(owned);
    if (!isDeepStrictEqual(latest.row, prior)) {
      throw new HostedOperatorError("reconciliation_required");
    }
  };
  const readTarget = async (effect: HostedOperatorEffectContext) => {
    await effect.assertCurrent();
    await deps.assertPlanningAuthorized(cloneContext(effect));
    await deps.assertAuthorized({ ...cloneContext(effect), plan: structuredClone(effect.plan) });
    const record = structuredClone(await deps.readCurrentTarget(effect));
    const { operator } = record;
    if (operator === undefined) {
      throw new HostedOperatorError("reconciliation_required");
    }
    const invalidTarget = [
      record.status !== "pending",
      record.step !== "reserved",
      !isDeepStrictEqual(record.request, effect.target),
      !sameOperatorSelection(effect.plan.selection, effect.target),
      !isDeepStrictEqual(operator.plan, effect.plan),
      operator.planDigest !== operatorPlanDigest(effect.plan),
      operator.operationRef !== effect.operationRef,
      operator.fenceGeneration !== effect.fenceGeneration,
    ].some(Boolean);
    if (invalidTarget) {
      throw new HostedOperatorError("reconciliation_required");
    }
    const approval = await deps.readApproval({
      ...cloneContext(effect),
      action: "prepare",
      callId: record.approvedByCallId,
      planDigest: operator.planDigest,
    });
    if (approval?.approved !== true) {
      throw new HostedOperatorError("authorization_required");
    }
    const invalidTargetApproval = [
      approval.action !== "prepare",
      approval.approvalId !== operator.approvalId,
      approval.callId !== record.approvedByCallId,
      approval.planDigest !== operator.planDigest,
    ].some(Boolean);
    if (invalidTargetApproval) {
      throw new HostedOperatorError("authorization_required");
    }
    await effect.assertCurrent();
    await deps.assertPlanningAuthorized(cloneContext(effect));
    await deps.assertAuthorized({ ...cloneContext(effect), plan: structuredClone(effect.plan) });
    const latest = structuredClone(await deps.readCurrentTarget(effect));
    if (!sameSharedAuthTargetCheckpoint(latest, record)) {
      throw new HostedOperatorError("reconciliation_required");
    }
    return record;
  };
  return {
    async checkpoint(input: {
      effect: HostedOperatorEffectContext;
      source: HostedOperatorAuthAdoptionSource;
    }) {
      // Snapshot every data field before yielding. Callbacks remain the existing leased journal callbacks.
      const owned = capture({ context: input.effect, source: input.source });
      const effect = {
        ...input.effect,
        ...owned.context,
        effect: structuredClone(input.effect.effect),
        plan: structuredClone(input.effect.plan),
      };
      if (
        effect.plan.action !== "prepare" ||
        effect.effect.kind !== "resources" ||
        effect.effect.resourceId !== effect.plan.authDatabase.resourceId ||
        effect.plan.authAdoption === undefined
      ) {
        throw new HostedOperatorError("resource_mismatch");
      }
      const target = await deps.readCurrentTarget(effect);
      // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Verify the target lease before reading another journal.
      const observed = await readSource(owned);
      if (!isDeepStrictEqual(observed.description, effect.plan.authAdoption)) {
        throw new HostedOperatorError("resource_mismatch");
      }
      const sourceOperator = observed.row.record.operator;
      if (sourceOperator === undefined) {
        throw new HostedOperatorError("reconciliation_required");
      }
      const privateState = sealHostedOperatorSharedAuth({
        source: {
          ...owned.source,
          config: deps.config,
          plan: sourceOperator.plan,
          record: observed.row.record,
        },
        target: { ...owned.context, config: deps.config, plan: effect.plan, record: target },
      });
      await assertSourceUnchanged(owned, observed.row);
      const latest = await deps.readCurrentTarget(effect);
      if (!isDeepStrictEqual(latest.privateState, target.privateState)) {
        throw new HostedOperatorError("operation_in_progress");
      }
      await deps.checkpointTarget({ effect, expected: target.privateState, privateState });
      const acknowledged = await deps.readCurrentTarget(effect);
      await assertSourceUnchanged(owned, observed.row);
      if (!isDeepStrictEqual(acknowledged.privateState, privateState)) {
        throw new HostedOperatorError("operation_in_progress");
      }
      // No worker bytes, URL, receipt or readiness assertion escapes this prerequisite.
      return { status: "checkpointed-awaiting-verification" as const };
    },
    async inspect(input: Input) {
      const owned = capture(input);
      const observed = await readSource(owned);
      await assertSourceUnchanged(owned, observed.row);
      return { adoption: observed.description, row: observed.row, source: owned.source };
    },
    async verify(input: {
      effect: HostedOperatorEffectContext;
      source: HostedOperatorAuthAdoptionSource;
      verifyReadiness: SharedAuthReadinessVerifier;
    }) {
      const owned = capture({ context: input.effect, source: input.source });
      const effect = {
        ...input.effect,
        ...owned.context,
        effect: structuredClone(input.effect.effect),
        plan: structuredClone(input.effect.plan),
        workerCheckpoints: structuredClone(input.effect.workerCheckpoints),
      };
      const { verifyReadiness } = input;
      const invalidEffect = [
        effect.plan.authAdoption === undefined,
        effect.plan.action !== "prepare",
        !["resources", "install"].includes(effect.effect.kind),
        !effect.plan.effects.some((candidate) => isDeepStrictEqual(candidate, effect.effect)),
        effect.effect.kind === "resources" &&
          effect.effect.resourceId !== effect.plan.authDatabase.resourceId,
        effect.effect.kind === "install" && effect.effect.id !== "auth-schema",
      ].some(Boolean);
      if (invalidEffect) {
        throw new HostedOperatorError("resource_mismatch");
      }
      const target = await readTarget(effect);
      // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Recheck the target lease before opening the source journal.
      const observed = await readSource(owned);
      const sourceOperator = observed.row.record.operator;
      if (
        sourceOperator === undefined ||
        !isDeepStrictEqual(observed.description, effect.plan.authAdoption)
      ) {
        throw new HostedOperatorError("resource_mismatch");
      }
      const assertCurrent = async () => {
        await assertSourceUnchanged(owned, observed.row);
        const latest = await readTarget(effect);
        if (!sameSharedAuthTargetCheckpoint(latest, target)) {
          throw new HostedOperatorError("reconciliation_required");
        }
      };
      const proof = await verifyPendingHostedOperatorSharedAuth({
        assertCurrent,
        source: {
          ...owned.source,
          config: deps.config,
          plan: sourceOperator.plan,
          record: observed.row.record,
        },
        target: { ...owned.context, config: deps.config, plan: effect.plan, record: target },
        verifyReadiness,
      });
      await assertCurrent();
      // Verification does not change the encrypted pending checkpoint or release credentials.
      return proof;
    },
  };
};
