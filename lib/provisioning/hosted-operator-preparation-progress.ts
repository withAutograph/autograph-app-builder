import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";
import type { OperatorPreparationProgress } from "./hosted-operator-contract";
import { normalActorProgramDigest } from "./hosted-operator-normal-actor-program";

type Operator = NonNullable<HostedRuntimeJournalRecord["operator"]>;
type Preparation = NonNullable<HostedRuntimeJournalRecord["accountPreparation"]>;
type PreparationRecord = Pick<HostedRuntimeJournalRecord, "leaseId" | "leaseExpiresAt"> & {
  operator?: Pick<Operator, "receipts" | "pendingEffectId" | "pendingEffectAttempt"> & {
    plan: Pick<Operator["plan"], "stage" | "effects" | "normalActorProgram">;
  };
  accountPreparation?: Pick<Preparation, "accountsCompletedAt" | "programDigest">;
};

/** Project the authorized journal as recorded, without reading providers or changing state. */
export const readOperatorPreparationProgress = (
  record: PreparationRecord,
  now: number,
): OperatorPreparationProgress | undefined => {
  const { operator } = record;
  if (operator === undefined) {
    return undefined;
  }
  const { plan } = operator;
  const expiry =
    record.leaseExpiresAt === undefined ? Number.NaN : Date.parse(record.leaseExpiresAt);
  let lease: OperatorPreparationProgress["lease"] = "absent";
  if (record.leaseId !== undefined) {
    lease = "unclassified";
    if (Number.isFinite(expiry)) {
      lease = expiry > now ? "active" : "expired";
    }
  }
  const missingKinds = new Set<OperatorPreparationProgress["missingEffectKinds"][number]>();
  for (const effect of plan.effects) {
    if (!operator.receipts.some((receipt) => receipt.effectId === effect.id)) {
      missingKinds.add(effect.kind);
    }
  }
  const missingEffectKinds = [...missingKinds];
  const pendingEffect = plan.effects.find((effect) => effect.id === operator.pendingEffectId);
  const preparation = record.accountPreparation;
  const stage: Pick<OperatorPreparationProgress, "planStage"> = {};
  if (plan.stage !== undefined) {
    stage.planStage = plan.stage;
  }
  const pending = { ...stage, lease };
  const pendingDetails: typeof pending &
    Pick<OperatorPreparationProgress, "hasPendingEffect" | "pendingEffectKind"> = {
    ...pending,
    hasPendingEffect: operator.pendingEffectId !== undefined,
  };
  if (pendingEffect !== undefined) {
    pendingDetails.pendingEffectKind = pendingEffect.kind;
  }
  const progress: OperatorPreparationProgress = {
    ...pendingDetails,
    hasPendingAttempt: operator.pendingEffectAttempt !== undefined,
    allPlanEffectsReceipted: missingEffectKinds.length === 0,
    missingEffectKinds,
    hasAccountPreparation: preparation !== undefined,
    accountsCompleted: preparation?.accountsCompletedAt !== undefined,
  };
  if (preparation !== undefined && plan.normalActorProgram !== undefined) {
    progress.accountProgramMatchesPlan =
      preparation.programDigest === normalActorProgramDigest(plan.normalActorProgram);
  }
  return progress;
};
