/* oxlint-disable eslint/require-await, unicorn/no-await-expression-member -- Async fixture ports retain rejection semantics; assertions inspect their awaited outcomes directly. */
import { z } from "zod";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRepositoryProductionWorkers } from "./repository-production-workers";
import type { RepositoryProductionWorkerDependencies } from "./repository-production-workers";
import {
  initialRepositoryProductionRecord,
  repositoryProductionOperationRef,
} from "./repository-production-contract";
import type { RepositoryProductionScope } from "./repository-production-contract";
import type { RepositoryProductionEffectContext } from "./repository-production-setup";
import { GENERATED_RELEASE_MEMBERS } from "./hosted-operator-sandbox-launcher";
import type {
  GeneratedAppReleaseFiles,
  ResourceBootstrapContextWire,
} from "./hosted-operator-sandbox-launcher";

const defined = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("Fixture value missing");
  }
  return value;
};
const planSchema = z.object({
  authOperatorRole: z.string(),
  authAppAccess: z.object({ request: z.object({ action: z.string() }) }).optional(),
  access: z
    .array(
      z.object({
        actorId: z.string(),
        organizationId: z.string(),
        actorKind: z.string(),
        roles: z.array(z.string()),
      }),
    )
    .optional(),
  appDatabase: z.json().optional(),
  authDatabase: z.object({ migratorRole: z.string(), runtimeRole: z.string() }).optional(),
});
const planFrom = (bytes: Buffer | undefined) =>
  planSchema.parse(JSON.parse(defined(bytes).toString()));
const scope: RepositoryProductionScope = {
  authority: {
    issuer: "https://builder.test/api/auth",
    audience: "https://builder.test/mcp",
    ownerUserId: "owner",
    workspaceId: "workspace",
  },
  appId: "requests",
  repositoryId: "repo",
  repositoryFullName: "example/repo",
  projectId: "app-project",
  organizationId: "org",
  publicOrigin: "https://apps.test",
  environment: "production",
};
// Frozen external wire contract: Arrusted 5f7a1e54 node-spool.ts
// digestResourceBootstrapContext binds the first check_fence before any SQL or effect.
const resourceWorkerContextDigest = (context: ResourceBootstrapContextWire) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        kind: context.kind,
        version: context.version,
        operation: {
          operation_id: context.operation.operation_id,
          approval_digest: context.operation.approval_digest,
          fence_generation: context.operation.fence_generation,
        },
        app_id: context.app_id,
        resource: {
          scope: context.resource.scope,
          resource_id: context.resource.resource_id,
          environment: context.resource.environment,
          hostname: context.resource.hostname,
          port: context.resource.port,
          database: context.resource.database,
          migrator_role: context.resource.migrator_role,
          runtime_role: context.resource.runtime_role,
          maintenance_database: context.resource.maintenance_database,
          bootstrap_role: context.resource.bootstrap_role,
          provider_project_id: context.resource.provider_project_id,
          provider_branch_id: context.resource.provider_branch_id,
          provider_endpoint_id: context.resource.provider_endpoint_id,
          credentials_sha256: context.resource.credentials_sha256,
        },
        release: { id: context.release.id, sha256: context.release.sha256 },
        installer: { id: context.installer.id, sha256: context.installer.sha256 },
        tenant_targets: context.tenant_targets,
      }),
    )
    .digest("hex");

