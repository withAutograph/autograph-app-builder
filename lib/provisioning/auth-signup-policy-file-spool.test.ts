/* oxlint-disable eslint/require-await, typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- Minimal SDK fixture exercises the real pinned transport without providers. */
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { HostedOperatorError } from "./hosted-operator-contract";
import { runAuthSignupPolicyFileSpool } from "./hosted-operator-sandbox-launcher";
import type { ProtectedInstallContextWire } from "./hosted-operator-sandbox-launcher";

const operationRef = "11111111-1111-4111-a111-111111111111";
const workerAttemptId = "22222222-2222-4222-a222-222222222222";
const spool = `/vercel/sandbox/protected-installer/${workerAttemptId}`;
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const worker = {
  id: "auth-owned-organization-v1",
  operationScope: "auth-protected-membership-v1",
  subcommand: "auth-protected-membership",
  executablePath: "/worker/membership",
  sha256: "a".repeat(64),
} as const;
const config = {
  image: "pinned-control",
  projectId: "prj-operator",
  teamId: "team-owned",
  workers: {},
  membershipWorker: worker,
};
const plan = {
  version: 1,
  action: "prepare",
  owner: { userId: "owner-fixture" },
  source: { sha256: "b".repeat(64) },
  selection: { sessionId: "saved-session", workspaceId: "workspace-fixture" },
  authDatabase: {
    resourceId: "isolated-auth",
    database: "pilot_auth",
    migratorRole: "pilot_migrator",
    runtimeRole: "pilot_runtime",
  },
  neon: {
    endpoint: "ep-isolated.neon.tech",
    projectId: "isolated-project",
    branchId: "isolated-branch",
  },
  authSignupPolicy: {
    version: 1,
    policyId: "pilot-signup",
    authResourceId: "isolated-auth",
    appId: "signup-pilot",
    origin: "https://pilot.example",
    appPath: "/pilot",
    organizationId: "pilot-org",
    eligibility: "approved-email",
    allowedEmails: ["controlled@example.test"],
    membershipRole: "member",
    appRoles: ["pilot_user"],
  },
  normalActorProgram: {
    appId: "signup-pilot",
    origin: "https://pilot.example",
    organizations: [{ organizationId: "pilot-org" }],
    appAccess: [{ appId: "signup-pilot", organizationId: "pilot-org", roles: ["pilot_user"] }],
  },
  deploymentBoundary: {
    teamId: "team-owned",
    operator: { projectId: "prj-operator", environment: "preview" },
    verification: {
      publicOrigin: "https://pilot.example",
      gatewayOrigin: "https://gateway.example",
      jwksUrl: "https://gateway.example/_platform/jwks.json",
    },
  },
  signupPolicyInstaller: { reference: worker.id, sha256: worker.sha256 },
  effects: [{ id: "auth-signup-policy", kind: "auth-signup-policy", resourceId: "isolated-auth" }],
};
const fixture = (
  options: {
    wrongPin?: boolean;
    denyFence?: boolean;
    forbiddenEffect?: string;
    foreignResource?: boolean;
    tenant?: boolean;
    mutateInspect?: boolean;
    wrongReadback?: boolean;
  } = {},
) => {
  const files = new Map<string, Buffer>();
  const modes = new Map<string, number | undefined>();
  let fenceRequested = false;
  const checkpoint = vi.fn(async (_value: unknown) => undefined);
  const bindWorkerContext = vi.fn(async (_value: { contextDigest: string }) => checkpoint);
  const kill = vi.fn(async () => undefined);
  const frame = (name: string, value: unknown) => files.set(`${spool}/${name}`, bytes(value));
  const sandbox = {
    fs: {
      mkdir: vi.fn(async () => undefined),
      rm: vi.fn(async () => undefined),
      lstat: vi.fn(async (path: string) => ({
        isFile: () => files.has(path),
        size: files.get(path)?.length ?? 0,
      })),
    },
    writeFiles: vi.fn(async (rows: { path: string; content: Buffer; mode?: number }[]) => {
      for (const row of rows) {
        files.set(row.path, row.content);
        modes.set(row.path, row.mode);
      }
    }),
    readFileToBuffer: vi.fn(async ({ path }: { path: string }) => files.get(path) ?? null),
    delete: vi.fn(async () => undefined),
    extendTimeout: vi.fn(async () => undefined),
    runCommand: vi.fn(async (command: { detached?: boolean; args: string[] }) => {
      if (!command.detached)
        return {
          exitCode: 0,
          stdout: async () =>
            `${options.wrongPin ? "f".repeat(64) : worker.sha256}  /worker/membership\n`,
        };
      const context = JSON.parse(
        files.get(`${spool}/startup/context.json`)!.toString(),
      ) as ProtectedInstallContextWire;
      const contextDigest = sha(bytes(context));
      const common = {
        version: 1,
        operation_id: context.operation.operation_id,
        approval_digest: context.operation.approval_digest,
        context_digest: contextDigest,
        fence_generation: context.operation.fence_generation,
        app_id: context.app_id,
        resource_id: context.resource.resource_id,
        release_id: context.release.id,
        installer_id: context.installer.id,
        installer_sha256: context.installer.sha256,
        tenant_id: null,
      };
      const inspect = command.args[0] === "auth-protected-membership-readback";
      const notices: [string, number][] = [
        ["protected_installer_lifecycle_ready", 1],
        ["protected_installer_frame_ready", 1],
      ];
      frame("requests/1.json", { ...common, kind: "check_fence" });
      frame("requests/1.ready", { version: 1, run_id: workerAttemptId, frame_id: 1 });
      if (!inspect || options.mutateInspect) {
        const effectId = options.forbiddenEffect ?? "auth-signup-policy";
        const resourceId = options.foreignResource ? "foreign-auth" : common.resource_id;
        const tenantId = options.tenant ? "foreign-tenant" : null;
        frame("requests/2.json", {
          ...common,
          kind: "authorize_effect",
          effect_id: effectId,
          sequence: 1,
          resource_id: resourceId,
          tenant_id: tenantId,
        });
        frame("requests/3.json", {
          kind: "checkpoint_effect",
          version: 1,
          operation_id: operationRef,
          context_digest: contextDigest,
          fence_generation: context.operation.fence_generation,
          effect_id: effectId,
          sequence: 1,
          resource_id: resourceId,
          tenant_id: tenantId,
          receipt: { state: "applied", readback_sha256: "c".repeat(64) },
        });
        for (const frameId of [2, 3]) {
          frame(`requests/${frameId}.ready`, {
            version: 1,
            run_id: workerAttemptId,
            frame_id: frameId,
          });
          notices.push(["protected_installer_frame_ready", frameId]);
        }
      }
      for (const [frameId, kind] of [
        [1, "worker_started"],
        [2, "worker_succeeded"],
      ] as const) {
        frame(`lifecycle/${frameId}.json`, { version: 1, run_id: workerAttemptId, kind });
        frame(`lifecycle/${frameId}.ready`, {
          version: 1,
          run_id: workerAttemptId,
          frame_id: frameId,
        });
      }
      notices.push(["protected_installer_lifecycle_ready", 2]);
      if (inspect)
        frame("readback.json", {
          version: 1,
          operation_id: operationRef,
          context_digest: options.wrongReadback ? "f".repeat(64) : contextDigest,
          fence_generation: context.operation.fence_generation,
          status: "applied",
          readback_sha256: "d".repeat(64),
        });
      return {
        kill,
        wait: async () => ({ exitCode: 0 }),
        logs: async function* logs() {
          for (const [kind, frameId] of notices) {
            if (kind === "protected_installer_frame_ready" && frameId === 1) fenceRequested = true;
            yield {
              stream: "stdout",
              data: `${JSON.stringify({ kind, version: 1, run_id: workerAttemptId, frame_id: frameId })}\n`,
            };
          }
        },
      };
    }),
  };
  const createSandbox = vi.fn(async () => sandbox);
  const input = {
    approvedPlanBytes: bytes(plan),
    approvalDigest: sha(bytes(plan)),
    effectId: "auth-signup-policy",
    operationRef,
    workerAttemptId,
    fenceGeneration: 7,
    credentials: {
      migrationUrl:
        "postgresql://pilot_migrator:fixture@ep-isolated.neon.tech/pilot_auth?sslmode=verify-full",
    },
    assertCurrent: vi.fn(async () => {
      if (options.denyFence && fenceRequested)
        throw new HostedOperatorError("authorization_required");
    }),
    bindWorkerContext,
  };
  const dependencies = {
    createSandbox: createSandbox as unknown as NonNullable<
      Parameters<typeof runAuthSignupPolicyFileSpool>[2]
    >["createSandbox"],
  };
  const inspectInput = () => {
    const { bindWorkerContext: _unused, ...rest } = input;
    return { ...rest, readbackOnly: true as const };
  };
  return {
    input,
    inspectInput,
    dependencies,
    createSandbox,
    sandbox,
    files,
    modes,
    checkpoint,
    bindWorkerContext,
    kill,
  };
};

