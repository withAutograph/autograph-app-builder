import { isDeepStrictEqual } from "node:util";
import { HostedOperatorError } from "./hosted-operator-contract";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";
import type {
  HostedOperatorEffectContext,
  ProtectedHostedOperatorDependencies,
} from "./hosted-operator-service";
import {
  retainedMembershipInspectionProvenance,
  RetainedMembershipApprovalUnavailableError,
} from "./hosted-operator-membership-inspection-provenance";
import type { RetainedMembershipInspectionProvenance } from "./hosted-operator-membership-inspection-provenance";

export interface ApprovedMembershipInspection {
  plan: HostedOperatorPlan;
  effect: HostedOperatorPlan["effects"][number];
}

type MembershipApproval = Awaited<ReturnType<ProtectedHostedOperatorDependencies["readApproval"]>>;

const matchesOriginalMembershipApproval = (
  approval: MembershipApproval,
  candidate: RetainedMembershipInspectionProvenance,
) =>
  [
    approval?.approved === true,
    approval?.action === "prepare",
    approval?.callId === candidate.approvedByCallId,
    approval?.planDigest === candidate.operator.planDigest,
    approval?.approvalId === candidate.operator.approvalId,
  ].every(Boolean);

const isSelectedMembershipEffect = (input: HostedOperatorEffectContext, organizationId: string) => {
  const membership = input.plan.authMembership;
  const organizations =
    membership?.kind === "create-owned-organization"
      ? [membership]
      : (membership?.organizations ?? []);
  const requiresSelectedEffect =
    input.plan.normalActorProgram !== undefined || organizations.length > 1;
  return [
    organizations.some((entry) => entry.organizationId === organizationId),
    input.effect.kind === "auth-membership",
    input.plan.effects.some(
      (effect) => effect.id === input.effect.id && effect.kind === input.effect.kind,
    ),
    !requiresSelectedEffect || input.effect.id === `auth-membership:${organizationId}`,
  ].every(Boolean);
};

const readOriginalMembershipApproval = async (
  input: {
    effect: HostedOperatorEffectContext;
    readApproval: ProtectedHostedOperatorDependencies["readApproval"];
  },
  candidate: RetainedMembershipInspectionProvenance,
): Promise<MembershipApproval> => {
  try {
    return await input.readApproval({
      ...input.effect,
      action: "prepare",
      callId: candidate.approvedByCallId,
      planDigest: candidate.operator.planDigest,
    });
  } catch (error) {
    if (!(error instanceof RetainedMembershipApprovalUnavailableError)) {
      throw error;
    }
    return null;
  }
};

/** Historical approval authorizes only inspection of the original ownership marker.
 * All resource credentials, capture checks and execution fences belong to the live effect.
 */
export const readApprovedRetainedMembershipInspection = async (input: {
  effect: HostedOperatorEffectContext;
  readCurrentRecord: () => Promise<HostedRuntimeJournalRecord>;
  readApproval: ProtectedHostedOperatorDependencies["readApproval"];
}): Promise<ApprovedMembershipInspection | undefined> => {
  if (input.effect.effect.kind !== "auth-membership") {
    throw new HostedOperatorError("authorization_required");
  }
  await input.effect.assertCurrent();
  const record = await input.readCurrentRecord();
  const candidates = retainedMembershipInspectionProvenance(record, input.effect.plan);
  if (candidates.length === 0) {
    return undefined;
  }
  if (candidates[0] === undefined || candidates.length !== 1) {
    throw new HostedOperatorError("reconciliation_required");
  }
  const candidate = structuredClone(candidates[0]);
  if (candidate.effect.id !== input.effect.effect.id) {
    throw new HostedOperatorError("authorization_required");
  }
  const approval = await input.readApproval({
    ...input.effect,
    action: "prepare",
    callId: candidate.approvedByCallId,
    planDigest: candidate.operator.planDigest,
  });
  if (approval?.approved !== true) {
    throw new HostedOperatorError("authorization_required");
  }
  const matches = [
    approval.action === "prepare",
    approval.callId === candidate.approvedByCallId,
    approval.planDigest === candidate.operator.planDigest,
    approval.approvalId === candidate.operator.approvalId,
  ];
  if (!matches.every(Boolean)) {
    throw new HostedOperatorError("authorization_required");
  }
  await input.effect.assertCurrent();
  const current = await input.readCurrentRecord();
  const fresh = retainedMembershipInspectionProvenance(current, input.effect.plan);
  if (fresh.length !== 1 || !isDeepStrictEqual(fresh[0], candidate)) {
    throw new HostedOperatorError("reconciliation_required");
  }
  return {
    effect: structuredClone(candidate.effect),
    plan: structuredClone(candidate.operator.plan),
  };
};

/** Inspect independently approved historical candidates sequentially at the
 * worker boundary. Source revisions are candidates, never an ambiguity gate;
 * only actual SELECT readback can identify the original ownership marker. */
export const readApprovedRetainedMembershipInspections = async (input: {
  effect: HostedOperatorEffectContext;
  organizationId: string;
  readCurrentRecord: () => Promise<HostedRuntimeJournalRecord>;
  readApproval: ProtectedHostedOperatorDependencies["readApproval"];
}): Promise<readonly ApprovedMembershipInspection[]> => {
  if (!isSelectedMembershipEffect(input.effect, input.organizationId)) {
    throw new HostedOperatorError("authorization_required");
  }
  await input.effect.assertCurrent();
  const record = await input.readCurrentRecord();
  const candidates = retainedMembershipInspectionProvenance(
    record,
    input.effect.plan,
    input.organizationId,
  ).map((candidate) => structuredClone(candidate));
  const approved: ApprovedMembershipInspection[] = [];
  const seen = new Set<string>();
  // Each authority lookup and guard may touch the same protected journal.
  for (const candidate of candidates) {
    const { planDigest } = candidate.operator;
    if (seen.has(planDigest)) {
      continue;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- This guard touches the same protected journal as the following approval lookup.
    await input.effect.assertCurrent();
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/server-sequential-independent-await -- Original approval lookup shares the protected journal with its current authority guards.
    const approval = await readOriginalMembershipApproval(input, candidate);
    // Current owner/fence failures are never caught as an old approval denial.
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/server-sequential-independent-await -- Recheck the same protected journal after the original approval lookup.
    await input.effect.assertCurrent();
    if (!matchesOriginalMembershipApproval(approval, candidate)) {
      continue;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/server-sequential-independent-await -- Re-read the protected journal only after the live guard and original approval complete.
    const current = await input.readCurrentRecord();
    const fresh = retainedMembershipInspectionProvenance(
      current,
      input.effect.plan,
      input.organizationId,
    );
    if (!fresh.some((entry) => isDeepStrictEqual(entry, candidate))) {
      throw new HostedOperatorError("reconciliation_required");
    }
    seen.add(planDigest);
    approved.push({
      effect: structuredClone(candidate.effect),
      plan: structuredClone(candidate.operator.plan),
    });
  }
  await input.effect.assertCurrent();
  return approved;
};
