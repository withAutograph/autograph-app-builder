/* oxlint-disable eslint/require-await, typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- Minimal official SDK fake exercises real resource transport without providers. */
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { HostedOperatorError } from "./hosted-operator-contract";
import { runAuthResourceFileSpool } from "./hosted-operator-sandbox-launcher";
import type { ResourceBootstrapContextWire } from "./hosted-operator-sandbox-launcher";

const operationRef = "11111111-1111-4111-a111-111111111111";
const workerAttemptId = "22222222-2222-4222-a222-222222222222";
const spool = `/vercel/sandbox/protected-installer/${workerAttemptId}`;
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const worker = {
  executablePath: "/worker/resources",
  id: "neon-resource-bootstrap-v1",
  operationScope: "neon-resource-bootstrap-v1",
  subcommand: "neon-resource-bootstrap",
  sha256: "a".repeat(64),
} as const;
const plan = {
  version: 1,
  action: "prepare",
  owner: { sessionId: "saved-pilot-session", appId: "pilot", userId: "owner" },
  source: { sha256: "b".repeat(64) },
  authDatabase: {
    database: "pilot_auth",
    migratorRole: "pilot_migrator",
    runtimeRole: "pilot_runtime",
    resourceId: "isolated-auth",
  },
  bootstrap: { endpointId: "ep-isolated", maintenanceDatabase: "neondb", role: "neondb_owner" },
  neon: {
    endpoint: "ep-isolated.neon.tech",
    projectId: "isolated-project",
    branchId: "isolated-branch",
  },
  resourcesInstaller: { reference: worker.id, sha256: worker.sha256 },
  effects: [{ id: "auth-resources", kind: "resources", resourceId: "isolated-auth" }],
};
const passwordPair = { migratorPassword: "m".repeat(40), runtimePassword: "r".repeat(40) };
const config = {
  image: "pinned-control",
  projectId: "operator-project",
  teamId: "owned-team",
  workers: {},
  resourcesWorker: worker,
};
const fixture = (
  options: {
    denyFence?: boolean;
    wrongPin?: boolean;
    forbiddenEffect?: string;
    foreignResource?: boolean;
    tenant?: boolean;
    wrongReadback?: boolean;
    mutateDuringInspect?: boolean;
  } = {},
) => {
  const files = new Map<string, Buffer>();
  const modes = new Map<string, number | undefined>();
  let fenceRequested = false;
  const checkpoint = vi.fn(async (_frame: unknown) => {});
  const bindWorkerContext = vi.fn(async (_binding: { contextDigest: string }) => checkpoint);
  const assertCredentialsCheckpointed = vi.fn(
    async (_binding: {
      approvalDigest: string;
      resourceId: string;
      credentialsSha256: string;
    }) => {},
  );
  const kill = vi.fn(async () => {});
  const frame = (name: string, value: unknown) => files.set(`${spool}/${name}`, bytes(value));
  const sandbox = {
    fs: {
      mkdir: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
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
    delete: vi.fn(async () => {}),
    extendTimeout: vi.fn(async () => {}),
    runCommand: vi.fn(async (command: { detached?: boolean; args: string[] }) => {
      if (!command.detached)
        return {
          exitCode: 0,
          stdout: async () =>
            `${options.wrongPin ? "f".repeat(64) : worker.sha256}  /worker/resources\n`,
        };
      // SAFETY: The production launcher wrote this context before the synthetic worker starts.
      const context = JSON.parse(
        files.get(`${spool}/startup/context.json`)!.toString(),
      ) as ResourceBootstrapContextWire;
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
      frame("requests/1.json", { ...common, kind: "check_fence" });
      frame("requests/1.ready", { version: 1, run_id: workerAttemptId, frame_id: 1 });
      const notices: [string, number][] = [
        ["protected_installer_frame_ready", 1],
        ["protected_installer_lifecycle_ready", 1],
      ];
      const inspect = command.args[0] === "neon-resource-inspect";
      if (!inspect || options.mutateDuringInspect) {
        for (const [index, effect] of [
          "resources:roles",
          "resources:database",
          "resources:acl",
        ].entries()) {
          const authorityFrame = 2 + index * 2;
          const effectId = options.forbiddenEffect ?? effect;
          const resourceId = options.foreignResource ? "foreign-resource" : common.resource_id;
          const tenantId = options.tenant ? "foreign-tenant" : null;
          frame(`requests/${authorityFrame}.json`, {
            ...common,
            resource_id: resourceId,
            tenant_id: tenantId,
            kind: "authorize_effect",
            effect_id: effectId,
            sequence: index + 1,
          });
          frame(`requests/${authorityFrame + 1}.json`, {
            kind: "checkpoint_effect",
            version: 1,
            operation_id: operationRef,
            context_digest: contextDigest,
            fence_generation: context.operation.fence_generation,
            sequence: index + 1,
            effect_id: effectId,
            resource_id: resourceId,
            tenant_id: tenantId,
            receipt: { state: "applied", readback_sha256: "c".repeat(64) },
          });
          for (const frameId of [authorityFrame, authorityFrame + 1]) {
            frame(`requests/${frameId}.ready`, {
              version: 1,
              run_id: workerAttemptId,
              frame_id: frameId,
            });
            notices.push(["protected_installer_frame_ready", frameId]);
          }
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
        frame("resource-observation.json", {
          version: 1,
          operation_id: operationRef,
          context_digest: contextDigest,
          fence_generation: context.operation.fence_generation,
          resource_id: options.wrongReadback ? "foreign-resource" : common.resource_id,
          scope: "auth_database",
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
  const createSandbox = vi.fn(async () => {
    expect(assertCredentialsCheckpointed).toHaveBeenCalledOnce();
    return sandbox;
  });
  const input = {
    approvedPlanBytes: bytes(plan),
    approvalDigest: sha(bytes(plan)),
    effectId: "auth-resources",
    operationRef,
    workerAttemptId,
    fenceGeneration: 7,
    credentials: {
      maintenanceUrl:
        "postgresql://neondb_owner:fixture@ep-isolated.neon.tech/neondb?sslmode=verify-full",
      bytes: bytes(passwordPair),
      sha256: sha(bytes(passwordPair)),
    },
    assertCurrent: vi.fn(async () => {
      if (options.denyFence && fenceRequested)
        throw new HostedOperatorError("authorization_required");
    }),
    assertCredentialsCheckpointed,
    bindWorkerContext,
  };
  // SAFETY: The fake implements only SDK methods consumed by the real transport.
  const dependencies = {
    createSandbox: createSandbox as unknown as NonNullable<
      Parameters<typeof runAuthResourceFileSpool>[2]
    >["createSandbox"],
  };
  const inspectInput = () => {
    const { bindWorkerContext: _binding, ...readback } = input;
    return { ...readback, readbackOnly: true as const };
  };
  return {
    input,
    inspectInput,
    dependencies,
    createSandbox,
    sandbox,
    files,
    modes,
    kill,
    checkpoint,
    bindWorkerContext,
    assertCredentialsCheckpointed,
  };
};

it("bootstraps only the approved Auth resource through all three fenced checkpointed effects", async () => {
  const f = fixture();
  await expect(runAuthResourceFileSpool(config, f.input, f.dependencies)).resolves.toBeNull();
  const contextBytes = f.files.get(`${spool}/startup/context.json`)!;
  expect(JSON.parse(contextBytes.toString())).toMatchObject({
    kind: "neon_resource_bootstrap",
    app_id: "auth",
    tenant_targets: [],
    operation: {
      operation_id: operationRef,
      approval_digest: f.input.approvalDigest,
      fence_generation: 7,
    },
    resource: {
      scope: "auth_database",
      resource_id: "isolated-auth",
      database: "pilot_auth",
      credentials_sha256: f.input.credentials.sha256,
      provider_endpoint_id: "ep-isolated",
    },
    release: { id: f.input.approvalDigest, sha256: f.input.approvalDigest },
  });
  expect(f.assertCredentialsCheckpointed).toHaveBeenCalledWith({
    approvalDigest: f.input.approvalDigest,
    resourceId: "isolated-auth",
    credentialsSha256: f.input.credentials.sha256,
  });
  expect(f.bindWorkerContext).toHaveBeenCalledWith({ contextDigest: sha(contextBytes) });
  expect(f.files.get(`${spool}/startup/resource-credentials.json`)).toEqual(bytes(passwordPair));
  expect(f.files.get(`${spool}/startup/direct-database-url.json`)).toEqual(
    bytes(f.input.credentials.maintenanceUrl),
  );
  expect(
    [...f.modes].filter(([path]) => path.includes("/startup/")).every(([, mode]) => mode === 0o600),
  ).toBe(true);
  expect(
    f.checkpoint.mock.calls.map(([value]) => (value as { effectId: string }).effectId),
  ).toEqual(["resources:roles", "resources:database", "resources:acl"]);
  expect(f.createSandbox).toHaveBeenCalledWith(
    expect.objectContaining({ env: {}, networkPolicy: "allow-all" }),
  );
  expect(f.sandbox.delete).toHaveBeenCalledOnce();
});

it("inspects the same immutable resource without granting mutation authority", async () => {
  const f = fixture();
  await expect(
    runAuthResourceFileSpool(config, f.inspectInput(), f.dependencies),
  ).resolves.toMatchObject({
    status: "applied",
    scope: "auth_database",
    resource_id: "isolated-auth",
  });
  expect(f.bindWorkerContext).not.toHaveBeenCalled();
  expect(f.checkpoint).not.toHaveBeenCalled();
  expect(f.sandbox.runCommand).toHaveBeenLastCalledWith(
    expect.objectContaining({
      args: ["neon-resource-inspect", "--file-spool", spool, workerAttemptId, "120000"],
      env: {},
    }),
  );
});

it.each(["mutation", "foreign-readback"])("rejects %s during resource inspection", async (kind) => {
  const f = fixture({
    mutateDuringInspect: kind === "mutation",
    wrongReadback: kind === "foreign-readback",
  });
  await expect(
    runAuthResourceFileSpool(config, f.inspectInput(), f.dependencies),
  ).rejects.toThrow();
  expect(f.files.has(`${spool}/responses/2.ready`)).toBe(false);
  expect(f.checkpoint).not.toHaveBeenCalled();
});

it("requires durable credential custody before allocating a Sandbox", async () => {
  const f = fixture();
  f.assertCredentialsCheckpointed.mockRejectedValue(
    new HostedOperatorError("operation_in_progress"),
  );
  await expect(runAuthResourceFileSpool(config, f.input, f.dependencies)).rejects.toThrow(
    "operation_in_progress",
  );
  expect(f.createSandbox).not.toHaveBeenCalled();
  expect(f.bindWorkerContext).not.toHaveBeenCalled();
});

it("withholds the startup fence grant after current authority is lost", async () => {
  const f = fixture({ denyFence: true });
  await expect(runAuthResourceFileSpool(config, f.input, f.dependencies)).rejects.toThrow(
    "authorization_required",
  );
  expect(f.files.has(`${spool}/responses/1.ready`)).toBe(false);
  expect(f.checkpoint).not.toHaveBeenCalled();
  expect(f.kill).toHaveBeenCalledOnce();
  expect(f.sandbox.delete).toHaveBeenCalledOnce();
});

it.each(["resources:retire", "generated_app.grant_access", "auth:apply-schema-plan"])(
  "denies the unrelated effect %s",
  async (forbiddenEffect) => {
    const f = fixture({ forbiddenEffect });
    await expect(runAuthResourceFileSpool(config, f.input, f.dependencies)).rejects.toThrow();
    expect(f.files.has(`${spool}/responses/2.ready`)).toBe(false);
    expect(f.checkpoint).not.toHaveBeenCalled();
  },
);

it.each(["resource", "tenant"])("denies a foreign %s in worker frames", async (kind) => {
  const f = fixture({ foreignResource: kind === "resource", tenant: kind === "tenant" });
  await expect(runAuthResourceFileSpool(config, f.input, f.dependencies)).rejects.toThrow();
  expect(f.files.has(`${spool}/responses/2.ready`)).toBe(false);
});

it("verifies the pinned executable before writing maintenance or role credentials", async () => {
  const f = fixture({ wrongPin: true });
  await expect(runAuthResourceFileSpool(config, f.input, f.dependencies)).rejects.toThrow();
  expect(f.files.has(`${spool}/startup/resource-credentials.json`)).toBe(false);
  expect(f.files.has(`${spool}/startup/direct-database-url.json`)).toBe(false);
});

it("accepts equivalent credential JSON while preserving the worker's canonical credential hash", async () => {
  const f = fixture();
  f.input.credentials.bytes = Buffer.from(
    JSON.stringify(
      {
        runtimePassword: passwordPair.runtimePassword,
        migratorPassword: passwordPair.migratorPassword,
      },
      null,
      2,
    ),
  );
  await expect(runAuthResourceFileSpool(config, f.input, f.dependencies)).resolves.toBeNull();
  expect(f.files.get(`${spool}/startup/resource-credentials.json`)).toEqual(bytes(passwordPair));
});

it("freezes resource, credentials, execution mode and worker pin before custody awaits", async () => {
  const f = fixture();
  const configuration = { ...config, resourcesWorker: { ...worker } };
  f.input.assertCurrent.mockImplementationOnce(async () => {
    f.input.approvedPlanBytes.fill(32);
    f.input.credentials.bytes.fill(32);
    f.input.credentials.maintenanceUrl = "postgresql://other:fixture@foreign.invalid/other";
    f.input.fenceGeneration = 99;
    configuration.resourcesWorker.sha256 = "f".repeat(64);
    Object.assign(f.input, { readbackOnly: true });
  });
  await expect(
    runAuthResourceFileSpool(configuration, f.input, f.dependencies),
  ).resolves.toBeNull();
  expect(f.checkpoint).toHaveBeenCalledTimes(3);
  expect(f.files.get(`${spool}/startup/resource-credentials.json`)).toEqual(bytes(passwordPair));
});

it.each([
  "approval",
  "effect",
  "second-resource",
  "installer",
  "credential-hash",
  "pooled-admin",
  "foreign-admin",
  "maintenance-database",
  "role",
  "fence",
] as const)("rejects invalid %s before private custody or allocation", async (kind) => {
  const f = fixture();
  const changed = structuredClone(plan);
  if (kind === "approval") f.input.approvalDigest = "f".repeat(64);
  if (kind === "effect") f.input.effectId = "other";
  if (kind === "second-resource")
    changed.effects.push({ id: "app-resources", kind: "resources", resourceId: "app-resource" });
  if (kind === "installer") changed.resourcesInstaller.sha256 = "f".repeat(64);
  if (kind === "credential-hash") f.input.credentials.sha256 = "f".repeat(64);
  if (kind === "pooled-admin")
    f.input.credentials.maintenanceUrl = f.input.credentials.maintenanceUrl.replace(
      "ep-isolated.",
      "ep-isolated-pooler.",
    );
  if (kind === "foreign-admin")
    f.input.credentials.maintenanceUrl = f.input.credentials.maintenanceUrl.replace(
      "neondb_owner",
      "other",
    );
  if (kind === "maintenance-database") changed.authDatabase.database = "neondb";
  if (kind === "role") changed.authDatabase.runtimeRole = changed.bootstrap.role;
  if (kind === "fence") f.input.fenceGeneration = 0;
  if (["second-resource", "installer", "maintenance-database", "role"].includes(kind)) {
    f.input.approvedPlanBytes = bytes(changed);
    f.input.approvalDigest = sha(f.input.approvedPlanBytes);
  }
  await expect(runAuthResourceFileSpool(config, f.input, f.dependencies)).rejects.toThrow();
  expect(f.assertCredentialsCheckpointed).not.toHaveBeenCalled();
  expect(f.createSandbox).not.toHaveBeenCalled();
});
