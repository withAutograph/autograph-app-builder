/* oxlint-disable eslint/no-await-in-loop -- Each CAS retry rereads canonical owner and both original approvals. */
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { readOperatorPreparationProgress } from "./hosted-operator-preparation-progress";
import {
  HostedOperatorError,
  operatorPreparationProgressSchema,
  operatorPlanDigest,
  operatorPublicResultSchema,
  sameOperatorSelection,
} from "./hosted-operator-contract";
import type {
  HostedOperatorPlan,
  OperatorRequest,
  OperatorPublicResult,
} from "./hosted-operator-contract";
import {
  hostedRuntimeJournalRecordSchema,
  retainedOperatorAuthFromJournal,
} from "./hosted-runtime-journal";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";
import type {
  HostedOperatorContext,
  ProtectedHostedOperatorDependencies,
} from "./hosted-operator-service";
import { infrastructureOnly } from "./hosted-operator-existing-auth-bootstrap";
import { normalActorProgramDigest } from "./hosted-operator-normal-actor-program";
import { inspectParticipantBootstrapPreparation } from "./hosted-operator-participant-bootstrap";

type Ports = Pick<ProtectedHostedOperatorDependencies, "assertAuthorized" | "readApproval"> & {
  store: Pick<ProtectedHostedOperatorDependencies["store"], "read" | "compareAndSet">;
};

// oxlint-disable-next-line eslint/complexity -- Share the existing exact coordination scope checks between authority and advisory projection.
const readRestorationCoordination = (
  record: HostedRuntimeJournalRecord,
  context: HostedOperatorContext,
) => {
  const current = record.operator;
  const preparation = record.accountPreparation;
  if (current === undefined || preparation === undefined) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const account = preparation.accountPlan;
  const link = current.identityLink;
  const accountLink =
    link !== undefined &&
    [
      link.bootstrapPlanDigest === preparation.accountPlanDigest,
      link.browserSession?.operationRef === preparation.accountOperationRef,
      link.browserSession?.participantProgramDigest === preparation.programDigest,
      link.ownerSessionId === context.target.sessionId,
      link.authResourceId === account.authDatabase.resourceId,
      link.browserOrigin === preparation.program.origin,
      link.issuer === account.deploymentBoundary?.verification.publicOrigin,
      link.audience === account.gatewayBindings?.operatorOrigin,
    ].every(Boolean);
  const wait = record.realmIdentityWait;
  const currentAdapter = context.ownerContext?.adapterSessionId;
  const historicalWait =
    wait !== undefined && currentAdapter !== undefined && wait.adapterSessionId !== currentAdapter;
  const continuation = record.realmContinuation;
  const continuationAcceptanceReceiptPresent =
    continuation !== undefined &&
    [continuation.acceptedAt !== undefined, continuation.receiverClaimedAt !== undefined].every(
      Boolean,
    );
  const historicalAcceptedContinuation =
    continuation !== undefined &&
    [
      currentAdapter !== undefined,
      continuation.adapterSessionId !== currentAdapter,
      continuation.status === "accepted",
      continuationAcceptanceReceiptPresent,
    ].every(Boolean);
  const execution = record.executionObservation;
  const currentExecutionAcknowledged =
    execution !== undefined &&
    [
      execution.state === "settled",
      execution.operationRef === current.operationRef,
      execution.planDigest === current.planDigest,
      execution.callId === record.approvedByCallId,
      execution.approvalId === current.approvalId,
      execution.state === "settled" && execution.outcome.status === "auth-schema-prepared",
    ].every(Boolean);
  // An ordinary owner can archive a completed notification only after its old nonce capability is gone.
  // Effect authorization still requires an active exact nonce; fresh capture mints a new one.
  const completedCurrentContinuation =
    continuation !== undefined &&
    [
      currentAdapter !== undefined,
      continuation.adapterSessionId === currentAdapter,
      context.ownerContext?.realmContinuation === undefined,
      continuation.status === "accepted",
      continuationAcceptanceReceiptPresent,
      link === undefined,
      wait === undefined ||
        [wait.observedAt !== undefined, wait.eventId !== undefined].every(Boolean),
      currentExecutionAcknowledged,
    ].every(Boolean);
  const accountWait =
    wait !== undefined &&
    [
      !historicalWait,
      accountLink,
      wait.nonceSha256 === link?.nonceSha256,
      wait.operationRef === preparation.accountOperationRef,
      wait.approvedPlanDigest === preparation.accountPlanDigest,
      wait.callId === preparation.accountApprovedByCallId,
    ].every(Boolean);
  const settledLink = [
    link === undefined,
    accountLink,
    historicalWait && wait.nonceSha256 === link?.nonceSha256,
    link !== undefined &&
      [
        link.consumedAt !== undefined,
        link.proofRef !== undefined,
        link.proofSha256 !== undefined,
      ].every(Boolean),
  ].some(Boolean);
  const settledWait =
    wait === undefined ||
    accountWait ||
    historicalWait ||
    [wait.observedAt !== undefined, wait.eventId !== undefined].every(Boolean);
  return {
    accountLink,
    accountWait,
    historicalWait,
    historicalAcceptedContinuation,
    completedCurrentContinuation,
    currentExecutionAcknowledged,
    continuationAcceptanceReceiptPresent,
    settledLink,
    settledWait,
  };
};

