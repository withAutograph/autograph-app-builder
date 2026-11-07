/* oxlint-disable eslint/require-await, typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- Minimal SDK fake exercises the real transport without provider calls. */
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { runAuthSchemaFileSpool } from "./hosted-operator-sandbox-launcher";
import type { ProtectedInstallContextWire } from "./hosted-operator-sandbox-launcher";
import { HostedOperatorError } from "./hosted-operator-contract";

const operationRef = "11111111-1111-4111-a111-111111111111";
const workerAttemptId = "22222222-2222-4222-a222-222222222222";
const spool = `/vercel/sandbox/protected-installer/${workerAttemptId}`;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const worker = {
  id: "auth-protected-schema-v1",
  sha256: "a".repeat(64),
  operationScope: "auth-protected-schema-v1",
  executablePath: "/worker/auth",
  subcommand: "auth-protected-schema",
} as const;
const resource = {
  version: 1,
  environment: "preview",
  hostname: "ep-isolated.neon.tech",
  port: 5432,
  database: "pilot_auth",
  schema: "public",
  migratorRole: "pilot_migrator",
  runtimeRole: "pilot_runtime",
  neon: { projectId: "isolated-project", branchId: "isolated-branch" },
};
const plan = {
  version: 1,
  action: "prepare",
  owner: { sessionId: "saved-pilot-session", appId: "pilot", userId: "owner" },
  source: { sha256: "d".repeat(64) },
  authDatabase: {
    database: resource.database,
    resourceId: "isolated-auth",
    migratorRole: resource.migratorRole,
    runtimeRole: resource.runtimeRole,
  },
  authSchema: {
    artifactRef: "owned-auth-proposal",
    planDigest: "b".repeat(64),
    targetDigest: "c".repeat(64),
    installer: { reference: worker.id, sha256: worker.sha256 },
  },
  neon: { endpoint: resource.hostname, ...resource.neon },
};
const proposal = {
  version: 1,
  proposal: "new-empty",
  resource,
  schemaPlan: {
    resource,
    planDigest: plan.authSchema.planDigest,
    targetDigest: plan.authSchema.targetDigest,
  },
};
const config = {
  image: "pinned-control",
  projectId: "operator-project",
  teamId: "owned-team",
  workers: {},
  authWorker: worker,
};
const fixture = (
  options: { denyFence?: boolean; wrongPin?: boolean; wrongEffect?: boolean } = {},
) => {
  const files = new Map<string, Buffer>();
  const modes = new Map<string, number | undefined>();
  let fenceRequested = false;
  const recordCheckpoint = vi.fn(async () => {});
  const bindWorkerContext = vi.fn(async (_binding: { contextDigest: string }) => recordCheckpoint);
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
      if (!command.detached) {
        return {
          exitCode: 0,
          stdout: async () =>
            `${options.wrongPin ? "f".repeat(64) : worker.sha256}  /worker/auth\n`,
        };
      }
      // SAFETY: context.json is emitted by the real launcher before the fake worker starts.
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
      frame("requests/1.json", { ...common, kind: "check_fence" });
      frame("requests/2.json", {
        ...common,
        kind: "authorize_effect",
        sequence: 1,
        effect_id: options.wrongEffect ? "generated_app.grant_access" : "auth:apply-schema-plan",
      });
      frame("requests/3.json", {
        kind: "checkpoint_effect",
        version: 1,
        operation_id: operationRef,
        context_digest: contextDigest,
        fence_generation: context.operation.fence_generation,
        sequence: 1,
        effect_id: "auth:apply-schema-plan",
        resource_id: context.resource.resource_id,
        tenant_id: null,
        receipt: { state: "applied", readback_sha256: "e".repeat(64) },
      });
      for (const frameId of [1, 2, 3]) {
        frame(`requests/${frameId}.ready`, {
          version: 1,
          run_id: workerAttemptId,
          frame_id: frameId,
        });
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
      return {
        kill,
        wait: async () => ({ exitCode: 0 }),
        logs: async function* logs() {
          for (const [kind, frameId] of [
            ["protected_installer_frame_ready", 1],
            ["protected_installer_lifecycle_ready", 1],
            ["protected_installer_frame_ready", 2],
            ["protected_installer_frame_ready", 3],
            ["protected_installer_lifecycle_ready", 2],
          ] as const) {
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
    expect(bindWorkerContext).toHaveBeenCalledOnce();
    return sandbox;
  });
  const input = {
    approvedPlanBytes: bytes(plan),
    approvalDigest: sha(bytes(plan)),
    authSchemaPlan: { artifactRef: plan.authSchema.artifactRef, content: bytes(proposal) },
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
  // SAFETY: The fake supplies only the official SDK methods consumed by this transport.
  const dependencies = {
    createSandbox: createSandbox as unknown as NonNullable<
      Parameters<typeof runAuthSchemaFileSpool>[2]
    >["createSandbox"],
  };
  return {
    input,
    dependencies,
    createSandbox,
    sandbox,
    files,
    modes,
    kill,
    recordCheckpoint,
    bindWorkerContext,
  };
};

it("executes and checkpoints an Auth-only approved plan with exact private startup bytes", async () => {
  const f = fixture();
  await expect(runAuthSchemaFileSpool(config, f.input, f.dependencies)).resolves.toBeNull();
  expect(f.files.get(`${spool}/startup/operator-plan.json`)).toEqual(f.input.approvedPlanBytes);
  expect(f.files.get(`${spool}/startup/auth-schema-plan.json`)).toEqual(
    f.input.authSchemaPlan.content,
  );
  const contextBytes = f.files.get(`${spool}/startup/context.json`)!;
  expect(JSON.parse(contextBytes.toString())).toMatchObject({
    app_id: "auth",
    operation: {
      operation_id: operationRef,
      approval_digest: f.input.approvalDigest,
      fence_generation: 7,
    },
    resource: {
      resource_id: "isolated-auth",
      database: "pilot_auth",
      runtime_role: "pilot_runtime",
    },
    release: { id: plan.authSchema.targetDigest, sha256: plan.authSchema.planDigest },
    tenant_targets: [],
  });
  expect(f.bindWorkerContext).toHaveBeenCalledWith({ contextDigest: sha(contextBytes) });
  const startup = [...f.modes.keys()].filter((path) => path.includes("/startup/"));
  expect(f.files.get(`${spool}/startup/direct-database-url.json`)).toEqual(
    bytes(f.input.credentials.migrationUrl),
  );
  expect(startup.every((path) => f.modes.get(path) === 0o600)).toBe(true);
  expect(f.createSandbox).toHaveBeenCalledWith(
    expect.objectContaining({ networkPolicy: "allow-all", env: {} }),
  );
  expect(f.sandbox.runCommand).toHaveBeenLastCalledWith(
    expect.objectContaining({
      cmd: worker.executablePath,
      env: {},
      args: [worker.subcommand, "--file-spool", spool, workerAttemptId, "120000"],
    }),
  );
  expect(f.recordCheckpoint).toHaveBeenCalledOnce();
  expect(f.sandbox.delete).toHaveBeenCalledOnce();
});

it("stops without granting authority when the startup fence is no longer current", async () => {
  const f = fixture({ denyFence: true });
  await expect(runAuthSchemaFileSpool(config, f.input, f.dependencies)).rejects.toThrow();
  expect(f.files.has(`${spool}/responses/1.ready`)).toBe(false);
  expect(f.recordCheckpoint).not.toHaveBeenCalled();
  expect(f.kill).toHaveBeenCalledOnce();
  expect(f.sandbox.delete).toHaveBeenCalledOnce();
});

it("keeps the approved startup and worker pin stable across asynchronous custody checks", async () => {
  const f = fixture();
  const configuration = { ...config, authWorker: { ...worker } };
  const approvedBytes = Buffer.from(f.input.approvedPlanBytes);
  const proposalBytes = Buffer.from(f.input.authSchemaPlan.content);
  const migrationUrl = f.input.credentials.migrationUrl;
  f.input.assertCurrent.mockImplementationOnce(async () => {
    f.input.approvedPlanBytes.fill(32);
    f.input.authSchemaPlan.content.fill(32);
    f.input.credentials.migrationUrl = "postgresql://other:fixture@other.invalid/other";
    configuration.authWorker.sha256 = "f".repeat(64);
  });
  await expect(runAuthSchemaFileSpool(configuration, f.input, f.dependencies)).resolves.toBeNull();
  expect(f.files.get(`${spool}/startup/operator-plan.json`)).toEqual(approvedBytes);
  expect(f.files.get(`${spool}/startup/auth-schema-plan.json`)).toEqual(proposalBytes);
  expect(f.files.get(`${spool}/startup/direct-database-url.json`)).toEqual(bytes(migrationUrl));
});

it("never authorizes an app grant through the Auth-only worker", async () => {
  const f = fixture({ wrongEffect: true });
  await expect(runAuthSchemaFileSpool(config, f.input, f.dependencies)).rejects.toThrow();
  expect(f.files.has(`${spool}/responses/2.ready`)).toBe(false);
  expect(f.recordCheckpoint).not.toHaveBeenCalled();
});

it("checks the executable pin before writing the Auth credential", async () => {
  const f = fixture({ wrongPin: true });
  await expect(runAuthSchemaFileSpool(config, f.input, f.dependencies)).rejects.toThrow();
  expect(f.files.has(`${spool}/startup/direct-database-url.json`)).toBe(false);
  expect(f.sandbox.delete).toHaveBeenCalledOnce();
});

it.each([
  "approval",
  "owner",
  "artifact",
  "schema",
  "resource",
  "nested-resource",
  "installer",
  "credential",
  "fence",
] as const)("rejects a mismatched %s before allocating a Sandbox", async (kind) => {
  const f = fixture();
  if (kind === "approval") f.input.approvalDigest = "f".repeat(64);
  if (kind === "owner")
    f.input.approvedPlanBytes = bytes({ ...plan, owner: { ...plan.owner, userId: "other" } });
  if (kind === "artifact") f.input.authSchemaPlan.artifactRef = "other";
  if (kind === "schema")
    f.input.authSchemaPlan.content = bytes({
      ...proposal,
      schemaPlan: { ...proposal.schemaPlan, planDigest: "f".repeat(64) },
    });
  if (kind === "resource")
    f.input.authSchemaPlan.content = bytes({
      ...proposal,
      resource: { ...resource, database: "other" },
    });
  if (kind === "nested-resource")
    f.input.authSchemaPlan.content = bytes({
      ...proposal,
      schemaPlan: { ...proposal.schemaPlan, resource: { ...resource, database: "other" } },
    });
  if (kind === "installer") {
    f.input.approvedPlanBytes = bytes({
      ...plan,
      authSchema: {
        ...plan.authSchema,
        installer: { ...plan.authSchema.installer, sha256: "f".repeat(64) },
      },
    });
    f.input.approvalDigest = sha(f.input.approvedPlanBytes);
  }
  if (kind === "credential")
    f.input.credentials.migrationUrl = f.input.credentials.migrationUrl.replace(
      "pilot_migrator",
      "another_login",
    );
  if (kind === "fence") f.input.fenceGeneration = 0;
  await expect(runAuthSchemaFileSpool(config, f.input, f.dependencies)).rejects.toThrow();
  expect(f.createSandbox).not.toHaveBeenCalled();
  expect(f.bindWorkerContext).not.toHaveBeenCalled();
});
