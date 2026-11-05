import { sameJournalAfterLeaseRenewal } from "./hosted-operator-lease-renewal";
import { isIdlePendingAccountCapture } from "./hosted-operator-pending-account-capture";
import { z } from "zod";
import {
  HostedOperatorError,
  hostedOperatorPlanSchema,
  operatorPlanDigest,
} from "./hosted-operator-contract";
import type { NormalActorJournalPorts } from "./hosted-operator-normal-actor-journal";
import type {
  HostedOperatorContext,
  ProtectedHostedOperatorDependencies,
} from "./hosted-operator-service";

const effectAuthority = z.object({
  effect: z.object({ id: z.string().min(1) }),
  operationRef: z.uuid(),
  plan: hostedOperatorPlanSchema,
  fenceGeneration: z.number().int().positive(),
  leaseId: z.uuid(),
});

/** Deployment journal guards are reads: renewing a lease here would invalidate every CAS revision. */
export const createNormalActorJournalAuthority = (input: {
  store: NormalActorJournalPorts["store"];
  keyring: NormalActorJournalPorts["keyring"];
  now: () => number;
  assertCanonicalOwner: (context: HostedOperatorContext) => Promise<void>;
  assertApprovedOwner: ProtectedHostedOperatorDependencies["assertAuthorized"];
  readApproval: ProtectedHostedOperatorDependencies["readApproval"];
}): NormalActorJournalPorts => ({
  store: input.store,
  keyring: input.keyring,
  now: input.now,
  assertAuthorized: input.assertCanonicalOwner,
  async assertAccountApproval(context, preparation) {
    await input.assertCanonicalOwner(context);
    const approval = await input.readApproval({
      ...context,
      action: "prepare",
      callId: preparation.accountApprovedByCallId,
      planDigest: preparation.accountPlanDigest,
    });
    if (
      ![
        approval?.approved === true,
        approval?.approvalId === preparation.accountApprovalId,
        approval?.callId === preparation.accountApprovedByCallId,
        approval?.planDigest === preparation.accountPlanDigest,
        approval?.action === "prepare",
      ].every(Boolean)
    ) {
      throw new HostedOperatorError("authorization_required");
    }
  },
  // oxlint-disable-next-line eslint/complexity -- Lease, approval and capture recovery remain independently scoped.
  async assertMutationAuthority(context, row, mode) {
    await input.assertCanonicalOwner(context);
    const currentRow = await input.store.read(context);
    if (!sameJournalAfterLeaseRenewal(row, currentRow, input.now()) || currentRow === undefined) {
      throw new HostedOperatorError("operation_in_progress");
    }
    const { record } = currentRow;
    const { operator } = record;
    if (operator === undefined) {
      throw new HostedOperatorError("operation_in_progress");
    }
    if ("effect" in context) {
      const current = effectAuthority.safeParse(context);
      if (!current.success) {
        throw new HostedOperatorError("operation_in_progress");
      }
      const effect = current.data;
      const ownsLease = [
        record.leaseId === effect.leaseId,
        record.leaseExpiresAt !== undefined && Date.parse(record.leaseExpiresAt) > input.now(),
        operator.operationRef === effect.operationRef,
        operator.planDigest === operatorPlanDigest(effect.plan),
        operator.fenceGeneration === effect.fenceGeneration,
        operator.pendingEffectId === undefined || operator.pendingEffectId === effect.effect.id,
      ].every(Boolean);
      if (!ownsLease) {
        throw new HostedOperatorError("operation_in_progress");
      }
      await input.assertApprovedOwner({ ...context, plan: effect.plan });
      const approval = await input.readApproval({
        ...context,
        action: "prepare",
        callId: record.approvedByCallId,
        planDigest: operator.planDigest,
      });
      if (
        approval?.approved !== true ||
        approval.approvalId !== operator.approvalId ||
        approval.callId !== record.approvedByCallId ||
        approval.planDigest !== operator.planDigest
      ) {
        throw new HostedOperatorError("authorization_required");
      }
    } else if (
      // oxlint-disable-next-line sonarjs/expression-complexity -- An idle capture exception requires the exact retained account attempt.
      record.leaseId !== undefined ||
      record.leaseExpiresAt !== undefined ||
      ((operator.pendingEffectId !== undefined || operator.pendingEffectAttempt !== undefined) &&
        !(mode === "capture" && isIdlePendingAccountCapture(record)))
    ) {
      throw new HostedOperatorError("operation_in_progress");
    }
    await input.assertCanonicalOwner(context);
    const latest = await input.store.read(context);
    if (
      !sameJournalAfterLeaseRenewal(currentRow, latest, input.now()) ||
      ("effect" in context &&
        (latest?.record.leaseExpiresAt === undefined ||
          Date.parse(latest.record.leaseExpiresAt) <= input.now()))
    ) {
      throw new HostedOperatorError("operation_in_progress");
    }
  },
});
