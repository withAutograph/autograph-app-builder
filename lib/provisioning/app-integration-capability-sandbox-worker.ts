/* oxlint-disable eslint/complexity, eslint/no-nested-ternary, sonarjs/no-nested-conditional, sonarjs/expression-complexity, sonarjs/cognitive-complexity -- The closed four-stage worker matrix preserves distinct resource, schema, membership and atomic registration authority. */
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type {
  AppIntegrationCapabilityWorker,
  AppIntegrationCapabilityEffectContext,
} from "./app-integration-capability-ports";
import {
  canonicalAppIntegrationCapabilityPlanBytes,
  integrationCapabilityReceiptSchema,
} from "./app-integration-capability-contract";
import type { IntegrationCapabilityReceipt } from "./app-integration-capability-contract";
import { assertIntegrationCapabilityReceipt } from "./app-integration-capability-receipts";
import { runAppIntegrationFileSpool } from "./hosted-operator-sandbox-launcher";
import type {
  HostedOperatorSandboxConfiguration,
  ProtectedInstallContextWire,
  ResourceBootstrapContextWire,
} from "./hosted-operator-sandbox-launcher";
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z.string().min(1);
const registration = z.strictObject({
  kind: z.literal("app-integration-application-authority-v1"),
  resourceProfileId: id,
  appId: id,
  registrationIdentitySha256: digest,
  operationRef: z.uuid(),
  planDigest: digest,
  principalName: id,
  principalGeneration: z.number().int().positive(),
  customerIds: z.array(id).min(1),
  scopeSha256: digest,
  configurationRef: z.uuid(),
  configurationSha256: digest,
  authoritySha256: digest,
  keyId: id,
  active: z.literal(true),
  sealed: z.strictObject({ encryptedToken: id, tokenIv: id, tokenTag: id }),
});
type CanonicalValue = z.infer<ReturnType<typeof z.json>>;
const canonical = (value: CanonicalValue): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The input is a parsed JSON value; this branch only serializes its representation.
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
export interface AppIntegrationWorkerPrivateFiles {
  connections: {
    controlMigrator: string;
    controlRuntime: string;
    applicationMigrator: string;
    applicationRuntime: string;
  };
  controlCredentials: { migratorPassword: string; runtimePassword: string };
  controlBootstrap?: { databaseUrl: string; role: string; maintenanceDatabase: string };
  authority?: z.infer<typeof registration>;
}
const unavailable = () => new Error("app_integration_worker_unavailable");
/** Fixed native commands only. Custody is resolved and persisted before this adapter can dispatch. */
export const createAppIntegrationCapabilitySandboxWorker = (input: {
  configuration: HostedOperatorSandboxConfiguration;
  readPrivateFiles: (
    context: AppIntegrationCapabilityEffectContext,
  ) => Promise<AppIntegrationWorkerPrivateFiles>;
  run?: typeof runAppIntegrationFileSpool;
}): AppIntegrationCapabilityWorker => {
  const run = input.run ?? runAppIntegrationFileSpool;
  const prepare = async (context: AppIntegrationCapabilityEffectContext, readOnly: boolean) => {
    await context.assertCurrent();
    const workerEffect = z
      .enum([
        "prepare-control-database",
        "install-control-schema",
        "bind-service-memberships",
        "register-central-app",
      ])
      .safeParse(context.effect);
    if (!workerEffect.success) {
      // Provider destination effects belong to the provider adapter, never a SQL worker.
      throw unavailable();
    }
    const privateFiles = await input.readPrivateFiles(context);
    await context.assertCurrent();
    const { plan } = context;
    const allocation = context.effect === "prepare-control-database";
    const selected =
      context.effect === "bind-service-memberships"
        ? plan.runtime.appDatabase
        : plan.control.database;
    const neon =
      context.effect === "bind-service-memberships" ? plan.runtime.neon : plan.control.neon;
    const resourcePin =
      "resourceWorker" in plan && plan.resourceWorker !== undefined
        ? z
            .strictObject({ id: z.literal("neon-resource-bootstrap-v1"), sha256: digest })
            .parse(plan.resourceWorker)
        : undefined;
    const version = z.union([z.literal(1), z.literal(2)]).parse(plan.version);
    if ((version === 2) !== (resourcePin !== undefined)) {
      throw unavailable();
    }
    const descriptor = allocation
      ? resourcePin === undefined
        ? input.configuration.resourcesWorker
        : input.configuration.integrationResourcesWorker
      : input.configuration.integrationWorker;
    if (
      !descriptor ||
      (allocation &&
        resourcePin !== undefined &&
        (descriptor.id !== resourcePin.id ||
          descriptor.sha256 !== resourcePin.sha256 ||
          descriptor.operationScope !== "neon-resource-bootstrap-v1")) ||
      (!allocation &&
        (descriptor.id !== plan.worker.reference || descriptor.sha256 !== plan.worker.sha256))
    )
      throw unavailable();
    const commands = {
      "prepare-control-database": "neon-resource-bootstrap",
      "install-control-schema": "integration-control-schema",
      "bind-service-memberships": "integration-service-memberships",
      "register-central-app": "integration-register-central-app",
    } as const;
    const command = commands[workerEffect.data];
    const subcommand = allocation
      ? readOnly
        ? "neon-resource-inspect"
        : "neon-resource-bootstrap"
      : `${command}${readOnly ? "-readback" : ""}`;
    const worker = {
      ...descriptor,
      subcommand: z
        .enum([
          "neon-resource-bootstrap",
          "neon-resource-inspect",
          "integration-control-schema",
          "integration-control-schema-readback",
          "integration-service-memberships",
          "integration-service-memberships-readback",
          "integration-register-central-app",
          "integration-register-central-app-readback",
        ])
        .parse(subcommand),
    };
    const operation = {
      operation_id: context.operationRef,
      approval_digest: context.planDigest,
      fence_generation: context.fenceGeneration,
    };
    const release = { id: plan.release.id, sha256: plan.release.manifestSha256 };
    const installer = { id: worker.id, sha256: worker.sha256 };
    const resource = {
      resource_id: selected.resourceId,
      environment: "preview" as const,
      hostname: selected.hostname,
      port: selected.port,
      database: selected.database,
      schema: "public" as const,
      migrator_role: selected.migratorRole,
      runtime_role: selected.runtimeRole,
      provider_project_id: neon.projectId,
      provider_branch_id: neon.branchId,
    };
    const protectedContext: ProtectedInstallContextWire = {
      version: 1,
      operation,
      app_id: plan.selection.appId,
      resource,
      release,
      installer,
      tenant_targets: plan.serviceMemberships.map((row) => row.organizationId).toSorted(),
    };
    const credentials = Buffer.from(JSON.stringify(privateFiles.controlCredentials));
    const bootstrap = privateFiles.controlBootstrap;
    let wire: ProtectedInstallContextWire | ResourceBootstrapContextWire = protectedContext;
    if (allocation) {
      if (!bootstrap) throw unavailable();
      const url = new URL(bootstrap.databaseUrl);
      if (
        url.protocol !== "postgresql:" ||
        url.hostname !== selected.hostname ||
        decodeURIComponent(url.pathname.slice(1)) !== bootstrap.maintenanceDatabase ||
        decodeURIComponent(url.username) !== bootstrap.role ||
        !url.password ||
        url.hash ||
        url.hostname.includes("-pooler") ||
        !["require", "verify-full"].includes(url.searchParams.get("sslmode") ?? "") ||
        [...url.searchParams.keys()].some((key) => !["sslmode", "channel_binding"].includes(key))
      )
        throw unavailable();
      wire = {
        kind: "neon_resource_bootstrap",
        version: 1,
        operation,
        app_id: "integrations",
        resource: {
          scope: "integration_control_database",
          resource_id: selected.resourceId,
          environment: "preview",
          hostname: selected.hostname,
          port: selected.port,
          database: selected.database,
          migrator_role: selected.migratorRole,
          runtime_role: selected.runtimeRole,
          maintenance_database: bootstrap.maintenanceDatabase,
          bootstrap_role: bootstrap.role,
          provider_project_id: neon.projectId,
          provider_branch_id: neon.branchId,
          provider_endpoint_id: neon.endpointId,
          credentials_sha256: sha(credentials),
        },
        release,
        installer,
        tenant_targets: [],
      };
    }
    const authority =
      context.effect === "register-central-app"
        ? registration.parse(privateFiles.authority)
        : undefined;
    if (
      authority &&
      (authority.operationRef !== context.operationRef ||
        authority.planDigest !== context.planDigest ||
        authority.appId !== plan.selection.appId ||
        authority.resourceProfileId !== plan.control.resourceProfileId ||
        authority.registrationIdentitySha256 !== plan.control.registrationIdentitySha256 ||
        authority.principalName !== plan.control.database.runtimeRole ||
        authority.principalGeneration !== context.attemptGeneration ||
        !isDeepStrictEqual(
          authority.customerIds,
          plan.serviceMemberships.map((row) => row.organizationId).toSorted(),
        ))
    )
      throw unavailable();
    const startupFiles = {
      "app-integration-approved-plan.json": Buffer.from(
        canonicalAppIntegrationCapabilityPlanBytes(plan),
      ),
      ...(allocation
        ? {}
        : {
            "app-integration-connections.json": Buffer.from(
              JSON.stringify(privateFiles.connections),
            ),
            ...(authority
              ? { "app-integration-authority.json": Buffer.from(JSON.stringify(authority)) }
              : {}),
          }),
    };
    const resourceVersion = sha(
      canonical({
        operationRef: context.operationRef,
        planDigest: context.planDigest,
        effect: context.effect,
        attemptGeneration: context.attemptGeneration,
      }),
    );
    const receipt = (): IntegrationCapabilityReceipt => {
      if (context.effect === "register-central-app" && !authority) throw unavailable();
      return integrationCapabilityReceiptSchema.parse(
        context.effect === "prepare-control-database"
          ? {
              effect: context.effect,
              resourceVersion,
              resourceId: selected.resourceId,
              database: selected.database,
              runtimeRole: selected.runtimeRole,
              migratorRole: selected.migratorRole,
            }
          : context.effect === "install-control-schema"
            ? { effect: context.effect, resourceVersion, schemaSha256: plan.control.schema.sha256 }
            : context.effect === "bind-service-memberships"
              ? {
                  effect: context.effect,
                  resourceVersion,
                  memberships: plan.serviceMemberships.map((member) => ({
                    ...member,
                    fenceGeneration: context.attemptGeneration,
                  })),
                }
              : {
                  effect: context.effect,
                  resourceVersion,
                  appId: plan.selection.appId,
                  resourceProfileId: plan.control.resourceProfileId,
                  registrationRef: registration.parse(authority).operationRef,
                  registrationDigest: sha(canonical(registration.parse(authority))),
                  principalGeneration: registration.parse(authority).principalGeneration,
                },
      );
    };
    const directDatabaseUrl = allocation
      ? bootstrap?.databaseUrl
      : context.effect === "bind-service-memberships"
        ? privateFiles.connections.applicationMigrator
        : privateFiles.connections.controlMigrator;
    if (directDatabaseUrl === undefined || directDatabaseUrl === "") throw unavailable();
    return { privateFiles, worker, wire, credentials, startupFiles, receipt, directDatabaseUrl };
  };
  const inspect = async (context: AppIntegrationCapabilityEffectContext) => {
    const prepared = await prepare(context, true);
    const result = await run(input.configuration, {
      worker: prepared.worker,
      context: prepared.wire,
      runId: randomUUID(),
      directDatabaseUrl: prepared.directDatabaseUrl,
      startupFiles: prepared.startupFiles,
      resourceCredentialBytes:
        context.effect === "prepare-control-database" ? prepared.credentials : undefined,
      readOnly: true,
      signal: context.invocation.signal,
      assertCurrent: context.assertCurrent,
    });
    await context.assertCurrent();
    if (!result || result.status !== "applied") throw unavailable();
    if (context.effect !== "prepare-control-database") {
      const observed = z.object({ receipt: z.unknown() }).parse(result).receipt;
      if (context.effect === "install-control-schema") {
        const row = z.strictObject({ resourceId: id, schemaSha256: digest }).parse(observed);
        if (
          row.resourceId !== context.plan.control.database.resourceId ||
          row.schemaSha256 !== context.plan.control.schema.sha256
        )
          throw unavailable();
      } else if (context.effect === "bind-service-memberships") {
        const row = z
          .strictObject({
            appId: id,
            releaseId: id,
            serviceMemberships: z.array(
              z.strictObject({
                organizationId: id,
                actorId: id,
                role: id,
                fenceGeneration: z.number().int().positive(),
              }),
            ),
          })
          .parse(observed);
        if (row.appId !== context.plan.selection.appId || row.releaseId !== context.plan.release.id)
          throw unavailable();
        assertIntegrationCapabilityReceipt(
          context.plan,
          {
            effect: context.effect,
            resourceVersion: "observed",
            memberships: row.serviceMemberships,
          },
          context.attemptGeneration,
        );
      } else {
        const expected = prepared.receipt();
        const row = z
          .strictObject({
            appId: id,
            resourceProfileId: id,
            registrationRef: z.uuid(),
            principalGeneration: z.number().int().positive(),
            registrationDigest: digest,
          })
          .parse(observed);
        if (
          expected.effect !== "register-central-app" ||
          !isDeepStrictEqual(row, {
            appId: expected.appId,
            resourceProfileId: expected.resourceProfileId,
            registrationRef: expected.registrationRef,
            principalGeneration: expected.principalGeneration,
            registrationDigest: expected.registrationDigest,
          })
        )
          throw unavailable();
      }
    }
    return prepared.receipt();
  };
  return {
    async reconcile(context) {
      // Only an already-dispatched effect is inspected. Fresh dispatch is owned by the durable handler.
      if (context.priorPhase !== "pending") throw unavailable();
      try {
        return { status: "applied", receipt: await inspect(context) };
      } catch {
        context.invocation.signal.throwIfAborted();
        return { status: "unknown" };
      }
    },
    async execute(context) {
      const prepared = await prepare(context, false);
      let accepted: IntegrationCapabilityReceipt | undefined;
      await run(input.configuration, {
        worker: prepared.worker,
        context: prepared.wire,
        runId: randomUUID(),
        directDatabaseUrl: prepared.directDatabaseUrl,
        startupFiles: prepared.startupFiles,
        resourceCredentialBytes:
          context.effect === "prepare-control-database" ? prepared.credentials : undefined,
        readOnly: false,
        signal: context.invocation.signal,
        assertCurrent: context.assertCurrent,
        recordCheckpoint: async (frame) => {
          await context.assertCurrent();
          if (frame.receipt.state === "unknown") throw unavailable();
          if (
            frame.effectId ===
            (context.effect === "prepare-control-database" ? "resources:acl" : context.effect)
          ) {
            accepted = prepared.receipt();
            await context.checkpoint.recordAccepted(accepted);
          }
        },
      });
      if (!accepted) throw unavailable();
      const observed = await inspect(context);
      if (!isDeepStrictEqual(observed, accepted)) throw unavailable();
      return observed;
    },
  };
};
