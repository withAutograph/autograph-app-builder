import { privateOperatorApprovalObservationSchema } from "../eve/private-operator-approval-observation";
import type { PrivateOperatorApprovalObservationPort } from "../eve/private-operator-approval-observation";
import { advanceExportPlanningStage } from "./hosted-operator-consent-diagnostic";
import type { ExportPlanningStageObserver } from "./hosted-operator-consent-diagnostic";
import { hostedRuntimeTargetSchema } from "./hosted-runtime-journal";
/* oxlint-disable sonarjs/no-nested-functions -- Physical lease and CAS closures retain one claim and attempt through asynchronous recovery. */
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  HostedOperatorError,
  hostedOperatorInstallationCustomerIds,
} from "./hosted-operator-contract";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";
import type { PhysicalResourceLeaseInput } from "./postgres-physical-resource-lease";
import {
  hostedTenantExportPlanSchema,
  hostedTenantExportRequestSchema,
  parseHostedTenantExportPlanForOwner,
  parseHostedTenantExportRequestForPlan,
  tenantExportJournalRecordSchema,
  tenantExportPlanDigest,
  tenantExportStatusSchema,
  tenantExportWorkerDescriptorSchema,
} from "./hosted-operator-export-contract";
import type {
  HostedTenantExportPlan,
  HostedTenantExportRequest,
  TenantExportJournalRecord,
  TenantExportStatus,
  TenantExportWorkerInput,
} from "./hosted-operator-export-contract";

/** Private execution locator, retained before dispatch; no credentials or output bytes. */
export const tenantExportWorkerLocatorSchema = z.strictObject({
  sandboxId: z.string().min(1),
  commandId: z.string().min(1).optional(),
  descriptor: tenantExportWorkerDescriptorSchema,
});
export type TenantExportWorkerLocator = z.infer<typeof tenantExportWorkerLocatorSchema>;
// This deployment-only state extends the Builder journal, never the cross-repo worker wire.
export const hostedTenantExportExecutionRecordSchema = z.strictObject({
  kind: z.literal("app-export"),
  originalTarget: hostedRuntimeTargetSchema,
  journal: tenantExportJournalRecordSchema,
  approvalObservation: privateOperatorApprovalObservationSchema.optional(),
  workers: z.array(
    z.strictObject({
      attemptId: z.uuid(),
      locator: tenantExportWorkerLocatorSchema,
    }),
  ),
});
export type HostedTenantExportExecutionRecord = z.infer<
  typeof hostedTenantExportExecutionRecordSchema
>;
export type ExportCompletion = NonNullable<TenantExportJournalRecord["completion"]>;
export type ExportApproval = NonNullable<TenantExportJournalRecord["approval"]>;
export interface TenantExportJournalStore {
  read: (input: {
    authority: HostedOperatorContext["authority"];
    exportId: string;
  }) => Promise<HostedTenantExportExecutionRecord | undefined>;
  reserve: (input: {
    record: HostedTenantExportExecutionRecord;
    now: Date;
  }) => Promise<HostedTenantExportExecutionRecord>;
  compareAndSet: (input: {
    record: HostedTenantExportExecutionRecord;
    expectedRevision: number;
    now: Date;
  }) => Promise<HostedTenantExportExecutionRecord | undefined>;
}
export interface TenantExportPrivateSource {
  readManifest: () => Promise<Uint8Array>;
  readMember: (name: string) => AsyncIterable<Uint8Array>;
}
export type TenantExportInspection =
  | { status: "complete"; completion: ExportCompletion }
  | { status: "incomplete"; workerTerminal: true }
  | { status: "unknown" };

