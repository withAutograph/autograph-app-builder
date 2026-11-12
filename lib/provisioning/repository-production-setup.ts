import { sameRepositoryProductionSetupEffects } from "./repository-production-intent";
/* oxlint-disable sonarjs/cognitive-complexity, sonarjs/no-nested-functions, sonarjs/max-union-size, react-doctor/js-cache-property-access -- Ordered recovery re-reads the mutable journal after every awaited write and retains the closed progress states. */
/* oxlint-disable eslint/no-await-in-loop, eslint/no-loop-func, eslint/complexity -- Ordered effects share one fenced row; every awaited callback completes before advancing the journal. */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  initialRepositoryProductionRecord,
  repositoryProductionIntentSchema,
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
import { repositoryProductionSignupSelection } from "./repository-production-signup-policy";

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
  schemaRevision?: {
    grantDigest: string;
    assertActive: () => Promise<void>;
    /** Read and verify the exact active predecessor and candidate on the retained database. */
    verify: (
      prior: RepositoryProductionEffectContext,
      candidate: RepositoryProductionIntent,
    ) => Promise<void>;
  };
}
export interface RepositoryProductionSetupResult {
  operationRef: string;
  state: "ready" | "setting-up-data" | "checking-access" | "identity-required" | "reconciling";
  signInUrl?: string;
  expiresAt?: string;
}
const CREATOR_ACCESS_EFFECT = "creator-access";
const BIND_RUNTIME_EFFECT = "bind-runtime";
const INSTALL_SCHEMA_EFFECT = "install-schema";
const ALLOCATE_STORAGE_EFFECT = "allocate-storage";
const schemaRevisionProof = z.strictObject({
  kind: z.literal("repository-production-schema-predecessor-v1"),
  grantDigest: z.string(),
  resourceId: z.string(),
  candidate: repositoryProductionIntentSchema.shape.storage,
  prior: repositoryProductionIntentSchema.pick({ sessionId: true, storage: true }),
});
const schemaRevisionUnverified = () =>
  new Error("repository_production_schema_revision_unverified");

const unfinished = (record: RepositoryProductionRecord) =>
  record.appAccessUpgrade?.state === "pending" ||
  record.creatorRoleUpdate?.state === "pending" ||
  Object.values(record.effects).some((effect) => effect.state === "pending");
const selectedEffects = (record: RepositoryProductionRecord): RepositoryProductionEffect[] => {
  const effects: RepositoryProductionEffect[] =
    record.intent.storage.kind === "none"
      ? [CREATOR_ACCESS_EFFECT]
      : [
          ALLOCATE_STORAGE_EFFECT,
          INSTALL_SCHEMA_EFFECT,
          CREATOR_ACCESS_EFFECT,
          BIND_RUNTIME_EFFECT,
        ];
  if (
    record.intent.access?.mode === "self-signup" ||
    record.effects["signup-policy"].receipt !== undefined
  ) {
    effects.push("signup-policy");
  }
  return effects;
};

/** Durable completion only; current owner and approval are checked by the caller. */
export const repositoryProductionSetupComplete = (record: RepositoryProductionRecord): boolean =>
  !unfinished(record) &&
  selectedEffects(record).every((effect) => record.effects[effect].state === "applied");

export const repositoryProductionSchemaEffectsMatch = (
  row: RepositoryProductionRow,
  intent: RepositoryProductionIntent,
): boolean => {
  const { record } = row;
  const { resource, intent: saved } = record;
  return [
    resource !== undefined,
    record.privateState !== undefined,
    record.creatorActorId !== undefined,
    saved.storage.kind === "postgres",
    intent.storage.kind === "postgres",
    saved.storage.kind === "postgres" &&
      intent.storage.kind === "postgres" &&
      saved.storage.databaseEnvironment === intent.storage.databaseEnvironment,
    saved.entryPath === intent.entryPath,
    saved.creatorEmail === intent.creatorEmail,
    record.appAccessUpgrade?.state !== "pending",
    record.creatorRoleUpdate?.state !== "pending",
    record.effects[ALLOCATE_STORAGE_EFFECT].state === "applied",
    record.effects[CREATOR_ACCESS_EFFECT].state === "applied",
    record.effects[BIND_RUNTIME_EFFECT].state === "applied",
    record.effects["signup-policy"].state !== "pending",
    sameRepositoryProductionSetupEffects({ ...saved, storage: intent.storage }, intent),
  ].every(Boolean);
};

