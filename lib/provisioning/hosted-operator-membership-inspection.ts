import { isDeepStrictEqual } from "node:util";
import { HostedOperatorError } from "./hosted-operator-contract";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";
import type {
  HostedOperatorEffectContext,
  ProtectedHostedOperatorDependencies,
} from "./hosted-operator-service";
import { retainedMembershipInspectionProvenance } from "./hosted-operator-membership-inspection-provenance";

export interface ApprovedMembershipInspection {
  plan: HostedOperatorPlan;
  effect: HostedOperatorPlan["effects"][number];
}

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
