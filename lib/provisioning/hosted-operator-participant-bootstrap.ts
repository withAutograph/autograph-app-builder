import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  HostedOperatorError,
  operatorDeploymentCandidateSchema,
  retainedOperatorAuthSchema,
  sameOperatorSelection,
  operatorPlanDigest,
} from "./hosted-operator-contract";
import type { HostedOperatorPlan, RetainedOperatorAuth } from "./hosted-operator-contract";
import { retainedOperatorAuthFromJournal } from "./hosted-runtime-journal";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";
import { hostedOperatorRealmLinkConfigSha256 } from "./hosted-operator-realm-link-config";
import { normalActorProgramDigest } from "./hosted-operator-normal-actor-program";
import type {
  HostedOperatorContext,
  ProtectedHostedOperatorDependencies,
} from "./hosted-operator-service";

export const completedParticipantBootstrapSchema = z.strictObject({
  auth: retainedOperatorAuthSchema,
  candidate: operatorDeploymentCandidateSchema,
});
export type CompletedParticipantBootstrap = z.infer<typeof completedParticipantBootstrapSchema>;

const sameAuth = (desired: HostedOperatorPlan, known: RetainedOperatorAuth) =>
  [
    isDeepStrictEqual(desired.authDatabase, known.plan.authDatabase),
    desired.neon.projectId === known.plan.neon.projectId,
    desired.neon.branchId === known.plan.neon.branchId,
    desired.neon.endpoint === known.plan.neon.endpoint,
    desired.bootstrap?.endpointId === known.plan.bootstrap?.endpointId,
    desired.authSchema?.targetDigest === known.authPreparation.targetDigest,
    desired.authSchema?.targetDigest === known.plan.authSchema?.targetDigest,
  ].every(Boolean);

export interface ParticipantBootstrapPreparation {
  auth?: RetainedOperatorAuth;
  gatewayPrepared: boolean;
}

/** Planning evidence only. Live owner/approval and normal-session checks still authorize execution. */
export const inspectParticipantBootstrapPreparation = (
  desired: HostedOperatorPlan,
  record: HostedRuntimeJournalRecord | undefined,
): ParticipantBootstrapPreparation => {
  if (record?.privateState === undefined || record.operator === undefined) {
    return { gatewayPrepared: false };
  }
  const completed = retainedOperatorAuthFromJournal(record);
  const snapshots = [completed, record.retainedAuth]
    .map((value) => retainedOperatorAuthSchema.safeParse(value))
    .filter((value) => value.success)
    .map((value) => value.data);
  const auth = snapshots.find((value) =>
    [
      sameAuth(desired, value),
      record.operator?.authPreparation?.database === value.authPreparation.database,
      record.operator?.authPreparation?.runtimeRole === value.authPreparation.runtimeRole,
      record.operator?.authPreparation?.targetDigest === value.authPreparation.targetDigest,
    ].every(Boolean),
  );
  if (
    auth === undefined ||
    desired.gatewayBindings === undefined ||
    desired.gatewayDelivery === undefined
  ) {
    return { auth, gatewayPrepared: false };
  }
  const desiredValue = hostedOperatorRealmLinkConfigSha256(desired);
  const candidate = record.operator.gatewayDeliveryCandidates?.find(
    (value) =>
      value.deploymentId === record.operator?.deliveredGatewayDeploymentId &&
      value.readyState === "READY",
  );
  const gatewayPrepared = snapshots.some((known) => {
    if (known.plan.gatewayBindings === undefined || known.plan.gatewayDelivery === undefined) {
      return false;
    }
    // Updating an owned provider row preserves its original creator operation.
    // Its observed value belongs to the completed binding receipt below.
    const binding = record.operator?.gatewayEnvironment?.find((row) =>
      [
        row.key === "PLATFORM_REALM_OPERATOR_LINK_CONFIG",
        row.projectId === desired.gatewayDelivery?.projectId,
        row.branch === desired.gatewayDelivery?.branch,
        row.pendingOperationRef === undefined,
        row.pendingValueSha256 === undefined,
        row.valueSha256 === desiredValue,
      ].every(Boolean),
    );
    return [
      sameAuth(desired, known),
      hostedOperatorRealmLinkConfigSha256(known.plan) === desiredValue,
      isDeepStrictEqual(known.plan.gatewayDelivery, desired.gatewayDelivery),
      binding !== undefined,
      known.gatewayEnvironment?.some((row) => isDeepStrictEqual(row, binding)) === true,
      candidate !== undefined,
      candidate?.operationRef === known.operationRef,
      candidate?.projectId === desired.gatewayDelivery?.projectId,
      candidate?.branch === desired.gatewayDelivery?.branch,
      candidate?.repoId === desired.gatewayDelivery?.repoId,
      known.plan.effects.some(
        (effect) =>
          effect.kind === "gateway-bindings" &&
          known.receipts.some((receipt) => receipt.effectId === effect.id),
      ),
      known.plan.effects.some(
        (effect) =>
          effect.kind === "gateway-delivery" &&
          known.receipts.some((receipt) => receipt.effectId === effect.id),
      ),
    ].every(Boolean);
  });
  return { auth, gatewayPrepared };
};