it("runs only the approved policy with complete unchanged bytes and an exact Auth context", async () => {
  const f = fixture();
  await expect(runAuthSignupPolicyFileSpool(config, f.input, f.dependencies)).resolves.toBeNull();
  expect(f.files.get(`${spool}/startup/operator-plan.json`)).toEqual(f.input.approvedPlanBytes);
  expect(JSON.parse(f.files.get(`${spool}/startup/context.json`)!.toString())).toMatchObject({
    app_id: "auth",
    tenant_targets: [],
    release: { id: f.input.approvalDigest, sha256: f.input.approvalDigest },
    resource: {
      resource_id: "isolated-auth",
      database: "pilot_auth",
      migrator_role: "pilot_migrator",
      runtime_role: "pilot_runtime",
    },
  });
  expect(JSON.parse(f.files.get(`${spool}/startup/membership-effect.json`)!.toString())).toEqual({
    version: 1,
    effectId: "auth-signup-policy",
    kind: "auth-signup-policy",
  });
  expect(
    [...f.files.keys()]
      .filter((name) => name.includes("/startup/"))
      .map((name) => name.split("/").at(-1))
      .sort(),
  ).toEqual([
    "auth-database-resource.json",
    "context.json",
    "direct-database-url.json",
    "membership-effect.json",
    "operator-plan.json",
    "ready.json",
  ]);
  expect(f.checkpoint).toHaveBeenCalledOnce();
  expect(f.checkpoint).toHaveBeenCalledWith(
    expect.objectContaining({ effectId: "auth-signup-policy" }),
  );
  expect([...f.modes.values()].every((mode) => mode === 0o600)).toBe(true);
  expect(f.createSandbox).toHaveBeenCalledWith(
    expect.objectContaining({ env: {}, networkPolicy: "allow-all" }),
  );
  expect(f.sandbox.delete).toHaveBeenCalledOnce();
});

