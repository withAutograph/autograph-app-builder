/* oxlint-disable eslint/require-await, unicorn/no-await-expression-member -- Async fixture ports retain rejection semantics; assertions inspect their awaited outcomes directly. */
import { z } from "zod";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRepositoryProductionWorkers } from "./repository-production-workers";
import type { RepositoryProductionWorkerDependencies } from "./repository-production-workers";
import {
  initialRepositoryProductionRecord,
  repositoryProductionOperationRef,
} from "./repository-production-contract";
import type { RepositoryProductionScope } from "./repository-production-contract";
import type { RepositoryProductionEffectContext } from "./repository-production-setup";
import { GENERATED_RELEASE_MEMBERS } from "./hosted-operator-sandbox-launcher";
import type { GeneratedAppReleaseFiles } from "./hosted-operator-sandbox-launcher";

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
    workers,
    context,
    calls,
    revoke: () => {
      valid = false;
    },
  };
};
describe("concrete protected Production worker composition", () => {
  afterEach(() => vi.restoreAllMocks());

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
        organizationId: "org",
        actorId: "verified-actor",
        actorKind: "human",
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
