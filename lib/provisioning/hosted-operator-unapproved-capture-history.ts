/* oxlint-disable eslint/complexity, sonarjs/expression-complexity, sonarjs/cognitive-complexity, unicorn/no-useless-undefined -- Exact predecessor verification returns an explicit absent result. */
import { isDeepStrictEqual } from "node:util";
import {
  normalActorPreparationSchema,
  operatorPlanDigest,
  sameOperatorSelection,
} from "./hosted-operator-contract";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import { normalActorProgramDigest } from "./hosted-operator-normal-actor-program";
import { hostedOperatorRealmLinkConfigSha256 } from "./hosted-operator-realm-link-config";
import { isAdditiveCaptureParticipantProgram } from "./hosted-operator-participant-successor";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";

/** Revalidate immutable captured-account history; caller must re-read both approvals. */
export const readUnapprovedCapturePredecessor = (
  record: HostedRuntimeJournalRecord,
  plan: HostedOperatorPlan,
  _now: number,
) => {
  const pointer = plan.normalActorCapturePredecessor;
  const program = plan.normalActorProgram;
  if (pointer === undefined || program === undefined || plan.stage !== "auth-participants") {
    return undefined;
  }
  for (const history of record.unapprovedAppProposalHistory ?? []) {
    const { preparation: account, retainedAuth: auth, operator: old } = history;
    const prior = old.plan;
    const accountPlan = account.accountPlan;
    const authPlan = auth.plan;
    const gatewayAuthority =
      pointer.gateway === undefined ? undefined : history.retainedParticipantGateway?.completion;
    if (
      pointer.gateway !== undefined &&
      (gatewayAuthority === undefined ||
        gatewayAuthority.operationRef !== pointer.gateway.operationRef ||
        gatewayAuthority.planDigest !== pointer.gateway.planDigest ||
        gatewayAuthority.approvalId !== pointer.gateway.approvalId ||
        gatewayAuthority.approvedByCallId !== pointer.gateway.approvedByCallId ||
        gatewayAuthority.planDigest !== operatorPlanDigest(gatewayAuthority.plan))
    ) {
      continue;
    }
    const completion = gatewayAuthority ?? auth;
    const gatewayPlan = completion.plan;
    const gateway = old.gatewayDeliveryCandidates?.find(
      (candidate) =>
        candidate.deploymentId === old.deliveredGatewayDeploymentId &&
        candidate.operationRef === completion.operationRef &&
        candidate.readyState === "READY" &&
        candidate.projectId === gatewayPlan.gatewayDelivery?.projectId &&
        candidate.branch === gatewayPlan.gatewayDelivery?.branch &&
        candidate.repoId === gatewayPlan.gatewayDelivery?.repoId &&
        (pointer.gateway === undefined ||
          isDeepStrictEqual(candidate, history.retainedParticipantGateway?.candidate)),
    );
    const binding = old.gatewayEnvironment?.find(
      (row) =>
        row.key === "PLATFORM_REALM_OPERATOR_LINK_CONFIG" &&
        row.projectId === prior.gatewayDelivery?.projectId &&
        row.branch === prior.gatewayDelivery?.branch &&
        row.pendingOperationRef === undefined &&
        row.pendingValueSha256 === undefined &&
        row.valueSha256 === hostedOperatorRealmLinkConfigSha256(prior),
    );
    const savedEffects = old.receipts.every((receipt) => {
      const oldEffect = prior.effects.find((effect) => effect.id === receipt.effectId);
      const authEffect = authPlan.effects.find((effect) => effect.id === receipt.effectId);
      return (
        oldEffect !== undefined &&
        authEffect !== undefined &&
        ["resources", "install"].includes(oldEffect.kind) &&
        oldEffect.kind === authEffect.kind &&
        oldEffect.resourceId === authEffect.resourceId &&
        auth.receipts.some((value) => isDeepStrictEqual(value, receipt))
      );
    });
    if (
      [
        history.approvedByCallId === "operator:unapproved-plan",
        old.approvalId === undefined &&
          old.pendingEffectId === undefined &&
          old.pendingEffectAttempt === undefined,
        old.planDigest === operatorPlanDigest(prior),
        prior.action === "prepare" && prior.stage === "app",
        account.accountsCompletedAt !== undefined,
        account.accountPlanDigest === operatorPlanDigest(accountPlan),
        accountPlan.action === "prepare" && accountPlan.stage === "auth-participants",
        normalActorProgramDigest(account.program) === account.programDigest,
        accountPlan.normalActorProgram !== undefined &&
          normalActorProgramDigest(accountPlan.normalActorProgram) === account.programDigest,
        prior.normalActorProgram !== undefined &&
          normalActorProgramDigest(prior.normalActorProgram) === account.programDigest,
        isDeepStrictEqual(
          prior.normalActorPreparation,
          normalActorPreparationSchema.strip().parse(account),
        ),
        isAdditiveCaptureParticipantProgram(account.program, program),
        account.accountOperationRef === pointer.preparation.accountOperationRef,
        account.accountPlanDigest === pointer.preparation.accountPlanDigest,
        account.programDigest === pointer.preparation.programDigest,
        account.accountApprovalId === pointer.preparation.accountApprovalId,
        account.accountApprovedByCallId === pointer.preparation.accountApprovedByCallId,
        auth.operationRef === pointer.bootstrapOperationRef,
        auth.planDigest === pointer.bootstrapPlanDigest,
        auth.approvalId === pointer.bootstrapApprovalId,
        auth.approvedByCallId === pointer.bootstrapApprovedByCallId,
        auth.planDigest === operatorPlanDigest(authPlan),
        sameOperatorSelection(plan.selection, record.request),
        sameOperatorSelection(prior.selection, record.request),
        sameOperatorSelection(accountPlan.selection, record.request),
        isDeepStrictEqual(plan.appDatabase, prior.appDatabase),
        isDeepStrictEqual(plan.authDatabase, prior.authDatabase),
        isDeepStrictEqual(plan.neon, prior.neon),
        isDeepStrictEqual(plan.publicGateway, prior.publicGateway),
        isDeepStrictEqual(accountPlan.appDatabase, prior.appDatabase),
        isDeepStrictEqual(accountPlan.authDatabase, prior.authDatabase),
        isDeepStrictEqual(accountPlan.neon, prior.neon),
        isDeepStrictEqual(authPlan.authDatabase, prior.authDatabase),
        isDeepStrictEqual(authPlan.neon, prior.neon),
        isDeepStrictEqual(plan.deploymentBoundary?.authority, prior.deploymentBoundary?.authority),
        plan.deploymentBoundary?.teamId === prior.deploymentBoundary?.teamId,
        prior.authSchema?.targetDigest === auth.authPreparation.targetDigest,
        old.authPreparation?.targetDigest === auth.authPreparation.targetDigest,
        gateway !== undefined,
        prior.gatewayDelivery !== undefined &&
          gatewayPlan.gatewayDelivery !== undefined &&
          prior.gatewayDelivery.projectId === gatewayPlan.gatewayDelivery.projectId &&
          prior.gatewayDelivery.branch === gatewayPlan.gatewayDelivery.branch &&
          prior.gatewayDelivery.repoId === gatewayPlan.gatewayDelivery.repoId &&
          prior.gatewayDelivery.gitSha === gatewayPlan.gatewayDelivery.gitSha,
        binding !== undefined &&
          completion.gatewayEnvironment?.some((row) => isDeepStrictEqual(row, binding)) === true,
        prior.gatewayBindings !== undefined &&
          gatewayPlan.gatewayBindings !== undefined &&
          hostedOperatorRealmLinkConfigSha256(prior) ===
            hostedOperatorRealmLinkConfigSha256(gatewayPlan),
        ["gateway-bindings", "gateway-delivery"].every((kind) =>
          gatewayPlan.effects.some(
            (effect) =>
              effect.kind === kind &&
              completion.receipts.some((receipt) => receipt.effectId === effect.id),
          ),
        ),
        savedEffects,
      ].every(Boolean) &&
      gateway !== undefined
    ) {
      return {
        account,
        bootstrap: {
          auth,
          candidate: gateway,
          ...(gatewayAuthority === undefined ? {} : { gateway: gatewayAuthority }),
        },
        priorOperator: old,
      };
    }
  }
  return undefined;
};
