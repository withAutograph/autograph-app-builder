import { IntegrationProviderError } from "./app-integration-provider-diagnostic";
/* oxlint-disable sonarjs/cognitive-complexity -- Ordered durable reconciliation preserves separate pending, accepted and independently verified effect states. */
import { isDeepStrictEqual } from "node:util";
import {
  readIntegrationCapabilityEffect,
  appIntegrationCapabilityPlanSchema,
  appIntegrationCapabilityPlanDigest,
  appIntegrationCapabilityOperationRef,
  integrationCapabilityReceiptSchema,
  preparedAppIntegrationCapabilitySchema,
} from "./app-integration-capability-contract";
import type {
  AppIntegrationCapabilityPlan,
  AppIntegrationCapabilityRecord,
  PreparedAppIntegrationCapability,
  IntegrationCapabilityEffect,
  IntegrationCapabilityReceipt,
} from "./app-integration-capability-contract";
import type {
  AppIntegrationCapabilityStore,
  AppIntegrationCapabilityRow,
} from "./app-integration-capability-store";
import type {
  AppIntegrationCapabilityWorker,
  AppIntegrationCapabilityEffectContext,
} from "./app-integration-capability-ports";
import {
  assertIntegrationCapabilityReceipt,
  assertPreparedIntegrationCapability,
} from "./app-integration-capability-receipts";
import type { PublicReleaseInvocation } from "./public-release-handler";

