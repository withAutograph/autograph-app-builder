import { isDeepStrictEqual } from "node:util";
import { retainedOperatorAuthSchema } from "./hosted-operator-contract";
import type { HostedOperatorPlan, RetainedOperatorAuth } from "./hosted-operator-contract";
import { retainedOperatorAuthFromJournal } from "./hosted-runtime-journal";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";
import { hostedOperatorRealmLinkConfigSha256 } from "./hosted-operator-realm-link-config";

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
