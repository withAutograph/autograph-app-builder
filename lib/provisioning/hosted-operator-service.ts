import { recoverOriginalApprovedPlan } from "./hosted-operator-approved-plan";
import { savedPreviewEnvironmentGitBranch } from "./native-preview-environment-scope";
import { isDeepStrictEqual } from "node:util";
import {
  retainAppDeliveryHistory,
  ownedAppEnvironmentRows,
  planOwnedAppEnvironmentCleanup,
  checkpointOwnedAppEnvironmentCleanup,
  checkpointActiveAppEnvironment,
} from "./hosted-operator-app-delivery-history";
import type { projectNormalActorRuntime } from "./hosted-operator-normal-actor-runtime-projection";
import {
  createHostedOperatorConsentDiagnostic,
  reportOperatorPlanningMismatch,
  observeOperatorPlanStage,
  observeOperatorExecutionStage,
} from "./hosted-operator-consent-diagnostic";
import type { OperatorExecutionStage } from "./hosted-operator-consent-diagnostic";
import type { HostedOperatorConsentOwner } from "./hosted-operator-consent-owner";
import {
  neonAuthorizationInputSchema,
  neonAuthorizationResultSchema,
} from "./hosted-operator-neon-authorization";
import type {
  NeonAuthorizationInput,
  NeonAuthorizationResult,
} from "./hosted-operator-neon-authorization";
/* oxlint-disable eslint/no-await-in-loop, eslint/no-loop-func, sonarjs/no-nested-functions, eslint/complexity, sonarjs/expression-complexity, sonarjs/cognitive-complexity, unicorn/no-await-expression-member, eslint/prefer-destructuring -- Effects, fences and journal checkpoints are deliberately sequential inside one resource lease. */
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import type { BuilderProvisionAuthority } from "./journal";
import {
  hostedRuntimeTargetSchema,
  hostedRuntimeProofSchema,
  retainedOperatorAuthFromJournal,
  updateHostedRuntimeJournal,
} from "./hosted-runtime-journal";
import type {
  HostedRuntimeJournalRecord,
  HostedRuntimeJournalStore,
  HostedRuntimeTarget,
} from "./hosted-runtime-journal";
import {
  HostedOperatorError,
  operatorNativePreviewSchema,
  assertOperatorNativePreview,
  managedOperatorEnvironmentRowsSchema,
  operatorAuthSchemaPreparationSchema,
  operatorDeploymentCandidatesSchema,
  hostedOperatorPlanSchema,
  operatorPlanDigest,
  operatorPublicResultSchema,
  operatorReceiptSchema,
  operatorAuthIdentityInputSchema,
  operatorRequestSchema,
  operatorSelectionSchema,
  restrictedOperatorEnvironment,
  sameOperatorSelection,
  sameOperatorPlanExceptExpiry,
  hostedOperatorRecordSchema,
  operatorOwnerContextSchema,
  workerContextBindingSchema,
  workerEffectCheckpointFrameSchema,
  workerEffectCheckpointSchema,
} from "./hosted-operator-contract";
import {
  assertNormalActorState,
  normalActorProgramDigest,
} from "./hosted-operator-normal-actor-program";
import type { NormalActorProgram, NormalActorState } from "./hosted-operator-normal-actor-program";
import { normalActorAccountPreparationSchema } from "./hosted-operator-normal-actor-journal";
import type { NormalActorAccountPreparation } from "./hosted-operator-normal-actor-journal";
import type {
  HostedOperatorPlan,
  OperatorPublicResult,
  OperatorRequest,
  OperatorReceipt,
  OperatorSelection,
  OperatorOwnerContext,
  WorkerContextBinding,
  WorkerEffectCheckpoint,
  WorkerEffectCheckpointFrame,
  ManagedOperatorEnvironmentRow,
  OperatorAuthSchemaPreparation,
  OperatorDeploymentCandidate,
} from "./hosted-operator-contract";

