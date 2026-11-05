import { hostedOperatorPlanSchema, normalActorPreparationSchema } from "./hosted-operator-contract";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import type { NormalActorProgram } from "./hosted-operator-normal-actor-program";
import type { UnapprovedAppSuccessorCandidate } from "./hosted-operator-unapproved-app-successor";

/** Build a new account-only proposal from real retained account and bootstrap authority. */
export const createUnapprovedParticipantPlan = (
  candidate: UnapprovedAppSuccessorCandidate,
  program: NormalActorProgram,
): HostedOperatorPlan => {
  const {
    appInstallation,
    appDeliveryReplacement,
    delivery,
    appTrustedSources,
    authMembership,
    authSignupPolicy,
    normalActorPreparation,
    normalActorPredecessor,
    normalActorCapturePredecessor,
    ...base
  } = candidate.priorOperator.plan;
  void appInstallation;
  void appDeliveryReplacement;
  void delivery;
  void appTrustedSources;
  void authMembership;
  void authSignupPolicy;
  void normalActorPreparation;
  void normalActorPredecessor;
  void normalActorCapturePredecessor;
  const gatewayBindings = candidate.priorOperator.plan.gatewayBindings;
  const trustedSources = gatewayBindings?.trustedSources;
  const auth = candidate.bootstrap.auth;
  return hostedOperatorPlanSchema.parse({
    ...base,
    ...(gatewayBindings === undefined
      ? {}
      : {
          gatewayBindings: {
            ...gatewayBindings,
            trustedSources:
              trustedSources !== undefined && "gatewayPreview" in trustedSources
                ? { gatewayPreview: trustedSources.gatewayPreview }
                : undefined,
          },
        }),
    stage: "auth-participants",
    access: [],
    normalActorProgram: program,
    normalActorCapturePredecessor: {
      preparation: normalActorPreparationSchema.strip().parse(candidate.account),
      bootstrapOperationRef: auth.operationRef,
      bootstrapPlanDigest: auth.planDigest,
      bootstrapApprovalId: auth.approvalId,
      bootstrapApprovedByCallId: auth.approvedByCallId,
      ...(candidate.bootstrap.gateway === undefined
        ? {}
        : {
            gateway: {
              operationRef: candidate.bootstrap.gateway.operationRef,
              planDigest: candidate.bootstrap.gateway.planDigest,
              approvalId: candidate.bootstrap.gateway.approvalId,
              approvedByCallId: candidate.bootstrap.gateway.approvedByCallId,
            },
          }),
    },
    effects: [
      {
        id: "normal-accounts",
        kind: "normal-accounts",
        description:
          "Prepare the approved additional participants while preserving the existing account capture.",
      },
    ],
  });
};
