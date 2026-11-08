import { sameRepositoryProductionSetupEffects } from "./repository-production-intent";
/* oxlint-disable sonarjs/cognitive-complexity, sonarjs/no-nested-functions, sonarjs/max-union-size, react-doctor/js-cache-property-access -- Ordered recovery re-reads the mutable journal after every awaited write and retains the closed progress states. */
/* oxlint-disable eslint/no-await-in-loop, eslint/no-loop-func, eslint/complexity -- Ordered effects share one fenced row; every awaited callback completes before advancing the journal. */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import {
  initialRepositoryProductionRecord,
  repositoryProductionOperationRef,
  repositoryProductionRecordSchema,
} from "./repository-production-contract";
import type {
  RepositoryProductionEffect,
  RepositoryProductionIntent,
  RepositoryProductionRecord,
  RepositoryProductionRow,
  RepositoryProductionScope,
} from "./repository-production-contract";

export interface RepositoryProductionStore {
  read: (scope: RepositoryProductionScope) => Promise<RepositoryProductionRow | undefined>;
  reserve: (record: RepositoryProductionRecord) => Promise<RepositoryProductionRow>;
  compareAndSet: (
    row: RepositoryProductionRow,
    record: RepositoryProductionRecord,
  ) => Promise<RepositoryProductionRow | undefined>;
}
export type RepositoryProductionObservation =
  | { state: "applied"; receipt: z.infer<ReturnType<typeof z.json>> }
  | { state: "not-applied" }
  | { state: "unknown" };
export type RepositoryProductionIdentity =
  | { state: "verified"; actorId: string }
  | { state: "required"; signInUrl?: string; expiresAt?: string };
export interface RepositoryProductionEffectContext {
  row: RepositoryProductionRow;
  effect: RepositoryProductionEffect;
  assertCurrent: () => Promise<void>;
  checkpoint: (value: z.infer<ReturnType<typeof z.json>>) => Promise<void>;
}
export interface RepositoryProductionSetupPorts {
  store: RepositoryProductionStore;
  /** Current canonical Builder owner, repository, organization and exact approved delivery intent. */
  assertAuthorized: (
    scope: RepositoryProductionScope,
    intent: RepositoryProductionIntent,
  ) => Promise<void>;
  /** Shared physical app slot; callback checks its live database lease before every effect. */
  withLease: <T>(
    scope: RepositoryProductionScope,
    run: (assertFence: () => Promise<void>) => Promise<T>,
  ) => Promise<T>;
  /** Pure encrypted credential allocation. The returned checkpoint is persisted before provider effects. */
  reservePrivateState: (
    row: RepositoryProductionRow,
  ) => Promise<z.infer<ReturnType<typeof z.json>>>;
  /** Reads the one-time proof for this Builder owner; matching email is not identity authority. */
  prepareCreatorIdentity?: (context: RepositoryProductionEffectContext) => Promise<void>;
  reconcileCreatorRoles?: (
    context: RepositoryProductionEffectContext,
  ) => Promise<"applied" | "skipped">;
  reconcileAppAccessUpgrade?: (context: RepositoryProductionEffectContext) => Promise<void>;
  readCreatorIdentity: (row: RepositoryProductionRow) => Promise<RepositoryProductionIdentity>;
  /** Persistent apps need their owned public ingress metadata as well as the credential binding. */
  isRuntimeBindingReady?: (row: RepositoryProductionRow) => boolean;
  reconcile: (
    context: RepositoryProductionEffectContext,
  ) => Promise<RepositoryProductionObservation>;
  apply: (context: RepositoryProductionEffectContext) => Promise<void>;
}
export interface RepositoryProductionSetupResult {
  operationRef: string;
  state: "ready" | "setting-up-data" | "checking-access" | "identity-required" | "reconciling";
  signInUrl?: string;
  expiresAt?: string;
}
const CREATOR_ACCESS_EFFECT = "creator-access";
const BIND_RUNTIME_EFFECT = "bind-runtime";

const unfinished = (record: RepositoryProductionRecord) =>
  record.appAccessUpgrade?.state === "pending" ||
  record.creatorRoleUpdate?.state === "pending" ||
  Object.values(record.effects).some((effect) => effect.state === "pending");
const selectedEffects = (record: RepositoryProductionRecord): RepositoryProductionEffect[] =>
  record.intent.storage.kind === "none"
    ? ["creator-access"]
    : ["allocate-storage", "install-schema", CREATOR_ACCESS_EFFECT, BIND_RUNTIME_EFFECT];