it("independently reads the same policy without binding or authorizing a mutation", async () => {
  const f = fixture();
  await expect(
    runAuthSignupPolicyFileSpool(config, f.inspectInput(), f.dependencies),
  ).resolves.toMatchObject({ status: "applied", fence_generation: 7 });
  expect(f.bindWorkerContext).not.toHaveBeenCalled();
  expect(f.checkpoint).not.toHaveBeenCalled();
  expect(f.sandbox.runCommand).toHaveBeenLastCalledWith(
    expect.objectContaining({
      args: [
        "auth-protected-membership-readback",
        "--file-spool",
        spool,
        workerAttemptId,
        "120000",
      ],
      env: {},
    }),
  );
});

it.each([
  "membership",
  "resources",
  "schema",
  "app-grant",
  "resource",
  "tenant",
  "inspect-mutation",
  "inspect-context",
] as const)("denies unrelated %s", async (kind) => {
  const effects = {
    membership: "auth-membership",
    resources: "resources:database",
    schema: "auth:apply-schema-plan",
    "app-grant": "generated_app.grant_access",
  };
  const f = fixture({
    forbiddenEffect: kind in effects ? effects[kind as keyof typeof effects] : undefined,
    foreignResource: kind === "resource",
    tenant: kind === "tenant",
    mutateInspect: kind === "inspect-mutation",
    wrongReadback: kind === "inspect-context",
  });
  await expect(
    runAuthSignupPolicyFileSpool(
      config,
      kind.startsWith("inspect") ? f.inspectInput() : f.input,
      f.dependencies,
    ),
  ).rejects.toThrow();
  expect(f.files.has(`${spool}/responses/2.ready`)).toBe(false);
  expect(f.checkpoint).not.toHaveBeenCalled();
});

it("withholds a fence grant after authority loss and verifies the pin before writing private files", async () => {
  const f = fixture({ denyFence: true });
  await expect(runAuthSignupPolicyFileSpool(config, f.input, f.dependencies)).rejects.toThrow(
    "authorization_required",
  );
  expect(f.files.has(`${spool}/responses/1.ready`)).toBe(false);
  expect(f.kill).toHaveBeenCalledOnce();
  const wrong = fixture({ wrongPin: true });
  await expect(
    runAuthSignupPolicyFileSpool(config, wrong.input, wrong.dependencies),
  ).rejects.toThrow();
  expect(wrong.files.size).toBe(0);
});

