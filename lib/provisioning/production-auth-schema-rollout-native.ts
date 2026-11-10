import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { z } from "zod";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Production Drizzle preserves the complete repository schema generic.
import * as schema from "../db/schema";
import { hostedRuntimePostgresOptions } from "../db/postgres-connection-policy";
import { createSameOriginEveTransport } from "../eve/same-origin-http";
import { readAuthSchemaRolloutApproval } from "../eve/private-auth-schema-rollout-approval";
import { diagnoseAuthSchemaApprovalPrefix } from "../eve/auth-schema-approval-diagnostic";
import type { MessageStreamEvent } from "eve/client";
import { HostedOperatorError, operatorOwnerContextSchema } from "./hosted-operator-contract";
import { createHostedOperatorConsentOwner } from "./hosted-operator-consent-owner";
import { createBuilderApprovalStreamFetch } from "./hosted-operator-approval-observer";
import { readHostedOperatorOwnerReaderConfiguration } from "./hosted-operator-owner-context";
import { runProductionAuthSchemaFileSpool } from "./hosted-operator-sandbox-launcher";
import type { ProtectedInstallContextWire } from "./hosted-operator-sandbox-launcher";
import { centralHostCanonicalBytes } from "./central-integration-host-contract";
import {
  assertAuthSchemaRolloutEnrollment,
  readAuthSchemaRolloutConfiguration,
  resolveAuthSchemaRolloutProfile,
} from "./production-auth-schema-rollout-configuration";
import {
  createPostgresAuthSchemaRolloutStore,
  createAuthSchemaRolloutLease,
} from "./production-auth-schema-rollout-store";
import { createProductionAuthSchemaProposal } from "./production-auth-schema-rollout-proposal";
import { createAuthSchemaRollout } from "./production-auth-schema-rollout";
import type {
  AuthSchemaRolloutPorts,
  AuthSchemaRolloutStore,
} from "./production-auth-schema-rollout";
import type { AuthSchemaRolloutRow } from "./production-auth-schema-rollout-contract";
import {
  observeAuthSchemaRolloutPhase,
  observeAuthSchemaRolloutPhaseSync,
} from "./production-auth-schema-rollout-diagnostic";

const ownerFields = {
  version: z.literal(1),
  sessionId: z.string().min(1),
  ownerContext: operatorOwnerContextSchema,
};
export const authSchemaRolloutRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ ...ownerFields, action: z.literal("plan"), profileId: z.string().min(1) }),
  z.strictObject({ ...ownerFields, action: z.literal("status"), operationRef: z.uuid() }),
  z.strictObject({
    ...ownerFields,
    action: z.literal("execute"),
    operationRef: z.uuid(),
    planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    approvedByCallId: z.string().min(1),
  }),
]);

export const authSchemaRolloutWorkerContext = (
  row: AuthSchemaRolloutRow,
): ProtectedInstallContextWire => {
  const { record } = row;
  const { plan } = record;
  const { resource } = plan;
  if (!record.lease || !record.approval) {
    throw new HostedOperatorError("authorization_required");
  }
  return {
    version: 1,
    operation: {
      operation_id: plan.operationRef,
      approval_digest: plan.planDigest,
      fence_generation: record.lease.fenceGeneration,
    },
    app_id: "auth",
    resource: {
      resource_id: resource.resourceId,
      environment: "production",
      hostname: resource.hostname,
      port: resource.port,
      database: resource.database,
      schema: resource.schema,
      migrator_role: resource.migratorRole,
      runtime_role: resource.runtimeRole,
      provider_project_id: resource.neon.projectId,
      provider_branch_id: resource.neon.branchId,
    },
    release: { id: plan.targetDigest, sha256: plan.schemaPlanDigest },
    installer: { id: record.runtime.worker.id, sha256: record.runtime.worker.sha256 },
    tenant_targets: [],
  };
};
/** No app-creator endpoint or input. This private service route requires both the
 * trusted Builder workload and the canonical, deployment-enrolled administrator.
 */
