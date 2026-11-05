import { isDeepStrictEqual } from "node:util";
import {
  hostedOperatorPlanSchema,
  HostedOperatorError,
  operatorPlanDigest,
  normalActorPreparationSchema,
} from "./hosted-operator-contract";
import type {
  HostedOperatorAuthSignupPolicyInput,
  HostedOperatorPlan,
} from "./hosted-operator-contract";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";
import type { NormalActorProgram } from "./hosted-operator-normal-actor-program";
import { normalActorProgramDigest } from "./hosted-operator-normal-actor-program";

type Predecessor = NonNullable<HostedRuntimeJournalRecord["participantPreparationHistory"]>[number];

/** Organization-proof migration is deliberately outside this capture-only successor. */
export const isAdditiveCaptureParticipantProgram = (
  prior: NormalActorProgram,
  next: NormalActorProgram,
) =>
  [
    prior.appId === next.appId,
    prior.origin === next.origin,
    prior.organizations.length === 0,
    prior.memberships.length === 0,
    prior.appAccess.length === 0,
    prior.actors.every((actor) => actor.account === "capture-existing"),
    next.actors.length > prior.actors.length,
    prior.actors.every((actor) =>
      next.actors.some((candidate) => isDeepStrictEqual(candidate, actor)),
    ),
    // Previously captured actors remain personal read-only identities, never implicit organization owners/grantees.
    next.memberships.every(
      (member) => !prior.actors.some((actor) => actor.actorKey === member.actorKey),
    ),
    next.appAccess.every(
      (grant) => !prior.actors.some((actor) => actor.actorKey === grant.actorKey),
    ),
  ].every(Boolean);

const completed = (record: HostedRuntimeJournalRecord, now: number): Predecessor | undefined => {
  const { operator, accountPreparation: preparation } = record;
  if (operator === undefined || preparation === undefined || operator.approvalId === undefined) {
    return undefined;
  }
  const eligible = [
    record.status === "prepared",
    record.step === "bound",
    record.leaseId === undefined,
    record.leaseExpiresAt === undefined,
    operator.pendingEffectId === undefined,
    operator.pendingEffectAttempt === undefined,
    record.executionObservation?.state !== "running",
    preparation.accountsCompletedAt !== undefined,
    preparation.programDigest === normalActorProgramDigest(preparation.program),
    preparation.accountPlanDigest === operatorPlanDigest(preparation.accountPlan),
    preparation.accountPlan.stage === "auth-participants",
    preparation.accountPlan.normalActorProgram !== undefined &&
      normalActorProgramDigest(preparation.accountPlan.normalActorProgram) ===
        preparation.programDigest,
    operator.fenceGeneration !== undefined,
    record.proof?.manifestSha256 === operator.plan.release.sha256,
    record.proof?.releaseId === operator.plan.release.id,
    preparation.predecessor === undefined,
    operator.plan.stage === "app",
    operator.plan.action === "prepare",
    operator.planDigest === operatorPlanDigest(operator.plan),
    operator.plan.normalActorProgram !== undefined &&
      normalActorProgramDigest(operator.plan.normalActorProgram) === preparation.programDigest,
    operator.plan.normalActorPreparation !== undefined &&
      isDeepStrictEqual(
        operator.plan.normalActorPreparation,
        normalActorPreparationSchema.strip().parse(preparation),
      ),
    Date.parse(operator.plan.retention.expiresAt) > now,
    record.privateState !== undefined,
    operator.plan.effects.every((effect) =>
      operator.receipts.some(
        (receipt) =>
          receipt.effectId === effect.id &&
          (effect.kind !== "access" || receipt.fenceGeneration === operator.fenceGeneration),
      ),
    ),
  ].every(Boolean);
  return eligible
    ? { preparation, operator, approvedByCallId: record.approvedByCallId, proof: record.proof }
    : undefined;
};

const samePhysicalScope = (prior: HostedOperatorPlan, next: HostedOperatorPlan) =>
  [
    isDeepStrictEqual(prior.selection, next.selection),
    isDeepStrictEqual(prior.appDatabase, next.appDatabase),
    isDeepStrictEqual(prior.authDatabase, next.authDatabase),
    isDeepStrictEqual(prior.neon, next.neon),
    isDeepStrictEqual(prior.deploymentBoundary?.authority, next.deploymentBoundary?.authority),
    prior.deploymentBoundary?.teamId === next.deploymentBoundary?.teamId,
    isDeepStrictEqual(prior.publicGateway, next.publicGateway),
  ].every(Boolean);

