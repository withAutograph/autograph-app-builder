/* oxlint-disable eslint/no-await-in-loop, eslint/no-loop-func, sonarjs/no-nested-functions, eslint/complexity, sonarjs/expression-complexity, unicorn/no-await-expression-member, eslint/prefer-destructuring -- Effects, fences and journal checkpoints are deliberately sequential inside one resource lease. */
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
  hostedOperatorPlanSchema,
  operatorPlanDigest,
  operatorPublicResultSchema,
  operatorReceiptSchema,
  operatorRequestSchema,
  restrictedOperatorEnvironment,
  sameOperatorSelection,
  hostedOperatorRecordSchema,
} from "./hosted-operator-contract";
import type {
  HostedOperatorPlan,
  OperatorPublicResult,
  OperatorReceipt,
  OperatorSelection,
} from "./hosted-operator-contract";

interface Context {
  authority: BuilderProvisionAuthority;
  target: HostedRuntimeTarget;
}
type PrivateState = NonNullable<HostedRuntimeJournalRecord["privateState"]>;
type Effect = HostedOperatorPlan["effects"][number];
type EffectContext = Context & {
  effect: Effect;
  operationRef: string;
  plan: HostedOperatorPlan;
  privateState?: PrivateState;
  assertCurrent: () => Promise<void>;
  checkpoint: (state: PrivateState) => Promise<void>;
};
export interface ProtectedHostedOperatorDependencies {
  store: HostedRuntimeJournalStore;
  /** Verify caller signature/audience and independently resolve this session's owner and selected project. Never trust body owner IDs. */
  authorize: (request: Request, selection: OperatorSelection) => Promise<Context>;
  /** Read-only owner-selected resource inventory and trusted generated artifact resolution. No caller checkout or shell execution. */
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
    input: EffectContext,
  ) => Promise<{ status: "absent" | "unknown" } | { status: "applied"; receipt: OperatorReceipt }>;
  /** Pinned trusted installer + verified declarative artifact only. Guard immediately before every effect; checkpoint credentials before allocation. */
  executeEffect: (input: EffectContext) => Promise<OperatorReceipt>;
  /** Independently read installed identities/release/provider bindings, with no mutation. */
  verify: (
    input: Context & { plan: HostedOperatorPlan; privateState?: PrivateState },
  ) => Promise<z.infer<typeof hostedRuntimeProofSchema>>;
  /** Decrypt only inside this operator; return the strict runtime environment projection. */
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
const assertUnexpired = (plan: HostedOperatorPlan, now: number) => {
  if (plan.action === "prepare" && Date.parse(plan.retention.expiresAt) <= now) {
    throw new HostedOperatorError("authorization_required");
  }
};
const requireOperator = (record: HostedRuntimeJournalRecord) =>
  hostedOperatorRecordSchema.parse(record.operator);
type OperatorHttpResponse =
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
      const authorized = await deps.authorize(request, input.selection);
      const context = {
        authority: hostedTenantAuthoritySchema.parse(authorized.authority),
        target: hostedRuntimeTargetSchema.parse(authorized.target),
      };
      if (!sameOperatorSelection(selectionFor(context.target), input.selection)) {
        throw new HostedOperatorError("authorization_required");
      }
      const read = async () => await deps.store.read(context);
      const update = async (
        change: (record: HostedRuntimeJournalRecord) => HostedRuntimeJournalRecord,
      ) => await updateHostedRuntimeJournal({ ...context, now, store: deps.store, update: change });
      if (input.action === "plan") {
        const plan = hostedOperatorPlanSchema.parse(
          await deps.plan({ ...context, action: input.operation }),
        );
        if (
          plan.action !== input.operation ||
          !sameOperatorSelection(plan.selection, input.selection)
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
        const row = await update((record) => {
          if (!record.operator) {
            throw new HostedOperatorError("legacy_runtime_requires_migration");
          }
          if (record.operator.planDigest === planDigest) {
            return record;
          }
          if (
            record.leaseId !== undefined ||
            record.operator.pendingEffectId !== undefined ||
            (record.operator.receipts.length > 0 &&
              !["prepared", "cleaned"].includes(record.status))
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
          const next = {
            ...record,
            approvedByCallId: "operator:unapproved-plan",
            environmentBound: false,
            operator,
            status: "pending" as const,
            step: "reserved" as const,
          };
          delete next.proof;
          return next;
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
      const publicStatus = (record: HostedRuntimeJournalRecord): OperatorPublicResult => ({
        appId,
        authenticatedBehavior: "unassessed",
        operationRef,
        planDigest,
        status:
          record.status === "prepared" || record.status === "cleaned" ? record.status : "pending",
      });
      if (input.action === "status") {
        return response(operatorPublicResultSchema.parse(publicStatus(current.record)));
      }
      assertUnexpired(plan, now());
      if (input.action === "bindings") {
        if (
          current.record.leaseId !== undefined ||
          current.record.status !== "prepared" ||
          current.record.step !== "bound" ||
          operator.approvalId === undefined ||
          operator.pendingEffectId !== undefined
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
        if (proof.artifactHash !== plan.release.sha256 || proof.releaseId !== plan.release.id) {
          throw new HostedOperatorError("resource_mismatch");
        }
        const environment = restrictedOperatorEnvironment(
          plan,
          await deps.bindings({ ...context, plan, privateState: current.record.privateState }),
        );
        await deps.assertAuthorized({ ...context, plan });
        const latest = await read();
        if (latest?.revision !== current.revision) {
          throw new HostedOperatorError("operation_in_progress");
        }
        return response({ environment, operationRef, plan, proof });
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
      const claimed = await update((record) => {
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
              if (
                requireOperator(record).receipts.some((receipt) => receipt.effectId === effect.id)
              ) {
                continue;
              }
              const effectInput: EffectContext = {
                ...context,
                assertCurrent,
                checkpoint: async (privateState) => {
                  await assertCurrent();
                  record = (await ownedUpdate((value) => ({ ...value, privateState }))).record;
                },
                effect,
                operationRef,
                plan,
                privateState: record.privateState,
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
                await assertCurrent();
                record = (
                  await ownedUpdate((value) => ({
                    ...value,
                    operator: { ...requireOperator(value), pendingEffectId: effect.id },
                    status: plan.action === "prepare" ? "pending" : "cleaning",
                  }))
                ).record;
                receipt = await deps.executeEffect({
                  ...effectInput,
                  privateState: record.privateState,
                });
              }
              receipt = operatorReceiptSchema.parse(receipt);
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
                  return { ...value, operator: next };
                })
              ).record;
            }
            await assertCurrent();
            const proof =
              plan.action === "prepare"
                ? hostedRuntimeProofSchema.parse(
                    await deps.verify({ ...context, plan, privateState: record.privateState }),
                  )
                : undefined;
            if (
              proof &&
              (proof.releaseId !== plan.release.id || proof.artifactHash !== plan.release.sha256)
            ) {
              throw new HostedOperatorError("resource_mismatch");
            }
            await assertCurrent();
            const complete = await ownedUpdate((value) => {
              if (plan.action === "cleanup") {
                delete value.privateState;
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
