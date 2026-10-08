/* oxlint-disable eslint/no-await-in-loop, eslint/no-loop-func, sonarjs/no-nested-functions, eslint/complexity, sonarjs/expression-complexity, sonarjs/cognitive-complexity, unicorn/no-await-expression-member, eslint/prefer-destructuring -- Effects, fences and journal checkpoints are deliberately sequential inside one resource lease. */
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import type { BuilderProvisionAuthority } from "./journal";
import {
  hostedRuntimeTargetSchema,
  hostedRuntimeProofSchema,
  updateHostedRuntimeJournal,
} from "./hosted-runtime-journal";
import type {
  HostedRuntimeJournalRecord,
  HostedRuntimeJournalStore,
  HostedRuntimeTarget,
} from "./hosted-runtime-journal";
import {
  HostedOperatorError,
  managedOperatorEnvironmentRowsSchema,
  operatorAuthSchemaPreparationSchema,
  operatorDeploymentCandidatesSchema,
  hostedOperatorPlanSchema,
  operatorPlanDigest,
  operatorPublicResultSchema,
  operatorReceiptSchema,
  operatorAuthIdentityInputSchema,
  operatorRequestSchema,
  restrictedOperatorEnvironment,
  sameOperatorSelection,
  hostedOperatorRecordSchema,
  operatorOwnerContextSchema,
  workerContextBindingSchema,
  workerEffectCheckpointFrameSchema,
  workerEffectCheckpointSchema,
} from "./hosted-operator-contract";
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
const AUTH_BOOTSTRAP_STAGE = "auth-bootstrap";
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
  fenceGeneration: number;
  operationRef: string;
  plan: HostedOperatorPlan;
  privateState?: PrivateState;
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
  /**
   * Read-only owner-selected resource inventory and trusted generated artifact resolution. No
   * caller checkout or shell execution. The plan must include the independently verified public
   * Gateway origin for its exact Preview project and branch, never a request/model value or
   * private Sandbox origin.
   */
  plan: (context: Context & { action: "prepare" | "cleanup" }) => Promise<HostedOperatorPlan>;
  /** Re-read membership, owner connection and provider grants. No ambient Neon authority. */
  assertAuthorized: (context: Context & { plan: HostedOperatorPlan }) => Promise<void>;
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
  authIdentityInput?: (
    input: Context & { operationRef: string; plan: HostedOperatorPlan },
  ) => Promise<z.infer<typeof operatorAuthIdentityInputSchema>>;
  bindings: (
    input: Context & { plan: HostedOperatorPlan; privateState?: PrivateState },
  ) => Promise<Record<string, string>>;
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
  | z.infer<typeof operatorAuthIdentityInputSchema>
  | OperatorPublicResult
  | { code: "not_found" }
  | {
      environment: Record<string, string>;
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

const handlePlanOperation = async (
  deps: ProtectedHostedOperatorDependencies,
  context: Context,
  input: Extract<OperatorRequest, { action: "plan" }>,
  appId: string,
  now: () => number,
) => {
  const plan = hostedOperatorPlanSchema.parse(
    await deps.plan({ ...context, action: input.operation }),
  );
  if (
    plan.action !== input.operation ||
    !sameOperatorSelection(plan.selection, input.selection) ||
    !hasRequiredGatewayPlan(input.operation, plan)
  ) {
    throw new HostedOperatorError("resource_mismatch");
  }
  await deps.assertAuthorized({ ...context, plan });
  assertUnexpired(plan, now());
  const planDigest = operatorPlanDigest(plan);
  const operator = {
    mode: "protected-operator-v1" as const,
    operationRef: randomUUID(),
    plan,
    planDigest,
    receipts: [],
  };
  await deps.store.reserve({
    ...context,
    approvedByCallId: "operator:unapproved-plan",
    now: new Date(now()),
    operator,
  });
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
      if (
        record.leaseId !== undefined ||
        record.operator.pendingEffectId !== undefined ||
        record.operator.pendingEffectAttempt !== undefined ||
        (record.operator.receipts.length > 0 &&
          !["prepared", "cleaned"].includes(record.status) &&
          !authStageCompleted)
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
      // Same-resource release changes keep credentials; old proof never attests the new plan.
      const nextOperator: ReturnType<typeof requireOperator> = { ...operator };
      if (authStageCompleted) {
        nextOperator.authPreparation = record.operator.authPreparation;
      }
      nextOperator.deliveryCandidates = record.operator.deliveryCandidates;
      nextOperator.gatewayDeliveryCandidates = record.operator.gatewayDeliveryCandidates;
      nextOperator.deliveredGatewayDeploymentId = record.operator.deliveredGatewayDeploymentId;
      if (record.operator.gatewayEnvironment !== undefined) {
        nextOperator.gatewayEnvironment = record.operator.gatewayEnvironment;
      }
      if (record.operator.identityLink?.consumedAt !== undefined) {
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
      if (record.operator.managedEnvironment !== undefined) {
        nextOperator.managedEnvironment = record.operator.managedEnvironment;
      }
      const next = {
        ...record,
        approvedByCallId: "operator:unapproved-plan",
        environmentBound: false,
        operator: nextOperator,
        status: "pending" as const,
        step: "reserved" as const,
      };
      delete next.proof;
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
  await deps.assertAuthorized({ ...context, plan });
  const latest = await read();
  if (latest?.revision !== current.revision) {
    throw new HostedOperatorError("operation_in_progress");
  }
  return response({ environment, operationRef, plan, proof });
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
      appId = input.selection.appId;
      const authorized = await deps.authorize(request, input.selection, input.ownerContext);
      const context = normalizeOperatorContext(authorized);
      if (!sameOperatorSelection(selectionFor(context.target), input.selection)) {
        throw new HostedOperatorError("authorization_required");
      }
      const read = async () => await deps.store.read(context);
      const update = async (
        change: (record: HostedRuntimeJournalRecord) => HostedRuntimeJournalRecord,
      ) => await updateHostedRuntimeJournal({ ...context, now, store: deps.store, update: change });
      if (input.action === "plan") {
        return await handlePlanOperation(deps, context, input, appId, now);
      }
      const current = await read();
      const operator = current?.record.operator;
      if (
        !operator ||
        operator.operationRef !== input.operationRef ||
        operator.planDigest !== operatorPlanDigest(operator.plan)
      ) {
        throw new HostedOperatorError("resource_mismatch");
      }
      const { plan, planDigest, operationRef } = operator;
      await deps.assertAuthorized({ ...context, plan });
      const publicStatus = (record: HostedRuntimeJournalRecord): OperatorPublicResult => {
        let status: OperatorPublicResult["status"] = "pending";
        if (record.status === "prepared" || record.status === "cleaned") {
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
        if (plan.stage === AUTH_BOOTSTRAP_STAGE) {
          throw new HostedOperatorError("auth_identity_required");
        }
        return await handleBindingsOperation({
          context,
          current,
          deps,
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
      const assertApproval = async () => {
        assertUnexpired(plan, now());
        await deps.assertAuthorized({ ...context, plan });
        const approval = await deps.readApproval({
          ...context,
          action: plan.action,
          callId: input.callId,
          planDigest,
        });
        if (
          approval?.approved !== true ||
          approval.approvalId === "" ||
          approval.callId !== input.callId ||
          approval.planDigest !== planDigest ||
          approval.action !== plan.action
        ) {
          throw new HostedOperatorError("authorization_required");
        }
        return approval;
      };
      const approval = await assertApproval();
      const leaseId = randomUUID();
      let claimed = await update((record) => {
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
      });
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
            let { record } = claimed;
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
                assertCurrent,
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
                      if (
                        gatewayEnvironment.some(
                          (row) =>
                            row.operationRef !== operationRef &&
                            !priorRows.some(
                              (prior) => JSON.stringify(prior) === JSON.stringify(row),
                            ),
                        )
                      ) {
                        throw new HostedOperatorError("resource_mismatch");
                      }
                      return { ...value, operator: { ...currentOperator, gatewayEnvironment } };
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
                      const priorRows = currentOperator.managedEnvironment ?? [];
                      if (
                        managedEnvironment.some(
                          (row) =>
                            row.operationRef !== operationRef &&
                            !priorRows.some(
                              (prior) => JSON.stringify(prior) === JSON.stringify(row),
                            ),
                        )
                      ) {
                        throw new HostedOperatorError("resource_mismatch");
                      }
                      return { ...value, operator: { ...currentOperator, managedEnvironment } };
                    })
                  ).record;
                  effectInput.managedEnvironment = requireOperator(record).managedEnvironment;
                },
                deliveryCandidates: requireOperator(record).deliveryCandidates,
                effect,
                fenceGeneration,
                gatewayDeliveryCandidates: requireOperator(record).gatewayDeliveryCandidates,
                gatewayEnvironmentRows: requireOperator(record).gatewayEnvironment,
                managedEnvironment: requireOperator(record).managedEnvironment,
                operationRef,
                plan,
                privateState: record.privateState,
                workerCheckpoints: (requireOperator(record).workerCheckpoints ?? []).filter(
                  (checkpoint) => checkpoint.parentEffectId === effect.id,
                ),
              };
              // Always inspect before first execution as well as uncertain retry. Provider timeouts cannot create new identities.
              const observed = await deps.reconcile(effectInput);
              if (observed.status === "unknown") {
                throw new HostedOperatorError("reconciliation_required");
              }
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
              const complete = await ownedUpdate((value) => ({
                ...value,
                environmentBound: false,
                operator: { ...requireOperator(value), authPreparation },
                status: "pending",
                step: "reserved",
              }));
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
              return {
                ...value,
                environmentBound: plan.action === "prepare",
                proof,
                status: plan.action === "prepare" ? "prepared" : "cleaned",
                step: plan.action === "prepare" ? "bound" : "cleaned",
              };
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