// oxlint-disable-next-line eslint/complexity -- Keep the exact restoration scope and settled-effect authority checks together.
const assertCompatible = (
  record: HostedRuntimeJournalRecord,
  proposal: HostedOperatorPlan,
  context: HostedOperatorContext,
  now: number,
) => {
  const current = record.operator;
  const preparation = record.accountPreparation;
  if (current === undefined || preparation === undefined) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const account = preparation.accountPlan;
  const {
    accountLink,
    accountWait,
    historicalAcceptedContinuation,
    completedCurrentContinuation,
    settledLink,
    settledWait,
  } = readRestorationCoordination(record, context);
  if (
    [
      record.realmContinuation !== undefined &&
        !historicalAcceptedContinuation &&
        !completedCurrentContinuation,
      record.executionObservation?.state === "running",
      !settledLink,
      !settledWait,
    ].some(Boolean)
  ) {
    throw new HostedOperatorError("operation_in_progress");
  }
  if (
    [
      record.leaseId !== undefined,
      record.leaseExpiresAt !== undefined,
      current.pendingEffectId !== undefined,
      current.pendingEffectAttempt !== undefined,
      current.plan.effects.some(
        (effect) => !current.receipts.some((receipt) => receipt.effectId === effect.id),
      ),
    ].some(Boolean)
  ) {
    throw new HostedOperatorError("operation_in_progress");
  }
  if (
    Date.parse(current.plan.retention.expiresAt) <= now ||
    Date.parse(account.retention.expiresAt) <= now
  ) {
    throw new HostedOperatorError("authorization_required");
  }
  const same = [
    record.status === "pending",
    record.step === "reserved",
    isDeepStrictEqual(record.request, context.target),
    current.plan.action === "prepare",
    current.plan.stage === "auth-bootstrap",
    infrastructureOnly(current.plan),
    account.action === "prepare",
    account.stage === "auth-participants",
    preparation.accountsCompletedAt === undefined,
    isDeepStrictEqual(proposal, account),
    operatorPlanDigest(account) === preparation.accountPlanDigest,
    operatorPlanDigest(current.plan) === current.planDigest,
    sameOperatorSelection(account.selection, current.plan.selection),
    sameOperatorSelection(account.selection, context.target),
    isDeepStrictEqual(account.authDatabase, current.plan.authDatabase),
    isDeepStrictEqual(account.appDatabase, current.plan.appDatabase),
    isDeepStrictEqual(account.neon, current.plan.neon),
    isDeepStrictEqual(account.bootstrap, current.plan.bootstrap),
    isDeepStrictEqual(account.publicGateway, current.plan.publicGateway),
    isDeepStrictEqual(account.gatewayBindings, current.plan.gatewayBindings),
    isDeepStrictEqual(account.deploymentBoundary?.authority, context.authority),
    isDeepStrictEqual(current.plan.deploymentBoundary?.authority, context.authority),
    account.deploymentBoundary?.teamId === current.plan.deploymentBoundary?.teamId,
    account.deploymentBoundary?.verification.publicOrigin ===
      current.plan.deploymentBoundary?.verification.publicOrigin,
    account.deploymentBoundary?.verification.jwksUrl ===
      current.plan.deploymentBoundary?.verification.jwksUrl,
    account.gatewayDelivery?.projectId === current.plan.gatewayDelivery?.projectId,
    account.gatewayDelivery?.branch === current.plan.gatewayDelivery?.branch,
    account.gatewayDelivery?.repoId === current.plan.gatewayDelivery?.repoId,
    account.normalActorProgram !== undefined,
    current.plan.normalActorProgram !== undefined,
    account.normalActorProgram !== undefined &&
      normalActorProgramDigest(account.normalActorProgram) === preparation.programDigest,
    current.plan.normalActorProgram !== undefined &&
      normalActorProgramDigest(current.plan.normalActorProgram) === preparation.programDigest,
    normalActorProgramDigest(preparation.program) === preparation.programDigest,
    current.authPreparation !== undefined,
    account.authSchema?.targetDigest === current.authPreparation?.targetDigest,
    current.plan.authSchema?.targetDigest === current.authPreparation?.targetDigest,
  ].every(Boolean);
  if (!same) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const auth = retainedOperatorAuthFromJournal(record);
  if (
    auth === undefined ||
    !inspectParticipantBootstrapPreparation(current.plan, record).gatewayPrepared
  ) {
    throw new HostedOperatorError("reconciliation_required");
  }
  return {
    current,
    preparation,
    auth,
    accountLink,
    // Completed notification recovery always removes its observed hook; only an existing pending account wait can survive.
    accountWait: accountWait && !completedCurrentContinuation,
  };
};

