/* oxlint-disable eslint/no-await-in-loop, eslint/no-loop-func, sonarjs/no-nested-functions -- Runtime binding, readback, consent checks and source publication must execute sequentially under one target lease. */
import { isDeepStrictEqual } from "node:util";
import {
  publicReleasePlanSchema,
  publicReleasePlanDigest,
  publicReleaseOperationRef,
  publicReleaseSelectionSchema,
  publicReleaseObservationSchema,
  publicReleaseRecordSchema,
  publicReleaseEffects,
} from "./public-release-contract";
import type {
  PublicReleasePlan,
  PublicReleaseAuthority,
  PublicReleaseEffect,
  PublicReleaseRecord,
  PublicReleaseObservation,
  PublicReleaseBindingState,
} from "./public-release-contract";

export interface PublicReleaseInvocation {
  authority: PublicReleaseAuthority;
  sessionId: string;
  callId: string;
  signal: AbortSignal;
}
export interface PublicReleaseRow {
  operationRef: string;
  revision: number;
  record: PublicReleaseRecord;
}
export interface PublicReleaseStore {
  read: (
    authority: PublicReleaseAuthority,
    operationRef: string,
  ) => Promise<PublicReleaseRow | undefined>;
  reserve: (plan: PublicReleasePlan) => Promise<PublicReleaseRow>;
  compareAndSet: (
    row: PublicReleaseRow,
    record: PublicReleaseRecord,
  ) => Promise<PublicReleaseRow | undefined>;
}
export interface PublicReleaseEffectContext {
  invocation: PublicReleaseInvocation;
  plan: PublicReleasePlan;
  operationRef: string;
  effect: PublicReleaseEffect;
  priorPhase: "idle" | "pending" | "applied";
  bindings: {
    read: () => Promise<Record<string, PublicReleaseBindingState>>;
    claim: (key: string) => Promise<PublicReleaseBindingState>;
    recordAccepted: (key: string, id: string) => Promise<void>;
    recordVerified: (key: string) => Promise<void>;
  };
}
/** Trusted server adapters only. Runtime configuration refs never contain credentials. */
export interface PublicReleasePorts {
  store: PublicReleaseStore;
  /** Read current session, owned standard provision receipt, reviewed publication and ready synthetic runtime. */
  resolve: (invocation: PublicReleaseInvocation, appId: string) => Promise<PublicReleasePlan>;
  /** Recheck current owner, provider authority and exact immutable plan, including existing-app assignment. */
  assertAuthorized: (invocation: PublicReleaseInvocation, plan: PublicReleasePlan) => Promise<void>;
  /** Independently read complete durable consent for THIS call/plan and both named effects. */
  assertApproved: (invocation: PublicReleaseInvocation, plan: PublicReleasePlan) => Promise<void>;
  /** Reuse the existing durable physical-resource lease for this exact project/environment. */
  withTargetLease: <T>(
    invocation: PublicReleaseInvocation,
    plan: PublicReleasePlan,
    run: () => Promise<T>,
  ) => Promise<T>;
  /** Unknown never permits another dispatch. not-applied requires effect-specific authoritative evidence. */
  reconcileEffect: (
    context: PublicReleaseEffectContext,
  ) => Promise<"applied" | "not-applied" | "unknown">;
  /** Runtime binding then normal approved Git publication; never deployment POST, promotion or aliases. */
  applyEffect: (context: PublicReleaseEffectContext) => Promise<void>;
  /** Read the provider's active Production domain/deployment binding; no listing/time/SHA election. */
  observe: (
    invocation: PublicReleaseInvocation,
    plan: PublicReleasePlan,
  ) => Promise<PublicReleaseObservation>;
}
const unavailable = () => new Error("public_release_unavailable");
const assertCaller = (invocation: PublicReleaseInvocation, plan: PublicReleasePlan) => {
  invocation.signal.throwIfAborted();
  if (
    !isDeepStrictEqual(invocation.authority, plan.authority) ||
    invocation.sessionId !== plan.selection.sessionId
  ) {
    throw unavailable();
  }
};
export const createPublicReleaseHandler = (ports: PublicReleasePorts) => {
  const authorize = async (
    invocation: PublicReleaseInvocation,
    plan: PublicReleasePlan,
    approval: boolean,
  ) => {
    assertCaller(invocation, plan);
    await ports.assertAuthorized(invocation, plan);
    if (approval) {
      await ports.assertApproved(invocation, plan);
    }
    invocation.signal.throwIfAborted();
  };
  const checkpoint = async (row: PublicReleaseRow, record: PublicReleaseRecord) => {
    const next = await ports.store.compareAndSet(row, publicReleaseRecordSchema.parse(record));
    if (!next) {
      throw new Error("public_release_conflict");
    }
    return next;
  };
  return {
    async plan(invocation: PublicReleaseInvocation, appId: string) {
      const selection = publicReleaseSelectionSchema.parse({
        appId,
        sessionId: invocation.sessionId,
      });
      invocation.signal.throwIfAborted();
      const plan = publicReleasePlanSchema.parse(await ports.resolve(invocation, selection.appId));
      await authorize(invocation, plan, false);
      if (plan.selection.appId !== selection.appId) {
        throw unavailable();
      }
      const row = await ports.store.reserve(plan);
      if (row.record.planDigest !== publicReleasePlanDigest(plan)) {
        throw unavailable();
      }
      return { operationRef: row.operationRef, planDigest: row.record.planDigest, plan };
    },
    async release(invocation: PublicReleaseInvocation, operationRef: string, planDigest: string) {
      invocation.signal.throwIfAborted();
      const initial = await ports.store.read(invocation.authority, operationRef);
      if (!initial || initial.record.planDigest !== planDigest) {
        throw unavailable();
      }
      const plan = publicReleasePlanSchema.parse(initial.record.plan);
      if (
        publicReleasePlanDigest(plan) !== planDigest ||
        publicReleaseOperationRef(plan) !== operationRef
      ) {
        throw unavailable();
      }
      await authorize(invocation, plan, true);
      return await ports.withTargetLease(invocation, plan, async () => {
        let row = await ports.store.read(invocation.authority, operationRef);
        if (!row || row.record.planDigest !== planDigest) {
          throw unavailable();
        }
        for (const effect of publicReleaseEffects) {
          await authorize(invocation, plan, true);
          if (row.record.effects[effect] === "applied") {
            continue;
          }
          const refresh = async () => {
            const latest = await ports.store.read(invocation.authority, operationRef);
            if (!latest || latest.record.planDigest !== planDigest) {
              throw unavailable();
            }
            row = latest;
            return latest;
          };
          const binding = async (key: string) => {
            await authorize(invocation, plan, true);
            if (effect !== "bind-production-runtime") {
              throw unavailable();
            }
            const current = await refresh();
            const expected = plan.environment.find((entry) => entry.key === key);
            const state = current.record.bindings[key];
            if (expected === undefined || state === undefined) {
              throw unavailable();
            }
            return { current, expected, state };
          };
          const saveBinding = async (key: string, state: PublicReleaseBindingState) => {
            const { current } = await binding(key);
            row = await checkpoint(current, {
              ...current.record,
              bindings: { ...current.record.bindings, [key]: state },
            });
          };
          const context: PublicReleaseEffectContext = {
            invocation,
            plan,
            operationRef,
            effect,
            priorPhase: row.record.effects[effect],
            bindings: {
              read: async () => {
                await authorize(invocation, plan, true);
                const current = await refresh();
                return structuredClone(current.record.bindings);
              },
              claim: async (key) => {
                const { state, expected } = await binding(key);
                if (state.state !== "idle") {
                  return state;
                }
                const next: PublicReleaseBindingState = {
                  state: "pending",
                  ...(expected.priorBinding === undefined
                    ? {}
                    : { acceptedEnvId: expected.priorBinding.id }),
                };
                await saveBinding(key, next);
                return next;
              },
              recordAccepted: async (key, id) => {
                const { state } = await binding(key);
                if (
                  state.state !== "pending" ||
                  id === "" ||
                  (state.acceptedEnvId !== undefined && state.acceptedEnvId !== id)
                ) {
                  throw unavailable();
                }
                await saveBinding(key, { ...state, acceptedEnvId: id });
              },
              recordVerified: async (key) => {
                const { state } = await binding(key);
                if (state.acceptedEnvId === undefined) {
                  throw unavailable();
                }
                await saveBinding(key, { ...state, state: "applied" });
              },
            },
          };
          const reconciled = await ports.reconcileEffect(context);
          row = await refresh();
          if (reconciled === "unknown") {
            return { status: "reconciliation-required" as const, operationRef, effect };
          }
          await authorize(invocation, plan, true);
          if (reconciled === "applied") {
            if (
              effect === "bind-production-runtime" &&
              Object.values(row.record.bindings).some((value) => value.state !== "applied")
            ) {
              throw unavailable();
            }
            row = await checkpoint(row, {
              ...row.record,
              effects: { ...row.record.effects, [effect]: "applied" },
            });
            continue;
          }
          row = await checkpoint(row, {
            ...row.record,
            effects: { ...row.record.effects, [effect]: "pending" },
          });
          await authorize(invocation, plan, true);
          await ports.applyEffect(context);
          row = await refresh();
          await authorize(invocation, plan, true);
          if ((await ports.reconcileEffect(context)) !== "applied") {
            return { status: "reconciliation-required" as const, operationRef, effect };
          }
          row = await refresh();
          if (
            effect === "bind-production-runtime" &&
            Object.values(row.record.bindings).some((value) => value.state !== "applied")
          ) {
            throw unavailable();
          }
          row = await checkpoint(row, {
            ...row.record,
            effects: { ...row.record.effects, [effect]: "applied" },
          });
        }
        await authorize(invocation, plan, true);
        const observation = publicReleaseObservationSchema.parse(
          await ports.observe(invocation, plan),
        );
        await authorize(invocation, plan, true);
        if (
          observation.status === "ready" &&
          (observation.projectId !== plan.project.projectId ||
            observation.publicOrigin !== plan.publicOrigin ||
            observation.releaseId !== plan.runtime.releaseId)
        ) {
          throw unavailable();
        }
        await checkpoint(row, { ...row.record, observation });
        return {
          status: observation.status,
          operationRef,
          observation,
          authenticatedBehavior: "unassessed" as const,
        };
      });
    },
  };
};
