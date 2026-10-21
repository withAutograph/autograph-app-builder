import type { PrivateOperatorApprovalObservationPort } from "../eve/private-operator-approval-observation";
/* oxlint-disable sonarjs/no-nested-functions -- One resource lease retains a single approved attempt through its private checkpoints. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { HostedOperatorError } from "./hosted-operator-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";
import type { PhysicalResourceLeaseInput } from "./postgres-physical-resource-lease";
import {
  continuityRecordSchema,
  continuityPlanDigest,
  continuityStatus,
  hostedContinuityPlanSchema,
  parseContinuityPlanForOwner,
  parseContinuityRequestForPlan,
} from "./hosted-operator-continuity-contract";
import type {
  ContinuityRecord,
  ContinuityApproval,
  ContinuityCapabilities,
  HostedContinuityPlan,
  HostedContinuityRequest,
  ContinuityRuntimeLocator,
  ContinuityCurrent,
  ContinuityProjection,
  ContinuityRuntimeSelection,
} from "./hosted-operator-continuity-contract";

export interface ContinuityJournalStore {
  read: (input: {
    authority: HostedOperatorContext["authority"];
    intentId: string;
  }) => Promise<ContinuityRecord | undefined>;
  reserve: (input: { record: ContinuityRecord; now: Date }) => Promise<ContinuityRecord>;
  compareAndSet: (input: {
    record: ContinuityRecord;
    expectedRevision: number;
    now: Date;
  }) => Promise<ContinuityRecord | undefined>;
}
export interface HostedContinuityDependencies {
  store: ContinuityJournalStore;
  assertOwner: (context: HostedOperatorContext) => Promise<void>;
  /** Includes fresh canonical owner, original setup approval/resource/release and owned VM selection. */
  assertSetup: (context: HostedOperatorContext, plan: HostedContinuityPlan) => Promise<void>;
  resolvePlan: (
    context: HostedOperatorContext,
    runtime: ContinuityRuntimeSelection,
  ) => Promise<Omit<HostedContinuityPlan, "intentId" | "planRef">>;
  readApproval: (
    context: HostedOperatorContext,
    request: HostedContinuityRequest,
    callId?: string,
    observation?: PrivateOperatorApprovalObservationPort,
  ) => Promise<ContinuityApproval | null>;
  seal: (
    record: ContinuityRecord,
    capabilities: ContinuityCapabilities,
  ) => ContinuityRecord["privateState"];
  unseal: (record: ContinuityRecord) => ContinuityCapabilities;
  withResourceLease: <T>(
    input: PhysicalResourceLeaseInput,
    run: (assertFence: () => Promise<void>) => Promise<T>,
  ) => Promise<T>;
  runtime: {
    /** Reconcile the same retained command before dispatch. No implicit fresh attempt. */
    start: (
      context: HostedOperatorContext,
      record: ContinuityRecord,
      capabilities: ContinuityCapabilities,
      assertCurrent: () => Promise<void>,
      checkpoint: (patch: {
        locator?: ContinuityRuntimeLocator;
        current?: ContinuityCurrent;
        projection?: ContinuityProjection;
        publicProfile?: ContinuityRecord["publicProfile"];
        workerAsset?: ContinuityRecord["workerAsset"];
      }) => Promise<void>,
    ) => Promise<void>;
    runSuite: (
      context: HostedOperatorContext,
      record: ContinuityRecord,
      capabilities: ContinuityCapabilities,
      assertCurrent: () => Promise<void>,
      checkpoint: (commandId: string) => Promise<void>,
      allowDispatch: boolean,
    ) => Promise<{ exitCode: number }>;
    close: (
      context: HostedOperatorContext,
      record: ContinuityRecord,
      checkpoint: (workerAsset: NonNullable<ContinuityRecord["workerAsset"]>) => Promise<void>,
    ) => Promise<void>;
    /** Atomic local state; no provider/model lookup per app request. */
    renew: (context: HostedOperatorContext, record: ContinuityRecord) => Promise<void>;
  };
  projection: {
    publish: (
      context: HostedOperatorContext,
      record: ContinuityRecord,
      capabilities: ContinuityCapabilities,
      assertCurrent: () => Promise<void>,
      checkpoint: (
        patch: Partial<
          Pick<
            ContinuityRecord,
            "environmentRows" | "environmentWrites" | "deliveryCandidates" | "deliveryAttempted"
          >
        >,
      ) => Promise<void>,
    ) => Promise<void>;
    revoke: (
      context: HostedOperatorContext,
      record: ContinuityRecord,
      assertCurrent: () => Promise<void>,
      checkpoint: (rows: ContinuityRecord["environmentRows"]) => Promise<void>,
    ) => Promise<void>;
  };
  now?: () => Date;
}
const unavailable = () => new HostedOperatorError("reconciliation_required");
const intentIdFor = (context: HostedOperatorContext, key: string) => {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        context.authority.issuer,
        context.authority.audience,
        context.authority.workspaceId,
        context.authority.ownerUserId,
        context.target.sessionId,
        context.target.appId,
        "app-continuity",
        key,
      ]),
    )
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};
export const createHostedContinuityOperations = (deps: HostedContinuityDependencies) => {
  const now = deps.now ?? (() => new Date());
  const read = async (context: HostedOperatorContext, intentId: string) => {
    await deps.assertOwner(context);
    const record = await deps.store.read({ authority: context.authority, intentId });
    if (record === undefined) {
      throw new HostedOperatorError("resource_mismatch");
    }
    parseContinuityPlanForOwner(record.plan, context);
    return record;
  };
  const update = async (
    record: ContinuityRecord,
    change: (value: ContinuityRecord) => ContinuityRecord,
  ) => {
    const changed = change(structuredClone(record));
    changed.revision = record.revision + 1;
    const saved = await deps.store.compareAndSet({
      record: continuityRecordSchema.parse(changed),
      expectedRevision: record.revision,
      now: now(),
    });
    if (saved === undefined) {
      throw new HostedOperatorError("operation_in_progress");
    }
    return saved;
  };
  const approvalObservation = (
    record: ContinuityRecord,
  ): PrivateOperatorApprovalObservationPort => ({
    ...(record.approvalObservation === undefined ? {} : { state: record.approvalObservation }),
    save: async (state) => {
      await update(record, (value) => ({ ...value, approvalObservation: state }));
    },
  });
  const approval = async (
    context: HostedOperatorContext,
    record: ContinuityRecord,
    callId?: string,
  ) => {
    await deps.assertSetup(context, record.plan);
    const request = {
      action: "continuity" as const,
      planRef: record.plan.planRef,
      planDigest: record.planDigest,
      idempotencyKey: record.idempotencyKey,
    };
    const approved =
      record.approval ??
      (await deps.readApproval(context, request, callId, approvalObservation(record)));
    if (
      approved === null ||
      !isDeepStrictEqual(
        { ...approved, approvalId: "", approvedByCallId: "" },
        { ...request, approvalId: "", approvedByCallId: "" },
      )
    ) {
      throw new HostedOperatorError("authorization_required");
    }
    return approved;
  };
  return {
    async plan(context: HostedOperatorContext, runtime: ContinuityRuntimeSelection, key: string) {
      await deps.assertOwner(context);
      const intentId = intentIdFor(context, z.string().min(1).parse(key));
      const previous = await deps.store.read({ authority: context.authority, intentId });
      if (previous !== undefined) {
        parseContinuityPlanForOwner(previous.plan, context);
        return {
          plan: previous.plan,
          request: {
            action: "continuity" as const,
            planRef: previous.plan.planRef,
            planDigest: previous.planDigest,
            idempotencyKey: previous.idempotencyKey,
          },
          status: continuityStatus(previous),
        };
      }
      const selected = await deps.resolvePlan(context, runtime);
      const plan = hostedContinuityPlanSchema.parse({
        ...selected,
        intentId,
        planRef: `_protected-operator/continuity-plans/${intentId}`,
      });
      await deps.assertSetup(context, plan);
      const record = await deps.store.reserve({
        record: continuityRecordSchema.parse({
          kind: "app-continuity",
          requestId: intentId,
          revision: 1,
          idempotencyKey: key,
          plan,
          planDigest: continuityPlanDigest(plan),
          state: "planned",
          fence: 0,
          environmentRows: [],
          environmentWrites: [],
          deliveryCandidates: [],
        }),
        now: now(),
      });
      return {
        plan: record.plan,
        request: {
          action: "continuity" as const,
          planRef: record.plan.planRef,
          planDigest: record.planDigest,
          idempotencyKey: record.idempotencyKey,
        },
        status: continuityStatus(record),
      };
    },
    async readPlan(context: HostedOperatorContext, intentId: string) {
      const record = await read(context, z.uuid().parse(intentId));
      const { plan, planDigest, idempotencyKey } = record;
      const request = parseContinuityRequestForPlan(
        { action: "continuity", planRef: plan.planRef, planDigest, idempotencyKey },
        plan,
      );
      return { plan, request, status: continuityStatus(record) };
    },
    async status(context: HostedOperatorContext, intentId: string) {
      return continuityStatus(await read(context, z.uuid().parse(intentId)));
    },
    async approval(context: HostedOperatorContext, request: HostedContinuityRequest) {
      let record = await read(context, z.uuid().parse(request.planRef.split("/").at(-1)));
      parseContinuityRequestForPlan(request, record.plan);
      if (request.idempotencyKey !== record.idempotencyKey) {
        throw new HostedOperatorError("resource_mismatch");
      }
      if (record.approval !== undefined) {
        return { approved: true };
      }
      await deps.assertSetup(context, record.plan);
      const receipt = await deps.readApproval(
        context,
        request,
        undefined,
        approvalObservation(record),
      );
      if (receipt !== null) {
        record = await update(record, (value) => ({
          ...value,
          approval: receipt,
          state: "approved",
        }));
      }
      return { approved: record.approval !== undefined };
    },
    async execute(
      context: HostedOperatorContext,
      request: HostedContinuityRequest,
      callId: string,
      signal?: AbortSignal,
    ) {
      const intentId = z.uuid().parse(request.planRef.split("/").at(-1));
      let current = await read(context, intentId);
      parseContinuityRequestForPlan(request, current.plan);
      if (request.idempotencyKey !== current.idempotencyKey) {
        throw new HostedOperatorError("resource_mismatch");
      }
      if (current.state === "settled" || current.state === "revoked") {
        return continuityStatus(current);
      }
      const approved = await approval(context, current, callId);
      if (current.approval === undefined) {
        current = await update(current, (value) => ({
          ...value,
          approval: approved,
          state: "approved",
        }));
      }
      return await deps.withResourceLease(
        {
          lockKeys: [
            JSON.stringify([
              "hosted_protected_operator_vercel_project_v1",
              current.plan.gateway.ownerId,
              current.plan.gateway.projectId,
            ]),
          ],
          initializeUnderLock: async () => {
            current = await read(context, intentId);
            if (current.state === "settled" || current.state === "revoked") {
              return;
            }
            await approval(context, current, callId);
            if (current.attemptId === undefined) {
              const capabilities = {
                suiteSelector: randomBytes(32).toString("base64url"),
                transport: randomBytes(32).toString("base64url"),
                lifecycle: randomBytes(32).toString("base64url"),
              };
              current = await update(current, (value) => {
                value.fence += 1;
                value.attemptId = randomUUID();
                value.privateState = deps.seal(value, capabilities);
                value.state = "starting";
                value.pendingStage = "runtime";
                return value;
              });
            }
          },
          readCurrentFence: async () => {
            const latest = await read(context, intentId);
            if (latest.fence !== current.fence || latest.attemptId !== current.attemptId) {
              throw unavailable();
            }
            if (latest.state !== "settled") {
              await approval(context, latest, callId);
            }
            return {
              operationRef: intentId,
              leaseId: latest.attemptId ?? intentId,
              fenceGeneration: latest.fence,
            };
          },
        },
        async (assertFence) => {
          let renewalFailure: Error | undefined;
          const assertCurrent = async () => {
            signal?.throwIfAborted();
            if (renewalFailure !== undefined) {
              throw renewalFailure;
            }
            await assertFence();
          };
          if (current.state === "settled" || current.state === "revoked") {
            return continuityStatus(current);
          }
          const capabilities = deps.unseal(current);
          const checkpointCleanup = async (
            workerAsset: NonNullable<ContinuityRecord["workerAsset"]>,
          ) => {
            await assertFence();
            current = await update(current, (value) => ({ ...value, workerAsset }));
          };
          let renewalTask: Promise<void> | undefined;
          let stopping = false;
          const renewal = setInterval(() => {
            if (stopping || renewalTask !== undefined) {
              return;
            }
            renewalTask = (async () => {
              try {
                await assertCurrent();
                if (!stopping) {
                  await deps.runtime.renew(context, current);
                }
              } catch (error) {
                renewalFailure = error instanceof Error ? error : unavailable();
                try {
                  await deps.runtime.close(context, current, checkpointCleanup);
                } catch {
                  /* Durable locator remains available for reconciliation. */
                }
              }
            })().finally(() => {
              renewalTask = undefined;
            });
          }, 15_000);
          const stopRenewal = async () => {
            stopping = true;
            clearInterval(renewal);
            await renewalTask;
          };
          const recoverFailure = async () => {
            await stopRenewal();
            const publicationFailed = current.pendingStage === "publication";
            if (publicationFailed) {
              try {
                await assertFence();
                current = await update(current, (value) => ({
                  ...value,
                  state: "reconciliation-required",
                  pendingStage: "revocation",
                  failure: {
                    stage: "publication",
                    reason: "runtime-closed-before-publication-completed",
                  },
                }));
              } catch {
                // Cleanup must still run if the final authority/CAS write fails.
                // Retained command liveness prevents publishing a closed target.
              }
            }
            // Closing the owned command is required even when cancellation/revocation
            // makes ordinary execution authorization fail. It never targets another VM.
            let closed = false;
            try {
              await deps.runtime.close(context, current, checkpointCleanup);
              closed = true;
            } catch {
              /* Retained locator, never redispatch. */
            }
            await assertFence();
            const cancelled = signal?.aborted === true;
            current = await update(current, (value) => ({
              ...value,
              state: "reconciliation-required",
              ...(cancelled ? { cancelled: true, pendingStage: "revocation" as const } : {}),
              ...(publicationFailed
                ? {
                    pendingStage: "revocation" as const,
                    failure: {
                      stage: "publication" as const,
                      reason: "runtime-closed-before-publication-completed" as const,
                    },
                  }
                : {}),
            }));
            if ((cancelled || current.failure !== undefined) && closed) {
              try {
                await deps.projection.revoke(
                  context,
                  current,
                  assertFence,
                  async (environmentRows) => {
                    await assertFence();
                    current = await update(current, (value) => ({ ...value, environmentRows }));
                  },
                );
                await assertFence();
                current = await update(current, (value) => {
                  value.state = "revoked";
                  if (value.current !== undefined) {
                    value.current.state = "revoked";
                  }
                  delete value.pendingStage;
                  return value;
                });
              } catch {
                /* Keep the same pending revocation for exact read-first reconciliation. */
              }
            }
          };
          try {
            let runtimeObserved = false;
            if (current.pendingStage === "runtime") {
              await deps.runtime.start(
                context,
                current,
                capabilities,
                assertCurrent,
                async (patch) => {
                  await assertCurrent();
                  current = await update(current, (value) => ({ ...value, ...patch }));
                },
              );
              runtimeObserved = true;
              await assertCurrent();
              current = await update(current, (value) => ({
                ...value,
                state: "publishing",
                pendingStage: "publication",
              }));
            }
            if (current.pendingStage === "publication") {
              // A previous failed journal write may have left this stage after owned
              // cleanup. Observe the retained command before any publication recovery.
              if (!runtimeObserved) {
                await deps.runtime.start(
                  context,
                  current,
                  capabilities,
                  assertCurrent,
                  async (patch) => {
                    await assertCurrent();
                    current = await update(current, (value) => ({ ...value, ...patch }));
                  },
                );
              }
              await deps.projection.publish(
                context,
                current,
                capabilities,
                assertCurrent,
                async (patch) => {
                  await assertCurrent();
                  current = await update(current, (value) => ({ ...value, ...patch }));
                },
              );
              await assertCurrent();
              current = await update(current, (value) => ({
                ...value,
                state: "ready",
                pendingStage: "suite",
              }));
            }
            if (current.pendingStage === "suite") {
              const allowDispatch = current.suiteDispatched !== true;
              if (allowDispatch) {
                current = await update(current, (value) => ({ ...value, suiteDispatched: true }));
              }
              const result = await deps.runtime.runSuite(
                context,
                current,
                capabilities,
                assertCurrent,
                async (suiteCommandId) => {
                  await assertCurrent();
                  current = await update(current, (value) => ({ ...value, suiteCommandId }));
                },
                allowDispatch,
              );
              await assertCurrent();
              current = await update(current, (value) => ({
                ...value,
                outcome: { exitCode: result.exitCode, completedAt: now().toISOString() },
                state: "revoking",
                pendingStage: "revocation",
              }));
            }
            if (current.pendingStage !== "revocation") {
              throw unavailable();
            }
            await stopRenewal();
            if (renewalFailure !== undefined) {
              throw renewalFailure;
            }
            await deps.runtime.close(context, current, checkpointCleanup);
            await deps.projection.revoke(
              context,
              current,
              assertCurrent,
              async (environmentRows) => {
                await assertCurrent();
                current = await update(current, (value) => ({ ...value, environmentRows }));
              },
            );
            await assertCurrent();
            current = await update(current, (value) => {
              value.state =
                value.cancelled === true || value.failure !== undefined ? "revoked" : "settled";
              if (value.current !== undefined) {
                value.current.state = "revoked";
              }
              delete value.pendingStage;
              return value;
            });
            return continuityStatus(current);
          } catch (error) {
            await recoverFailure();
            throw error instanceof HostedOperatorError ? error : unavailable();
          } finally {
            await stopRenewal();
          }
        },
      );
    },
  };
};
