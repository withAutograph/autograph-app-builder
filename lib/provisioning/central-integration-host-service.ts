/* oxlint-disable eslint/no-await-in-loop, react-doctor/async-await-in-loop, eslint/no-loop-func, sonarjs/no-nested-functions -- Approved effects and consent rechecks are strictly ordered under one physical lease. */
import { builderAppIdSchema } from "./names";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  centralHostPlanDigest,
  centralHostOperationRef,
  centralHostReadyReceiptSchema,
} from "./central-integration-host-contract";
import type {
  CentralHostSetupPlan,
  CentralHostCallerPlan,
  CentralIntegrationHostReadyReceipt,
} from "./central-integration-host-contract";
import { centralHostRecordSchema } from "./central-integration-host-store";
import type {
  CentralHostRow,
  CentralHostRecord,
  createPostgresCentralHostStore,
} from "./central-integration-host-store";
import {
  centralEffectReceiptSchema,
  centralEffectReceiptMatches,
  centralExecutionLeaseSchema,
} from "./central-integration-host-checkpoint";
import type {
  CentralEffectReceipt,
  CentralEffectAttempt,
  CentralRuntimeBinding,
} from "./central-integration-host-checkpoint";
import type { PublicReleaseInvocation } from "./public-release-handler";

type Plan = CentralHostSetupPlan | CentralHostCallerPlan;
const centralHostStateChanged = "central_host_state_changed";
const centralIntegrationHostSetupKind = "central-integration-host-setup-v1";
export const centralHostSelectionSchema = z.strictObject({
  operationRef: z.uuid(),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const centralHostPlanRequestSchema = z.strictObject({
  appId: builderAppIdSchema,
  kind: z.enum(["setup", "caller"]),
});
export interface CentralApprovalReceipt {
  approvalId?: string;
  approvedByCallId: string;
  approvedAt: string;
}
export interface CentralHostLease {
  leaseId: string;
  fenceGeneration: number;
  assertCurrent: () => Promise<void>;
}
export interface CentralHostEffectContext {
  invocation: PublicReleaseInvocation;
  plan: Plan;
  operationRef: string;
  planDigest: string;
  effect: Plan["effects"][number];
  priorPhase: "idle" | "pending";
  fenceGeneration: number;
  attemptGeneration: number;
  assertCurrent: () => Promise<void>;
  checkpoint: {
    read: () => Promise<CentralEffectAttempt>;
    recordGrantAttempt: (attempt: { beforeSha256: string; afterSha256: string }) => Promise<void>;
    recordAccepted: (receipt: CentralEffectReceipt) => Promise<void>;
  };
  bindings: {
    read: () => Promise<Record<string, CentralRuntimeBinding>>;
    claim: (key: string) => Promise<void>;
    recordAccepted: (key: string, id: string) => Promise<void>;
    recordVerified: (key: string) => Promise<void>;
  };
}
export interface CentralHostServicePorts {
  store: Pick<
    ReturnType<typeof createPostgresCentralHostStore>,
    "read" | "reserve" | "compareAndSet"
  >;
  resolvePlan: (
    invocation: PublicReleaseInvocation,
    request: z.infer<typeof centralHostPlanRequestSchema>,
  ) => Promise<Plan>;
  /** Read-only canonical grant reuse; the native port proves current app/session against original retained approval. */
  resolveReady?: (
    invocation: PublicReleaseInvocation,
    request: z.infer<typeof centralHostPlanRequestSchema>,
  ) => Promise<CentralIntegrationHostReadyReceipt | undefined>;
  assertAuthorized: (invocation: PublicReleaseInvocation, plan: Plan) => Promise<void>;
  /** Complete ordinary native consent including cancellation; every retained call is independently re-read. */
  readApproval: (
    invocation: PublicReleaseInvocation,
    plan: Plan,
    callId: string,
  ) => Promise<CentralApprovalReceipt>;
  withTargetLease: <T>(
    invocation: PublicReleaseInvocation,
    plan: Plan,
    run: (lease: CentralHostLease) => Promise<T>,
  ) => Promise<T>;
  applyEffect: (context: CentralHostEffectContext) => Promise<void>;
  /** Pending is read-only. Absence and transport errors cannot authorize another mutation. */
  reconcileEffect: (
    context: CentralHostEffectContext,
  ) => Promise<{ status: "applied"; receipt: CentralEffectReceipt } | { status: "unknown" }>;
  observeSetup: (invocation: PublicReleaseInvocation, row: CentralHostRow) => Promise<boolean>;
  observeCaller: (
    invocation: PublicReleaseInvocation,
    row: CentralHostRow,
  ) => Promise<CentralIntegrationHostReadyReceipt | undefined>;
}
const fail = () => new Error("central_host_service_unavailable");
const unknown = () => new Error("central_host_effect_outcome_unknown");
export const createCentralHostService = (ports: CentralHostServicePorts) => {
  const authorize = async (invocation: PublicReleaseInvocation, plan: Plan) => {
    invocation.signal.throwIfAborted();
    if (
      !isDeepStrictEqual(invocation.authority, plan.authority) ||
      invocation.sessionId !== plan.selection.sessionId
    ) {
      throw fail();
    }
    await ports.assertAuthorized(invocation, plan);
    invocation.signal.throwIfAborted();
  };
  const load = async (
    invocation: PublicReleaseInvocation,
    raw: z.infer<typeof centralHostSelectionSchema>,
  ) => {
    const selected = centralHostSelectionSchema.parse(raw);
    const row = await ports.store.read(invocation.authority, selected.operationRef);
    if (
      row === undefined ||
      row.record.planDigest !== selected.planDigest ||
      centralHostOperationRef(row.record.plan) !== selected.operationRef
    ) {
      throw fail();
    }
    await authorize(invocation, row.record.plan);
    return row;
  };
  const historical = async (invocation: PublicReleaseInvocation, row: CentralHostRow) => {
    await authorize(invocation, row.record.plan);
    for (const receipt of row.record.approvalReceipts ?? []) {
      const actual = await ports.readApproval(
        invocation,
        row.record.plan,
        receipt.approvedByCallId,
      );
      if (!isDeepStrictEqual(actual, receipt)) {
        throw fail();
      }
      await authorize(invocation, row.record.plan);
    }
  };
  const save = async (
    invocation: PublicReleaseInvocation,
    row: CentralHostRow,
    record: CentralHostRecord,
  ) => {
    await authorize(invocation, row.record.plan);
    const next = await ports.store.compareAndSet(row, centralHostRecordSchema.parse(record));
    await authorize(invocation, row.record.plan);
    if (next === undefined) {
      throw new Error(centralHostStateChanged);
    }
    return next;
  };
  const observe = async (invocation: PublicReleaseInvocation, row: CentralHostRow) => {
    await historical(invocation, row);
    if (Object.values(row.record.effects).some((phase) => phase !== "applied")) {
      return {
        operationRef: row.operationRef,
        planDigest: row.record.planDigest,
        status: "pending" as const,
      };
    }
    if ((row.record.approvalReceipts?.length ?? 0) === 0) {
      throw fail();
    }
    if (row.record.plan.kind === centralIntegrationHostSetupKind) {
      const native = row.record.nativeDeployment;
      if (native?.status === "conflict") {
        throw new Error("central_host_native_deployment_conflict");
      }
      if (native?.status !== "accepted") {
        return {
          operationRef: row.operationRef,
          planDigest: row.record.planDigest,
          status: "waiting-native-deployment" as const,
        };
      }
      const ready = await ports.observeSetup(invocation, row);
      await historical(invocation, row);
      return {
        operationRef: row.operationRef,
        planDigest: row.record.planDigest,
        status: ready ? ("ready" as const) : ("pending" as const),
      };
    }
    const observation = await ports.observeCaller(invocation, row);
    await historical(invocation, row);
    if (observation === undefined) {
      return {
        operationRef: row.operationRef,
        planDigest: row.record.planDigest,
        status: "pending" as const,
      };
    }
    const receipt = centralHostReadyReceiptSchema.parse(observation);
    if (
      row.record.observation !== undefined &&
      !isDeepStrictEqual(row.record.observation, receipt)
    ) {
      throw fail();
    }
    const next =
      row.record.observation === undefined
        ? await save(invocation, row, { ...row.record, observation: receipt })
        : row;
    return {
      operationRef: next.operationRef,
      planDigest: next.record.planDigest,
      receipt,
      status: "ready" as const,
    };
  };
  return {
    async plan(
      invocation: PublicReleaseInvocation,
      raw: z.infer<typeof centralHostPlanRequestSchema>,
    ) {
      const request = centralHostPlanRequestSchema.parse(raw);
      if (request.kind === "caller" && ports.resolveReady !== undefined) {
        const receipt = await ports.resolveReady(invocation, request);
        if (receipt !== undefined) {
          const ready = centralHostReadyReceiptSchema.parse(receipt);
          if (!isDeepStrictEqual(ready.authority, invocation.authority)) {
            throw fail();
          }
          invocation.signal.throwIfAborted();
          return { receipt: ready, status: "ready" as const, ...ready.callerSetup };
        }
      }
      const plan = await ports.resolvePlan(invocation, request);
      await authorize(invocation, plan);
      if (
        (request.kind === "setup") !== (plan.kind === centralIntegrationHostSetupKind) ||
        request.appId !== plan.selection.initiatingAppId
      ) {
        throw fail();
      }
      const row = await ports.store.reserve(plan);
      await authorize(invocation, plan);
      return {
        operationRef: row.operationRef,
        plan: row.record.plan,
        planDigest: centralHostPlanDigest(plan),
      };
    },
    async prepare(
      invocation: PublicReleaseInvocation,
      selection: z.infer<typeof centralHostSelectionSchema>,
    ) {
      const initial = await load(invocation, selection);
      await historical(invocation, initial);
      const approval = await ports.readApproval(invocation, initial.record.plan, invocation.callId);
      if (approval.approvedByCallId !== invocation.callId) {
        throw fail();
      }
      await authorize(invocation, initial.record.plan);
      return await ports.withTargetLease(invocation, initial.record.plan, async (lease) => {
        const checkedLease = centralExecutionLeaseSchema.parse({
          fenceGeneration: lease.fenceGeneration,
          leaseId: lease.leaseId,
        });
        await lease.assertCurrent();
        let row = await load(invocation, selection);
        await historical(invocation, row);
        const approvals = row.record.approvalReceipts ?? [];
        if (
          approvals.some(
            (receipt) =>
              receipt.approvedByCallId === approval.approvedByCallId &&
              !isDeepStrictEqual(receipt, approval),
          )
        ) {
          throw fail();
        }
        row = await save(invocation, row, {
          ...row.record,
          approvalReceipts: approvals.some((receipt) => isDeepStrictEqual(receipt, approval))
            ? approvals
            : [...approvals, approval],
          executionLease: checkedLease,
        });
        const refresh = async () => {
          row = await load(invocation, selection);
          await lease.assertCurrent();
          await historical(invocation, row);
          return row;
        };
        const assertCurrent = async () => {
          await refresh();
          if (!isDeepStrictEqual(row.record.executionLease, checkedLease)) {
            throw fail();
          }
        };
        const effectOrder: readonly CentralHostEffectContext["effect"][] = row.record.plan.effects;
        for (const effect of effectOrder) {
          await assertCurrent();
          if (row.record.effects[effect] === "applied") {
            continue;
          }
          const priorPhase = row.record.effects[effect];
          if (priorPhase !== "idle" && priorPhase !== "pending") {
            throw fail();
          }
          if (priorPhase === "idle") {
            if (
              row.record.plan.effects
                .slice(0, effectOrder.indexOf(effect))
                .some((key) => row.record.effects[key] !== "applied")
            ) {
              throw fail();
            }
            row = await save(invocation, row, {
              ...row.record,
              attempts: {
                ...row.record.attempts,
                [effect]: {
                  attemptGeneration: checkedLease.fenceGeneration,
                  attemptId: randomUUID(),
                },
              },
              effects: { ...row.record.effects, [effect]: "pending" },
            });
          }
          const attempt = row.record.attempts?.[effect];
          if (attempt === undefined) {
            throw unknown();
          }
          const updateAttempt = async (patch: Partial<CentralEffectAttempt>) => {
            await assertCurrent();
            const current = row.record.attempts?.[effect];
            if (current === undefined) {
              throw fail();
            }
            row = await save(invocation, row, {
              ...row.record,
              attempts: { ...row.record.attempts, [effect]: { ...current, ...patch } },
            });
          };
          const bindingState = async (key: string) => {
            await assertCurrent();
            if (
              row.record.plan.kind !== centralIntegrationHostSetupKind ||
              !row.record.plan.environment.some((entry) => entry.key === key) ||
              effect !== "bind-central-preview-runtime"
            ) {
              throw fail();
            }
            return row.record.runtimeBindings?.[key] ?? { state: "idle" as const };
          };
          const setBinding = async (key: string, binding: CentralRuntimeBinding) => {
            await bindingState(key);
            row = await save(invocation, row, {
              ...row.record,
              runtimeBindings: { ...row.record.runtimeBindings, [key]: binding },
            });
          };
          const context: CentralHostEffectContext = {
            assertCurrent,
            attemptGeneration: attempt.attemptGeneration,
            bindings: {
              claim: async (key) => {
                const state = await bindingState(key);
                if (state.state !== "idle") {
                  throw unknown();
                }
                await setBinding(key, {
                  attemptGeneration: checkedLease.fenceGeneration,
                  state: "pending",
                });
              },
              read: async () => {
                await assertCurrent();
                return row.record.plan.kind === centralIntegrationHostSetupKind
                  ? Object.fromEntries(
                      row.record.plan.environment.map((entry) => [
                        entry.key,
                        row.record.runtimeBindings?.[entry.key] ?? { state: "idle" as const },
                      ]),
                    )
                  : {};
              },
              recordAccepted: async (key, id) => {
                const state = await bindingState(key);
                if (state.state !== "pending") {
                  throw fail();
                }
                await setBinding(key, { ...state, acceptedEnvId: id });
              },
              recordVerified: async (key) => {
                const state = await bindingState(key);
                if (state.state === "idle" || state.acceptedEnvId === undefined) {
                  throw fail();
                }
                await setBinding(key, {
                  acceptedEnvId: state.acceptedEnvId,
                  attemptGeneration: state.attemptGeneration,
                  state: "applied",
                });
              },
            },
            checkpoint: {
              read: async () => {
                await assertCurrent();
                const value = row.record.attempts?.[effect];
                if (value === undefined) {
                  throw fail();
                }
                return value;
              },
              recordAccepted: async (raw) => {
                const receipt = centralEffectReceiptSchema.parse(raw);
                if (
                  receipt.effect !== effect ||
                  !centralEffectReceiptMatches(row.record.plan, receipt, attempt.attemptGeneration)
                ) {
                  throw fail();
                }
                await updateAttempt({ receipt });
              },
              recordGrantAttempt: async (value) => {
                await updateAttempt({ grantAttempt: value });
              },
            },
            effect,
            fenceGeneration: checkedLease.fenceGeneration,
            invocation,
            operationRef: row.operationRef,
            plan: row.record.plan,
            planDigest: row.record.planDigest,
            priorPhase,
          };
          if (priorPhase === "idle") {
            await ports.applyEffect(context);
            await assertCurrent();
          }
          const observed = await ports.reconcileEffect({ ...context, priorPhase: "pending" });
          await assertCurrent();
          if (observed.status !== "applied") {
            throw unknown();
          }
          await context.checkpoint.recordAccepted(observed.receipt);
          await assertCurrent();
          row = await save(invocation, row, {
            ...row.record,
            effects: { ...row.record.effects, [effect]: "applied" },
          });
        }
        await assertCurrent();
        return await observe(invocation, row);
      });
    },
    async read(
      invocation: PublicReleaseInvocation,
      selection: z.infer<typeof centralHostSelectionSchema>,
    ) {
      return await observe(invocation, await load(invocation, selection));
    },
  };
};