export interface AppIntegrationCapabilityPorts {
  store: AppIntegrationCapabilityStore;
  worker: AppIntegrationCapabilityWorker;
  resolvePlan: (
    invocation: PublicReleaseInvocation,
    appId: string,
  ) => Promise<AppIntegrationCapabilityPlan>;
  assertAuthorized: (
    invocation: PublicReleaseInvocation,
    plan: AppIntegrationCapabilityPlan,
    approval: boolean,
  ) => Promise<void>;
  withTargetLease: <T>(
    invocation: PublicReleaseInvocation,
    plan: AppIntegrationCapabilityPlan,
    run: () => Promise<T>,
  ) => Promise<T>;
  /** Seal actual scoped configuration only after independent effect/registration readiness. No provider activation. */
  finalize: (
    invocation: PublicReleaseInvocation,
    plan: AppIntegrationCapabilityPlan,
    receipts: readonly IntegrationCapabilityReceipt[],
  ) => Promise<PreparedAppIntegrationCapability>;
}
const unavailable = () => new Error("app_integration_capability_unavailable");
interface IntegrationExecution {
  row: AppIntegrationCapabilityRow;
  ports: AppIntegrationCapabilityPorts;
  refresh: () => Promise<AppIntegrationCapabilityRow>;
  save: (
    row: AppIntegrationCapabilityRow,
    record: AppIntegrationCapabilityRecord,
  ) => Promise<AppIntegrationCapabilityRow>;
  assertCurrent: () => Promise<void>;
}
const processCapabilityEffect = async (
  execution: IntegrationExecution,
  invocation: PublicReleaseInvocation,
  plan: AppIntegrationCapabilityPlan,
  operationRef: string,
  planDigest: string,
  effect: IntegrationCapabilityEffect,
) => {
  // Effect order is the approved resource/schema/service/registration dependency order.
  // oxlint-disable-next-line eslint/no-await-in-loop
  await execution.refresh();
  if (readIntegrationCapabilityEffect(execution.row.record, effect).state === "applied")
    {return null;}
  const state = readIntegrationCapabilityEffect(execution.row.record, effect);
  const fenceGeneration = execution.row.record.executionLease?.fenceGeneration;
  if (fenceGeneration === undefined) {throw unavailable();}
  const assertCurrent = async () => {
    await execution.assertCurrent();
  };
  const context: AppIntegrationCapabilityEffectContext = {
    invocation,
    plan,
    operationRef,
    planDigest,
    effect,
    priorPhase: state.state === "pending" ? "pending" : "idle",
    fenceGeneration,
    attemptGeneration: state.state === "pending" ? state.attemptGeneration : fenceGeneration,
    assertCurrent,
    checkpoint: {
      read: async () => {
        await assertCurrent();
        const current = await execution.refresh();
        const value = readIntegrationCapabilityEffect(current.record, effect);
        return value.state === "idle" ? undefined : value.receipt;
      },
      recordAccepted: async (raw) => {
        const receipt = integrationCapabilityReceiptSchema.parse(raw);
        await assertCurrent();
        const current = await execution.refresh();
        const value = readIntegrationCapabilityEffect(current.record, effect);
        if (
          value.state !== "pending" ||
          receipt.effect !== effect ||
          (value.receipt !== undefined && !isDeepStrictEqual(value.receipt, receipt))
        )
          {throw unavailable();}
        assertIntegrationCapabilityReceipt(plan, receipt, value.attemptGeneration);
        execution.row = await execution.save(current, {
          ...current.record,
          effects: { ...current.record.effects, [effect]: { ...value, receipt } },
        });
      },
    },
  };
  // oxlint-disable-next-line eslint/no-await-in-loop
  const observed =
    state.state === "idle"
      ? { status: "not-applied" as const, proof: "effect-not-dispatched" as const }
      : await execution.ports.worker.reconcile(context);
  // oxlint-disable-next-line eslint/no-await-in-loop
  await assertCurrent();
  if (observed.status === "unknown")
    {return {
      status: "reconciliation-required" as const,
      operationRef,
      effect,
      ...(execution.row.record.providerDiagnostic === undefined
        ? {}
        : { diagnostic: execution.row.record.providerDiagnostic }),
    };}
  if (observed.status === "applied") {
    assertIntegrationCapabilityReceipt(
      plan,
      observed.receipt,
      state.state === "pending" ? state.attemptGeneration : undefined,
    );
    // oxlint-disable-next-line eslint/no-await-in-loop
    await execution.refresh();
    const current = readIntegrationCapabilityEffect(execution.row.record, effect);
    if (
      current.state !== "idle" &&
      current.receipt !== undefined &&
      !isDeepStrictEqual(current.receipt, observed.receipt)
    )
      {throw unavailable();}
    // oxlint-disable-next-line eslint/no-await-in-loop
    execution.row = await execution.save(execution.row, {
      ...execution.row.record,
      effects: {
        ...execution.row.record.effects,
        [effect]: {
          state: "applied",
          retiredAttempts: current.retiredAttempts,
          ...(current.state === "pending" ? { attemptGeneration: current.attemptGeneration } : {}),
          receipt: observed.receipt,
        },
      },
    });
    return null;
  }
  if (
    observed.proof !== "authoritative-effect-not-applied" &&
    !(state.state === "idle" && observed.proof === "effect-not-dispatched")
  )
    {throw unavailable();}
  // An authoritative effect-specific nonapplication proof is retained before any new attempt.
  const history =
    state.state === "pending"
      ? [
          ...state.retiredAttempts,
          {
            attemptGeneration: state.attemptGeneration,
            proof: "authoritative-effect-not-applied" as const,
          },
        ]
      : state.retiredAttempts;
  if (state.state === "pending" && state.receipt !== undefined) {throw unavailable();}
  // oxlint-disable-next-line eslint/no-await-in-loop
  await execution.refresh();
  // oxlint-disable-next-line eslint/no-await-in-loop
  execution.row = await execution.save(execution.row, {
    ...execution.row.record,
    effects: {
      ...execution.row.record.effects,
      [effect]: {
        state: "pending",
        attemptGeneration: fenceGeneration,
        retiredAttempts: history,
      },
    },
  });
  const dispatch = {
    ...context,
    priorPhase: "idle" as const,
    attemptGeneration: fenceGeneration,
  };
  // oxlint-disable-next-line eslint/no-await-in-loop
  await assertCurrent();
  // oxlint-disable-next-line eslint/no-await-in-loop
  let accepted: IntegrationCapabilityReceipt;
  try {
    accepted = await execution.ports.worker.execute(dispatch);
  } catch (error) {
    if (!(error instanceof IntegrationProviderError)) {
      throw error;
    }
    await assertCurrent();
    await execution.refresh();
    execution.row = await execution.save(execution.row, {
      ...execution.row.record,
      providerDiagnostic: error.diagnostic,
    });
    return {
      status: "reconciliation-required" as const,
      operationRef,
      effect,
      diagnostic: error.diagnostic,
    };
  }
  // oxlint-disable-next-line eslint/no-await-in-loop
  await context.checkpoint.recordAccepted(accepted);
  // oxlint-disable-next-line eslint/no-await-in-loop
  const verified = await execution.ports.worker.reconcile({ ...dispatch, priorPhase: "pending" });
  // oxlint-disable-next-line eslint/no-await-in-loop
  await assertCurrent();
  if (verified.status !== "applied" || !isDeepStrictEqual(verified.receipt, accepted))
    {return { status: "reconciliation-required" as const, operationRef, effect };}
  // oxlint-disable-next-line eslint/no-await-in-loop
  await execution.refresh();
  const acceptedState = readIntegrationCapabilityEffect(execution.row.record, effect);
  if (acceptedState.state !== "pending") {throw unavailable();}
  // oxlint-disable-next-line eslint/no-await-in-loop
  execution.row = await execution.save(execution.row, {
    ...execution.row.record,
    effects: {
      ...execution.row.record.effects,
      [effect]: { ...acceptedState, state: "applied", receipt: verified.receipt },
    },
  });
  return null;
};
export const createAppIntegrationCapabilityHandler = (ports: AppIntegrationCapabilityPorts) => {
  const authorize = async (
    invocation: PublicReleaseInvocation,
    plan: AppIntegrationCapabilityPlan,
    approval: boolean,
  ) => {
    invocation.signal.throwIfAborted();
    if (
      !isDeepStrictEqual(invocation.authority, plan.authority) ||
      invocation.sessionId !== plan.selection.sessionId
    )
      {throw unavailable();}
    await ports.assertAuthorized(invocation, plan, approval);
    invocation.signal.throwIfAborted();
  };
  const save = async (row: AppIntegrationCapabilityRow, record: AppIntegrationCapabilityRecord) => {
    const updated = await ports.store.compareAndSet(row, record);
    if (updated === undefined) {throw unavailable();}
    return updated;
  };
  return {
    plan: async (invocation: PublicReleaseInvocation, appId: string) => {
      const plan = appIntegrationCapabilityPlanSchema.parse(
        await ports.resolvePlan(invocation, appId),
      );
      if (plan.selection.appId !== appId) {throw unavailable();}
      await authorize(invocation, plan, false);
      const row = await ports.store.reserve(plan);
      await authorize(invocation, row.record.plan, false);
      return {
        operationRef: row.operationRef,
        planDigest: row.record.planDigest,
        plan: row.record.plan,
      };
    },
    prepare: async (
      invocation: PublicReleaseInvocation,
      operationRef: string,
      planDigest: string,
    ) => {
      const initial = await ports.store.read(invocation.authority, operationRef);
      if (
        initial === undefined ||
        initial.record.planDigest !== planDigest ||
        appIntegrationCapabilityOperationRef(initial.record.plan) !== operationRef ||
        appIntegrationCapabilityPlanDigest(initial.record.plan) !== planDigest
      )
        {throw unavailable();}
      let row: AppIntegrationCapabilityRow = initial;
      const plan = row.record.plan;
      await authorize(invocation, plan, true);
      return await ports.withTargetLease(invocation, plan, async () => {
        const refresh = async () => {
          const observed = await ports.store.read(invocation.authority, operationRef);
          if (observed === undefined || !isDeepStrictEqual(observed.record.plan, plan))
            {throw unavailable();}
          row = observed;
          return observed;
        };
        await refresh();
        await authorize(invocation, plan, true);
        const execution: IntegrationExecution = {
          row,
          ports,
          refresh: async () => {
            const current = await refresh();
            execution.row = current;
            return current;
          },
          save,
          assertCurrent: async () => {
            await authorize(invocation, plan, true);
          },
        };
        for (const effect of plan.effects) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- Approved effects have ordered resource/schema/authority dependencies.
          const pending = await processCapabilityEffect(
            execution,
            invocation,
            plan,
            operationRef,
            planDigest,
            effect,
          );
          if (pending !== null) {
            return pending;
          }
        }
        row = execution.row;
        await authorize(invocation, plan, true);
        const receipts = plan.effects.map((effect) => {
          const value = readIntegrationCapabilityEffect(row.record, effect);
          if (value.state !== "applied") {throw unavailable();}
          return value.receipt;
        });
        const capability = preparedAppIntegrationCapabilitySchema.parse(
          await ports.finalize(invocation, plan, receipts),
        );
        assertPreparedIntegrationCapability(plan, capability, receipts);
        await authorize(invocation, plan, true);
        await refresh();
        row = await save(row, { ...row.record, prepared: capability });
        return {
          status: "prepared" as const,
          operationRef,
          capability,
          providerActivation: "unassessed" as const,
          hostedAcceptance: "unassessed" as const,
        };
      });
    },
  };
};