const restorationDiagnosticSchema = z.strictObject({
  proposalIsOriginalAccountPlan: z.boolean(),
  proposalStage: operatorPreparationProgressSchema.shape.planStage.unwrap().or(z.literal("absent")),
  lease: operatorPreparationProgressSchema.shape.lease,
  hasLeaseExpiry: z.boolean(),
  hasPendingEffect: z.boolean(),
  hasPendingAttempt: z.boolean(),
  allPlanEffectsReceipted: z.boolean(),
  missingEffectKinds: operatorPreparationProgressSchema.shape.missingEffectKinds,
  executionState: z.enum(["absent", "running", "settled"]),
  linkScope: z.enum(["absent", "current-account", "settled-or-historical", "unrelated"]),
  wait: z.enum(["absent", "current-account", "old-adapter", "observed", "unrelated"]),
  continuation: z.enum([
    "absent",
    "old-accepted",
    "current-accepted",
    "current-pending",
    "old-unknown",
  ]),
  continuationArchiveable: z.boolean(),
  currentExecutionAcknowledged: z.boolean(),
  continuationAcceptanceReceiptPresent: z.boolean(),
  ownerRestrictedCapabilityPresent: z.boolean(),
});

type RestorationDiagnostic = z.infer<typeof restorationDiagnosticSchema>;
type Coordination = ReturnType<typeof readRestorationCoordination>;
const diagnosticWait = (
  record: HostedRuntimeJournalRecord,
  coordination: Coordination,
): RestorationDiagnostic["wait"] => {
  const wait = record.realmIdentityWait;
  if (wait === undefined) {
    return "absent";
  }
  if (coordination.accountWait) {
    return "current-account";
  }
  if (coordination.historicalWait) {
    return "old-adapter";
  }
  if (wait.observedAt !== undefined && wait.eventId !== undefined) {
    return "observed";
  }
  return "unrelated";
};
const diagnosticContinuation = (
  record: HostedRuntimeJournalRecord,
  context: HostedOperatorContext,
): RestorationDiagnostic["continuation"] => {
  const continuation = record.realmContinuation;
  if (continuation === undefined) {
    return "absent";
  }
  const current = continuation.adapterSessionId === context.ownerContext?.adapterSessionId;
  if (continuation.status === "accepted") {
    return current ? "current-accepted" : "old-accepted";
  }
  return current ? "current-pending" : "old-unknown";
};
const diagnosticLinkScope = (
  record: HostedRuntimeJournalRecord,
  coordination: Coordination,
): RestorationDiagnostic["linkScope"] => {
  if (record.operator?.identityLink === undefined) {
    return "absent";
  }
  if (coordination.accountLink) {
    return "current-account";
  }
  return coordination.settledLink ? "settled-or-historical" : "unrelated";
};

/** Advisory closed facts only: this probe grants no authority and cannot change a planning outcome. */
const reportRestorationCandidate = async (
  deps: Ports,
  context: HostedOperatorContext,
  proposal: HostedOperatorPlan,
  now: () => number,
) => {
  try {
    const row = await deps.store.read(context);
    const record = row?.record;
    const operator = record?.operator;
    const preparation = record?.accountPreparation;
    if (
      record === undefined ||
      operator?.plan.stage !== "auth-bootstrap" ||
      preparation === undefined ||
      preparation.accountsCompletedAt !== undefined
    ) {
      return;
    }
    await deps.assertAuthorized({ ...context, plan: operator.plan, purpose: "planning" });
    const progress = readOperatorPreparationProgress(record, now());
    if (progress === undefined) {
      return;
    }
    const coordination = readRestorationCoordination(record, context);
    const diagnostic = restorationDiagnosticSchema.parse({
      proposalIsOriginalAccountPlan: isDeepStrictEqual(proposal, preparation.accountPlan),
      proposalStage: proposal.stage ?? "absent",
      lease: progress.lease,
      hasLeaseExpiry: record.leaseExpiresAt !== undefined,
      hasPendingEffect: progress.hasPendingEffect,
      hasPendingAttempt: progress.hasPendingAttempt,
      allPlanEffectsReceipted: progress.allPlanEffectsReceipted,
      missingEffectKinds: progress.missingEffectKinds,
      executionState: record.executionObservation?.state ?? "absent",
      linkScope: diagnosticLinkScope(record, coordination),
      wait: diagnosticWait(record, coordination),
      continuation: diagnosticContinuation(record, context),
      continuationArchiveable:
        coordination.historicalAcceptedContinuation || coordination.completedCurrentContinuation,
      currentExecutionAcknowledged: coordination.currentExecutionAcknowledged,
      continuationAcceptanceReceiptPresent: coordination.continuationAcceptanceReceiptPresent,
      ownerRestrictedCapabilityPresent: context.ownerContext?.realmContinuation !== undefined,
    });
    console.info("[builder:pending-account-restoration]", diagnostic);
  } catch {
    // Missing diagnostics, reads, authorization or logging never change the existing restoration path.
  }
};