export const createAuthSchemaRolloutNativeHandler =
  (
    environment: Readonly<Record<string, string | undefined>> = process.env,
    dependencies: {
      consent?: Parameters<typeof createHostedOperatorConsentOwner>[2];
      propose?: ReturnType<typeof createProductionAuthSchemaProposal>;
      approvalFetch?: typeof fetch;
      openJournal?: (databaseUrl: string) => Promise<{
        store: AuthSchemaRolloutStore;
        close: () => Promise<void>;
      }>;
    } = {},
  ) =>
  async (request: Request) => {
    if (request.method !== "POST") {
      return Response.json({ code: "not_found" }, { status: 404 });
    }
    const configuration = observeAuthSchemaRolloutPhaseSync("configuration", () =>
      readAuthSchemaRolloutConfiguration(environment),
    );
    const input = await observeAuthSchemaRolloutPhase("request_validation", async () =>
      authSchemaRolloutRequestSchema.parse(await request.json()),
    );
    const { consent, current } = await observeAuthSchemaRolloutPhase(
      "canonical_owner",
      async () => {
        const selected = createHostedOperatorConsentOwner(
          configuration.builderWorkload,
          environment,
          dependencies.consent,
        );
        return {
          consent: selected,
          current: await selected.authorize(request, input.sessionId, input.ownerContext),
        };
      },
    );
    const owner = current.ownerContext;
    const assertOwner: AuthSchemaRolloutPorts["assertOwner"] = async (expected) => {
      await observeAuthSchemaRolloutPhase("owner_recheck", async () => {
        request.signal.throwIfAborted();
        if (!isDeepStrictEqual(expected, owner)) {
          throw new HostedOperatorError("authorization_required");
        }
        await consent.assertCurrent(current);
      });
    };
    const settings = observeAuthSchemaRolloutPhaseSync("owner_reader_configuration", () =>
      readHostedOperatorOwnerReaderConfiguration(environment),
    );
    const journalConnection = await observeAuthSchemaRolloutPhase(
      "journal_initialize",
      async () => {
        if (dependencies.openJournal) {
          return await dependencies.openJournal(settings.databaseUrl);
        }
        const client = postgres(settings.databaseUrl, hostedRuntimePostgresOptions);
        try {
          return {
            store: createPostgresAuthSchemaRolloutStore(drizzle(client, { schema })),
            close: async () => {
              await client.end({ timeout: 5 });
            },
          };
        } catch (error) {
          await client.end({ timeout: 5 });
          throw error;
        }
      },
    );
    try {
      const journal = journalConnection.store;
      const store: AuthSchemaRolloutStore = {
        read: async (scope, operationRef) =>
          await observeAuthSchemaRolloutPhase(
            "journal_read",
            async () => await journal.read(scope, operationRef),
          ),
        reserve: async (record) =>
          await observeAuthSchemaRolloutPhase(
            "journal_save",
            async () => await journal.reserve(record),
          ),
        compareAndSet: async (row, record) =>
          await observeAuthSchemaRolloutPhase(
            "journal_save",
            async () => await journal.compareAndSet(row, record),
          ),
      };
      const profile: AuthSchemaRolloutPorts["profile"] = (scope, record) =>
        observeAuthSchemaRolloutPhaseSync("profile_selection", () =>
          record
            ? assertAuthSchemaRolloutEnrollment(configuration, record)
            : resolveAuthSchemaRolloutProfile(configuration, scope),
        );
      const readMigrationUrl = async (
        row: AuthSchemaRolloutRow,
        assertCurrent: () => Promise<void>,
      ) => {
        await assertCurrent();
        const value = environment[row.record.runtime.migrationConnectionEnvironment];
        if (value === undefined || value === "") {
          throw new HostedOperatorError("operator_unavailable");
        }
        return value;
      };
      const invoke = async (
        row: AuthSchemaRolloutRow,
        assertCurrent: () => Promise<void>,
        readOnly: boolean,
        checkpoint?: Parameters<AuthSchemaRolloutPorts["apply"]>[2],
        beforeWorkerDispatch?: () => Promise<void>,
      ) => {
        // An actual native effect approval is required before the mutation adapter can
        // resolve a migration credential. Planning has a separate pinned read-only binary.
        if (!row.record.approval) {
          throw new HostedOperatorError("authorization_required");
        }
        await assertCurrent();
        return await runProductionAuthSchemaFileSpool(
          { ...row.record.runtime.sandbox, workers: {} },
          {
            worker: row.record.runtime.worker,
            context: authSchemaRolloutWorkerContext(row),
            operatorPlan: centralHostCanonicalBytes(row.record.operatorPlan),
            authSchemaPlan: centralHostCanonicalBytes(row.record.proposal),
            directDatabaseUrl: await readMigrationUrl(row, assertCurrent),
            readOnly,
            runId: readOnly ? randomUUID() : row.record.plan.operationRef,
            signal: request.signal,
            assertCurrent,
            recordCheckpoint: checkpoint,
            beforeWorkerDispatch,
          },
        );
      };
      const approvalHistory = (assertCurrent: () => Promise<void>) => {
        const carrier = request.headers.get("authorization");
        if (carrier === null || !carrier.startsWith("Bearer ")) {
          throw new HostedOperatorError("authorization_required");
        }
        const { origin } = new URL(settings.issuer);
        const transport = createSameOriginEveTransport({
          config: { baseUrl: origin },
          // oxlint-disable-next-line typescript/promise-function-async -- Workload is already verified and request-bound.
          workloadIdentity: { token: () => Promise.resolve(carrier.slice(7)) },
          fetchImplementation: createBuilderApprovalStreamFetch({
            origin,
            adapterSessionId: owner.adapterSessionId,
            signal: request.signal,
            fetchImplementation: dependencies.approvalFetch ?? fetch,
          }),
          verifyReadAuthority: async (read) => {
            if (
              read.adapterSessionId !== owner.adapterSessionId ||
              read.sessionId !== owner.sessionId ||
              !isDeepStrictEqual(read.principal, owner.principal)
            ) {
              return false;
            }
            await assertCurrent();
            return true;
          },
        });
        const { observePrivateHistory } = transport;
        if (observePrivateHistory === undefined) {
          throw new HostedOperatorError("operator_unavailable");
        }
        return async (
          startIndex: number,
          onEvent: (event: MessageStreamEvent) => void,
          endIndexExclusive?: number,
        ) => {
          const read: Parameters<typeof observePrivateHistory>[0] = {
            principal: owner.principal,
            adapterSessionId: owner.adapterSessionId,
            sessionId: owner.sessionId,
            startIndex,
            onEvent,
          };
          if (endIndexExclusive !== undefined) {
            read.endIndexExclusive = endIndexExclusive;
          }
          return await observePrivateHistory(read);
        };
      };
      const service = createAuthSchemaRollout({
        store,
        assertOwner,
        profile,
        propose: async (selected, assertCurrent) =>
          await (dependencies.propose ?? createProductionAuthSchemaProposal())({
            profile: selected,
            assertCurrent,
            readMigrationUrl: async () => {
              await assertCurrent();
              const value = environment[selected.runtime.migrationConnectionEnvironment];
              if (value === undefined || value === "") {
                throw new HostedOperatorError("operator_unavailable");
              }
              return value;
            },
          }),
        withLease: createAuthSchemaRolloutLease({
          databaseUrl: settings.databaseUrl,
          store,
          assertCurrent: async (row) => {
            await assertOwner(owner);
            profile(row.record.plan.scope, row.record);
          },
        }),
        approval: async (approval) => {
          const readHistory = approvalHistory(approval.assertCurrent);
          return await readAuthSchemaRolloutApproval({
            plan: approval.plan,
            callId: approval.callId,
            owner,
            observation: { state: approval.observation, save: approval.save },
            assertOwner: approval.assertCurrent,
            readHistory,
          });
        },
        diagnoseApproval: async (row, assertCurrent) => {
          const observation = row.record.approvalObservation;
          if (observation === undefined) {
            return;
          }
          const readHistory = approvalHistory(assertCurrent);
          await diagnoseAuthSchemaApprovalPrefix({
            plan: row.record.plan,
            endIndexExclusive: observation.nextNativeIndex,
            assertCurrent,
            readHistory: async (endIndexExclusive, onEvent) =>
              await readHistory(0, onEvent, endIndexExclusive),
          });
        },
        apply: async (row, assertCurrent, checkpoint, beforeWorkerDispatch) => {
          await invoke(row, assertCurrent, false, checkpoint, beforeWorkerDispatch);
        },
        inspect: async (row, assertCurrent) => {
          try {
            const observed = z
              .object({
                status: z.literal("applied"),
                readback_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
              })
              .parse(await invoke(row, assertCurrent, true));
            return { state: "applied", readbackSha256: observed.readback_sha256 };
          } catch {
            return { state: "unknown" };
          }
        },
      });
      let result;
      if (input.action === "plan") {
        result = await service.plan(owner, input.profileId);
      } else if (input.action === "status") {
        result = await service.status(owner, input.operationRef);
      } else {
        result = await service.execute(
          owner,
          input.operationRef,
          input.planDigest,
          input.approvedByCallId,
        );
      }
      return Response.json(result, { headers: { "cache-control": "no-store" } });
    } finally {
      await observeAuthSchemaRolloutPhase("journal_cleanup", async () => {
        await journalConnection.close();
      });
    }
  };