export interface HostedOperatorContext {
  authority: BuilderProvisionAuthority;
  target: HostedRuntimeTarget;
  ownerContext?: OperatorOwnerContext;
}
const UNAPPROVED_PLAN = "operator:unapproved-plan";
const AUTH_BOOTSTRAP_STAGE = "auth-bootstrap";
const AUTH_PARTICIPANTS_STAGE = "auth-participants";
const PARTICIPANTS_PREPARED = "participants-prepared";
type Context = HostedOperatorContext;
type PrivateState = NonNullable<HostedRuntimeJournalRecord["privateState"]>;
type Effect = HostedOperatorPlan["effects"][number];
export type HostedOperatorManagedEnvironmentContext = HostedOperatorEffectContext & {
  checkpointManagedEnvironment: (rows: readonly ManagedOperatorEnvironmentRow[]) => Promise<void>;
};
export type GatewayManagedEnvironmentContext = HostedOperatorEffectContext & {
  gateway: {
    authBrowserOrigin: string;
    branch: string;
    builderCallbackOrigin: string;
    catalogAppIds: readonly string[];
    gatewayOrigin: string;
    operatorOrigin: string;
    projectId: string;
    publicOrigin: string;
    readonlyAttesters?: NonNullable<HostedOperatorPlan["gatewayBindings"]>["readonlyAttesters"];
    sourceWorkload: NonNullable<HostedOperatorPlan["gatewayBindings"]>["sourceWorkload"];
  };
  gatewayEnvironmentRows?: ManagedOperatorEnvironmentRow[];
  checkpointGatewayEnvironment: (rows: readonly ManagedOperatorEnvironmentRow[]) => Promise<void>;
};
export type HostedOperatorDeploymentContext = HostedOperatorEffectContext & {
  checkpointDelivery: (
    candidates: readonly OperatorDeploymentCandidate[],
    selectedId?: string,
  ) => Promise<void>;
};
export type HostedOperatorEffectContext = Context & {
  effect: Effect;
  /** Actual execution lease, retained privately for read-only journal CAS authority checks. */
  leaseId?: string;
  fenceGeneration: number;
  operationRef: string;
  plan: HostedOperatorPlan;
  privateState?: PrivateState;
  accountPreparation?: NormalActorAccountPreparation;
  checkpointAccountPreparation?: (preparation: NormalActorAccountPreparation) => Promise<void>;
  deliveryCandidates?: OperatorDeploymentCandidate[];
  gatewayDeliveryCandidates?: OperatorDeploymentCandidate[];
  checkpointGatewayDelivery?: (
    candidates: readonly OperatorDeploymentCandidate[],
    selectedId?: string,
  ) => Promise<void>;
  checkpointDelivery?: (
    candidates: readonly OperatorDeploymentCandidate[],
    selectedId?: string,
  ) => Promise<void>;
  gatewayEnvironmentRows?: ManagedOperatorEnvironmentRow[];
  checkpointGatewayEnvironment?: (rows: readonly ManagedOperatorEnvironmentRow[]) => Promise<void>;
  managedEnvironment?: ManagedOperatorEnvironmentRow[];
  checkpointManagedEnvironment?: (rows: readonly ManagedOperatorEnvironmentRow[]) => Promise<void>;
  workerCheckpoints: WorkerEffectCheckpoint[];
  assertCurrent: () => Promise<void>;
  /** Fresh canonical owner, actual approval, execution lease and physical fence for private reads. */
  assertCurrentObservation?: () => Promise<void>;
  checkpoint: (state: PrivateState) => Promise<void>;
};
export type RecordWorkerCheckpoint = (frame: WorkerEffectCheckpointFrame) => Promise<void>;
export type HostedOperatorWorkerEffectContext = HostedOperatorEffectContext & {
  workerAttemptId: string;
  bindWorkerContext: (binding: WorkerContextBinding) => Promise<RecordWorkerCheckpoint>;
};
export interface ProtectedHostedOperatorDependencies {
  store: HostedRuntimeJournalStore;
  /** Verify caller signature/audience and independently resolve this session's owner and selected project. Never trust body owner IDs. */
  authorize: (
    request: Request,
    selection: OperatorSelection,
    ownerContext?: OperatorOwnerContext,
  ) => Promise<Context>;
  /** Read only the configured Preview target after current-owner and provider authorization. */
  resolvePreviewTarget?: (
    request: Request,
    identity: Pick<OperatorSelection, "appId" | "sessionId">,
    ownerContext?: OperatorOwnerContext,
  ) => Promise<Context>;
  /**
   * Read-only owner-selected resource inventory and trusted generated artifact resolution. No
   * caller checkout or shell execution. The plan must include the independently verified public
   * Gateway origin for its exact Preview project and branch, never a request/model value or
   * private Sandbox origin.
   */
  plan: (
    context: Context & {
      action: "prepare" | "cleanup";
      normalActorProgram?: NormalActorProgram;
    },
  ) => Promise<HostedOperatorPlan>;
  /** Re-read membership, owner connection and provider grants. No ambient Neon authority. */
  assertAuthorized: (context: Context & { plan: HostedOperatorPlan }) => Promise<void>;
  /** Canonical session/member/app/adapter authority; provider grants remain full at observation boundaries and mutations. */
  assertCanonicalOwner?: (context: Context) => Promise<void>;
  /** Canonical current-owner original approval selection; never accepts model-supplied proof. */
  readApprovedPlan?: (
    context: Context & {
      plan: HostedOperatorPlan;
      currentOperation?: { operationRef: string; planDigest: string };
      now: number;
    },
  ) => Promise<{ operationRef: string; plan: HostedOperatorPlan; planDigest: string } | null>;
  /** Read the durable authenticated approval outcome and exact tool input from Eve's authoritative store. */
  readApproval: (
    context: Context & { callId: string; planDigest: string; action: "prepare" | "cleanup" },
  ) => Promise<{
    approvalId: string;
    callId: string;
    planDigest: string;
    action: "prepare" | "cleanup";
    approved: boolean;
  } | null>;
  /** Acquire/fence the actual shared Auth/app/access resources, in deterministic order, outside a DB transaction. */
  withResourceLease: <T>(
    input: Context & { plan: HostedOperatorPlan; operationRef: string },
    run: (assertFence: () => Promise<void>) => Promise<T>,
  ) => Promise<T>;
  /** Inspect uncertain effects on the same frozen identities before retry. Unknown must never become absent. */
  reconcile: (
    input: HostedOperatorEffectContext,
  ) => Promise<
    | { status: "absent" | "unknown" }
    | { status: "retryable"; resourceVersion: string }
    | { status: "applied"; receipt: OperatorReceipt }
  >;
  /** Pinned trusted installer + verified declarative artifact only. Guard immediately before every effect; checkpoint credentials before allocation. */
  executeEffect: (input: HostedOperatorWorkerEffectContext) => Promise<OperatorReceipt>;
  /** Private actual normal sessions only, after prepared approval and native Preview verification. */
  normalActorRuntimeBindings?: (
    input: Context & { plan: HostedOperatorPlan; operationRef: string },
  ) => Promise<ReturnType<typeof projectNormalActorRuntime> | undefined>;
  /** Independently read installed identities/release/provider bindings, with no mutation. */
  verify: (
    input: Context & { plan: HostedOperatorPlan; privateState?: PrivateState },
  ) => Promise<z.infer<typeof hostedRuntimeProofSchema>>;
  /** Decrypt only inside this operator; return the strict runtime environment projection. */
  verifyAuthReadiness?: (
    input: Context & {
      plan: HostedOperatorPlan;
      privateState?: PrivateState;
      assertCurrent: () => Promise<void>;
    },
  ) => Promise<OperatorAuthSchemaPreparation>;
  /** Mandatory for participant plans: current normal sessions, with the original encrypted account scope. */
  verifyNormalActorAccounts?: (
    input: Context & {
      plan: HostedOperatorPlan;
      assertCurrent: () => Promise<void>;
      accountPreparation: NormalActorAccountPreparation;
      checkpointAccountPreparation: (preparation: NormalActorAccountPreparation) => Promise<void>;
    },
  ) => Promise<NormalActorState>;
  /** Called after real first approval and before claiming an account-effect lease. */
  ensureNormalActorCapture?: (
    input: Context & {
      plan: HostedOperatorPlan;
      operationRef: string;
      callId: string;
      approvalId: string;
      planDigest: string;
    },
  ) => Promise<"ready" | "required">;
  authIdentityInput?: (
    input: Context & { operationRef: string; plan: HostedOperatorPlan },
  ) => Promise<z.infer<typeof operatorAuthIdentityInputSchema>>;
  bindings: (
    input: Context & { plan: HostedOperatorPlan; privateState?: PrivateState },
  ) => Promise<Record<string, string>>;
  authorizeNeonConsent?: (
    request: Request,
    sessionId: string,
    ownerContext?: OperatorOwnerContext,
  ) => Promise<HostedOperatorConsentOwner>;
  neonAuthorization?: (
    context: HostedOperatorConsentOwner,
    input: NeonAuthorizationInput,
  ) => Promise<NeonAuthorizationResult>;
  now?: () => number;
}
const selectionFor = (target: HostedRuntimeTarget): OperatorSelection => ({
  appId: target.appId,
  branch: target.branch,
  environment: target.environment,
  projectId: target.projectId,
  sessionId: target.sessionId,
});
const hasRequiredGatewayPlan = (operation: "prepare" | "cleanup", plan: HostedOperatorPlan) =>
  operation !== "prepare" || plan.publicGateway !== undefined;
const assertUnexpired = (plan: HostedOperatorPlan, now: number) => {
  if (plan.action === "prepare" && Date.parse(plan.retention.expiresAt) <= now) {
    throw new HostedOperatorError("authorization_required");
  }
};
const requireOperator = (record: HostedRuntimeJournalRecord) =>
  hostedOperatorRecordSchema.parse(record.operator);
type OperatorHttpResponse =
  | OperatorSelection
  | NeonAuthorizationResult
  | z.infer<typeof operatorAuthIdentityInputSchema>
  | OperatorPublicResult
  | { code: "not_found" }
  | {
      environment: Record<string, string>;
      nativePreview?: z.infer<typeof operatorNativePreviewSchema>;
      operationRef: string;
      plan: HostedOperatorPlan;
      proof: z.infer<typeof hostedRuntimeProofSchema>;
    };
const response = (value: OperatorHttpResponse, status = 200) =>
  Response.json(value, { headers: { "cache-control": "no-store" }, status });
const resourceIdentity = (plan: HostedOperatorPlan) =>
  JSON.stringify({
    appDatabase: plan.appDatabase,
    authDatabase: plan.authDatabase,
    contextId: plan.contextId,
    neon: plan.neon,
  });
const sameAuthPreparation = (prior: HostedOperatorPlan, next: HostedOperatorPlan) =>
  JSON.stringify(prior.authDatabase) === JSON.stringify(next.authDatabase) &&
  (["projectId", "branchId", "endpoint"] as const).every(
    (key) => prior.neon[key] === next.neon[key],
  ) &&
  prior.bootstrap?.endpointId === next.bootstrap?.endpointId &&
  (next.authSchema === undefined ||
    prior.authSchema?.targetDigest === next.authSchema.targetDigest);

/** A source repair continues the already observed bootstrap effects under a new normal approval.
 * Native deployment creation is at-least-once; an uncertain alias write still requires reconciliation.
 */