/** Restore only the original unfinished account authority after its approved infrastructure prerequisite settles. */
// oxlint-disable-next-line eslint/complexity -- The narrow transition keeps owner, approval, CAS and coordination preservation in one path.
export const restorePendingAccountPreparation = async (
  deps: Ports,
  context: HostedOperatorContext,
  input: Extract<OperatorRequest, { action: "plan" }>,
  proposal: HostedOperatorPlan,
  now: () => number,
): Promise<OperatorPublicResult | null> => {
  if (input.operation === "prepare") {
    await reportRestorationCandidate(deps, context, proposal, now);
  }
  if (input.operation !== "prepare" || proposal.stage !== "auth-participants") {
    return null;
  }
  for (;;) {
    const row = await deps.store.read(context);
    if (
      row?.record.operator?.plan.stage !== "auth-bootstrap" ||
      row.record.accountPreparation === undefined
    ) {
      return null;
    }
    if (
      row.record.accountPreparation.accountsCompletedAt !== undefined ||
      !isDeepStrictEqual(proposal, row.record.accountPreparation.accountPlan)
    ) {
      return null;
    }
    const { current, preparation, auth, accountLink, accountWait } = assertCompatible(
      row.record,
      proposal,
      context,
      now(),
    );
    await deps.assertAuthorized({ ...context, plan: current.plan, purpose: "planning" });
    await deps.assertAuthorized({ ...context, plan: preparation.accountPlan, purpose: "planning" });
    for (const original of [
      {
        callId: row.record.approvedByCallId,
        planDigest: current.planDigest,
        approvalId: current.approvalId,
      },
      {
        callId: preparation.accountApprovedByCallId,
        planDigest: preparation.accountPlanDigest,
        approvalId: preparation.accountApprovalId,
      },
    ]) {
      // oxlint-disable-next-line react-doctor/async-await-in-loop -- Preserve ordered independent approval rechecks before the same CAS attempt.
      const approved = await deps.readApproval({
        ...context,
        action: "prepare",
        callId: original.callId,
        planDigest: original.planDigest,
      });
      if (
        [
          approved?.approved !== true,
          approved?.action !== "prepare",
          approved?.callId !== original.callId,
          approved?.planDigest !== original.planDigest,
          approved?.approvalId !== original.approvalId,
        ].some(Boolean)
      ) {
        throw new HostedOperatorError("authorization_required");
      }
    }
    const fresh = await deps.store.read(context);
    if (fresh?.revision !== row.revision || !isDeepStrictEqual(fresh.record, row.record)) {
      continue;
    }
    assertCompatible(fresh.record, proposal, context, now());
    await deps.assertAuthorized({ ...context, plan: preparation.accountPlan, purpose: "planning" });
    const { identityLink, workerCheckpoints, ...accountOperator } = current;
    void workerCheckpoints;
    const { executionObservation, realmIdentityWait, realmContinuation, ...idleRecord } =
      row.record;
    const restored = hostedRuntimeJournalRecordSchema.parse({
      ...idleRecord,
      ...(accountWait ? { realmIdentityWait } : {}),
      approvedByCallId: preparation.accountApprovedByCallId,
      retainedAuth: auth,
      pendingAccountRestorations: [
        ...(row.record.pendingAccountRestorations ?? []),
        {
          approvedByCallId: row.record.approvedByCallId,
          operator: current,
          retainedAuth: row.record.retainedAuth,
          executionObservation,
          realmIdentityWait,
          realmContinuation,
        },
      ],
      operator: {
        ...accountOperator,
        ...(accountLink ? { identityLink } : {}),
        operationRef: preparation.accountOperationRef,
        plan: preparation.accountPlan,
        planDigest: preparation.accountPlanDigest,
        approvalId: preparation.accountApprovalId,
        receipts: [],
      },
    });
    const committed = await deps.store.compareAndSet({
      ...context,
      expectedRevision: row.revision,
      record: restored,
      now: new Date(now()),
    });
    if (committed === undefined) {
      continue;
    }
    return operatorPublicResultSchema.parse({
      appId: context.target.appId,
      authenticatedBehavior: "unassessed",
      status: "planned",
      operationRef: preparation.accountOperationRef,
      plan: preparation.accountPlan,
      planDigest: preparation.accountPlanDigest,
    });
  }
};