export const retainedRepositoryProductionSchemaPredecessor = (
  row: RepositoryProductionRow,
  grantDigest?: string,
) => {
  for (const entry of row.record.workerCheckpoints.toReversed()) {
    const proof = schemaRevisionProof.safeParse(entry);
    if (!proof.success) {
      continue;
    }
    const { data } = proof;
    const sameCandidate = isDeepStrictEqual(data.candidate, row.record.intent.storage);
    if (
      sameCandidate &&
      (grantDigest === undefined || data.grantDigest === grantDigest) &&
      data.resourceId === row.record.resource?.resourceId
    ) {
      return data;
    }
  }
  // oxlint-disable-next-line unicorn/no-useless-undefined -- The explicit optional lookup result is part of the guard.
  return undefined;
};

/** Only the workflow that authorized the current candidate may resume its pending install. */
export const hasPendingRepositoryProductionSchemaRevision = (
  row: RepositoryProductionRow | undefined,
): boolean =>
  row !== undefined &&
  row.record.effects[INSTALL_SCHEMA_EFFECT].state !== "applied" &&
  retainedRepositoryProductionSchemaPredecessor(row) !== undefined;

/** Journal only the approved schema install, preserving the owned allocation and every access effect. */
const prepareExistingSchemaRevision = async (input: {
  ports: RepositoryProductionSetupPorts;
  row: RepositoryProductionRow;
  intent: RepositoryProductionIntent;
  assertCurrent: () => Promise<void>;
  save: (record: RepositoryProductionRecord) => Promise<RepositoryProductionRow>;
}): Promise<RepositoryProductionSetupResult> => {
  const { ports, intent, assertCurrent, save } = input;
  const revision = ports.schemaRevision;
  let { row } = input;
  const { record } = row;
  const { resource, intent: saved } = record;
  if (
    revision === undefined ||
    resource === undefined ||
    ports.isRuntimeBindingReady?.(row) === false ||
    !repositoryProductionSchemaEffectsMatch(row, intent)
  ) {
    throw schemaRevisionUnverified();
  }
  const ready = { operationRef: row.operationRef, state: "ready" } as const;
  const reconciling = { operationRef: row.operationRef, state: "reconciling" } as const;
  const context = (selected: RepositoryProductionRow): RepositoryProductionEffectContext => ({
    row: selected,
    effect: INSTALL_SCHEMA_EFFECT,
    assertCurrent,
    async checkpoint(value) {
      row = await save({
        ...row.record,
        workerCheckpoints: [...row.record.workerCheckpoints, value],
      });
    },
  });
  if (isDeepStrictEqual(saved.storage, intent.storage)) {
    const proof = retainedRepositoryProductionSchemaPredecessor(row, revision.grantDigest);
    if (proof === undefined) {
      throw schemaRevisionUnverified();
    }
    if (repositoryProductionSetupComplete(record)) {
      return ready;
    }
    if (record.effects[INSTALL_SCHEMA_EFFECT].state === "pending") {
      const observed = await ports.reconcile(context(row));
      if (observed.state === "unknown") {
        return reconciling;
      }
      if (observed.state === "applied") {
        await save({
          ...row.record,
          effects: {
            ...row.record.effects,
            [INSTALL_SCHEMA_EFFECT]: { state: "applied", receipt: observed.receipt },
          },
        });
        return ready;
      }
    }
    await revision.verify(
      context({ ...row, record: { ...row.record, intent: { ...saved, ...proof.prior } } }),
      intent,
    );
  } else {
    if (!repositoryProductionSetupComplete(record)) {
      throw schemaRevisionUnverified();
    }
    await revision.verify(context(row), intent);
    const proof = schemaRevisionProof.parse({
      kind: "repository-production-schema-predecessor-v1",
      grantDigest: revision.grantDigest,
      resourceId: resource.resourceId,
      candidate: intent.storage,
      prior: { sessionId: saved.sessionId, storage: saved.storage },
    });
    row = await save({
      ...row.record,
      intent,
      effects: { ...row.record.effects, [INSTALL_SCHEMA_EFFECT]: { state: "idle" } },
      workerCheckpoints: [...row.record.workerCheckpoints, proof],
    });
  }
  row = await save({
    ...row.record,
    effects: {
      ...row.record.effects,
      [INSTALL_SCHEMA_EFFECT]: { state: "pending", attemptId: randomUUID() },
    },
  });
  await revision.assertActive();
  await assertCurrent();
  await ports.apply(context(row));
  await assertCurrent();
  const observed = await ports.reconcile(context(row));
  if (observed.state !== "applied") {
    return reconciling;
  }
  await save({
    ...row.record,
    effects: {
      ...row.record.effects,
      [INSTALL_SCHEMA_EFFECT]: { state: "applied", receipt: observed.receipt },
    },
  });
  return ready;
};