export interface HostedTenantExportDependencies {
  store: TenantExportJournalStore;
  assertOwner: (context: HostedOperatorContext) => Promise<void>;
  resolvePlan: (
    context: HostedOperatorContext,
    customerId: string,
    onPlanStage?: ExportPlanningStageObserver,
  ) => Promise<Omit<HostedTenantExportPlan, "exportId" | "planRef" | "destination">>;
  /** Recheck the current canonical owner and exact original approved preparation together. */
  assertSetup: (
    context: HostedOperatorContext,
    plan: HostedTenantExportPlan,
    onPlanStage?: ExportPlanningStageObserver,
  ) => Promise<void>;
  readApproval: (
    context: HostedOperatorContext,
    request: HostedTenantExportRequest,
    callId?: string,
    observation?: PrivateOperatorApprovalObservationPort,
  ) => Promise<ExportApproval | null>;
  withResourceLease: <T>(
    input: PhysicalResourceLeaseInput,
    run: (assertFence: () => Promise<void>) => Promise<T>,
  ) => Promise<T>;
  inspect: (
    context: HostedOperatorContext,
    worker: TenantExportWorkerInput,
    locator: TenantExportWorkerLocator | undefined,
    assertCurrent: () => Promise<void>,
  ) => Promise<TenantExportInspection>;
  prepareWorker: (
    context: HostedOperatorContext,
    worker: TenantExportWorkerInput,
    assertCurrent: () => Promise<void>,
  ) => Promise<TenantExportWorkerLocator>;
  runWorker: (
    context: HostedOperatorContext,
    worker: TenantExportWorkerInput,
    locator: TenantExportWorkerLocator,
    assertCurrent: () => Promise<void>,
    checkpoint: (locator: TenantExportWorkerLocator) => Promise<void>,
  ) => Promise<TenantExportPrivateSource>;
  publish: (
    context: HostedOperatorContext,
    worker: TenantExportWorkerInput,
    source: TenantExportPrivateSource,
    assertCurrent: () => Promise<void>,
  ) => Promise<ExportCompletion>;
  disposeWorker?: (locator: TenantExportWorkerLocator) => Promise<void>;
  now?: () => Date;
}
/** Caller first verifies the exact approved, fully prepared installation and its receipts. */
export const assertTenantExportCustomer = (
  plan: Pick<HostedOperatorPlan, "access" | "authMembership" | "appInstallation">,
  customerId: string,
) => {
  const membership = plan.authMembership;
  let organizations: { organizationId: string }[] = [];
  if (membership !== undefined) {
    organizations =
      membership.kind === "create-owned-organization" ? [membership] : membership.organizations;
  }
  const authorized =
    hostedOperatorInstallationCustomerIds(plan).includes(customerId) ||
    organizations.some((organization) => organization.organizationId === customerId);
  if (!authorized) {
    throw new HostedOperatorError("authorization_required");
  }
};

const mismatch = () => new HostedOperatorError("resource_mismatch");
const unavailable = () => new HostedOperatorError("reconciliation_required");
const exportIdFor = (context: HostedOperatorContext, idempotencyKey: string) => {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        context.authority.issuer,
        context.authority.audience,
        context.authority.workspaceId,
        context.authority.ownerUserId,
        context.target.sessionId,
        context.target.appId,
        idempotencyKey,
      ]),
    )
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};
const workerFor = (
  record: TenantExportJournalRecord,
  attemptId: string,
): TenantExportWorkerInput => {
  const attempt = record.attempts.find((value) => value.attemptId === attemptId);
  if (attempt?.snapshotId === undefined) {
    throw unavailable();
  }
  const plan = record.plan;
  return {
    version: 1,
    kind: "tenant-export-worker",
    exportId: plan.exportId,
    attemptId,
    snapshotId: attempt.snapshotId,
    planDigest: record.planDigest,
    scope: plan.scope,
    resource: plan.resource,
    release: plan.release,
    selection: plan.selection,
    format: plan.format,
  };
};
export const tenantExportStatus = (record: TenantExportJournalRecord): TenantExportStatus =>
  tenantExportStatusSchema.parse({
    exportId: record.plan.exportId,
    planRef: record.plan.planRef,
    state: record.state,
    ...(record.completion === undefined
      ? {}
      : {
          counts: {
            fileCount: record.completion.fileCount,
            rowCount: record.completion.rowCount,
            byteLength: record.completion.byteLength,
          },
          download: { indexPath: `/api/hosted-operator/exports/${record.plan.exportId}` },
        }),
  });
