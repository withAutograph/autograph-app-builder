/* oxlint-disable eslint/no-nested-ternary, sonarjs/no-nested-conditional -- Closed worker choices select only the concrete resource and request shape for each operation. */
/* oxlint-disable eslint/complexity, sonarjs/cognitive-complexity, sonarjs/max-union-size -- The closed worker protocol keeps each resource, command, and private startup file binding explicit. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { repositoryProductionGatewayVerification } from "./repository-production-app-boundary";
import {
  observeRepositoryProductionPhase,
  reportRepositoryProductionFailure,
  reportRepositoryProductionProgress,
} from "./repository-production-diagnostic";
import {
  encryptVercelToken,
  decryptVersionedVercelToken,
} from "../integrations/vercel-installation";
import type { VercelTokenKeyringConfig } from "../integrations/vercel-installation";
import {
  repositoryProductionDigest,
  repositoryProductionOperationRef,
} from "./repository-production-contract";
import type {
  RepositoryProductionResource,
  RepositoryProductionRow,
} from "./repository-production-contract";
import type {
  RepositoryProductionEffectContext,
  RepositoryProductionIdentity,
  RepositoryProductionObservation,
} from "./repository-production-setup";
import { runRepositoryProductionFileSpool } from "./hosted-operator-sandbox-launcher";
import type {
  GeneratedAppReleaseFiles,
  HostedOperatorSandboxConfiguration,
  ProtectedInstallerWorkerDescriptor,
  ProtectedInstallContextWire,
  ResourceBootstrapContextWire,
} from "./hosted-operator-sandbox-launcher";

const AUTH_MEMBERSHIP_EFFECT = "auth-membership";

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const sealedSchema = z.strictObject({
  encryptedToken: z.string(),
  tokenIv: z.string(),
  tokenTag: z.string(),
  keyVersion: z.string(),
});
const credentialsSchema = z.strictObject({
  migratorPassword: z.string().min(32),
  runtimePassword: z.string().min(32),
});
export type RepositoryProductionCreatorProof =
  | RepositoryProductionRealmProof
  | { kind: "managed-invitation"; invitationId: string; actorId: string; scopeDigest: string };
export interface RepositoryProductionRealmProof {
  actorId: string;
  proof: string;
  bootstrapPlanDigest: string;
  identityNonceSha256: string;
  identityProof: { reference: string; sha256: string };
  identityCapture: { capturedAt: string; realmSessionId: string };
  identityVerification: {
    audience: string;
    issuer: string;
    jwksUrl: string;
    transportSource: {
      audience: string;
      environment: "production";
      issuer: string;
      ownerId: string;
      projectId: string;
    };
  };
}
export interface RepositoryProductionWorkerProfile {
  sandbox: HostedOperatorSandboxConfiguration;
  workers: {
    storage: ProtectedInstallerWorkerDescriptor;
    schema: ProtectedInstallerWorkerDescriptor;
    access: ProtectedInstallerWorkerDescriptor;
    membership: ProtectedInstallerWorkerDescriptor;
    authManagement: ProtectedInstallerWorkerDescriptor;
  };
  neon: {
    endpoint: string;
    projectId: string;
    branchId: string;
    endpointId: string;
    maintenanceDatabase: string;
    maintenanceRole: string;
  };
  authResource: RepositoryProductionResource;
  authOperatorRole: string;
  operator: { teamId: string; projectId: string; environment: "production" };
}
export interface RepositoryProductionWorkerDependencies {
  profile: RepositoryProductionWorkerProfile;
  keyring: VercelTokenKeyringConfig;
  builderOrigin: string;
  authRealm: z.infer<ReturnType<typeof z.json>>;
  signal: AbortSignal;
  /** The owner-bound, one-time Auth proof, never an email-based account lookup. */
  readCreator: (
    row: RepositoryProductionRow,
  ) => Promise<
    RepositoryProductionCreatorProof | { state: "required"; signInUrl?: string; expiresAt?: string }
  >;
  readGeneratedRelease: (row: RepositoryProductionRow) => Promise<GeneratedAppReleaseFiles>;
  /** Live connected-provider reads; returns credentials only inside this protected closure. */
  readConnections: (context: RepositoryProductionEffectContext) => Promise<{
    maintenanceUrl: string;
    authOperator: string;
    authRuntime: string;
    oidcToken: string;
  }>;
  runtimeBinding: {
    isReady: (row: RepositoryProductionRow, runtimeUrl: string) => boolean;
    apply: (context: RepositoryProductionEffectContext, runtimeUrl: string) => Promise<void>;
    reconcile: (
      context: RepositoryProductionEffectContext,
      runtimeUrl: string,
    ) => Promise<RepositoryProductionObservation>;
  };
  /** Frontend-only app grants are Auth-owned and require no generated database worker. */
  frontendAccess: {
    apply: (
      context: RepositoryProductionEffectContext,
      proof: RepositoryProductionCreatorProof,
    ) => Promise<void>;
    reconcile: (
      context: RepositoryProductionEffectContext,
      proof: RepositoryProductionCreatorProof,
    ) => Promise<RepositoryProductionObservation>;
  };
  runWorker?: typeof runRepositoryProductionFileSpool;
}
const associatedData = (row: RepositoryProductionRow) =>
  `repository-production-credentials-v1:${repositoryProductionOperationRef(row.record.scope)}:${repositoryProductionDigest(row.record.scope)}`;