const isGatewaySourceSuccessor = (
  record: HostedRuntimeJournalRecord,
  plan: HostedOperatorPlan,
  now: number,
) => {
  const prior = record.operator;
  const delivery = prior?.plan.effects.find((effect) => effect.kind === "gateway-delivery");
  if (
    prior === undefined ||
    delivery === undefined ||
    prior.plan.gatewayDelivery === undefined ||
    plan.gatewayDelivery === undefined
  ) {
    return false;
  }
  return [
    record.status === "pending",
    record.step === "reserved",
    record.privateState !== undefined,
    prior.approvalId !== undefined,
    record.approvedByCallId !== UNAPPROVED_PLAN,
    prior.plan.stage === AUTH_BOOTSTRAP_STAGE,
    prior.plan.gatewayDelivery.gitSha !== plan.gatewayDelivery.gitSha,
    sameOperatorPlanExceptExpiry(prior.plan, {
      ...plan,
      gatewayDelivery: { ...plan.gatewayDelivery, gitSha: prior.plan.gatewayDelivery.gitSha },
    }),
    record.leaseId === undefined ||
      (record.leaseExpiresAt !== undefined && Date.parse(record.leaseExpiresAt) <= now),
    prior.pendingEffectId === undefined || prior.pendingEffectId === delivery.id,
    prior.gatewayDeliveryCandidates?.some(
      (candidate) =>
        candidate.operationRef === prior.operationRef && candidate.gatewayAliasAttempted === true,
    ) !== true,
    !prior.receipts.some((receipt) => receipt.effectId === delivery.id),
    prior.plan.effects.every(
      (effect) =>
        effect.id === delivery.id ||
        (["resources", "install", "gateway-bindings"].includes(effect.kind) &&
          prior.receipts.some((receipt) => receipt.effectId === effect.id)),
    ),
  ].every(Boolean);
};

const retainCompletedAuth = (record: HostedRuntimeJournalRecord): HostedRuntimeJournalRecord => ({
  ...record,
  retainedAuth:
    record.operator?.plan.stage === AUTH_BOOTSTRAP_STAGE
      ? (retainedOperatorAuthFromJournal(record) ?? record.retainedAuth)
      : (record.retainedAuth ?? retainedOperatorAuthFromJournal(record)),
});

const handlePlanOperation = async (
  deps: ProtectedHostedOperatorDependencies,
  context: Context,
  input: Extract<OperatorRequest, { action: "plan" }>,
  appId: string,
  now: () => number,
) => {
  const proposed = await observeOperatorPlanStage(
    context.target.sessionId,
    "plan_composition",
    async () =>
      await deps.plan({
        ...context,
        action: input.operation,
        ...(input.normalActorProgram === undefined
          ? {}
          : { normalActorProgram: input.normalActorProgram }),
      }),
  );
  const cleanupPrior = input.operation === "cleanup" ? await deps.store.read(context) : undefined;
  const plan = await observeOperatorPlanStage(context.target.sessionId, "plan_validation", () =>
    hostedOperatorPlanSchema.parse(
      planOwnedAppEnvironmentCleanup(proposed, cleanupPrior?.record.operator),
    ),
  );
  const failed = {
    plan_action: plan.action !== input.operation,
    plan_selection: !sameOperatorSelection(plan.selection, input.selection),
    gateway_plan: !hasRequiredGatewayPlan(input.operation, plan),
  };
  if (Object.values(failed).some(Boolean)) {
    reportOperatorPlanningMismatch(context.target.sessionId, "plan_result", failed);
    throw new HostedOperatorError("resource_mismatch");
  }
  await observeOperatorPlanStage(context.target.sessionId, "plan_authorization", async () => {
    await deps.assertAuthorized({ ...context, plan });
  });
  assertUnexpired(plan, now());
  const recovered = await recoverOriginalApprovedPlan(deps, context, input, appId, plan, now);
  if (recovered !== null) {
    return response(recovered);
  }
  const planDigest = operatorPlanDigest(plan);
  const operator = {
    mode: "protected-operator-v1" as const,
    operationRef: randomUUID(),
    plan,
    planDigest,
    receipts: [],
  };
  await observeOperatorPlanStage(
    context.target.sessionId,
    "plan_reservation",
    async () =>
      await deps.store.reserve({
        ...context,
        approvedByCallId: UNAPPROVED_PLAN,
        now: new Date(now()),
        operator,
      }),
  );
  const prior = await deps.store.read(context);
  const retainedCandidate =
    (prior?.record.retainedAuth === undefined ||
      prior.record.operator?.plan.stage === AUTH_BOOTSTRAP_STAGE) &&
    prior?.record.operator?.planDigest !== planDigest
      ? prior && retainedOperatorAuthFromJournal(prior.record)
      : undefined;
  if (retainedCandidate !== undefined) {
    const approval = await deps.readApproval({
      ...context,
      action: "prepare",
      callId: retainedCandidate.approvedByCallId,
      planDigest: retainedCandidate.planDigest,
    });
    if (
      approval?.approved !== true ||
      approval.approvalId !== retainedCandidate.approvalId ||
      approval.callId !== retainedCandidate.approvedByCallId ||
      approval.planDigest !== retainedCandidate.planDigest ||
      approval.action !== "prepare"
    ) {
      throw new HostedOperatorError("authorization_required");
    }
  }
  const row = await updateHostedRuntimeJournal({
    ...context,
    now,
    store: deps.store,
    update: (record) => {
      if (!record.operator) {
        throw new HostedOperatorError("legacy_runtime_requires_migration");
      }
      if (record.operator.planDigest === planDigest) {
        return record;
      }
      const authStageCompleted =
        record.operator.plan.stage === AUTH_BOOTSTRAP_STAGE &&
        record.operator.authPreparation !== undefined &&
        record.operator.pendingEffectId === undefined &&
        record.operator.pendingEffectAttempt === undefined &&
        record.operator.plan.effects.every(
          (effect) =>
            record.operator?.receipts.some((receipt) => receipt.effectId === effect.id) === true,
        );
      const participantsCompleted =
        record.status === PARTICIPANTS_PREPARED &&
        record.operator.plan.stage === AUTH_PARTICIPANTS_STAGE &&
        record.accountPreparation !== undefined;
      const gatewaySourceSuccessor = isGatewaySourceSuccessor(record, plan, now());
      if (
        !gatewaySourceSuccessor &&
        (record.leaseId !== undefined ||
          record.operator.pendingEffectId !== undefined ||
          record.operator.pendingEffectAttempt !== undefined ||
          (record.operator.receipts.length > 0 &&
            !["prepared", "cleaned"].includes(record.status) &&
            !authStageCompleted &&
            !participantsCompleted))
      ) {
        throw new HostedOperatorError("operation_in_progress");
      }
      const hasResources =
        record.status !== "cleaned" &&
        (record.privateState !== undefined ||
          record.operator.receipts.length > 0 ||
          record.status === "prepared");
      if (hasResources && resourceIdentity(record.operator.plan) !== resourceIdentity(plan)) {
        throw new HostedOperatorError("resource_mismatch");
      }
      if (
        retainedCandidate !== undefined &&
        (JSON.stringify(retainedOperatorAuthFromJournal(record)) !==
          JSON.stringify(retainedCandidate) ||
          JSON.stringify(record.privateState) !== JSON.stringify(prior?.record.privateState))
      ) {
        throw new HostedOperatorError("operation_in_progress");
      }
      const retainedAuth =
        record.operator.plan.stage === AUTH_BOOTSTRAP_STAGE
          ? (retainedCandidate ?? record.retainedAuth)
          : (record.retainedAuth ?? retainedCandidate);
      if (record.accountPreparation !== undefined) {
        const preparation = record.accountPreparation;
        if (
          plan.normalActorProgram === undefined ||
          preparation.programDigest !== normalActorProgramDigest(plan.normalActorProgram)
        ) {
          throw new HostedOperatorError("resource_mismatch");
        }
        if (plan.stage === "app") {
          const proposedPreparation = plan.normalActorPreparation;
          if (
            proposedPreparation === undefined ||
            proposedPreparation.accountOperationRef !== preparation.accountOperationRef ||
            proposedPreparation.accountPlanDigest !== preparation.accountPlanDigest ||
            proposedPreparation.accountApprovalId !== preparation.accountApprovalId ||
            proposedPreparation.accountApprovedByCallId !== preparation.accountApprovedByCallId
          ) {
            throw new HostedOperatorError("resource_mismatch");
          }
        }
      }
      // Same-resource release changes keep credentials; old proof never attests the new plan.
      const nextOperator: ReturnType<typeof requireOperator> = { ...operator };
      nextOperator.retainedGatewayDeliveries = record.operator.retainedGatewayDeliveries;
      if (gatewaySourceSuccessor) {
        const { retainedGatewayDeliveries, ...priorOperator } = record.operator;
        nextOperator.retainedGatewayDeliveries = [
          ...(retainedGatewayDeliveries ?? []),
          { approvedByCallId: record.approvedByCallId, operator: priorOperator },
        ];
        nextOperator.receipts = record.operator.receipts;
      }
      if (sameAuthPreparation(record.operator.plan, plan)) {
        nextOperator.authPreparation = record.operator.authPreparation;
      }
      Object.assign(nextOperator, retainAppDeliveryHistory(record.operator, nextOperator));
      nextOperator.gatewayDeliveryCandidates = record.operator.gatewayDeliveryCandidates;
      if (!gatewaySourceSuccessor) {
        nextOperator.deliveredGatewayDeploymentId = record.operator.deliveredGatewayDeploymentId;
      }
      if (record.operator.gatewayEnvironment !== undefined) {
        nextOperator.gatewayEnvironment = record.operator.gatewayEnvironment;
      }
      if (plan.action === "prepare" && record.operator.identityLink?.consumedAt !== undefined) {
        nextOperator.identityLink = record.operator.identityLink;
      }
      if (
        authStageCompleted &&
        record.operator.plan.authSchema?.targetDigest === plan.authSchema?.targetDigest
      ) {
        nextOperator.receipts = record.operator.receipts.filter((receipt) => {
          const priorEffect = record.operator?.plan.effects.find(
            (effect) => effect.id === receipt.effectId,
          );
          const nextEffect = plan.effects.find((effect) => effect.id === receipt.effectId);
          return (
            priorEffect !== undefined &&
            nextEffect !== undefined &&
            ["resources", "install"].includes(priorEffect.kind) &&
            priorEffect.kind === nextEffect.kind &&
            priorEffect.resourceId === nextEffect.resourceId
          );
        });
      }
      const next = {
        ...record,
        approvedByCallId: UNAPPROVED_PLAN,
        environmentBound: false,
        operator: nextOperator,
        retainedAuth:
          retainedAuth !== undefined && sameAuthPreparation(retainedAuth.plan, plan)
            ? retainedAuth
            : undefined,
        status: "pending" as const,
        step: "reserved" as const,
      };
      delete next.proof;
      if (gatewaySourceSuccessor) {
        delete next.leaseId;
        delete next.leaseExpiresAt;
      }
      return next;
    },
  });
  return response(
    operatorPublicResultSchema.parse({
      appId,
      authenticatedBehavior: "unassessed",
      operationRef: requireOperator(row.record).operationRef,
      plan,
      planDigest,
      status: "planned",
    }),
  );
};

