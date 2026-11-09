/* oxlint-disable sonarjs/expression-complexity -- Exact approval and worker checkpoint bindings are checked together before accepting effects. */
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { HostedOperatorError, workerEffectCheckpointFrameSchema } from "./hosted-operator-contract";
import type { OperatorOwnerContext, WorkerEffectCheckpointFrame } from "./hosted-operator-contract";
import {
  authSchemaRolloutApprovalSchema,
  authSchemaRolloutDigest,
  authSchemaRolloutOperationRef,
  authSchemaRolloutRecordSchema,
  authSchemaRolloutStatusSchema,
} from "./production-auth-schema-rollout-contract";
import type {
  AuthSchemaRolloutApproval,
  AuthSchemaRolloutRecord,
  AuthSchemaRolloutRow,
  AuthSchemaRolloutScope,
} from "./production-auth-schema-rollout-contract";
import type { AuthSchemaRolloutProfile } from "./production-auth-schema-rollout-configuration";
import type { PrivateOperatorApprovalObservation } from "../eve/private-operator-approval-observation";
import { observeAuthSchemaRolloutPhaseSync } from "./production-auth-schema-rollout-diagnostic";

export interface AuthSchemaRolloutStore {
  read: (
    scope: AuthSchemaRolloutScope,
    operationRef: string,
  ) => Promise<AuthSchemaRolloutRow | undefined>;
  reserve: (record: AuthSchemaRolloutRecord) => Promise<AuthSchemaRolloutRow>;
  compareAndSet: (
    row: AuthSchemaRolloutRow,
    record: AuthSchemaRolloutRecord,
  ) => Promise<AuthSchemaRolloutRow | undefined>;
}
export interface AuthSchemaRolloutPorts {
  store: AuthSchemaRolloutStore;
  assertOwner: (owner: OperatorOwnerContext) => Promise<void>;
  profile: (
    scope: AuthSchemaRolloutScope,
    record?: AuthSchemaRolloutRecord,
  ) => AuthSchemaRolloutProfile;
  propose: (
    profile: AuthSchemaRolloutProfile,
    assertCurrent: () => Promise<void>,
  ) => Promise<z.infer<ReturnType<typeof z.json>>>;
  withLease: <T>(
    row: AuthSchemaRolloutRow,
    run: (assertCurrent: () => Promise<void>) => Promise<T>,
  ) => Promise<T>;
  approval: (input: {
    plan: AuthSchemaRolloutApproval;
    owner: OperatorOwnerContext;
    callId: string;
    observation?: PrivateOperatorApprovalObservation;
    save: (observation: PrivateOperatorApprovalObservation) => Promise<void>;
    assertCurrent: () => Promise<void>;
  }) => Promise<{ approvalId: string; approvedByCallId: string } | null>;
  apply: (
    row: AuthSchemaRolloutRow,
    assertCurrent: () => Promise<void>,
    checkpoint: (frame: WorkerEffectCheckpointFrame) => Promise<void>,
    beforeWorkerDispatch: () => Promise<void>,
  ) => Promise<void>;
  inspect: (
    row: AuthSchemaRolloutRow,
    assertCurrent: () => Promise<void>,
  ) => Promise<{ state: "applied"; readbackSha256: string } | { state: "not-applied" | "unknown" }>;
}
const proposalSchema = z.object({
  version: z.literal(1),
  resource: z.json(),
  schemaPlan: z.looseObject({
    resource: z.json(),
    authOperatorRole: z.string(),
    planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    targetDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    effects: z.array(
      z.object({ owner: z.string(), sql: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }),
    ),
  }),
});
const denied = () => new HostedOperatorError("authorization_required");
const mismatch = () => new HostedOperatorError("resource_mismatch");
const status = (row: AuthSchemaRolloutRow) =>
  authSchemaRolloutStatusSchema.parse({
    version: 1,
    operationRef: row.record.plan.operationRef,
    state: row.record.state,
    readbackSha256: row.record.readbackSha256,
  });