const matchesAppParticipantBootstrap = (
  operator: NonNullable<HostedRuntimeJournalRecord["operator"]>,
  preparation: NonNullable<HostedRuntimeJournalRecord["accountPreparation"]>,
  auth: RetainedOperatorAuth,
): boolean => {
  const account = preparation.accountPlan;
  const readiness = operator.authPreparation;
  return ![
    operator.pendingEffectId !== undefined,
    operator.pendingEffectAttempt !== undefined,
    operator.plan.action !== "prepare",
    readiness?.database !== auth.authPreparation.database,
    readiness?.runtimeRole !== auth.authPreparation.runtimeRole,
    readiness?.targetDigest !== auth.authPreparation.targetDigest,
    readiness?.assetSha256 !== auth.authPreparation.assetSha256,
    readiness?.catalogFingerprint !== auth.authPreparation.catalogFingerprint,
    !sameAuth(operator.plan, auth),
    account.stage !== "auth-participants",
    account.action !== "prepare",
    preparation.accountPlanDigest !== operatorPlanDigest(account),
    normalActorProgramDigest(preparation.program) !== preparation.programDigest,
    account.normalActorProgram === undefined ||
      normalActorProgramDigest(account.normalActorProgram) !== preparation.programDigest,
    !isDeepStrictEqual(operator.plan.normalActorPreparation, {
      accountOperationRef: preparation.accountOperationRef,
      accountPlanDigest: preparation.accountPlanDigest,
      programDigest: preparation.programDigest,
      accountApprovalId: preparation.accountApprovalId,
      accountApprovedByCallId: preparation.accountApprovedByCallId,
    }),
  ].some(Boolean);
};

/** Structural handoff evidence; original enrollment and completed Auth approvals remain live reads. */
export const inspectCompletedParticipantBootstrap = (
  desired: HostedOperatorPlan,
  record: HostedRuntimeJournalRecord | undefined,
): CompletedParticipantBootstrap | undefined => {
  const operator = record?.operator;
  const preparation = record?.accountPreparation;
  if (
    record === undefined ||
    operator === undefined ||
    preparation?.accountsCompletedAt === undefined ||
    [
      record.leaseId !== undefined,
      record.leaseExpiresAt !== undefined,
      record.status !== "pending",
      record.step !== "reserved",
      operator.plan.stage !== "auth-bootstrap" && operator.plan.stage !== "app",
    ].some(Boolean)
  ) {
    return undefined;
  }
  const retained = retainedOperatorAuthSchema.safeParse(record.retainedAuth);
  const appPlanning = operator.plan.stage === "app";
  const retainedAuth = retained.success ? retained.data : undefined;
  const auth = appPlanning ? retainedAuth : retainedOperatorAuthFromJournal(record);
  const program = desired.normalActorProgram;
  const currentProgram = operator.plan.normalActorProgram;
  const account = preparation.accountPlan;
  if (auth === undefined || program === undefined || currentProgram === undefined) {
    return undefined;
  }
  // App planning retains the original enrollment and completed Auth, not unfinished app receipts.
  if (appPlanning && !matchesAppParticipantBootstrap(operator, preparation, auth)) {
    return undefined;
  }
  const sameScope = [
    normalActorProgramDigest(program) === preparation.programDigest,
    normalActorProgramDigest(currentProgram) === preparation.programDigest,
    sameOperatorSelection(account.selection, desired.selection),
    sameOperatorSelection(operator.plan.selection, desired.selection),
    isDeepStrictEqual(account.appDatabase, desired.appDatabase),
    isDeepStrictEqual(account.authDatabase, desired.authDatabase),
    account.neon.projectId === desired.neon.projectId,
    account.neon.branchId === desired.neon.branchId,
    account.neon.endpoint === desired.neon.endpoint,
    isDeepStrictEqual(operator.plan.appDatabase, desired.appDatabase),

    sameAuth(desired, auth),
    inspectParticipantBootstrapPreparation(desired, record).gatewayPrepared,
  ].every(Boolean);
  const candidate = operator.gatewayDeliveryCandidates?.find(
    (value) =>
      value.deploymentId === operator.deliveredGatewayDeploymentId && value.readyState === "READY",
  );
  return sameScope && candidate !== undefined
    ? completedParticipantBootstrapSchema.parse({ auth, candidate })
    : undefined;
};

export const assertCompletedParticipantBootstrapApproval = async (
  context: HostedOperatorContext,
  bootstrap: CompletedParticipantBootstrap,
  readApproval: ProtectedHostedOperatorDependencies["readApproval"],
) => {
  const { auth } = bootstrap;
  const approval = await readApproval({
    ...context,
    action: "prepare",
    callId: auth.approvedByCallId,
    planDigest: auth.planDigest,
  });
  if (
    [
      approval?.approved !== true,
      approval?.approvalId !== auth.approvalId,
      approval?.callId !== auth.approvedByCallId,
      approval?.planDigest !== auth.planDigest,
      approval?.action !== "prepare",
    ].some(Boolean)
  ) {
    throw new HostedOperatorError("authorization_required");
  }
};