const handleBindingsOperation = async (input: {
  context: Context;
  current: NonNullable<Awaited<ReturnType<HostedRuntimeJournalStore["read"]>>>;
  deps: ProtectedHostedOperatorDependencies;
  operationRef: string;
  operator: z.infer<typeof hostedOperatorRecordSchema>;
  plan: HostedOperatorPlan;
  planDigest: string;
  read: () => Promise<Awaited<ReturnType<HostedRuntimeJournalStore["read"]>>>;
  now: () => number;
}) => {
  const { context, current, deps, operationRef, operator, plan, planDigest, read } = input;
  if (
    current.record.leaseId !== undefined ||
    current.record.status !== "prepared" ||
    current.record.step !== "bound" ||
    operator.approvalId === undefined ||
    operator.pendingEffectId !== undefined ||
    operator.pendingEffectAttempt !== undefined
  ) {
    throw new HostedOperatorError("operation_in_progress");
  }
  const approval = await deps.readApproval({
    ...context,
    action: plan.action,
    callId: current.record.approvedByCallId,
    planDigest,
  });
  if (
    approval?.approved !== true ||
    approval.approvalId !== operator.approvalId ||
    approval.callId !== current.record.approvedByCallId ||
    approval.planDigest !== planDigest ||
    approval.action !== plan.action
  ) {
    throw new HostedOperatorError("authorization_required");
  }
  const proof = hostedRuntimeProofSchema.parse(
    await deps.verify({ ...context, plan, privateState: current.record.privateState }),
  );
  if (proof.manifestSha256 !== plan.release.sha256 || proof.releaseId !== plan.release.id) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const environment = restrictedOperatorEnvironment(
    plan,
    await deps.bindings({ ...context, plan, privateState: current.record.privateState }),
    context.authority,
  );
  const app = operator.deliveryCandidates?.find(
    (candidate) => candidate.deploymentId === operator.deliveredDeploymentId,
  );
  const gateway = operator.gatewayDeliveryCandidates?.find(
    (candidate) => candidate.deploymentId === operator.deliveredGatewayDeploymentId,
  );
  // Legacy prepared operations remain readable, but cannot publish a native Preview without both deliveries.
  const nativePreview =
    app && gateway
      ? operatorNativePreviewSchema.parse({
          app,
          expiresAt: plan.retention.expiresAt,
          gateway,
          operationRef,
          planDigest,
          publicOrigin: plan.deploymentBoundary?.verification.publicOrigin,
          verifiedAt: new Date(input.now()).toISOString(),
        })
      : undefined;
  if (nativePreview) {
    assertOperatorNativePreview(nativePreview, plan, operationRef, input.now());
  }
  let normalActors: ReturnType<typeof projectNormalActorRuntime> | undefined;
  if (plan.normalActorProgram !== undefined) {
    if (nativePreview === undefined || deps.normalActorRuntimeBindings === undefined) {
      throw new HostedOperatorError("auth_identity_required");
    }
    if (plan.normalActorProgram.origin !== nativePreview.publicOrigin) {
      throw new HostedOperatorError("resource_mismatch");
    }
    normalActors = await deps.normalActorRuntimeBindings({ ...context, plan, operationRef });
    if (normalActors === undefined) {
      throw new HostedOperatorError("auth_identity_required");
    }
    if (normalActors.origin !== nativePreview.publicOrigin) {
      throw new HostedOperatorError("resource_mismatch");
    }
  }
  await deps.assertAuthorized({ ...context, plan });
  const latest = await read();
  if (latest?.revision !== current.revision) {
    throw new HostedOperatorError("operation_in_progress");
  }
  return response({
    environment,
    ...(nativePreview === undefined ? {} : { nativePreview }),
    ...(normalActors === undefined ? {} : { normalActors }),
    operationRef,
    plan,
    proof,
  });
};

