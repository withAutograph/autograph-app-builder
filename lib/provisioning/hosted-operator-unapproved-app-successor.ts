/* oxlint-disable eslint/complexity, sonarjs/expression-complexity -- Keep related authority and receipt compatibility checks together. */
import { isDeepStrictEqual } from "node:util";
import { operatorPlanDigest, sameOperatorSelection } from "./hosted-operator-contract";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import { normalActorProgramDigest } from "./hosted-operator-normal-actor-program";
import type { NormalActorProgram } from "./hosted-operator-normal-actor-program";
import {
  inspectCompletedParticipantBootstrap,
  inspectPlanningParticipantBootstrap,
} from "./hosted-operator-participant-bootstrap";
import type { CompletedParticipantBootstrap } from "./hosted-operator-participant-bootstrap";
import { isAdditiveCaptureParticipantProgram } from "./hosted-operator-participant-successor";
import type { HostedRuntimeJournalRecord, HostedRuntimeTarget } from "./hosted-runtime-journal";

/** Facts for a proposed transition; neither the old app proposal nor this value grants approval. */
export interface UnapprovedAppSuccessorCandidate {
  account: NonNullable<HostedRuntimeJournalRecord["accountPreparation"]>;
  bootstrap: CompletedParticipantBootstrap;
  priorOperator: NonNullable<HostedRuntimeJournalRecord["operator"]>;
}

/**
 * Inspect a settled, unapproved app proposal before planning additive participants.
 * The caller must independently re-read owner and both original approvals, archive the
 * exact record under CAS, and acquire normal approval for each new plan.
 */
export const inspectUnapprovedAppSuccessor = (
  record: HostedRuntimeJournalRecord | undefined,
  target: HostedRuntimeTarget,
  program: NormalActorProgram,
  now: number,
): UnapprovedAppSuccessorCandidate | undefined => {
  const operator = record?.operator;
  const account = record?.accountPreparation;
  if (record === undefined || operator === undefined || account === undefined) {
    return undefined;
  }
  const plan = operator.plan;
  const accountPlan: HostedOperatorPlan = account.accountPlan;
  if (
    [
      record.status !== "pending",
      record.step !== "reserved",
      record.approvedByCallId !== "operator:unapproved-plan",
      operator.approvalId !== undefined,
      record.leaseId !== undefined &&
        (record.leaseExpiresAt === undefined || Date.parse(record.leaseExpiresAt) > now),
      operator.pendingEffectId !== undefined,
      operator.pendingEffectAttempt !== undefined,
      record.executionObservation?.state === "running",
      record.privateState === undefined,
      plan.action !== "prepare",
      plan.stage !== "app",
      operator.planDigest !== operatorPlanDigest(plan),
      account.accountsCompletedAt === undefined,
      account.accountPlanDigest !== operatorPlanDigest(accountPlan),
      accountPlan.action !== "prepare",
      accountPlan.stage !== "auth-participants",
      accountPlan.normalActorProgram === undefined,
      accountPlan.normalActorProgram !== undefined &&
        normalActorProgramDigest(accountPlan.normalActorProgram) !== account.programDigest,
      normalActorProgramDigest(account.program) !== account.programDigest,
      plan.normalActorProgram === undefined,
      plan.normalActorProgram !== undefined &&
        normalActorProgramDigest(plan.normalActorProgram) !== account.programDigest,
      !isAdditiveCaptureParticipantProgram(account.program, program),
      !isDeepStrictEqual(record.request, target),
      !sameOperatorSelection(plan.selection, target),
      !sameOperatorSelection(accountPlan.selection, target),
      !isDeepStrictEqual(plan.appDatabase, accountPlan.appDatabase),
      !isDeepStrictEqual(plan.authDatabase, accountPlan.authDatabase),
      !isDeepStrictEqual(plan.neon, accountPlan.neon),
      !isDeepStrictEqual(plan.publicGateway, accountPlan.publicGateway),
      !isDeepStrictEqual(
        plan.deploymentBoundary?.authority,
        accountPlan.deploymentBoundary?.authority,
      ),
      plan.deploymentBoundary?.teamId !== accountPlan.deploymentBoundary?.teamId,
    ].some(Boolean)
  ) {
    return undefined;
  }
  // A saved proposal may omit a source ref while the retained native Gateway
  // records it. The same project, branch, repository and commit remain the
  // identity; the reference is diagnostic, not an authority to select a route.
  const retainedDelivery = record.retainedAuth?.plan.gatewayDelivery;
  const desiredDelivery = plan.gatewayDelivery;
  const sameDelivery =
    retainedDelivery !== undefined &&
    desiredDelivery !== undefined &&
    retainedDelivery.projectId === desiredDelivery.projectId &&
    retainedDelivery.branch === desiredDelivery.branch &&
    retainedDelivery.repoId === desiredDelivery.repoId &&
    retainedDelivery.gitSha === desiredDelivery.gitSha;
  const bootstrapPlan = sameDelivery ? { ...plan, gatewayDelivery: retainedDelivery } : plan;
  // Expired leases are idle, but the bootstrap inspector requires an idle-shaped
  // view. This projection changes no journal state or authority.
  const idleRecord =
    record.leaseId === undefined
      ? record
      : {
          ...record,
          leaseId: undefined,
          leaseExpiresAt: undefined,
        };
  const bootstrap =
    inspectPlanningParticipantBootstrap(plan, idleRecord) ??
    inspectPlanningParticipantBootstrap(bootstrapPlan, idleRecord) ??
    inspectCompletedParticipantBootstrap(bootstrapPlan, idleRecord);
  if (bootstrap === undefined) {
    return undefined;
  }
  // An unapproved app proposal may carry completed bootstrap receipts. Do not
  // reinterpret unrelated receipts as app approval or infer absent effects.
  if (
    operator.receipts.some((receipt) => {
      const effect = plan.effects.find((entry) => entry.id === receipt.effectId);
      const original = bootstrap.auth.plan.effects.find((entry) => entry.id === receipt.effectId);
      return (
        effect === undefined ||
        original === undefined ||
        !["resources", "install"].includes(effect.kind) ||
        effect.kind !== original.kind ||
        effect.resourceId !== original.resourceId ||
        !bootstrap.auth.receipts.some((value) => isDeepStrictEqual(value, receipt))
      );
    })
  ) {
    return undefined;
  }
  return { account, bootstrap, priorOperator: operator };
};