const fixture = async (staticApp = false) => {
  const record = initialRepositoryProductionRecord(scope, {
    sessionId: "session",
    sourceSha: "a".repeat(40),
    creatorRoles: ["requester"],
    storage: staticApp
      ? { kind: "none" }
      : {
          kind: "postgres",
          artifactRef: "artifact",
          releaseId: "release",
          manifestSha256: "b".repeat(64),
          databaseEnvironment: "REQUESTS_DATABASE_URL",
        },
  });
  record.lease = { leaseId: "11111111-1111-4111-a111-111111111111", fenceGeneration: 2 };
  record.creatorActorId = "verified-actor";
  let valid = true;
  let accepted = false;
  const calls: Parameters<NonNullable<RepositoryProductionWorkerDependencies["runWorker"]>>[1][] =
    [];
  const runWorker: NonNullable<RepositoryProductionWorkerDependencies["runWorker"]> = async (
    _config,
    input,
  ) => {
    calls.push(input);
    const plan =
      input.operation === "auth-management"
        ? planFrom(input.startupFiles["operator-plan.json"])
        : undefined;
    if (plan?.authAppAccess?.request.action === "complete") {
      accepted = true;
    }
    return {
      version: 1,
      operation_id: input.context.operation.operation_id,
      context_digest: "a".repeat(64),
      fence_generation: 2,
      status: "applied",
      readback_sha256: "b".repeat(64),
      result: {
        status: accepted ? "accepted" : "verified",
        verifiedActorId: "verified-actor",
        scopeDigest: "scope",
      },
    };
  };
  const generic = { executablePath: "/worker", sha256: "c".repeat(64) };
  const workers = createRepositoryProductionWorkers({
    profile: {
      sandbox: { image: "test-image", projectId: "operator", teamId: "team", workers: {} },
      workers: {
        storage: {
          ...generic,
          id: "neon-resource-bootstrap-v1",
          operationScope: "neon-resource-bootstrap-v1",
          subcommand: "neon-resource-bootstrap",
        },
        schema: {
          ...generic,
          id: "generated-app-protected-installer-v1",
          operationScope: "generated-app-release-install-v1",
          subcommand: "protected-generated-app-install",
        },
        access: {
          ...generic,
          id: "generated-app-protected-installer-v1",
          operationScope: "generated-app-access-v1",
          subcommand: "protected-generated-app-access",
        },
        membership: {
          ...generic,
          id: "auth-owned-organization-v1",
          operationScope: "auth-protected-membership-v1",
          subcommand: "auth-protected-membership",
        },
        authManagement: {
          ...generic,
          id: "auth-app-access-v1",
          operationScope: "auth-app-access-v1",
          subcommand: "auth-protected-app-access",
        },
      },
      neon: {
        endpoint: "ep-test.neon.tech",
        projectId: "neon",
        branchId: "branch",
        endpointId: "endpoint",
        maintenanceDatabase: "neondb",
        maintenanceRole: "operator",
      },
      authOperatorRole: "auth_operator",
      authResource: {
        resourceId: "auth",
        database: "auth",
        migratorRole: "auth_m",
        runtimeRole: "auth_r",
      },
      operator: { teamId: "team", projectId: "operator", environment: "production" },
    },
    keyring: { tokenKey: Buffer.alloc(32, 7), tokenKeyVersion: "test" },
    builderOrigin: "https://builder.test",
    authRealm: {},
    signal: new AbortController().signal,
    readCreator: async () => ({
      kind: "managed-invitation",
      actorId: "verified-actor",
      invitationId: "11111111-1111-4111-a111-111111111111",
      scopeDigest: "scope",
    }),
    // SAFETY: Enumerating the closed member list supplies every required release file exactly once.
    readGeneratedRelease: async () =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Test fixture builds every declared member.
      Object.fromEntries(
        GENERATED_RELEASE_MEMBERS.map((member) => [member, Buffer.from(member)]),
      ) as GeneratedAppReleaseFiles,
    readConnections: async () => ({
      maintenanceUrl: "postgresql://operator:secret@ep-test.neon.tech/neondb",
      authOperator: "postgresql://auth_operator:secret@ep-test.neon.tech/auth",
      authRuntime: "postgresql://auth_r:secret@ep-test.neon.tech/auth",
      oidcToken: "private-token",
    }),
    runtimeBinding: { apply: vi.fn(), reconcile: async () => ({ state: "applied", receipt: {} }) },
    frontendAccess: {
      apply: async () => {
        throw new Error("unexpected legacy identity");
      },
      reconcile: async () => {
        throw new Error("unexpected legacy identity");
      },
    },
    runWorker,
  });
  const context: RepositoryProductionEffectContext = {
    row: { operationRef: repositoryProductionOperationRef(scope), revision: 1, record },
    effect: "creator-access",
    assertCurrent: async () => {
      if (!valid) {
        throw new Error("revoked");
      }
    },
    checkpoint: async (value) => {
      record.workerCheckpoints.push(value);
    },
  };
  if (!staticApp) {
    record.privateState = await workers.reservePrivateState(context.row);
  }
  return {
    calls,
    context,
    revoke: () => {
      valid = false;
    },
    workers,
  };
};
describe("concrete protected Production worker composition", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("matches the resource worker's first authority frame for storage execution and readback", async () => {
    const f = await fixture();
    f.context.effect = "allocate-storage";
    await f.workers.apply(f.context);
    await expect(f.workers.reconcile(f.context)).resolves.toMatchObject({ state: "applied" });
    expect(f.calls.map((call) => call.readOnly)).toEqual([false, true]);
    for (const call of f.calls) {
      const context = call.context;
      if (!("kind" in context)) {
        throw new Error("Fixture storage worker context is missing");
      }
      const workerFence = {
        kind: "check_fence",
        operation_id: context.operation.operation_id,
        context_digest: resourceWorkerContextDigest(context),
        fence_generation: context.operation.fence_generation,
        resource_id: context.resource.resource_id,
      };
      const hostDigest = createHash("sha256").update(JSON.stringify(context)).digest("hex");
      // The host's real requestMatchesContext predicate must accept this independently
      // serialized worker digest; matching values with a different digest cannot authorize SQL.
      expect(workerFence.context_digest).toBe(hostDigest);
      expect(workerFence).toMatchObject({
        operation_id: f.context.row.operationRef,
        fence_generation: f.context.row.record.lease?.fenceGeneration,
        resource_id: f.context.row.record.resource?.resourceId,
      });
    }
  });

  it("identifies unavailable encrypted credentials without exposing or replacing private state", async () => {
    const f = await fixture();
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const privateState = { encryptedToken: "private-sealed-credential-fixture" };
    f.context.row.record.privateState = privateState;
    f.context.effect = "allocate-storage";
    await expect(f.workers.apply(f.context)).rejects.toThrow(
      /^repository_production_credentials_unavailable$/u,
    );
    expect(f.calls).toEqual([]);
    expect(f.context.row.record.privateState).toBe(privateState);
    const output = log.mock.calls.flat().join("");
    expect(output).toContain('"phase":"credential_decode"');
    expect(output).not.toContain("private-sealed-credential-fixture");
    expect(output).not.toContain("encryptedToken");
    const progress = vi.mocked(console.info).mock.calls.flat().join("");
    expect(progress).toContain('"phase":"worker_input"');
    expect(progress).toContain('"state":"started"');
    expect(progress).not.toContain('"state":"completed"');
  });

  it("marks completed worker input assembly without logging its private payload", async () => {
    const f = await fixture();
    f.context.effect = "allocate-storage";
    await f.workers.apply(f.context);
    expect(f.calls).toHaveLength(1);
    const progress = vi.mocked(console.info).mock.calls.flat().join("");
    expect(progress).toContain('"phase":"worker_input"');
    expect(progress).toContain('"state":"started"');
    expect(progress).toContain('"state":"completed"');
    expect(progress).not.toContain("secret");
    expect(progress).not.toContain("postgresql");
  });

  it("retains a revoked worker authority without dispatch when diagnostics fail", async () => {
    const f = await fixture();
    vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    f.revoke();
    await expect(f.workers.apply(f.context)).rejects.toThrow("revoked");
    expect(f.calls).toEqual([]);
  });
  it("binds the restricted Auth role into approval without changing resource identity or passing the owner credential", async () => {
    const f = await fixture();
    await f.workers.apply(f.context);
    const auth = defined(f.calls.find((call) => call.operation === "auth-management"));
    const planBytes = defined(auth.startupFiles["operator-plan.json"]);
    expect(planFrom(planBytes).authOperatorRole).toBe("auth_operator");
    expect(auth.context.operation.approval_digest).toBe(
      createHash("sha256").update(planBytes).digest("hex"),
    );
    expect(new URL(auth.directDatabaseUrl).username).toBe("auth_operator");
    expect(auth.context.resource.migrator_role).toBe("auth_m");
    expect(auth.context.resource.runtime_role).toBe("auth_r");
    const resource = z
      .object({ migratorRole: z.string(), runtimeRole: z.string() })
      .parse(JSON.parse(defined(auth.startupFiles["auth-database-resource.json"]).toString()));
    expect(resource.migratorRole).toBe("auth_m");
    expect(resource.runtimeRole).toBe("auth_r");
    const access = defined(f.calls.find((call) => call.operation === "access" && !call.readOnly));
    const accessPlan = defined(access.startupFiles["approved-access-plan.json"]);
    expect(planFrom(accessPlan).authOperatorRole).toBe("auth_operator");
    expect(planFrom(accessPlan).authDatabase?.migratorRole).toBe("auth_m");
    expect(access.context.operation.approval_digest).toBe(
      createHash("sha256").update(accessPlan).digest("hex"),
    );
    const connections = z
      .strictObject({
        appMigrator: z.string(),
        appRuntime: z.string(),
        authOperator: z.string(),
        authRuntime: z.string(),
      })
      .parse(JSON.parse(defined(access.startupFiles["access-connections.json"]).toString()));
    expect(new URL(connections.authOperator).username).toBe("auth_operator");
    expect(new URL(connections.authRuntime).username).toBe("auth_r");
  });

  it("joins the verified actor, grants app roles, reads back, then completes the invitation", async () => {
    const f = await fixture();
    await f.workers.apply(f.context);
    const authActions = f.calls
      .filter((call) => call.operation === "auth-management")
      .map(
        (call) => planFrom(call.startupFiles["operator-plan.json"]).authAppAccess?.request.action,
      );
    expect(authActions).toEqual(["prepare-member", "complete"]);
    const grant = defined(f.calls.find((call) => call.operation === "access" && !call.readOnly));
    const plan = planFrom(grant.startupFiles["approved-access-plan.json"]);
    expect(plan.access).toEqual([
      {
        actorId: "verified-actor",
        actorKind: "human",
        organizationId: "org",
        roles: ["requester"],
      },
    ]);
    expect(grant.context.resource.environment).toBe("production");
    expect((await f.workers.reconcile(f.context)).state).toBe("applied");
    expect(JSON.stringify(plan)).not.toContain("secret");
  });
  it("frontend-only setup uses the shared Auth worker and never starts an app database worker", async () => {
    const f = await fixture(true);
    await f.workers.apply(f.context);
    expect(f.calls.every((call) => call.operation === "auth-management")).toBe(true);
    expect((await f.workers.reconcile(f.context)).state).toBe("applied");
    expect(f.context.row.record.privateState).toBeUndefined();
  });
  it("supports management grants without stealing creator identity or encrypted resource ownership", async () => {
    const f = await fixture();
    await f.workers.mutateAppAccess(
      {
        ...f.context,
        row: { ...f.context.row, operationRef: "22222222-2222-4222-a222-222222222222" },
      },
      { actorId: "invitee", roles: ["requester"], active: true },
    );
    const plan = planFrom(defined(f.calls[0]).startupFiles["approved-access-plan.json"]);
    expect(plan.access?.[0]?.actorId).toBe("invitee");
    expect(plan.appDatabase).toEqual(f.context.row.record.resource);
  });
  it("stops before credentials or provider work when the lease is revoked", async () => {
    const f = await fixture();
    f.revoke();
    await expect(f.workers.apply(f.context)).rejects.toThrow("revoked");
    expect(f.calls).toEqual([]);
  });
});