const normalizeOperatorContext = (authorized: Context): Context => {
  const context: Context = {
    authority: hostedTenantAuthoritySchema.parse(authorized.authority),
    target: hostedRuntimeTargetSchema.parse(authorized.target),
  };
  if (authorized.ownerContext) {
    const owner = operatorOwnerContextSchema.parse(authorized.ownerContext);
    if (
      owner.sessionId !== context.target.sessionId ||
      (["audience", "issuer", "ownerUserId", "workspaceId"] as const).some(
        (key) => owner.authority[key] !== context.authority[key],
      )
    ) {
      throw new HostedOperatorError("authorization_required");
    }
    context.ownerContext = owner;
  }
  return context;
};

/** Separate service entrypoint. There is deliberately no production dependency fallback. */
export const createProtectedHostedOperatorHandler = (deps: ProtectedHostedOperatorDependencies) => {
  for (const name of [
    "authorize",
    "plan",
    "assertAuthorized",
    "readApproval",
    "withResourceLease",
    "reconcile",
    "executeEffect",
    "verify",
    "bindings",
  ] as const) {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Trusted adapter startup validates each required callback; there is no permissive fallback.
    if (typeof deps[name] !== "function") {
      throw new HostedOperatorError("protected_operator_required");
    }
  }
  if (deps.store === undefined) {
    throw new HostedOperatorError("protected_operator_required");
  }
  const now = deps.now ?? Date.now;
  return async (request: Request): Promise<Response> => {
    let appId = "unknown";
    try {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/runtime") {
        return response({ code: "not_found" }, 404);
      }
      const input = operatorRequestSchema.parse(await request.json());
      const isConsentRequest = input.action === "neon-authorization";
      createHostedOperatorConsentDiagnostic(
        isConsentRequest || input.action === "resolve-preview-target"
          ? input.sessionId
          : input.selection.sessionId,
      )({
        boundary: "operator",
        outcome: "started",
        phase: isConsentRequest ? input.phase : "inline",
        stage: "operator_ingress",
      });
      if (isConsentRequest) {
        if (deps.neonAuthorization === undefined || deps.authorizeNeonConsent === undefined) {
          throw new HostedOperatorError("protected_operator_required");
        }
        const context = await deps.authorizeNeonConsent(
          request,
          input.sessionId,
          input.ownerContext,
        );
        const consentInput: Pick<typeof input, "callbackUrl" | "phase"> = { phase: input.phase };
        if (input.callbackUrl !== undefined) {
          consentInput.callbackUrl = input.callbackUrl;
        }
        const consentRequest = neonAuthorizationInputSchema.parse(consentInput);
        return response(
          neonAuthorizationResultSchema.parse(
            await deps.neonAuthorization(context, consentRequest),
          ),
        );
      }
      if (input.action === "resolve-preview-target") {
        appId = input.appId;
        if (deps.resolvePreviewTarget === undefined) {
          throw new HostedOperatorError("protected_operator_required");
        }
        const context = normalizeOperatorContext(
          await deps.resolvePreviewTarget(
            request,
            { appId: input.appId, sessionId: input.sessionId },
            input.ownerContext,
          ),
        );
        const selection = operatorSelectionSchema.parse(selectionFor(context.target));
        if (selection.appId !== input.appId || selection.sessionId !== input.sessionId) {
          throw new HostedOperatorError("authorization_required");
        }
        return response(selection);
      }
      appId = input.selection.appId;
      const authorizeContext = async () => {
        const authorized = await deps.authorize(request, input.selection, input.ownerContext);
        const ownedContext = normalizeOperatorContext(authorized);
        if (!sameOperatorSelection(selectionFor(ownedContext.target), input.selection)) {
          throw new HostedOperatorError("authorization_required");
        }
        return ownedContext;
      };
      const authorizeExecutionContext = async () =>
        input.action === "execute"
          ? await observeOperatorExecutionStage(
              input.selection.sessionId,
              "owner_authorization",
              authorizeContext,
            )
          : await authorizeContext();
      const context =
        input.action === "plan"
          ? await observeOperatorPlanStage(
              input.selection.sessionId,
              "plan_owner_authorization",
              authorizeContext,
            )
          : await authorizeExecutionContext();
      const read = async () => await deps.store.read(context);
      const update = async (
        change: (record: HostedRuntimeJournalRecord) => HostedRuntimeJournalRecord,
      ) => await updateHostedRuntimeJournal({ ...context, now, store: deps.store, update: change });
      if (input.action === "plan") {
        return await handlePlanOperation(deps, context, input, appId, now);
      }
      const current =
        input.action === "execute"
          ? await observeOperatorExecutionStage(context.target.sessionId, "journal_read", read)
          : await read();
      const operator = current?.record.operator;
      if (
        !operator ||
        operator.operationRef !== input.operationRef ||
        operator.planDigest !== operatorPlanDigest(operator.plan)
      ) {
        throw new HostedOperatorError("resource_mismatch");
      }
      const { plan, planDigest, operationRef } = operator;
      const observePrepare = async <T>(stage: OperatorExecutionStage, run: () => T | Promise<T>) =>
        input.action === "execute" && plan.action === "prepare"
          ? await observeOperatorExecutionStage(context.target.sessionId, stage, run)
          : await run();
      await observePrepare("provider_authorization", async () => {
        await deps.assertAuthorized({ ...context, plan });
      });
      const publicStatus = (record: HostedRuntimeJournalRecord): OperatorPublicResult => {
        let status: OperatorPublicResult["status"] = "pending";
        if (
          record.status === "prepared" ||
          record.status === "cleaned" ||
          record.status === PARTICIPANTS_PREPARED
        ) {
          status = record.status;
        }
        if (
          operator.plan.stage === AUTH_BOOTSTRAP_STAGE &&
          requireOperator(record).authPreparation !== undefined
        ) {
          status = "auth-schema-prepared";
        }
        return { appId, authenticatedBehavior: "unassessed", operationRef, planDigest, status };
      };
      if (input.action === "auth-identity-input") {
        if (plan.normalActorProgram !== undefined && plan.stage !== AUTH_PARTICIPANTS_STAGE) {
          throw new HostedOperatorError("auth_identity_required");
        }
        if (deps.authIdentityInput === undefined) {
          throw new HostedOperatorError("operator_unavailable");
        }
        return response(
          operatorAuthIdentityInputSchema.parse(
            await deps.authIdentityInput({ ...context, operationRef, plan }),
          ),
        );
      }
      if (input.action === "status") {
        return response(operatorPublicResultSchema.parse(publicStatus(current.record)));
      }
      assertUnexpired(plan, now());
      if (input.action === "bindings") {
        if (plan.stage === AUTH_BOOTSTRAP_STAGE || plan.stage === AUTH_PARTICIPANTS_STAGE) {
          throw new HostedOperatorError("auth_identity_required");
        }
        return await handleBindingsOperation({
          context,
          current,
          deps,
          now,
          operationRef,
          operator,
          plan,
          planDigest,
          read,
        });
      }
      if (input.planDigest !== planDigest) {
        throw new HostedOperatorError("resource_mismatch");
      }
      const assertApproval = async (observation = false, diagnose = false) => {
        assertUnexpired(plan, now());
        const authorizeApproval = async () => {
          await (observation && deps.assertCanonicalOwner !== undefined
            ? deps.assertCanonicalOwner(context)
            : deps.assertAuthorized({ ...context, plan }));
        };
        await (diagnose
          ? observePrepare("approval_authorization", authorizeApproval)
          : authorizeApproval());
        const readApproval = async () => {
          const currentApproval = await deps.readApproval({
            ...context,
            action: plan.action,
            callId: input.callId,
            planDigest,
          });
          if (
            currentApproval?.approved !== true ||
            currentApproval.approvalId === "" ||
            currentApproval.callId !== input.callId ||
            currentApproval.planDigest !== planDigest ||
            currentApproval.action !== plan.action
          ) {
            throw new HostedOperatorError("authorization_required");
          }
          return currentApproval;
        };
        return diagnose
          ? await observePrepare("approval_read", readApproval)
          : await readApproval();
      };
      const approval = await assertApproval(false, true);
      if (plan.stage === AUTH_PARTICIPANTS_STAGE) {
        if (deps.ensureNormalActorCapture === undefined) {
          throw new HostedOperatorError("operator_unavailable");
        }
        // Retain real approval provenance before idle owner capture; no account-effect lease exists yet.
        await update((value) => {
          const savedOperator = requireOperator(value);
          if (
            savedOperator.operationRef !== operationRef ||
            savedOperator.planDigest !== planDigest ||
            value.leaseId !== undefined ||
            savedOperator.pendingEffectId !== undefined ||
            savedOperator.pendingEffectAttempt !== undefined
          ) {
            throw new HostedOperatorError("operation_in_progress");
          }
          if (value.accountPreparation !== undefined) {
            return value;
          }
          return {
            ...value,
            approvedByCallId: input.callId,
            operator: { ...savedOperator, approvalId: approval.approvalId },
          };
        });
        const capture = await deps.ensureNormalActorCapture({
          ...context,
          plan,
          operationRef,
          callId: input.callId,
          approvalId: approval.approvalId,
          planDigest,
        });
        if (capture !== "ready") {
          throw new HostedOperatorError("auth_identity_required");
        }
      }
      const leaseId = randomUUID();
      let claimed = await observePrepare(
        "lease_claim",
        async () =>
          await update((record) => {
            if (
              record.operator?.operationRef !== operationRef ||
              record.operator.planDigest !== planDigest
            ) {
              throw new HostedOperatorError("resource_mismatch");
            }
            if (
              record.leaseId !== undefined &&
              record.leaseExpiresAt !== undefined &&
              Date.parse(record.leaseExpiresAt) > now()
            ) {
              throw new HostedOperatorError("operation_in_progress");
            }
            return {
              ...record,
              approvedByCallId: input.callId,
              leaseExpiresAt: new Date(now() + 60_000).toISOString(),
              leaseId,
              operator: { ...record.operator, approvalId: approval.approvalId },
            };
          }),
      );
      let fenceGeneration = requireOperator(claimed.record).fenceGeneration;
      if (fenceGeneration === undefined) {
        const allocated = await deps.store.reserveFenceGeneration({
          ...context,
          expectedRevision: claimed.revision,
          leaseId,
          now: new Date(now()),
          operationRef,
        });
        if (allocated) {
          claimed = allocated;
          fenceGeneration = requireOperator(claimed.record).fenceGeneration;
        } else {
          const latest = await read();
          if (
            latest?.record.leaseId !== leaseId ||
            requireOperator(latest.record).operationRef !== operationRef ||
            requireOperator(latest.record).fenceGeneration === undefined
          ) {
            throw new HostedOperatorError("operation_in_progress");
          }
          claimed = latest;
          fenceGeneration = requireOperator(latest.record).fenceGeneration;
        }
      }
      if (fenceGeneration === undefined) {
        throw new HostedOperatorError("reconciliation_required");
      }
      const ownedUpdate = async (
        change: (record: HostedRuntimeJournalRecord) => HostedRuntimeJournalRecord,
      ) =>
        await update((record) => {
          if (
            record.leaseId !== leaseId ||
            record.operator?.operationRef !== operationRef ||
            record.leaseExpiresAt === undefined ||
            Date.parse(record.leaseExpiresAt) <= now()
          ) {
            throw new HostedOperatorError("operation_in_progress");
          }
          return change({ ...record, leaseExpiresAt: new Date(now() + 60_000).toISOString() });
        });
      try {
        return await deps.withResourceLease(
          { ...context, operationRef, plan },
          async (assertFence) => {
            const assertCurrent = async () => {
              await assertApproval();
              await assertFence();
              await ownedUpdate((record) => record);
            };
            const assertCurrentObservation = async () => {
              const currentApproval = await assertApproval(true);
              if (currentApproval.approvalId !== approval.approvalId) {
                throw new HostedOperatorError("authorization_required");
              }
              await assertFence();
              await ownedUpdate((record) => record);
            };
            let { record } = claimed;
            const checkpointAccountPreparation = async (
              supplied: NormalActorAccountPreparation,
            ) => {
              await assertCurrent();
              const preparation = normalActorAccountPreparationSchema.parse(supplied);
              if (
                plan.normalActorProgram === undefined ||
                preparation.programDigest !== normalActorProgramDigest(plan.normalActorProgram)
              ) {
                throw new HostedOperatorError("resource_mismatch");
              }
              record = (
                await ownedUpdate((value) => {
                  const prior = value.accountPreparation;
                  if (prior === undefined) {
                    if (
                      plan.stage !== AUTH_PARTICIPANTS_STAGE ||
                      preparation.accountOperationRef !== operationRef ||
                      preparation.accountPlanDigest !== planDigest ||
                      preparation.accountApprovalId !== approval.approvalId ||
                      preparation.accountApprovedByCallId !== input.callId
                    ) {
                      throw new HostedOperatorError("authorization_required");
                    }
                  } else if (
                    preparation.accountOperationRef !== prior.accountOperationRef ||
                    preparation.accountPlanDigest !== prior.accountPlanDigest ||
                    preparation.accountApprovalId !== prior.accountApprovalId ||
                    preparation.accountApprovedByCallId !== prior.accountApprovedByCallId ||
                    preparation.programDigest !== prior.programDigest
                  ) {
                    throw new HostedOperatorError("resource_mismatch");
                  }
                  return { ...value, accountPreparation: preparation };
                })
              ).record;
            };
            for (const effect of plan.effects) {
              await assertCurrent();
              const priorReceipt = requireOperator(record).receipts.find(
                (receipt) => receipt.effectId === effect.id,
              );
              if (
                priorReceipt !== undefined &&
                ((effect.kind !== "access" && effect.kind !== "revoke") ||
                  priorReceipt.fenceGeneration === fenceGeneration)
              ) {
                continue;
              }
              const effectInput: HostedOperatorEffectContext = {
                ...context,
                leaseId,
                assertCurrent,
                accountPreparation: record.accountPreparation,
                checkpointAccountPreparation,
                assertCurrentObservation,
                checkpoint: async (privateState) => {
                  await assertCurrent();
                  record = (await ownedUpdate((value) => ({ ...value, privateState }))).record;
                },
                checkpointDelivery: async (rows, selectedId) => {
                  await assertCurrent();
                  const candidates = operatorDeploymentCandidatesSchema.parse(rows);
                  record = (
                    await ownedUpdate((value) => {
                      const prior = requireOperator(value);
                      if (
                        candidates.some(
                          (candidate) =>
                            candidate.operationRef !== operationRef &&
                            !(prior.deliveryCandidates ?? []).some(
                              (old) => JSON.stringify(old) === JSON.stringify(candidate),
                            ),
                        )
                      ) {
                        throw new HostedOperatorError("resource_mismatch");
                      }
                      const merged = [
                        ...(prior.deliveryCandidates ?? []).filter(
                          (old) =>
                            !candidates.some(
                              (observedCandidate) =>
                                observedCandidate.deploymentId === old.deploymentId,
                            ),
                        ),
                        ...candidates,
                      ];
                      const next = { ...prior, deliveryCandidates: merged };
                      if (selectedId !== undefined) {
                        next.deliveredDeploymentId = selectedId;
                      }
                      return { ...value, operator: next };
                    })
                  ).record;
                },
                checkpointGatewayDelivery: async (rows, selectedId) => {
                  await assertCurrent();
                  const candidates = operatorDeploymentCandidatesSchema.parse(rows);
                  record = (
                    await ownedUpdate((value) => {
                      const prior = requireOperator(value);
                      if (
                        candidates.some(
                          (candidate) =>
                            candidate.operationRef !== operationRef &&
                            !(prior.gatewayDeliveryCandidates ?? []).some(
                              (old) => JSON.stringify(old) === JSON.stringify(candidate),
                            ),
                        )
                      ) {
                        throw new HostedOperatorError("resource_mismatch");
                      }
                      const merged = [
                        ...(prior.gatewayDeliveryCandidates ?? []).filter(
                          (old) =>
                            !candidates.some(
                              (observedCandidate) =>
                                observedCandidate.deploymentId === old.deploymentId,
                            ),
                        ),
                        ...candidates,
                      ];
                      const next = { ...prior, gatewayDeliveryCandidates: merged };
                      if (selectedId !== undefined) {
                        next.deliveredGatewayDeploymentId = selectedId;
                      }
                      return { ...value, operator: next };
                    })
                  ).record;
                },
                checkpointGatewayEnvironment: async (rows) => {
                  await assertCurrent();
                  const gatewayEnvironment = managedOperatorEnvironmentRowsSchema.parse(rows);
                  record = (
                    await ownedUpdate((value) => {
                      const currentOperator = requireOperator(value);
                      const priorRows = currentOperator.gatewayEnvironment ?? [];
                      const approvedRows =
                        currentOperator.plan.authAdoption?.gatewayEnvironment ?? [];
                      if (
                        gatewayEnvironment.some((row) => {
                          const prior = priorRows.find(
                            (saved) => saved.id === row.id || saved.key === row.key,
                          );
                          const approved = approvedRows.find(
                            (saved) => saved.id === row.id || saved.key === row.key,
                          );
                          const sameIdentity = (saved: ManagedOperatorEnvironmentRow) =>
                            (
                              [
                                "branch",
                                "comment",
                                "id",
                                "key",
                                "operationRef",
                                "projectId",
                              ] as const
                            ).every((key) => saved[key] === row[key]) &&
                            savedPreviewEnvironmentGitBranch(saved) ===
                              savedPreviewEnvironmentGitBranch(row);
                          const foreignPending =
                            row.pendingOperationRef !== undefined &&
                            row.pendingOperationRef !== operationRef;
                          if (
                            foreignPending ||
                            (prior !== undefined && !sameIdentity(prior)) ||
                            (approved !== undefined && !sameIdentity(approved))
                          ) {
                            return true;
                          }
                          // Approved canonical ownership seeds adopted rows. Verified value and
                          // current-operation pending metadata may evolve while row identity stays fixed.
                          return (
                            row.operationRef !== operationRef &&
                            prior === undefined &&
                            approved === undefined
                          );
                        })
                      ) {
                        throw new HostedOperatorError("resource_mismatch");
                      }
                      return {
                        ...value,
                        operator: { ...currentOperator, gatewayEnvironment },
                        retainedAuth:
                          value.retainedAuth === undefined
                            ? undefined
                            : { ...value.retainedAuth, gatewayEnvironment },
                      };
                    })
                  ).record;
                  effectInput.gatewayEnvironmentRows = requireOperator(record).gatewayEnvironment;
                },
                checkpointManagedEnvironment: async (rows) => {
                  await assertCurrent();
                  const managedEnvironment = managedOperatorEnvironmentRowsSchema.parse(rows);
                  record = (
                    await ownedUpdate((value) => {
                      const currentOperator = requireOperator(value);
                      const priorRows =
                        plan.appEnvironmentCleanup === undefined
                          ? (currentOperator.managedEnvironment ?? [])
                          : ownedAppEnvironmentRows(currentOperator);
                      if (
                        managedEnvironment.some(
                          (row) =>
                            row.operationRef !== operationRef &&
                            !priorRows.some((prior) => isDeepStrictEqual(prior, row)),
                        )
                      ) {
                        throw new HostedOperatorError("resource_mismatch");
                      }
                      if (plan.appEnvironmentCleanup !== undefined) {
                        if (
                          managedEnvironment.some(
                            (row) => !priorRows.some((prior) => isDeepStrictEqual(prior, row)),
                          )
                        ) {
                          throw new HostedOperatorError("resource_mismatch");
                        }
                        return {
                          ...value,
                          operator: checkpointOwnedAppEnvironmentCleanup(
                            currentOperator,
                            managedEnvironment,
                          ),
                        };
                      }
                      return {
                        ...value,
                        operator: checkpointActiveAppEnvironment(
                          currentOperator,
                          managedEnvironment,
                        ),
                      };
                    })
                  ).record;
                  effectInput.managedEnvironment =
                    plan.appEnvironmentCleanup === undefined
                      ? requireOperator(record).managedEnvironment
                      : ownedAppEnvironmentRows(requireOperator(record));
                },
                deliveryCandidates: requireOperator(record).deliveryCandidates,
                effect,
                fenceGeneration,
                gatewayDeliveryCandidates: requireOperator(record).gatewayDeliveryCandidates,
                gatewayEnvironmentRows: requireOperator(record).gatewayEnvironment,
                managedEnvironment:
                  plan.appEnvironmentCleanup === undefined
                    ? requireOperator(record).managedEnvironment
                    : ownedAppEnvironmentRows(requireOperator(record)),
                operationRef,
                plan,
                privateState: record.privateState,
                workerCheckpoints: (requireOperator(record).workerCheckpoints ?? []).filter(
                  (checkpoint) => checkpoint.parentEffectId === effect.id,
                ),
              };
              // Always inspect before first execution as well as uncertain retry. Provider timeouts cannot create new identities.
              const observed = await observePrepare("effect_reconciliation", async () => {
                const result = await deps.reconcile(effectInput);
                if (result.status === "unknown") {
                  throw new HostedOperatorError("reconciliation_required");
                }
                return result;
              });
              let receipt: OperatorReceipt;
              if (observed.status === "applied") {
                receipt = observed.receipt;
              } else {
                const workerAttemptId = randomUUID();
                await assertCurrent();
                record = (
                  await ownedUpdate((value) => ({
                    ...value,
                    operator: {
                      ...requireOperator(value),
                      pendingEffectAttempt: { id: workerAttemptId },
                      pendingEffectId: effect.id,
                    },
                    status: plan.action === "prepare" ? "pending" : "cleaning",
                  }))
                ).record;
                const executeInput: HostedOperatorWorkerEffectContext = {
                  ...effectInput,
                  bindWorkerContext: async (bindingInput) => {
                    const binding = workerContextBindingSchema.parse(bindingInput);
                    await assertCurrent();
                    record = (
                      await ownedUpdate((value) => {
                        const currentOperator = requireOperator(value);
                        const pendingAttempt = currentOperator.pendingEffectAttempt;
                        if (
                          currentOperator.fenceGeneration !== fenceGeneration ||
                          currentOperator.pendingEffectId !== effect.id ||
                          pendingAttempt?.id !== workerAttemptId ||
                          (pendingAttempt.contextDigest !== undefined &&
                            pendingAttempt.contextDigest !== binding.contextDigest)
                        ) {
                          throw new HostedOperatorError("reconciliation_required");
                        }
                        return {
                          ...value,
                          operator: {
                            ...currentOperator,
                            pendingEffectAttempt: {
                              contextDigest: binding.contextDigest,
                              id: workerAttemptId,
                            },
                          },
                        };
                      })
                    ).record;
                    return async (frameInput) => {
                      const frame = workerEffectCheckpointFrameSchema.parse(frameInput);
                      if (
                        frame.operationId !== operationRef ||
                        frame.fenceGeneration !== fenceGeneration ||
                        frame.contextDigest !== binding.contextDigest
                      ) {
                        throw new HostedOperatorError("resource_mismatch");
                      }
                      const checkpoint = workerEffectCheckpointSchema.parse({
                        attemptId: workerAttemptId,
                        contextDigest: frame.contextDigest,
                        effectId: frame.effectId,
                        fenceGeneration,
                        operationRef,
                        parentEffectId: effect.id,
                        receipt: frame.receipt,
                        resourceId: frame.resourceId,
                        sequence: frame.sequence,
                        tenantId: frame.tenantId ?? undefined,
                      });
                      const resourceIds = new Set([
                        plan.appDatabase.resourceId,
                        plan.authDatabase.resourceId,
                      ]);
                      const tenantIds = new Set(plan.access.map((target) => target.organizationId));
                      if (
                        !resourceIds.has(checkpoint.resourceId) ||
                        (effect.kind === "resources" &&
                          effect.resourceId !== undefined &&
                          (checkpoint.resourceId !== effect.resourceId ||
                            checkpoint.tenantId !== undefined ||
                            !["resources:roles", "resources:database", "resources:acl"].includes(
                              checkpoint.effectId,
                            ))) ||
                        (checkpoint.tenantId !== undefined && !tenantIds.has(checkpoint.tenantId))
                      ) {
                        throw new HostedOperatorError("resource_mismatch");
                      }
                      await assertCurrent();
                      record = (
                        await ownedUpdate((value) => {
                          const currentOperator = requireOperator(value);
                          const pendingAttempt = currentOperator.pendingEffectAttempt;
                          if (
                            currentOperator.fenceGeneration !== fenceGeneration ||
                            currentOperator.pendingEffectId !== effect.id ||
                            pendingAttempt?.id !== workerAttemptId ||
                            pendingAttempt.contextDigest !== binding.contextDigest
                          ) {
                            throw new HostedOperatorError("reconciliation_required");
                          }
                          const checkpoints = currentOperator.workerCheckpoints ?? [];
                          const previous = checkpoints.find(
                            (entry) =>
                              entry.attemptId === workerAttemptId &&
                              entry.parentEffectId === effect.id &&
                              entry.sequence === checkpoint.sequence,
                          );
                          if (previous !== undefined) {
                            if (JSON.stringify(previous) !== JSON.stringify(checkpoint)) {
                              throw new HostedOperatorError("reconciliation_required");
                            }
                            return value;
                          }
                          let lastSequence = 0;
                          for (const entry of checkpoints) {
                            if (
                              entry.attemptId === workerAttemptId &&
                              entry.parentEffectId === effect.id
                            ) {
                              lastSequence = Math.max(lastSequence, entry.sequence);
                            }
                          }
                          const expectedSequence = lastSequence + 1;
                          if (checkpoint.sequence !== expectedSequence) {
                            throw new HostedOperatorError("reconciliation_required");
                          }
                          return {
                            ...value,
                            operator: {
                              ...currentOperator,
                              workerCheckpoints: [...checkpoints, checkpoint],
                            },
                          };
                        })
                      ).record;
                    };
                  },
                  privateState: record.privateState,
                  workerAttemptId,
                };
                receipt = await deps.executeEffect(executeInput);
              }
              receipt = operatorReceiptSchema.parse(receipt);
              if (
                (effect.kind === "access" || effect.kind === "revoke") &&
                receipt.fenceGeneration !== fenceGeneration
              ) {
                throw new HostedOperatorError("reconciliation_required");
              }
              if (receipt.effectId !== effect.id) {
                throw new HostedOperatorError("resource_mismatch");
              }
              await assertCurrent();
              record = (
                await ownedUpdate((value) => {
                  const next = {
                    ...requireOperator(value),
                    receipts: [...requireOperator(value).receipts, receipt],
                  };
                  delete next.pendingEffectId;
                  delete next.pendingEffectAttempt;
                  return { ...value, operator: next };
                })
              ).record;
            }
            await assertCurrent();
            if (plan.stage === AUTH_PARTICIPANTS_STAGE) {
              const latest = await read();
              if (latest === undefined) {
                throw new HostedOperatorError("operation_in_progress");
              }
              record = latest.record;
              const preparation = record.accountPreparation;
              const program = plan.normalActorProgram;
              if (
                deps.verifyNormalActorAccounts === undefined ||
                preparation === undefined ||
                program === undefined
              ) {
                throw new HostedOperatorError("operator_unavailable");
              }
              const state = assertNormalActorState(
                program,
                await deps.verifyNormalActorAccounts({
                  ...context,
                  plan,
                  assertCurrent,
                  accountPreparation: preparation,
                  checkpointAccountPreparation,
                }),
                preparation.accountOperationRef,
              );
              if (
                state.actors.some(
                  (actor) =>
                    actor.signup !== "complete" ||
                    actor.session === undefined ||
                    actor.storageState === undefined,
                )
              ) {
                throw new HostedOperatorError("reconciliation_required");
              }
              await assertCurrent();
              const complete = await ownedUpdate((value) => ({
                ...value,
                environmentBound: false,
                status: PARTICIPANTS_PREPARED,
                step: "reserved",
              }));
              return response(operatorPublicResultSchema.parse(publicStatus(complete.record)));
            }
            if (plan.stage === AUTH_BOOTSTRAP_STAGE) {
              if (deps.verifyAuthReadiness === undefined) {
                throw new HostedOperatorError("operator_unavailable");
              }
              await assertCurrent();
              const authPreparation = operatorAuthSchemaPreparationSchema.parse(
                await deps.verifyAuthReadiness({
                  ...context,
                  assertCurrent,
                  plan,
                  privateState: record.privateState,
                }),
              );
              const matches = [
                authPreparation.targetDigest === plan.authSchema?.targetDigest,
                authPreparation.database === plan.authDatabase.database,
                authPreparation.runtimeRole === plan.authDatabase.runtimeRole,
              ].every(Boolean);
              if (!matches) {
                throw new HostedOperatorError("resource_mismatch");
              }
              await assertCurrent();
              const complete = await ownedUpdate((value) =>
                retainCompletedAuth({
                  ...value,
                  environmentBound: false,
                  operator: { ...requireOperator(value), authPreparation },
                  status: "pending",
                  step: "reserved",
                }),
              );
              return response(operatorPublicResultSchema.parse(publicStatus(complete.record)));
            }
            const proof =
              plan.action === "prepare"
                ? hostedRuntimeProofSchema.parse(
                    await deps.verify({ ...context, plan, privateState: record.privateState }),
                  )
                : undefined;
            if (
              proof &&
              (proof.releaseId !== plan.release.id || proof.manifestSha256 !== plan.release.sha256)
            ) {
              throw new HostedOperatorError("resource_mismatch");
            }
            await assertCurrent();
            const complete = await ownedUpdate((value) => {
              if (plan.action === "cleanup") {
                // Shared Auth remains live after app cleanup; retain its owned encrypted credentials.
                delete value.proof;
              }
              return retainCompletedAuth({
                ...value,
                environmentBound: plan.action === "prepare",
                proof,
                status: plan.action === "prepare" ? "prepared" : "cleaned",
                step: plan.action === "prepare" ? "bound" : "cleaned",
              });
            });
            return response(operatorPublicResultSchema.parse(publicStatus(complete.record)));
          },
        );
      } finally {
        await update((record) => {
          if (record.leaseId === leaseId) {
            delete record.leaseId;
            delete record.leaseExpiresAt;
          }
          return record;
        });
      }
    } catch (error) {
      return response(
        operatorPublicResultSchema.parse({
          appId,
          authenticatedBehavior: "unassessed",
          code: error instanceof HostedOperatorError ? error.code : "operator_unavailable",
          status: "blocked",
        }),
      );
    }
  };
};