export const readParticipantSuccessorPredecessor = (
  record: HostedRuntimeJournalRecord,
  plan: HostedOperatorPlan,
  now: number,
): Predecessor | undefined => {
  const pointer = plan.normalActorPredecessor;
  const program = plan.normalActorProgram;
  if (pointer === undefined || program === undefined || plan.stage !== "auth-participants") {
    return undefined;
  }
  const candidates = [completed(record, now), ...(record.participantPreparationHistory ?? [])];
  return candidates.find(
    (prior) =>
      prior !== undefined &&
      [
        prior.operator.operationRef === pointer.operationRef,
        prior.operator.planDigest === pointer.planDigest,
        prior.operator.approvalId === pointer.approvalId,
        prior.approvedByCallId === pointer.approvedByCallId,
        isDeepStrictEqual(
          normalActorPreparationSchema.strip().parse(prior.preparation),
          pointer.preparation,
        ),
        isAdditiveCaptureParticipantProgram(prior.preparation.program, program),
        samePhysicalScope(prior.operator.plan, plan),
        record.operator !== undefined &&
          samePhysicalScope(prior.operator.plan, record.operator.plan),
      ].every(Boolean),
  );
};

export const createParticipantSuccessorPlan = (
  record: HostedRuntimeJournalRecord | undefined,
  program: NormalActorProgram | undefined,
  now: number,
  requestedSignupPolicy?: HostedOperatorAuthSignupPolicyInput,
): HostedOperatorPlan | undefined => {
  if (record === undefined || program === undefined) {
    return undefined;
  }
  const current = record.operator;
  const complete = [
    record.status === "participants-prepared",
    record.accountPreparation?.programDigest === normalActorProgramDigest(program),
    record.accountPreparation?.accountsCompletedAt !== undefined,
    record.leaseId === undefined,
    record.leaseExpiresAt === undefined,
    current?.pendingEffectId === undefined,
    current?.pendingEffectAttempt === undefined,
  ].every(Boolean);
  if (
    current?.plan.normalActorPredecessor !== undefined &&
    isDeepStrictEqual(current.plan.normalActorProgram, program) &&
    readParticipantSuccessorPredecessor(record, current.plan, now) !== undefined &&
    !complete
  ) {
    if (requestedSignupPolicy !== undefined) {
      throw new HostedOperatorError("resource_mismatch");
    }
    return current.plan;
  }
  const prior = completed(record, now);
  if (
    prior === undefined ||
    !isAdditiveCaptureParticipantProgram(prior.preparation.program, program)
  ) {
    return undefined;
  }
  // Signup enrollment is a separate resolved app-stage approval, never part of account preparation.
  if (requestedSignupPolicy !== undefined) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const {
    appInstallation,
    appDeliveryReplacement,
    delivery,
    appTrustedSources,
    authMembership,
    authSignupPolicy,
    normalActorPreparation,
    ...base
  } = prior.operator.plan;
  void appInstallation;
  void appDeliveryReplacement;
  void delivery;
  void appTrustedSources;
  void authMembership;
  void authSignupPolicy;
  void normalActorPreparation;
  const gatewayBindings = prior.operator.plan.gatewayBindings;
  const trustedSources = gatewayBindings?.trustedSources;
  return hostedOperatorPlanSchema.parse({
    ...base,
    ...(gatewayBindings === undefined
      ? {}
      : {
          gatewayBindings: {
            ...gatewayBindings,
            // Existing app/JWKS grants stay provider facts; this account-only plan cannot authorize them.
            trustedSources:
              trustedSources !== undefined && "gatewayPreview" in trustedSources
                ? { gatewayPreview: trustedSources.gatewayPreview }
                : undefined,
          },
        }),
    stage: "auth-participants",
    access: [],
    normalActorProgram: program,
    normalActorPredecessor: {
      preparation: normalActorPreparationSchema.strip().parse(prior.preparation),
      operationRef: prior.operator.operationRef,
      planDigest: prior.operator.planDigest,
      approvalId: prior.operator.approvalId,
      approvedByCallId: prior.approvedByCallId,
    },
    effects: [
      {
        id: "normal-accounts",
        kind: "normal-accounts",
        description:
          "Prepare only the explicitly approved additional participants; preserve the original verified personal capture.",
      },
    ],
  });
};

export const isParticipantProgramSuccessor = (
  record: HostedRuntimeJournalRecord,
  plan: HostedOperatorPlan,
  now: number,
) => {
  const prior = readParticipantSuccessorPredecessor(record, plan, now);
  if (prior === undefined) {
    return false;
  }
  return (
    completed(record, now)?.operator.operationRef === prior.operator.operationRef ||
    [
      record.operator?.planDigest === operatorPlanDigest(plan),
      record.operator?.plan.stage === "auth-participants",
      record.leaseId === undefined,
      record.leaseExpiresAt === undefined,
      record.operator?.pendingEffectId === undefined,
      record.operator?.pendingEffectAttempt === undefined,
    ].every(Boolean)
  );
};