/** Same-app delivery continuation; no Preview prerequisite, deployment mutation or product-test gate. */
export const createRepositoryProductionSetup = (ports: RepositoryProductionSetupPorts) => ({
  async prepare(
    scope: RepositoryProductionScope,
    intent: RepositoryProductionIntent,
  ): Promise<RepositoryProductionSetupResult> {
    await ports.assertAuthorized(scope, intent);
    return await ports.withLease(scope, async (assertFence) => {
      const saved = await ports.store.read(scope);
      if (ports.schemaRevision !== undefined && saved === undefined) {
        throw schemaRevisionUnverified();
      }
      let row: RepositoryProductionRow =
        saved ?? (await ports.store.reserve(initialRepositoryProductionRecord(scope, intent)));
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
        return row;
      };
      if (ports.schemaRevision !== undefined) {
        return await prepareExistingSchemaRevision({ ports, row, intent, assertCurrent, save });
      }
      if (hasPendingRepositoryProductionSchemaRevision(row)) {
        throw schemaRevisionUnverified();
      }
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
        next.effects[ALLOCATE_STORAGE_EFFECT] = row.record.effects[ALLOCATE_STORAGE_EFFECT];
        next.effects["creator-access"] = row.record.effects["creator-access"];
        const previousPolicy = row.record.effects["signup-policy"];
        if (
          isDeepStrictEqual(
            repositoryProductionSignupSelection(row.record.intent),
            repositoryProductionSignupSelection(intent),
          )
        ) {
          next.effects["signup-policy"] = previousPolicy;
        } else {
          next.effects["signup-policy"] = { state: "idle" };
          if (previousPolicy.receipt !== undefined) {
            next.effects["signup-policy"].receipt = previousPolicy.receipt;
          }
        }
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
      const noPendingAccessChanges =
        row.record.appAccessUpgrade?.state !== "pending" &&
        row.record.creatorRoleUpdate?.state !== "pending";
      const runtimeOnly =
        row.record.intent.storage.kind === "postgres" &&
        noPendingAccessChanges &&
        selectedEffects(row.record)
          .filter((effect) => effect !== BIND_RUNTIME_EFFECT)
          .every((effect) => row.record.effects[effect].state === "applied") &&
        ports.isRuntimeBindingReady?.(row) === false;
      await assertCurrent();
      if (row.record.intent.storage.kind !== "none" && row.record.privateState === undefined) {
        const privateState = await ports.reservePrivateState(row);
        await save({ ...row.record, privateState });
      }
      // oxlint-disable-next-line sonarjs/too-many-break-or-continue-in-loop -- Process selected authorized setup effects in order.
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
      repositoryProductionSetupComplete(row.record) &&
      (row.record.intent.storage.kind === "none" || ports.isRuntimeBindingReady?.(row) !== false);
    return { operationRef: row.operationRef, state: complete ? "ready" : "checking-access" };
  },
});