/** Same-app delivery continuation; no Preview prerequisite, deployment mutation or product-test gate. */
export const createRepositoryProductionSetup = (ports: RepositoryProductionSetupPorts) => ({
  async prepare(
    scope: RepositoryProductionScope,
    intent: RepositoryProductionIntent,
  ): Promise<RepositoryProductionSetupResult> {
    await ports.assertAuthorized(scope, intent);
    return await ports.withLease(scope, async (assertFence) => {
      let row: RepositoryProductionRow =
        (await ports.store.read(scope)) ??
        (await ports.store.reserve(initialRepositoryProductionRecord(scope, intent)));
      if (!isDeepStrictEqual(row.record.scope, scope)) {
        throw new Error("repository_production_destination_changed");
      }
      const assertCurrent = async () => {
        await assertFence();
        await ports.assertAuthorized(scope, intent);
      };
      const save = async (record: RepositoryProductionRecord) => {
        await assertCurrent();
        const next = await ports.store.compareAndSet(
          row,
          repositoryProductionRecordSchema.parse(record),
        );
        if (next === undefined) {
          throw new Error("repository_production_conflict");
        }
        row = next;
      };
      if (!sameRepositoryProductionSetupEffects(row.record.intent, intent)) {
        if (unfinished(row.record)) {
          return { operationRef: row.operationRef, state: "reconciling" };
        }
        // Keep resource ownership/credentials and completed allocation through ordinary revisions.
        const next = initialRepositoryProductionRecord(scope, intent);
        if (row.record.resource !== undefined) {
          next.resource = row.record.resource;
        }
        if (row.record.privateState !== undefined) {
          next.privateState = row.record.privateState;
        }
        next.effects["allocate-storage"] = row.record.effects["allocate-storage"];
        next.effects["creator-access"] = row.record.effects["creator-access"];
        if (row.record.intent.storage.kind === "none" && intent.storage.kind === "postgres") {
          next.appAccessUpgrade = { commandId: randomUUID(), state: "pending" };
        }
        if (
          next.effects["creator-access"].state === "applied" &&
          !isDeepStrictEqual(
            [...new Set(row.record.intent.creatorRoles)].toSorted(),
            [...new Set(intent.creatorRoles)].toSorted(),
          )
        ) {
          next.creatorRoleUpdate = {
            commandId: randomUUID(),
            roles: [...new Set(intent.creatorRoles)].toSorted(),
            state: "pending",
          };
        }
        if (row.record.approval !== undefined) {
          next.approval = row.record.approval;
        }
        if (row.record.creatorOwnerContext !== undefined) {
          next.creatorOwnerContext = row.record.creatorOwnerContext;
        }
        if (row.record.ownerContext !== undefined) {
          next.ownerContext = row.record.ownerContext;
        }
        if (row.record.creatorActorId !== undefined) {
          next.creatorActorId = row.record.creatorActorId;
        }
        if (row.record.lease !== undefined) {
          next.lease = row.record.lease;
        }
        next.workerCheckpoints = row.record.workerCheckpoints;
        await save(next);
      }
      if (
        intent.creatorEmail !== undefined &&
        row.record.intent.creatorEmail !== intent.creatorEmail
      ) {
        await save({
          ...row.record,
          intent: { ...row.record.intent, creatorEmail: intent.creatorEmail },
        });
      }
      const runtimeOnly =
        row.record.intent.storage.kind === "postgres" &&
        row.record.appAccessUpgrade?.state !== "pending" &&
        row.record.creatorRoleUpdate?.state !== "pending" &&
        selectedEffects(row.record)
          .filter((effect) => effect !== BIND_RUNTIME_EFFECT)
          .every((effect) => row.record.effects[effect].state === "applied") &&
        ports.isRuntimeBindingReady?.(row) === false;
      await assertCurrent();
      if (row.record.intent.storage.kind !== "none" && row.record.privateState === undefined) {
        const privateState = await ports.reservePrivateState(row);
        await save({ ...row.record, privateState });
      }
      for (const effect of selectedEffects(row.record)) {
        if (runtimeOnly && effect !== BIND_RUNTIME_EFFECT) {
          continue;
        }
        await assertCurrent();
        const context = (): RepositoryProductionEffectContext => ({
          row,
          effect,
          assertCurrent,
          checkpoint: async (value) => {
            await save({
              ...row.record,
              workerCheckpoints: [...row.record.workerCheckpoints, value],
            });
          },
        });
        if (effect === CREATOR_ACCESS_EFFECT && row.record.appAccessUpgrade?.state === "pending") {
          if (!ports.reconcileAppAccessUpgrade) {
            throw new Error("repository_production_access_upgrade_unavailable");
          }
          const upgrade = row.record.appAccessUpgrade;
          await ports.reconcileAppAccessUpgrade(context());
          await save({ ...row.record, appAccessUpgrade: { ...upgrade, state: "applied" } });
        }
        // Once initially granted, access management owns revocation and role changes.
        // Neither an ordinary revision nor setup retry may restore an intentionally removed grant.
        if (effect === CREATOR_ACCESS_EFFECT && row.record.effects[effect].state === "applied") {
          const update = row.record.creatorRoleUpdate;
          if (update?.state === "pending") {
            if (!ports.reconcileCreatorRoles) {
              throw new Error("repository_production_role_update_unavailable");
            }
            const state = await ports.reconcileCreatorRoles(context());
            await save({ ...row.record, creatorRoleUpdate: { ...update, state } });
          }
          continue;
        }
        // Initial installation needs the real verified actor's tenant partition,
        // but membership and app grants remain the later creator-access effect.
        if (
          effect === CREATOR_ACCESS_EFFECT ||
          (effect === "install-schema" &&
            row.record.effects[CREATOR_ACCESS_EFFECT].state !== "applied")
        ) {
          await ports.prepareCreatorIdentity?.({
            row,
            effect,
            assertCurrent,
            checkpoint: async (value) => {
              await save({
                ...row.record,
                workerCheckpoints: [...row.record.workerCheckpoints, value],
              });
            },
          });
          const identity = await ports.readCreatorIdentity(row);
          await assertCurrent();
          if (identity.state === "required") {
            const result: RepositoryProductionSetupResult = {
              operationRef: row.operationRef,
              state: "identity-required",
            };
            if (identity.signInUrl !== undefined) {
              result.signInUrl = identity.signInUrl;
            }
            if (identity.expiresAt !== undefined) {
              result.expiresAt = identity.expiresAt;
            }
            return result;
          }
          if (
            row.record.creatorActorId !== undefined &&
            row.record.creatorActorId !== identity.actorId
          ) {
            throw new Error("repository_production_identity_changed");
          }
          if (row.record.creatorActorId === undefined) {
            await save({ ...row.record, creatorActorId: identity.actorId });
          }
        }
        if (row.record.effects[effect].state !== "idle") {
          const observation = await ports.reconcile(context());
          await assertCurrent();
          if (observation.state === "applied") {
            await save({
              ...row.record,
              effects: {
                ...row.record.effects,
                [effect]: {
                  ...row.record.effects[effect],
                  state: "applied",
                  receipt: observation.receipt,
                },
              },
            });
            continue;
          }
          if (observation.state === "unknown") {
            return { operationRef: row.operationRef, state: "reconciling" };
          }
          // Only authoritative not-applied readback permits another attempt.
        }
        await save({
          ...row.record,
          effects: {
            ...row.record.effects,
            [effect]: { state: "pending", attemptId: randomUUID() },
          },
        });
        await assertCurrent();
        await ports.apply(context());
        await assertCurrent();
        const observed = await ports.reconcile(context());
        await assertCurrent();
        if (observed.state !== "applied") {
          return { operationRef: row.operationRef, state: "reconciling" };
        }
        await save({
          ...row.record,
          effects: {
            ...row.record.effects,
            [effect]: {
              ...row.record.effects[effect],
              state: "applied",
              receipt: observed.receipt,
            },
          },
        });
      }
      await assertCurrent();
      return { operationRef: row.operationRef, state: "ready" };
    });
  },
  async status(
    scope: RepositoryProductionScope,
    intent: RepositoryProductionIntent,
  ): Promise<RepositoryProductionSetupResult> {
    await ports.assertAuthorized(scope, intent);
    const row = await ports.store.read(scope);
    if (!row) {
      return {
        operationRef: repositoryProductionOperationRef(scope),
        state: intent.storage.kind === "none" ? "checking-access" : "setting-up-data",
      };
    }
    if (!sameRepositoryProductionSetupEffects(row.record.intent, intent)) {
      return { operationRef: row.operationRef, state: "reconciling" };
    }
    if (
      row.record.effects[CREATOR_ACCESS_EFFECT].state !== "applied" &&
      (row.record.intent.storage.kind === "none" ||
        row.record.effects["allocate-storage"].state === "applied")
    ) {
      const identity = await ports.readCreatorIdentity(row);
      if (identity.state === "required") {
        const result: RepositoryProductionSetupResult = {
          operationRef: row.operationRef,
          state: "identity-required",
        };
        if (identity.signInUrl !== undefined) {
          result.signInUrl = identity.signInUrl;
        }
        if (identity.expiresAt !== undefined) {
          result.expiresAt = identity.expiresAt;
        }
        return result;
      }
    }
    if (unfinished(row.record)) {
      return { operationRef: row.operationRef, state: "reconciling" };
    }
    const complete =
      selectedEffects(row.record).every(
        (effect) => row.record.effects[effect].state === "applied",
      ) &&
      (row.record.intent.storage.kind === "none" || ports.isRuntimeBindingReady?.(row) !== false);
    return { operationRef: row.operationRef, state: complete ? "ready" : "checking-access" };
  },
});
