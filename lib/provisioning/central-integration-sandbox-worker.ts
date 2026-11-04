/* oxlint-disable sonarjs/expression-complexity -- The complete approved scope and direct TLS credential tuple must agree before native dispatch. */
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  centralHostCanonicalBytes,
  centralHostPlanDigest,
  centralHostOperationRef,
} from "./central-integration-host-contract";
import type { CentralHostEffectContext } from "./central-integration-host-service";
import {
  centralEffectReceiptSchema,
  centralEffectReceiptMatches,
} from "./central-integration-host-checkpoint";
import type { CentralEffectReceipt } from "./central-integration-host-checkpoint";
import {
  runCentralIntegrationFileSpool,
  runAppIntegrationFileSpool,
} from "./hosted-operator-sandbox-launcher";
import type {
  HostedOperatorSandboxConfiguration,
  CentralIntegrationContextWire,
  ResourceBootstrapContextWire,
} from "./hosted-operator-sandbox-launcher";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const unavailable = () => new Error("central_integration_worker_unavailable");
export interface CentralIntegrationWorkerPrivateFiles {
  connections: { migrator: string; runtime: string };
  resourceCredentials: { migratorPassword: string; runtimePassword: string };
  bootstrap: { databaseUrl: string; role: string; maintenanceDatabase: string };
}
const connection = (
  value: string,
  expected: { hostname: string; port: number; database: string; role: string; password?: string },
) => {
  const url = new URL(value);
  const validEndpoint =
    ["postgresql:", "postgres:"].includes(url.protocol) &&
    url.hostname === expected.hostname &&
    url.port === String(expected.port) &&
    !url.hostname.includes("-pooler");
  const validRole =
    decodeURIComponent(url.username) === expected.role &&
    !!url.password &&
    (expected.password === undefined || decodeURIComponent(url.password) === expected.password);
  const validTls =
    url.searchParams.getAll("sslmode").length === 1 &&
    url.searchParams.get("sslmode") === "verify-full" &&
    [...url.searchParams.keys()].every((key) => key === "sslmode" || key === "channel_binding") &&
    url.searchParams.getAll("channel_binding").length <= 1 &&
    (!url.searchParams.has("channel_binding") ||
      url.searchParams.get("channel_binding") === "require");
  if (
    !validEndpoint ||
    !validRole ||
    !validTls ||
    decodeURIComponent(url.pathname.slice(1)) !== expected.database ||
    url.hash
  ) {
    throw unavailable();
  }
};
/** Fixed native resource/schema commands; private files must already exist under the approved frozen pointer. */
export const createCentralIntegrationSandboxWorker = (input: {
  configuration: HostedOperatorSandboxConfiguration;
  readPrivateFiles: (
    context: CentralHostEffectContext,
  ) => Promise<CentralIntegrationWorkerPrivateFiles>;
  run?: typeof runCentralIntegrationFileSpool;
  runResources?: typeof runAppIntegrationFileSpool;
}) => {
  const prepare = async (context: CentralHostEffectContext, readOnly: boolean) => {
    await context.assertCurrent();
    const plan = context.plan;
    if (
      plan.kind !== "central-integration-host-setup-v1" ||
      !["prepare-central-resources", "install-central-schema"].includes(context.effect) ||
      context.planDigest !== centralHostPlanDigest(plan) ||
      context.operationRef !== centralHostOperationRef(plan) ||
      !isDeepStrictEqual(context.invocation.authority, plan.authority) ||
      context.invocation.sessionId !== plan.selection.sessionId
    ) {
      throw unavailable();
    }
    z.number().int().positive().parse(context.attemptGeneration);
    if (
      !readOnly &&
      (context.priorPhase !== "idle" || context.attemptGeneration !== context.fenceGeneration)
    ) {
      throw unavailable();
    }
    const privateFiles = await input.readPrivateFiles(context);
    await context.assertCurrent();
    const resource = plan.control.resource;
    const common = {
      hostname: resource.hostname,
      port: resource.port,
      database: resource.database,
    };
    connection(privateFiles.connections.migrator, {
      ...common,
      role: resource.migratorRole,
      password: privateFiles.resourceCredentials.migratorPassword,
    });
    connection(privateFiles.connections.runtime, {
      ...common,
      role: plan.control.centralRuntimeRole,
      password: privateFiles.resourceCredentials.runtimePassword,
    });
    connection(privateFiles.bootstrap.databaseUrl, {
      ...common,
      database: privateFiles.bootstrap.maintenanceDatabase,
      role: privateFiles.bootstrap.role,
    });
    if (
      privateFiles.resourceCredentials.migratorPassword ===
      privateFiles.resourceCredentials.runtimePassword
    ) {
      throw unavailable();
    }
    const allocation = context.effect === "prepare-central-resources";
    const frozen = allocation ? plan.source.workers.resources : plan.source.workers.schema;
    const descriptor = allocation
      ? [input.configuration.integrationResourcesWorker, input.configuration.resourcesWorker].find(
          (candidate) =>
            candidate?.id === frozen.id &&
            candidate.sha256 === frozen.sha256 &&
            candidate.operationScope === "neon-resource-bootstrap-v1",
        )
      : input.configuration.centralIntegrationWorker;
    if (!descriptor || descriptor.id !== frozen.id || descriptor.sha256 !== frozen.sha256) {
      throw unavailable();
    }
    const commands = {
      resources: { inspect: "neon-resource-inspect", execute: "neon-resource-bootstrap" },
      schema: {
        inspect: "central-integration-schema-readback",
        execute: "central-integration-schema",
      },
    } as const;
    const worker = {
      ...descriptor,
      subcommand: commands[allocation ? "resources" : "schema"][readOnly ? "inspect" : "execute"],
    };
    const operation = {
      operation_id: context.operationRef,
      approval_digest: context.planDigest,
      fence_generation: context.attemptGeneration,
    };
    const release = { id: plan.source.configurationRef, sha256: plan.source.configurationSha256 };
    const installer = { id: worker.id, sha256: worker.sha256 };
    const credentials = Buffer.from(JSON.stringify(privateFiles.resourceCredentials));
    const base = {
      version: 1 as const,
      operation,
      app_id: "integrations" as const,
      release,
      installer,
      tenant_targets: [],
    };
    const schemaWire: CentralIntegrationContextWire = {
      ...base,
      kind: "central_integration_schema",
      resource: {
        resource_id: resource.resourceId,
        environment: "preview",
        hostname: resource.hostname,
        port: resource.port,
        database: resource.database,
        schema: resource.schema,
        migrator_role: resource.migratorRole,
        runtime_role: plan.control.centralRuntimeRole,
        provider_project_id: plan.control.neon.projectId,
        provider_branch_id: plan.control.neon.branchId,
        provider_endpoint_id: plan.control.neon.endpointId,
      },
    };
    const resourceWire: ResourceBootstrapContextWire = {
      ...base,
      kind: "neon_resource_bootstrap",
      resource: {
        scope: "integration_control_database",
        resource_id: resource.resourceId,
        environment: "preview",
        hostname: resource.hostname,
        port: resource.port,
        database: resource.database,
        migrator_role: resource.migratorRole,
        runtime_role: plan.control.centralRuntimeRole,
        maintenance_database: privateFiles.bootstrap.maintenanceDatabase,
        bootstrap_role: privateFiles.bootstrap.role,
        provider_project_id: plan.control.neon.projectId,
        provider_branch_id: plan.control.neon.branchId,
        provider_endpoint_id: plan.control.neon.endpointId,
        credentials_sha256: hash(credentials),
      },
    };
    const startupFiles = {
      "central-integration-approved-plan.json": centralHostCanonicalBytes(plan),
      ...(allocation
        ? {}
        : {
            "central-integration-connections.json": Buffer.from(
              JSON.stringify(privateFiles.connections),
            ),
          }),
    };
    const resourceVersion = hash(
      centralHostCanonicalBytes({
        operationRef: context.operationRef,
        planDigest: context.planDigest,
        effect: context.effect,
        attemptGeneration: context.attemptGeneration,
      }),
    );
    const schemaReceipt = () =>
      centralEffectReceiptSchema.parse({
        effect: "install-central-schema",
        resourceProfileId: plan.resourceProfileId,
        schemaSha256: plan.control.schemaSha256,
        configurationSha256: plan.source.configurationSha256,
        centralPrincipalGeneration: context.attemptGeneration,
      });
    return {
      plan,
      allocation,
      worker,
      credentials,
      schemaWire,
      resourceWire,
      startupFiles,
      resourceVersion,
      schemaReceipt,
      privateFiles,
    };
  };
  const run = async (
    context: CentralHostEffectContext,
    readOnly: boolean,
    recordCheckpoint?: Parameters<typeof runAppIntegrationFileSpool>[1]["recordCheckpoint"],
  ) => {
    const prepared = await prepare(context, readOnly);
    const common = {
      worker: prepared.worker,
      runId: randomUUID(),
      startupFiles: prepared.startupFiles,
      readOnly,
      signal: context.invocation.signal,
      assertCurrent: context.assertCurrent,
      recordCheckpoint,
    };
    const result = prepared.allocation
      ? await (input.runResources ?? runAppIntegrationFileSpool)(input.configuration, {
          ...common,
          context: prepared.resourceWire,
          directDatabaseUrl: prepared.privateFiles.bootstrap.databaseUrl,
          resourceCredentialBytes: prepared.credentials,
        })
      : await (input.run ?? runCentralIntegrationFileSpool)(input.configuration, {
          ...common,
          context: prepared.schemaWire,
          directDatabaseUrl: prepared.privateFiles.connections.migrator,
        });
    await context.assertCurrent();
    return { prepared, result };
  };
  const inspect = async (context: CentralHostEffectContext): Promise<CentralEffectReceipt> => {
    const { prepared, result } = await run(context, true);
    if (!result || result.status !== "applied") {
      throw unavailable();
    }
    if (prepared.allocation) {
      const observation = z
        .object({
          resource_id: z.literal(prepared.plan.control.resource.resourceId),
          scope: z.literal("integration_control_database"),
          readback_sha256: digest,
        })
        .parse(result);
      const prior = await context.checkpoint.read();
      if (prior.attemptGeneration !== context.attemptGeneration) {
        throw unavailable();
      }
      if (prior.receipt !== undefined) {
        if (
          prior.receipt.effect !== "prepare-central-resources" ||
          prior.receipt.resourceVersion !== prepared.resourceVersion ||
          !centralEffectReceiptMatches(prepared.plan, prior.receipt, context.attemptGeneration)
        ) {
          throw unavailable();
        }
        // The accepted ACL checkpoint digest and an independent full-resource inspection digest are distinct facts.
        return prior.receipt;
      }
      return centralEffectReceiptSchema.parse({
        effect: "prepare-central-resources",
        resourceId: prepared.plan.control.resource.resourceId,
        resourceVersion: prepared.resourceVersion,
        readbackSha256: observation.readback_sha256,
      });
    }
    const observation = z
      .object({
        receipt: z.strictObject({
          centralPrincipalGeneration: z.number().int().positive(),
          schemaSha256: digest,
          resourceProfileId: z.string().min(1),
          configurationSha256: digest,
        }),
      })
      .parse(result);
    const receipt = centralEffectReceiptSchema.parse({
      effect: "install-central-schema",
      ...observation.receipt,
    });
    const envelope = z.object({ readback_sha256: digest }).parse(result);
    if (envelope.readback_sha256 !== hash(centralHostCanonicalBytes(observation.receipt))) {
      throw unavailable();
    }
    const prior = await context.checkpoint.read();
    if (
      !centralEffectReceiptMatches(prepared.plan, receipt, context.attemptGeneration) ||
      prior.attemptGeneration !== context.attemptGeneration ||
      (prior.receipt !== undefined && !isDeepStrictEqual(prior.receipt, receipt))
    ) {
      throw unavailable();
    }
    return receipt;
  };
  return {
    execute: async (context: CentralHostEffectContext): Promise<CentralEffectReceipt> => {
      const prepared = await prepare(context, false);
      // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Re-read the current durable attempt only after private scope authorization completes.
      const existing = await context.checkpoint.read();
      if (existing.receipt !== undefined) {
        throw unavailable();
      }
      let accepted: CentralEffectReceipt | undefined;
      await run(context, false, async (frame) => {
        await context.assertCurrent();
        if (frame.receipt.state !== "applied" && frame.receipt.state !== "no_change") {
          throw unavailable();
        }
        if (frame.effectId === (prepared.allocation ? "resources:acl" : "install-central-schema")) {
          const readbackSha256 = digest.parse(frame.receipt.readbackSha256);
          if (!prepared.allocation) {
            const expectedReadback = {
              centralPrincipalGeneration: context.attemptGeneration,
              schemaSha256: prepared.plan.control.schemaSha256,
              resourceProfileId: prepared.plan.resourceProfileId,
              configurationSha256: prepared.plan.source.configurationSha256,
            };
            if (readbackSha256 !== hash(centralHostCanonicalBytes(expectedReadback))) {
              throw unavailable();
            }
          }
          accepted = prepared.allocation
            ? centralEffectReceiptSchema.parse({
                effect: "prepare-central-resources",
                resourceId: prepared.plan.control.resource.resourceId,
                resourceVersion: prepared.resourceVersion,
                readbackSha256,
              })
            : prepared.schemaReceipt();
          await context.checkpoint.recordAccepted(accepted);
          await context.assertCurrent();
        }
      });
      if (accepted === undefined) {
        throw unavailable();
      }
      const observed = await inspect(context);
      if (!isDeepStrictEqual(observed, accepted)) {
        throw unavailable();
      }
      return observed;
    },
    reconcile: async (
      context: CentralHostEffectContext,
    ): Promise<{ status: "applied"; receipt: CentralEffectReceipt } | { status: "unknown" }> => {
      if (context.priorPhase !== "pending") {
        throw unavailable();
      }
      try {
        return { status: "applied", receipt: await inspect(context) };
      } catch {
        context.invocation.signal.throwIfAborted();
        return { status: "unknown" };
      }
    },
  };
};
