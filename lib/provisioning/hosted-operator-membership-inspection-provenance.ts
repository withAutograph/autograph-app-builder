import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import type {
  HostedOperatorPlan,
  HostedOperatorRecord,
  HostedOperatorRecordBase,
} from "./hosted-operator-contract";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";

export interface RetainedMembershipInspectionProvenance {
  approvedByCallId: string;
  operator: HostedOperatorRecordBase;
  effect: HostedOperatorPlan["effects"][number];
}

const canonicalDigest = (plan: HostedOperatorPlan): string | undefined => {
  const parsed = hostedOperatorPlanSchema.safeParse(plan);
  return parsed.success ? operatorPlanDigest(parsed.data) : undefined;
};

const membershipEffect = (
  plan: HostedOperatorPlan,
): HostedOperatorPlan["effects"][number] | null => {
  if (
    plan.action !== "prepare" ||
    plan.stage !== "app" ||
    plan.normalActorProgram !== undefined ||
    plan.authMembership?.kind !== "create-owned-organization"
  ) {
    return null;
  }
  const effects = plan.effects.filter((effect) => effect.kind === "auth-membership");
  return effects.length === 1 ? (effects[0] ?? null) : null;
};

const originalOwnershipReadback = (operator: HostedOperatorRecordBase): string | null => {
  const membership = operator.plan.authMembership;
  if (membership?.kind !== "create-owned-organization") {
    return null;
  }
  // These fixed keys are in the worker's canonical alphabetical order. The
  // marker stays a JSON string inside the canonical ownership readback.
  const marker = JSON.stringify({
    actorId: membership.actorId,
    identityProofSha256: membership.identityProof.sha256,
    ownerSessionId: operator.plan.selection.sessionId,
    planDigest: operator.planDigest,
    purpose: "protected-owned-organization-v1",
    version: 1,
  });
  return createHash("sha256")
    .update(
      JSON.stringify({
        actorId: membership.actorId,
        marker,
        organizationId: membership.organizationId,
        role: "owner",
      }),
    )
    .digest("hex");
};

// Delivery attempts and source revisions can change while the owned Auth resource
// and the frozen organization identity remain the same.
const membershipAuthority = (plan: HostedOperatorPlan) => {
  const boundary = plan.deploymentBoundary;
  return {
    selection: plan.selection,
    contextId: plan.contextId,
    neon: plan.neon,
    authDatabase: plan.authDatabase,
    authMembership: plan.authMembership,
    publicGateway: plan.publicGateway,
    deploymentBoundary:
      boundary === undefined
        ? undefined
        : {
            authority: boundary.authority,
            teamId: boundary.teamId,
            operator: {
              projectId: boundary.operator.projectId,
              environment: boundary.operator.environment,
            },
            app: {
              projectId: boundary.app.projectId,
              branch: boundary.app.branch,
              environment: boundary.app.environment,
            },
            gateway: {
              projectId: boundary.gateway.projectId,
              branch: boundary.gateway.branch,
              environment: boundary.gateway.environment,
            },
            verification: boundary.verification,
          },
  };
};

interface RetainedOperation {
  approvedByCallId: string;
  operator: HostedOperatorRecordBase;
}
type OperatorHistory = Pick<
  HostedOperatorRecord,
  | "retainedProjectSettingsOperations"
  | "retainedInstallerOperations"
  | "retainedGatewayDeliveries"
  | "retainedRenewalOperations"
>;

const retainedOperations = (operator: OperatorHistory): RetainedOperation[] => [
  ...(operator.retainedProjectSettingsOperations ?? []),
  ...(operator.retainedInstallerOperations ?? []),
  ...(operator.retainedGatewayDeliveries ?? []),
  ...(operator.retainedRenewalOperations ?? []),
];

/** Private server-side structural evidence for SELECT-only inspection. Archives
 * never grant approval or prove that the retained plan created the live marker.
 * The caller must recheck canonical original approval and live owner/lease/capture
 * authority, then inspect the actual marker without replaying or rewriting it. */
export const retainedMembershipInspectionProvenance = (
  record: HostedRuntimeJournalRecord,
  currentPlan: HostedOperatorPlan,
): readonly RetainedMembershipInspectionProvenance[] => {
  const current = record.operator;
  const effect = membershipEffect(currentPlan);
  const digest = canonicalDigest(currentPlan);
  if (current === undefined || effect === null || digest === undefined) {
    return [];
  }
  if (current.planDigest !== digest || canonicalDigest(current.plan) !== digest) {
    return [];
  }
  // Archives are structurally finite: ready-delivery snapshots contain these
  // four histories, whose entries contain only the base operator record.
  const retained = [
    ...retainedOperations(current),
    ...(current.retainedReadyDeliveryOperations ?? []).flatMap((archive) => [
      archive,
      ...retainedOperations(archive.operator),
    ]),
  ];
  const candidates: RetainedMembershipInspectionProvenance[] = [];
  const seen = new Set<string>();
  for (const entry of retained) {
    const prior = entry.operator;
    const priorEffect = membershipEffect(prior.plan);
    if (priorEffect === null || prior.approvalId === undefined) {
      continue;
    }
    const hasAuthority = [
      entry.approvedByCallId.trim().length > 0,
      entry.approvedByCallId !== "operator:unapproved-plan",
      prior.approvalId.trim().length > 0,
      prior.operationRef === current.operationRef,
      prior.planDigest !== digest,
      canonicalDigest(prior.plan) === prior.planDigest,
      priorEffect.id === effect.id,
      prior.receipts.some(
        (receipt) =>
          receipt.effectId === priorEffect.id &&
          receipt.resourceVersion === originalOwnershipReadback(prior),
      ),
      isDeepStrictEqual(membershipAuthority(prior.plan), membershipAuthority(currentPlan)),
      !seen.has(prior.planDigest),
    ].every(Boolean);
    if (!hasAuthority) {
      continue;
    }
    seen.add(prior.planDigest);
    candidates.push({
      approvedByCallId: entry.approvedByCallId,
      operator: prior,
      effect: priorEffect,
    });
  }
  return candidates;
};

/** Match the requested private approval identity against the same structural
 * evidence used by inspection; this does not replace canonical approval lookup. */
export const matchRetainedMembershipInspectionProvenance = (
  record: HostedRuntimeJournalRecord,
  currentPlan: HostedOperatorPlan,
  requested: { approvedByCallId: string; planDigest: string },
): RetainedMembershipInspectionProvenance | undefined =>
  retainedMembershipInspectionProvenance(record, currentPlan).find(
    (candidate) =>
      candidate.approvedByCallId === requested.approvedByCallId &&
      candidate.operator.planDigest === requested.planDigest,
  );