// oxlint-disable-next-line typescript/promise-function-async -- Preserve the existing promise and synchronous exception behavior.
const assertCurrent = (context: RepositoryProductionEffectContext) =>
  // oxlint-disable-next-line typescript/promise-function-async -- Preserve the existing promise and synchronous exception behavior.
  observeRepositoryProductionPhase("worker_authority", "authorization_unavailable", () =>
    context.assertCurrent(),
  );

const observe = (
  value: Awaited<ReturnType<typeof runRepositoryProductionFileSpool>>,
): RepositoryProductionObservation => {
  if (value?.status === "applied") {
    return { receipt: z.json().parse(value), state: "applied" };
  }
  if (value?.status === "absent" || value?.status === "retryable") {
    return { state: "not-applied" };
  }
  return { state: "unknown" };
};
export const createRepositoryProductionWorkers = (deps: RepositoryProductionWorkerDependencies) => {
  const privateCredentials = (row: RepositoryProductionRow) => {
    try {
      const sealed = sealedSchema.parse(row.record.privateState);
      const config = deps.keyring;
      const credentialAssociatedData = associatedData(row);
      return credentialsSchema.parse(
        JSON.parse(
          decryptVersionedVercelToken({
            ...sealed,
            associatedData: credentialAssociatedData,
            config,
          }),
        ),
      );
    } catch (error) {
      reportRepositoryProductionFailure("credential_decode", "credentials_unavailable", error);
      // oxlint-disable-next-line eslint/preserve-caught-error -- Keep the existing credential-safe exception without private parser or decryption causes.
      throw new Error("repository_production_credentials_unavailable");
    }
  };
  const appConnections = (row: RepositoryProductionRow) => {
    const { resource } = row.record;
    if (!resource) {
      throw new Error("repository_production_storage_unavailable");
    }
    const credentials = privateCredentials(row);
    const url = (role: string, password: string) => {
      const value = new URL(`postgresql://${deps.profile.neon.endpoint}:5432/${resource.database}`);
      value.username = role;
      value.password = password;
      value.searchParams.set("sslmode", "verify-full");
      return value.toString();
    };
    return {
      appMigrator: url(resource.migratorRole, credentials.migratorPassword),
      appRuntime: url(resource.runtimeRole, credentials.runtimePassword),
    };
  };
  const creator = async (context: RepositoryProductionEffectContext) => {
    await assertCurrent(context);
    const proof = await deps.readCreator(context.row);
    if (
      "state" in proof ||
      proof.actorId !== context.row.record.creatorActorId ||
      (!("kind" in proof) && sha256(proof.proof) !== proof.identityProof.sha256)
    ) {
      throw new Error("repository_production_identity_required");
    }
    await assertCurrent(context);
    return proof;
  };
  const run = async (
    context: RepositoryProductionEffectContext,
    operation: "storage" | "schema" | "access" | "membership",
    readOnly: boolean,
    managedAccess?: { actorId: string; roles: string[]; active: boolean },
  ) => {
    await assertCurrent(context);
    const { row } = context;
    const { scope, intent, resource, lease } = row.record;
    if (!resource || !lease || intent.storage.kind !== "postgres") {
      throw new Error("repository_production_storage_unavailable");
    }
    const worker = deps.profile.workers[operation];
    const connections = await deps.readConnections(context);
    reportRepositoryProductionProgress("worker_input", "started");
    const urls = {
      ...appConnections(row),
      authOperator: connections.authOperator,
      authRuntime: connections.authRuntime,
    };
    const proof =
      // oxlint-disable-next-line sonarjs/expression-complexity -- Preserve the existing conditions and their evaluation order.
      managedAccess === undefined &&
      (operation === "membership" ||
        operation === "access" ||
        (operation === "schema" && row.record.effects["creator-access"].state !== "applied"))
        ? await creator(context)
        : undefined;
    const access =
      managedAccess === undefined
        ? proof === undefined
          ? []
          : [
              {
                organizationId: scope.organizationId,
                actorId: proof.actorId,
                actorKind: "human" as const,
                roles: intent.creatorRoles,
              },
            ]
        : [
            {
              organizationId: scope.organizationId,
              actorId: managedAccess.actorId,
              actorKind: "human" as const,
              roles: managedAccess.roles,
            },
          ];
    const membership =
      proof === undefined || "kind" in proof
        ? undefined
        : {
            kind: "join-existing-organization",
            workspaceId: scope.authority.workspaceId,
            actorId: proof.actorId,
            organizationId: scope.organizationId,
            membershipRole: "member",
            bootstrapPlanDigest: proof.bootstrapPlanDigest,
            identityNonceSha256: proof.identityNonceSha256,
            identityProof: proof.identityProof,
            identityCapture: proof.identityCapture,
            identityVerification: proof.identityVerification,
          };
    const planStart = {
      version: 1,
      kind: "repository-production-setup-v1",
      action: managedAccess?.active === false ? "cleanup" : "prepare",
      selection: {
        appId: scope.appId,
        sessionId: intent.sessionId,
        workspaceId: scope.authority.workspaceId,
        environment: "production",
      },
      appDatabase: resource,
      authDatabase: deps.profile.authResource,
      authOperatorRole: deps.profile.authOperatorRole,
      neon: deps.profile.neon,
      release: { id: intent.storage.releaseId, sha256: intent.storage.manifestSha256 },
      installer: {
        reference: (operation === "access"
          ? deps.profile.workers.access
          : deps.profile.workers.schema
        ).id,
        sha256: (operation === "access" ? deps.profile.workers.access : deps.profile.workers.schema)
          .sha256,
      },
      appInstallation: { customerIds: [scope.organizationId] },
      access,
      effects: [{ id: AUTH_MEMBERSHIP_EFFECT, kind: AUTH_MEMBERSHIP_EFFECT }],
    };
    const planWithMembership: typeof planStart & { authMembership?: typeof membership } = planStart;
    if (membership !== undefined) {
      planWithMembership.authMembership = membership;
    }
    const plan = {
      ...planWithMembership,
      deploymentBoundary: {
        teamId: deps.profile.operator.teamId,
        operator: deps.profile.operator,
        verification: repositoryProductionGatewayVerification(scope),
      },
    };
    const planBytes = Buffer.from(JSON.stringify(plan));
    const selected = operation === "membership" ? deps.profile.authResource : resource;
    const common: ProtectedInstallContextWire = {
      version: 1,
      operation: {
        operation_id: row.operationRef,
        approval_digest: sha256(planBytes),
        fence_generation: lease.fenceGeneration,
      },
      app_id: operation === "membership" ? "auth" : scope.appId,
      resource: {
        resource_id: selected.resourceId,
        environment: "production",
        hostname: deps.profile.neon.endpoint,
        port: 5432,
        database: selected.database,
        schema: "public",
        migrator_role: selected.migratorRole,
        runtime_role: selected.runtimeRole,
        provider_project_id: deps.profile.neon.projectId,
        provider_branch_id: deps.profile.neon.branchId,
      },
      release:
        operation === "membership" && proof !== undefined && !("kind" in proof)
          ? { id: sha256(planBytes), sha256: proof.identityProof.sha256 }
          : { id: intent.storage.releaseId, sha256: intent.storage.manifestSha256 },
      installer: { id: worker.id, sha256: worker.sha256 },
      tenant_targets:
        operation === "storage" || operation === "membership" ? [] : [scope.organizationId],
    };
    const resourceCredentialBytes = Buffer.from(JSON.stringify(privateCredentials(row)));
    let workerContext: ProtectedInstallContextWire | ResourceBootstrapContextWire = common;
    if (operation === "storage") {
      // The fixed resource worker canonicalizes this wire order before hashing
      // its first authority frame; preserve the same bytes without changing any binding.
      workerContext = {
        kind: "neon_resource_bootstrap",
        version: common.version,
        operation: common.operation,
        app_id: common.app_id,
        resource: {
          scope: "app_database",
          resource_id: common.resource.resource_id,
          environment: common.resource.environment,
          hostname: common.resource.hostname,
          port: common.resource.port,
          database: common.resource.database,
          migrator_role: common.resource.migrator_role,
          runtime_role: common.resource.runtime_role,
          maintenance_database: deps.profile.neon.maintenanceDatabase,
          bootstrap_role: deps.profile.neon.maintenanceRole,
          provider_project_id: common.resource.provider_project_id,
          provider_branch_id: common.resource.provider_branch_id,
          provider_endpoint_id: deps.profile.neon.endpointId,
          credentials_sha256: sha256(resourceCredentialBytes),
        },
        release: common.release,
        installer: common.installer,
        tenant_targets: common.tenant_targets,
      };
    }
    const startupFiles: Record<string, Buffer> = {};
    if (operation === "schema" || operation === "access") {
      startupFiles["approved-access-plan.json"] = planBytes;
      if (operation === "access" || readOnly) {
        startupFiles["access-connections.json"] = Buffer.from(JSON.stringify(urls));
      }
    }
    if (operation === "membership" && proof !== undefined && !("kind" in proof)) {
      startupFiles["operator-plan.json"] = planBytes;
      startupFiles["membership-effect.json"] = Buffer.from(
        JSON.stringify({
          version: 1,
          effectId: AUTH_MEMBERSHIP_EFFECT,
          kind: AUTH_MEMBERSHIP_EFFECT,
        }),
      );
      startupFiles["auth-database-resource.json"] = Buffer.from(
        JSON.stringify({
          version: 1,
          environment: "production",
          hostname: deps.profile.neon.endpoint,
          port: 5432,
          database: selected.database,
          schema: "public",
          runtimeRole: selected.runtimeRole,
          migratorRole: selected.migratorRole,
          neon: { projectId: deps.profile.neon.projectId, branchId: deps.profile.neon.branchId },
        }),
      );
      startupFiles["realm-identity-proof.json"] = Buffer.from(
        JSON.stringify({ proof: proof.proof }),
      );
      startupFiles["gateway-readback-oidc.json"] = Buffer.from(
        JSON.stringify({ token: connections.oidcToken }),
      );
    }
    await assertCurrent(context);
    const runWorker = deps.runWorker ?? runRepositoryProductionFileSpool;
    const { sandbox } = deps.profile;
    type WorkerInput = Parameters<typeof runRepositoryProductionFileSpool>[1];
    const workerPrefix: Pick<
      WorkerInput,
      "operation" | "worker" | "context" | "startupFiles" | "directDatabaseUrl"
    > &
      Partial<Pick<WorkerInput, "resourceCredentialBytes" | "generatedRelease">> = {
      operation,
      worker,
      context: workerContext,
      startupFiles,
      directDatabaseUrl:
        operation === "storage"
          ? connections.maintenanceUrl
          : operation === "membership"
            ? connections.authOperator
            : urls.appMigrator,
    };
    if (operation === "storage") {
      workerPrefix.resourceCredentialBytes = resourceCredentialBytes;
    }
    if (operation === "schema" || operation === "access") {
      workerPrefix.generatedRelease = await deps.readGeneratedRelease(row);
    }
    const workerInput: WorkerInput = {
      ...workerPrefix,
      readOnly,
      runId: readOnly
        ? randomUUID()
        : (row.record.effects[context.effect].attemptId ?? randomUUID()),
      signal: deps.signal,
      assertCurrent: context.assertCurrent,
    };
    if (!readOnly) {
      workerInput.recordCheckpoint = async (frame) => {
        await context.checkpoint(z.json().parse(frame));
      };
    }
    reportRepositoryProductionProgress("worker_input", "completed");
    return await runWorker(sandbox, workerInput);
  };
  const invokeAuthManagement = async (
    context: RepositoryProductionEffectContext,
    authAppAccess: z.infer<ReturnType<typeof z.json>>,
    readOnly: boolean,
  ) => {
    await assertCurrent(context);
    const { row } = context;
    const { lease } = row.record;
    if (!lease) {
      throw new Error("repository_production_lease_unavailable");
    }
    const worker = deps.profile.workers.authManagement;
    const connection = await deps.readConnections(context);
    reportRepositoryProductionProgress("worker_input", "started");
    const resource = deps.profile.authResource;
    const authResource = {
      version: 1,
      environment: "production",
      hostname: deps.profile.neon.endpoint,
      port: 5432,
      database: resource.database,
      schema: "public",
      runtimeRole: resource.runtimeRole,
      migratorRole: resource.migratorRole,
      neon: { projectId: deps.profile.neon.projectId, branchId: deps.profile.neon.branchId },
    };
    const plan = {
      version: 1,
      action: "prepare",
      kind: "repository-production-access-v1",
      authOperatorRole: deps.profile.authOperatorRole,
      authAppAccess,
      effects: [{ id: "auth-app-invitation", kind: "auth-app-invitation" }],
    };
    const planBytes = Buffer.from(JSON.stringify(plan));
    const workerContext: ProtectedInstallContextWire = {
      version: 1,
      operation: {
        operation_id: row.operationRef,
        approval_digest: sha256(planBytes),
        fence_generation: lease.fenceGeneration,
      },
      app_id: "auth",
      resource: {
        resource_id: resource.resourceId,
        environment: "production",
        hostname: deps.profile.neon.endpoint,
        port: 5432,
        database: resource.database,
        schema: "public",
        migrator_role: resource.migratorRole,
        runtime_role: resource.runtimeRole,
        provider_project_id: deps.profile.neon.projectId,
        provider_branch_id: deps.profile.neon.branchId,
      },
      release: { id: sha256(planBytes), sha256: sha256(planBytes) },
      installer: { id: worker.id, sha256: worker.sha256 },
      tenant_targets: [],
    };
    const runWorker = deps.runWorker ?? runRepositoryProductionFileSpool;
    const { sandbox } = deps.profile;
    const workerInput: Parameters<typeof runRepositoryProductionFileSpool>[1] = {
      operation: "auth-management",
      worker,
      context: workerContext,
      directDatabaseUrl: connection.authOperator,
      readOnly,
      runId: readOnly
        ? randomUUID()
        : (row.record.effects[context.effect].attemptId ?? randomUUID()),
      startupFiles: {
        "operator-plan.json": planBytes,
        "auth-database-resource.json": Buffer.from(JSON.stringify(authResource)),
      },
      signal: deps.signal,
      assertCurrent: context.assertCurrent,
    };
    if (!readOnly) {
      workerInput.recordCheckpoint = async (frame) => {
        await context.checkpoint(z.json().parse(frame));
      };
    }
    reportRepositoryProductionProgress("worker_input", "completed");
    return await runWorker(sandbox, workerInput);
  };
  const managedAuth = async (
    context: RepositoryProductionEffectContext,
    proof: Extract<RepositoryProductionCreatorProof, { kind: "managed-invitation" }>,
    action: "prepare-member" | "complete" | "read" | "set-access",
    readOnly: boolean,
  ) => {
    const hex = sha256(`${context.row.operationRef}:creator:${proof.invitationId}:${action}`);
    const operationRef = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    const changed = { ...context, row: { ...context.row, operationRef } };
    return await invokeAuthManagement(
      changed,
      {
        version: 1,
        realm: deps.authRealm,
        builderOrigin: deps.builderOrigin,
        scope: {
          appId: context.row.record.scope.appId,
          organizationId: context.row.record.scope.organizationId,
        },
        request:
          action === "read"
            ? { action, invitationId: proof.invitationId }
            : action === "set-access"
              ? {
                  action,
                  actorId: proof.actorId,
                  roles: context.row.record.intent.creatorRoles,
                  active: true,
                }
              : {
                  action,
                  invitationId: proof.invitationId,
                  scopeDigest: proof.scopeDigest,
                  actorId: proof.actorId,
                },
      },
      readOnly,
    );
  };
  return {
    isRuntimeBindingReady: (row: RepositoryProductionRow) =>
      row.record.intent.storage.kind === "none" ||
      deps.runtimeBinding.isReady(row, appConnections(row).appRuntime),
    async mutateAppAccess(
      context: RepositoryProductionEffectContext,
      access: { actorId: string; roles: string[]; active: boolean },
    ) {
      await run(context, "access", false, access);
    },
    async inspectAppAccess(
      context: RepositoryProductionEffectContext,
      access: { actorId: string; roles: string[]; active: boolean },
    ) {
      return observe(await run(context, "access", true, access));
    },
    invokeAuthManagement,
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the existing promise and synchronous exception behavior.
    reservePrivateState: (row: RepositoryProductionRow) =>
      Promise.resolve({
        ...encryptVercelToken({
          key: deps.keyring.tokenKey,
          associatedData: associatedData(row),
          token: JSON.stringify({
            migratorPassword: randomBytes(32).toString("base64url"),
            runtimePassword: randomBytes(32).toString("base64url"),
          }),
        }),
        keyVersion: deps.keyring.tokenKeyVersion,
      }),
    readCreatorIdentity: async (
      row: RepositoryProductionRow,
    ): Promise<RepositoryProductionIdentity> => {
      const result = await deps.readCreator(row);
      return "state" in result ? result : { actorId: result.actorId, state: "verified" };
    },
    async apply(context: RepositoryProductionEffectContext) {
      if (context.effect === "bind-runtime") {
        await deps.runtimeBinding.apply(context, appConnections(context.row).appRuntime);
        return;
      }
      if (context.effect === "creator-access") {
        const proof = await creator(context);
        if ("kind" in proof) {
          await managedAuth(context, proof, "prepare-member", false);
          if (context.row.record.intent.storage.kind === "none") {
            await managedAuth(context, proof, "set-access", false);
          } else {
            await run(context, "access", false);
            if (observe(await run(context, "access", true)).state !== "applied") {
              throw new Error("repository_production_access_unverified");
            }
          }
          await managedAuth(context, proof, "complete", false);
        } else {
          if (context.row.record.intent.storage.kind === "none") {
            await deps.frontendAccess.apply(context, proof);
            return;
          }
          await run(context, "membership", false);
          await run(context, "access", false);
        }
        return;
      }
      await run(context, context.effect === "allocate-storage" ? "storage" : "schema", false);
    },
    async reconcile(context: RepositoryProductionEffectContext) {
      if (context.effect === "bind-runtime") {
        return await deps.runtimeBinding.reconcile(context, appConnections(context.row).appRuntime);
      }
      if (context.effect === "creator-access") {
        const proof = await creator(context);
        if ("kind" in proof) {
          const invite = z
            .object({
              result: z.object({
                status: z.string(),
                verifiedActorId: z.string().nullable(),
                scopeDigest: z.string(),
              }),
            })
            .parse(await managedAuth(context, proof, "read", true)).result;
          if (
            invite.status !== "accepted" ||
            invite.verifiedActorId !== proof.actorId ||
            invite.scopeDigest !== proof.scopeDigest
          ) {
            return { state: "not-applied" } as const;
          }
          if (context.row.record.intent.storage.kind === "none") {
            return {
              receipt: { actorId: proof.actorId, invitationId: proof.invitationId },
              state: "applied",
            } as const;
          }
        } else {
          if (context.row.record.intent.storage.kind === "none") {
            return await deps.frontendAccess.reconcile(context, proof);
          }
          const membership = observe(await run(context, "membership", true));
          if (membership.state !== "applied") {
            return membership;
          }
        }
        return observe(await run(context, "access", true));
      }
      return observe(
        await run(context, context.effect === "allocate-storage" ? "storage" : "schema", true),
      );
    },
  };
};