/** Private service maintenance only: one existing resource, one approved schema plan, no app grants. */
export const createAuthSchemaRollout = (ports: AuthSchemaRolloutPorts) => {
  const authorize = async (
    owner: OperatorOwnerContext,
    scope: AuthSchemaRolloutScope,
    record?: AuthSchemaRolloutRecord,
  ) => {
    if (
      !isDeepStrictEqual(scope.authority, owner.authority) ||
      scope.sessionId !== owner.sessionId
    ) {
      throw denied();
    }
    await ports.assertOwner(owner);
    return ports.profile(scope, record);
  };
  const read = async (owner: OperatorOwnerContext, operationRef: string) => {
    await ports.assertOwner(owner);
    // The store predicate binds all four tenant coordinates before exposing a journal.
    const scope = { authority: owner.authority, sessionId: owner.sessionId, profileId: "" };
    const row = await ports.store.read(scope, operationRef);
    if (!row) {
      throw denied();
    }
    await authorize(owner, row.record.plan.scope, row.record);
    return row;
  };
  const save = async (row: AuthSchemaRolloutRow, record: AuthSchemaRolloutRecord) => {
    const next = await ports.store.compareAndSet(row, authSchemaRolloutRecordSchema.parse(record));
    if (!next) {
      throw new HostedOperatorError("reconciliation_required");
    }
    return next;
  };
  return {
    async plan(owner: OperatorOwnerContext, profileId: string) {
      const scope = { authority: owner.authority, sessionId: owner.sessionId, profileId };
      const profile = await authorize(owner, scope);
      const assertCurrent = async () => {
        await authorize(owner, scope);
      };
      const proposal = await ports.propose(profile, assertCurrent);
      const frozen = observeAuthSchemaRolloutPhaseSync("proposal_validation", () => {
        const parsed = proposalSchema.parse(proposal);
        const { resourceId, ...resource } = profile.resource;
        if (
          !isDeepStrictEqual(parsed.resource, resource) ||
          !isDeepStrictEqual(parsed.schemaPlan.resource, resource) ||
          parsed.schemaPlan.authOperatorRole !== profile.authOperatorRole
        ) {
          throw mismatch();
        }
        const operatorPlan = z.json().parse({
          version: 1,
          action: "prepare",
          authDatabase: {
            resourceId,
            database: resource.database,
            migratorRole: resource.migratorRole,
            runtimeRole: resource.runtimeRole,
          },
          authSchema: {
            planDigest: parsed.schemaPlan.planDigest,
            targetDigest: parsed.schemaPlan.targetDigest,
            authOperatorRole: profile.authOperatorRole,
          },
          neon: {
            endpoint: resource.hostname,
            projectId: resource.neon.projectId,
            branchId: resource.neon.branchId,
          },
          rollout: { scope, runtime: profile.runtime, proposal },
        });
        const planDigest = authSchemaRolloutDigest(operatorPlan);
        const plan = authSchemaRolloutApprovalSchema.parse({
          version: 1,
          operationRef: authSchemaRolloutOperationRef(scope, planDigest),
          scope,
          planDigest,
          resource: profile.resource,
          resourceLabel: profile.label,
          authOperatorRole: profile.authOperatorRole,
          schemaPlanDigest: parsed.schemaPlan.planDigest,
          targetDigest: parsed.schemaPlan.targetDigest,
          workerSha256: profile.runtime.worker.sha256,
          sourceCapture: profile.runtime.worker.sourceCapture,
          effects: parsed.schemaPlan.effects,
        });
        return { operatorPlan, plan };
      });
      const { operatorPlan, plan } = frozen;
      await assertCurrent();
      const row = await ports.store.reserve(
        authSchemaRolloutRecordSchema.parse({
          version: 1,
          kind: "production-auth-schema-rollout-v1",
          plan,
          runtime: profile.runtime,
          proposal,
          operatorPlan,
          state: "planned",
          checkpoints: [],
        }),
      );
      if (!isDeepStrictEqual(row.record.plan, plan)) {
        throw mismatch();
      }
      return { version: 1 as const, plan: row.record.plan };
    },
    async status(owner: OperatorOwnerContext, operationRef: string) {
      return status(await read(owner, operationRef));
    },
    async execute(
      owner: OperatorOwnerContext,
      operationRef: string,
      planDigest: string,
      callId: string,
    ) {
      const original = await read(owner, operationRef);
      if (original.record.plan.planDigest !== planDigest) {
        throw mismatch();
      }
      return await ports.withLease(original, async (assertFence) => {
        let row = await read(owner, operationRef);
        const assertCurrent = async () => {
          await assertFence();
          const current = await read(owner, operationRef);
          if (
            current.record.plan.planDigest !== planDigest ||
            !isDeepStrictEqual(current.record.lease, row.record.lease)
          ) {
            throw denied();
          }
        };
        const approval = await ports.approval({
          plan: row.record.plan,
          owner,
          callId: row.record.approval?.approvedByCallId ?? callId,
          observation: row.record.approvalObservation,
          save: async (observation) => {
            row = await save(row, { ...row.record, approvalObservation: observation });
          },
          assertCurrent,
        });
        if (
          !approval ||
          approval.approvedByCallId !== (row.record.approval?.approvedByCallId ?? callId) ||
          (row.record.approval && !isDeepStrictEqual(row.record.approval, approval))
        ) {
          throw denied();
        }
        await assertCurrent();
        if (row.record.state === "ready") {
          return status(row);
        }
        if (row.record.state !== "planned") {
          // Never repeat an uncertain write. Reconcile this exact original plan first.
          const observed = await ports.inspect(row, assertCurrent);
          await assertCurrent();
          if (observed.state === "applied") {
            row = await save(row, {
              ...row.record,
              state: "ready",
              readbackSha256: observed.readbackSha256,
            });
            return status(row);
          }
          if (observed.state === "unknown") {
            row = await save(row, { ...row.record, state: "reconciling" });
            return status(row);
          }
        }
        row = await save(row, { ...row.record, approval });
        let dispatched = false;
        try {
          await ports.apply(
            row,
            assertCurrent,
            async (input) => {
              if (!dispatched) {
                throw mismatch();
              }
              const frame = workerEffectCheckpointFrameSchema.parse(input);
              if (
                frame.operationId !== operationRef ||
                frame.resourceId !== row.record.plan.resource.resourceId ||
                frame.effectId !== "auth:apply-schema-plan" ||
                frame.sequence !== 1 ||
                (frame.tenantId !== null && frame.tenantId !== undefined) ||
                frame.fenceGeneration !== row.record.lease?.fenceGeneration
              ) {
                throw mismatch();
              }
              await assertCurrent();
              row = await save(row, {
                ...row.record,
                checkpoints: [...row.record.checkpoints, frame],
              });
            },
            async () => {
              if (dispatched) {
                throw mismatch();
              }
              await assertCurrent();
              row = await save(row, { ...row.record, state: "pending" });
              dispatched = true;
            },
          );
          if (!dispatched) {
            throw mismatch();
          }
          await assertCurrent();
          const frame = row.record.checkpoints.at(-1);
          if (
            frame === undefined ||
            frame.receipt.state === "unknown" ||
            frame.receipt.readbackSha256 === undefined
          ) {
            throw new HostedOperatorError("reconciliation_required");
          }
          row = await save(row, {
            ...row.record,
            state: "ready",
            readbackSha256: frame.receipt.readbackSha256,
          });
        } catch {
          // The durable checkpoint survives a lost terminal reply. A later continuation
          // performs independent readback before it can launch another write.
          if (dispatched) {
            row = await save(row, { ...row.record, state: "reconciling" });
          }
        }
        return status(row);
      });
    },
  };
};