export const createHostedTenantExportOperations = (deps: HostedTenantExportDependencies) => {
  const now = deps.now ?? (() => new Date());
  const read = async (context: HostedOperatorContext, exportId: string) => {
    await deps.assertOwner(context);
    const record = await deps.store.read({ authority: context.authority, exportId });
    if (record === undefined) {
      throw mismatch();
    }
    parseHostedTenantExportPlanForOwner(record.journal.plan, {
      authority: context.authority,
      target: context.target,
    });
    return record;
  };
  const update = async (
    record: HostedTenantExportExecutionRecord,
    change: (value: HostedTenantExportExecutionRecord) => HostedTenantExportExecutionRecord,
  ) => {
    const changed = change(structuredClone(record));
    changed.journal.revision = record.journal.revision + 1;
    const result = await deps.store.compareAndSet({
      record: hostedTenantExportExecutionRecordSchema.parse(changed),
      expectedRevision: record.journal.revision,
      now: now(),
    });
    if (result === undefined) {
      throw new HostedOperatorError("operation_in_progress");
    }
    return result;
  };
  const approvalObservation = (
    record: HostedTenantExportExecutionRecord,
  ): PrivateOperatorApprovalObservationPort => ({
    ...(record.approvalObservation === undefined ? {} : { state: record.approvalObservation }),
    save: async (state) => {
      await update(record, (value) => ({ ...value, approvalObservation: state }));
    },
  });
  const assertApproval = async (
    context: HostedOperatorContext,
    record: HostedTenantExportExecutionRecord,
    callId?: string,
  ) => {
    await deps.assertSetup(context, record.journal.plan);
    const request = {
      action: "export" as const,
      planRef: record.journal.plan.planRef,
      planDigest: record.journal.planDigest,
      idempotencyKey: record.journal.idempotencyKey,
    };
    const approval =
      record.journal.approval ??
      (await deps.readApproval(context, request, callId, approvalObservation(record)));
    if (
      approval === null ||
      !isDeepStrictEqual(
        { ...approval, approvalId: "", approvedByCallId: "" },
        { ...request, approvalId: "", approvedByCallId: "" },
      ) ||
      (record.journal.approval !== undefined &&
        !isDeepStrictEqual(approval, record.journal.approval))
    ) {
      throw new HostedOperatorError("authorization_required");
    }
    return approval;
  };
  const complete = async (
    record: HostedTenantExportExecutionRecord,
    completion: ExportCompletion,
  ) => {
    const attempt = record.journal.attempts.find(
      (value) => value.attemptId === completion.attemptId,
    );
    if (
      record.journal.claim?.attemptId !== completion.attemptId ||
      attempt?.snapshotId !== completion.snapshotId
    ) {
      throw unavailable();
    }
    return await update(record, (value) => {
      value.journal.state = "complete";
      value.journal.completion = completion;
      value.journal.attempts = value.journal.attempts.map((entry) =>
        entry.attemptId === completion.attemptId ? { ...entry, state: "complete" } : entry,
      );
      delete value.journal.claim;
      return value;
    });
  };
  return {
    async plan(
      context: HostedOperatorContext,
      customerId: string,
      idempotencyKey: string,
      observer?: ExportPlanningStageObserver,
    ) {
      const onPlanStage: ExportPlanningStageObserver | undefined =
        observer === undefined
          ? undefined
          : (next) => {
              advanceExportPlanningStage(observer, next);
            };
      advanceExportPlanningStage(onPlanStage, "plan_owner_authorization");
      await deps.assertOwner(context);
      advanceExportPlanningStage(onPlanStage, "plan_input_validation");
      const exportId = exportIdFor(context, z.string().min(1).parse(idempotencyKey));
      advanceExportPlanningStage(onPlanStage, "plan_prior_read");
      const prior = await deps.store.read({ authority: context.authority, exportId });
      if (prior !== undefined) {
        advanceExportPlanningStage(onPlanStage, "plan_prior_validation");
        parseHostedTenantExportPlanForOwner(prior.journal.plan, {
          authority: context.authority,
          target: context.target,
        });
        if (
          prior.journal.plan.scope.customerId !== customerId ||
          prior.journal.idempotencyKey !== idempotencyKey
        ) {
          throw mismatch();
        }
        return {
          plan: prior.journal.plan,
          request: {
            action: "export" as const,
            planRef: prior.journal.plan.planRef,
            planDigest: prior.journal.planDigest,
            idempotencyKey,
          },
          status: tenantExportStatus(prior.journal),
        };
      }
      advanceExportPlanningStage(onPlanStage, "plan_input_validation");
      const selection = await deps.resolvePlan(
        context,
        z.string().min(1).parse(customerId),
        onPlanStage,
      );
      advanceExportPlanningStage(onPlanStage, "plan_construction");
      const plan = hostedTenantExportPlanSchema.parse({
        ...selection,
        exportId,
        planRef: `_protected-operator/export-plans/${exportId}`,
        destination: {
          kind: "owner-private-builder-artifact",
          artifactPrefix: `_protected-operator/artifacts/tenant-export/${exportId}`,
        },
      });
      advanceExportPlanningStage(onPlanStage, "plan_validation");
      parseHostedTenantExportPlanForOwner(plan, {
        authority: context.authority,
        target: context.target,
      });
      await deps.assertSetup(context, plan, onPlanStage);
      advanceExportPlanningStage(onPlanStage, "plan_reservation");
      const record = await deps.store.reserve({
        record: {
          kind: "app-export",
          originalTarget: context.target,
          journal: {
            kind: "app-export",
            version: 1,
            requestId: exportId,
            authority: plan.authority,
            target: plan.target,
            plan,
            planDigest: tenantExportPlanDigest(plan),
            idempotencyKey,
            revision: 1,
            fenceGeneration: 0,
            state: "planned",
            attempts: [],
          },
          workers: [],
        },
        now: now(),
      });
      advanceExportPlanningStage(onPlanStage, "plan_reservation_match");
      if (
        !isDeepStrictEqual(record.journal.plan, plan) ||
        record.journal.idempotencyKey !== idempotencyKey
      ) {
        throw mismatch();
      }
      return {
        plan,
        request: {
          action: "export" as const,
          planRef: plan.planRef,
          planDigest: record.journal.planDigest,
          idempotencyKey,
        },
        status: tenantExportStatus(record.journal),
      };
    },
    async approval(context: HostedOperatorContext, input: HostedTenantExportRequest) {
      const request = hostedTenantExportRequestSchema.parse(input);
      const exportId = z.uuid().parse(request.planRef.split("/").at(-1));
      const current = await read(context, exportId);
      parseHostedTenantExportRequestForPlan(request, current.journal.plan);
      if (request.idempotencyKey !== current.journal.idempotencyKey) {
        throw mismatch();
      }
      if (current.journal.state === "complete") {
        return { approved: current.journal.approval !== undefined };
      }
      await deps.assertSetup(context, current.journal.plan);
      const approval =
        current.journal.approval ??
        (await deps.readApproval(context, request, undefined, approvalObservation(current)));
      if (approval !== null && current.journal.approval === undefined) {
        await update(current, (value) => {
          value.journal.approval = approval;
          value.journal.state = "approved";
          return value;
        });
      }
      return { approved: approval !== null };
    },
    async readPlan(context: HostedOperatorContext, exportId: string) {
      const current = await read(context, z.uuid().parse(exportId));
      const { plan, planDigest, idempotencyKey } = current.journal;
      const request = parseHostedTenantExportRequestForPlan(
        { action: "export", planRef: plan.planRef, planDigest, idempotencyKey },
        plan,
      );
      return { plan, request, status: tenantExportStatus(current.journal) };
    },
    async status(context: HostedOperatorContext, exportId: string) {
      const current = await read(context, z.uuid().parse(exportId));
      return tenantExportStatus(current.journal);
    },
    async execute(
      context: HostedOperatorContext,
      input: HostedTenantExportRequest,
      callId: string,
    ) {
      const request = hostedTenantExportRequestSchema.parse(input);
      const exportId = request.planRef.split("/").at(-1);
      if (exportId === undefined) {
        throw mismatch();
      }
      let current = await read(context, exportId);
      parseHostedTenantExportRequestForPlan(request, current.journal.plan);
      if (request.idempotencyKey !== current.journal.idempotencyKey) {
        throw mismatch();
      }
      if (current.journal.state === "complete") {
        return tenantExportStatus(current.journal);
      }
      const approval = await assertApproval(context, current, callId);
      if (current.journal.approval === undefined) {
        current = await update(current, (value) => {
          value.journal.approval = approval;
          value.journal.state = "approved";
          return value;
        });
      }
      return await deps.withResourceLease(
        {
          lockKeys: [
            JSON.stringify([
              "hosted_protected_operator_database_v1",
              current.journal.plan.resource.projectId,
              current.journal.plan.resource.branchId,
              current.journal.plan.resource.database,
            ]),
          ],
          initializeUnderLock: async () => {
            current = await read(context, exportId);
            if (current.journal.state === "complete") {
              return;
            }
            await assertApproval(context, current, callId);
            const last = current.journal.attempts.at(-1);
            if (last !== undefined && last.state !== "failed") {
              const worker = workerFor(current.journal, last.attemptId);
              const locator = current.workers.find(
                (value) => value.attemptId === last.attemptId,
              )?.locator;
              const observed = await deps.inspect(context, worker, locator, async () => {
                const latest = await read(context, exportId);
                if (!isDeepStrictEqual(latest, current)) {
                  throw unavailable();
                }
                await assertApproval(context, latest, callId);
              });
              if (observed.status === "complete") {
                current = await complete(current, observed.completion);
                return;
              }
              if (observed.status !== "incomplete") {
                throw unavailable();
              }
              current = await update(current, (value) => {
                value.journal.attempts = value.journal.attempts.map((attempt) =>
                  attempt.attemptId === last.attemptId ? { ...attempt, state: "failed" } : attempt,
                );
                value.journal.state = "approved";
                delete value.journal.claim;
                return value;
              });
            }
            if (current.journal.state === "complete") {
              return;
            }
            const attemptId = randomUUID();
            current = await update(current, (value) => {
              value.journal.fenceGeneration += 1;
              value.journal.claim = {
                claimId: randomUUID(),
                fenceGeneration: value.journal.fenceGeneration,
                attemptId,
              };
              value.journal.attempts.push({
                attemptId,
                snapshotId: randomUUID(),
                state: "reserved",
              });
              value.journal.state = "approved";
              return value;
            });
          },
          readCurrentFence: async () => {
            const latest = await read(context, exportId);
            const claim = latest.journal.claim;
            if (latest.journal.state === "complete") {
              return {
                operationRef: exportId,
                leaseId: exportId,
                fenceGeneration: latest.journal.fenceGeneration,
              };
            }
            if (claim === undefined || !isDeepStrictEqual(claim, current.journal.claim)) {
              throw unavailable();
            }
            await assertApproval(context, latest, callId);
            return {
              operationRef: exportId,
              leaseId: claim.claimId,
              fenceGeneration: claim.fenceGeneration,
            };
          },
        },
        async (assertFence) => {
          if (current.journal.state === "complete") {
            return tenantExportStatus(current.journal);
          }
          const claim = current.journal.claim;
          if (claim === undefined) {
            throw unavailable();
          }
          const worker = workerFor(current.journal, claim.attemptId);
          const assertCurrent = assertFence;
          try {
            const locator = await deps.prepareWorker(context, worker, assertCurrent);
            await assertCurrent();
            current = await update(current, (value) => {
              value.workers.push({ attemptId: claim.attemptId, locator });
              return value;
            });
            current = await update(current, (value) => {
              value.journal.state = "reading";
              value.journal.attempts = value.journal.attempts.map((attempt) =>
                attempt.attemptId === claim.attemptId ? { ...attempt, state: "reading" } : attempt,
              );
              return value;
            });
            const source = await deps.runWorker(
              context,
              worker,
              locator,
              assertCurrent,
              async (observed) => {
                if (
                  observed.sandboxId !== locator.sandboxId ||
                  !isDeepStrictEqual(observed.descriptor, locator.descriptor)
                ) {
                  throw unavailable();
                }
                await assertCurrent();
                current = await update(current, (value) => {
                  value.workers = value.workers.map((entry) =>
                    entry.attemptId === claim.attemptId ? { ...entry, locator: observed } : entry,
                  );
                  return value;
                });
              },
            );
            await assertCurrent();
            current = await update(current, (value) => {
              value.journal.state = "publishing";
              value.journal.attempts = value.journal.attempts.map((attempt) =>
                attempt.attemptId === claim.attemptId
                  ? { ...attempt, state: "publishing" }
                  : attempt,
              );
              return value;
            });
            const completion = await deps.publish(context, worker, source, assertCurrent);
            await assertCurrent();
            current = await complete(current, completion);
            try {
              await deps.disposeWorker?.(locator);
            } catch {
              // Completion survives cleanup failure.
            }
            return tenantExportStatus(current.journal);
          } catch {
            current = await read(context, exportId);
            if (isDeepStrictEqual(current.journal.claim, claim)) {
              await update(current, (value) => {
                value.journal.state = "reconciliation-required";
                value.journal.attempts = value.journal.attempts.map((attempt) =>
                  attempt.attemptId === claim.attemptId
                    ? { ...attempt, state: "reconciliation-required" }
                    : attempt,
                );
                return value;
              });
            }
            throw unavailable();
          }
        },
      );
    },
  };
};