it("supports the worker's organization-scoped effect ID without changing its canonical policy command", async () => {
  const f = fixture();
  const changed = structuredClone(plan);
  changed.effects[0]!.id += ":pilot-org";
  f.input.effectId = changed.effects[0]!.id;
  f.input.approvedPlanBytes = bytes(changed);
  f.input.approvalDigest = sha(f.input.approvedPlanBytes);
  await expect(runAuthSignupPolicyFileSpool(config, f.input, f.dependencies)).resolves.toBeNull();
  expect(
    JSON.parse(f.files.get(`${spool}/startup/membership-effect.json`)!.toString()).effectId,
  ).toBe("auth-signup-policy:pilot-org");
});

it("snapshots approved inputs, worker and execution mode before awaiting custody", async () => {
  const f = fixture();
  const configuration = { ...config, membershipWorker: { ...worker } };
  f.input.assertCurrent.mockImplementationOnce(async () => {
    f.input.approvedPlanBytes.fill(32);
    f.input.credentials.migrationUrl = "postgresql://foreign:fixture@foreign.invalid/other";
    f.input.fenceGeneration = 99;
    Object.assign(f.input, { readbackOnly: true });
    configuration.membershipWorker.sha256 = "f".repeat(64);
    configuration.projectId = "foreign-project";
    configuration.teamId = "foreign-team";
    configuration.image = "foreign-image";
  });
  await expect(
    runAuthSignupPolicyFileSpool(configuration, f.input, f.dependencies),
  ).resolves.toBeNull();
  expect(f.checkpoint).toHaveBeenCalledOnce();
  expect(f.createSandbox).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: "prj-operator",
      teamId: "team-owned",
      image: "pinned-control",
    }),
  );
});

it.each([
  "approval",
  "public-policy",
  "admin-role",
  "duplicate-email",
  "organization",
  "roles",
  "app",
  "origin",
  "gateway",
  "auth-resource",
  "app-database",
  "membership",
  "extra-effect",
  "effect-resource",
  "worker",
  "team",
  "operator",
  "foreign-url",
  "pooled-url",
] as const)("rejects invalid %s before allocating a Sandbox", async (kind) => {
  const f = fixture();
  const changed = structuredClone(plan);
  if (kind === "public-policy") changed.authSignupPolicy.eligibility = "public";
  if (kind === "admin-role") changed.authSignupPolicy.appRoles = ["app_admin"];
  if (kind === "duplicate-email")
    changed.authSignupPolicy.allowedEmails.push("CONTROLLED@example.test");
  if (kind === "organization")
    changed.normalActorProgram.organizations[0]!.organizationId = "other";
  if (kind === "roles") changed.normalActorProgram.appAccess[0]!.roles = ["other"];
  if (kind === "app") changed.normalActorProgram.appId = "other";
  if (kind === "origin") changed.authSignupPolicy.origin = "https://other.example";
  if (kind === "gateway")
    changed.deploymentBoundary.verification.jwksUrl = "https://other.example/_platform/jwks.json";
  if (kind === "auth-resource") changed.authSignupPolicy.authResourceId = "other";
  if (kind === "app-database")
    Object.assign(changed, { appDatabase: { database: "not-approved" } });
  if (kind === "membership")
    Object.assign(changed, { authMembership: { organizationId: "not-approved" } });
  if (kind === "extra-effect")
    changed.effects.push({ id: "access", kind: "access", resourceId: "other" });
  if (kind === "effect-resource") changed.effects[0]!.resourceId = "other";
  if (kind === "worker") changed.signupPolicyInstaller.sha256 = "f".repeat(64);
  if (kind === "team") changed.deploymentBoundary.teamId = "other";
  if (kind === "operator") changed.deploymentBoundary.operator.projectId = "other";
  if (kind === "foreign-url")
    f.input.credentials.migrationUrl = f.input.credentials.migrationUrl.replace(
      "pilot_migrator",
      "foreign",
    );
  if (kind === "pooled-url")
    f.input.credentials.migrationUrl = f.input.credentials.migrationUrl.replace(
      "ep-isolated.",
      "ep-isolated-pooler.",
    );
  f.input.approvedPlanBytes = bytes(changed);
  f.input.approvalDigest = kind === "approval" ? "f".repeat(64) : sha(f.input.approvedPlanBytes);
  await expect(runAuthSignupPolicyFileSpool(config, f.input, f.dependencies)).rejects.toThrow();
  expect(f.createSandbox).not.toHaveBeenCalled();
});
