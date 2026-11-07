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
type JsonFixtureValue =
  | null
  | boolean
  | number
  | string
  | JsonFixtureValue[]
  | { [key: string]: JsonFixtureValue }
  | ProtectedInstallContextWire;

const bytes = (value: JsonFixtureValue) => Buffer.from(JSON.stringify(value));
const readFile = (files: Map<string, Buffer>, path: string) => {
  const value = files.get(path);
  if (!value) {
    throw new Error(`Missing fixture file: ${path}`);
  }
  return value;
};
const worker = {
  executablePath: "/worker/auth",
  id: "auth-protected-schema-v1",
  operationScope: "auth-protected-schema-v1",
  sha256: "a".repeat(64),
  subcommand: "auth-protected-schema",
} as const;
const resource = {
  database: "pilot_auth",
  environment: "preview",
  hostname: "ep-isolated.neon.tech",
  migratorRole: "pilot_migrator",
  neon: { branchId: "isolated-branch", projectId: "isolated-project" },
  port: 5432,
  runtimeRole: "pilot_runtime",
  schema: "public",
  version: 1,
};
const plan = {
  action: "prepare",
  authDatabase: {
    database: resource.database,
    migratorRole: resource.migratorRole,
    resourceId: "isolated-auth",
    runtimeRole: resource.runtimeRole,
  },
  authSchema: {
    artifactRef: "owned-auth-proposal",
    installer: { reference: worker.id, sha256: worker.sha256 },
    planDigest: "b".repeat(64),
    targetDigest: "c".repeat(64),
  },
  neon: { endpoint: resource.hostname, ...resource.neon },
  owner: { appId: "pilot", sessionId: "saved-pilot-session", userId: "owner" },
  source: { sha256: "d".repeat(64) },
  version: 1,
};
const proposal = {
  proposal: "new-empty",
  resource,
  schemaPlan: {
    planDigest: plan.authSchema.planDigest,
    resource,
    targetDigest: plan.authSchema.targetDigest,
  },
  version: 1,
};
const config = {
  authWorker: worker,
  image: "pinned-control",
  projectId: "operator-project",
  teamId: "owned-team",
  workers: {},
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
  const frame = (name: string, value: JsonFixtureValue) =>
    files.set(`${spool}/${name}`, bytes(value));
  const sandbox = {
    delete: vi.fn(async () => {}),
    extendTimeout: vi.fn(async () => {}),
    fs: {
      lstat: vi.fn(async (path: string) => ({
        isFile: () => files.has(path),
        size: files.get(path)?.length ?? 0,
      })),
      mkdir: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
    },
    readFileToBuffer: vi.fn(async ({ path }: { path: string }) => files.get(path) ?? null),
    runCommand: vi.fn(async (command: { detached?: boolean; args: string[] }) => {
      if (command.detached === false || command.detached === undefined) {
        return {
          exitCode: 0,
          stdout: async () =>
            `${options.wrongPin === true ? "f".repeat(64) : worker.sha256}  /worker/auth\n`,
        };
      }
      // SAFETY: context.json is emitted by the real launcher before the fake worker starts.
      const context = JSON.parse(
        readFile(files, `${spool}/startup/context.json`).toString(),
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
        effect_id:
          options.wrongEffect === true ? "generated_app.grant_access" : "auth:apply-schema-plan",
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
            if (kind === "protected_installer_frame_ready" && frameId === 1) {
              fenceRequested = true;
            }
            yield {
              stream: "stdout",
              data: `${JSON.stringify({ kind, version: 1, run_id: workerAttemptId, frame_id: frameId })}\n`,
            };
          }
        },
      };
    }),
    writeFiles: vi.fn(async (rows: { path: string; content: Buffer; mode?: number }[]) => {
      for (const row of rows) {
        files.set(row.path, row.content);
        modes.set(row.path, row.mode);
      }
    }),
  };
  const createSandbox = vi.fn(async () => {
    expect(bindWorkerContext).toHaveBeenCalledOnce();
    return sandbox;
  });
  const input = {
    approvalDigest: sha(bytes(plan)),
    approvedPlanBytes: bytes(plan),
    assertCurrent: vi.fn(async () => {
      if (options.denyFence === true && fenceRequested) {
        throw new HostedOperatorError("authorization_required");
      }
    }),
    authSchemaPlan: { artifactRef: plan.authSchema.artifactRef, content: bytes(proposal) },
    bindWorkerContext,
    credentials: {
      migrationUrl:
        "postgresql://pilot_migrator:fixture@ep-isolated.neon.tech/pilot_auth?sslmode=verify-full",
    },
    fenceGeneration: 7,
    operationRef,
    workerAttemptId,
  };
  // SAFETY: The fake supplies only the official SDK methods consumed by this transport.
  const dependencies = {
    createSandbox: createSandbox as unknown as NonNullable<
      Parameters<typeof runAuthSchemaFileSpool>[2]
    >["createSandbox"],
  };
  return {
    bindWorkerContext,
    createSandbox,
    dependencies,
    files,
    input,
    kill,
    modes,
    recordCheckpoint,
    sandbox,
  };
};

it("executes and checkpoints an Auth-only approved plan with exact private startup bytes", async () => {
  const f = fixture();
  await expect(runAuthSchemaFileSpool(config, f.input, f.dependencies)).resolves.toBeNull();
  expect(f.files.get(`${spool}/startup/operator-plan.json`)).toEqual(f.input.approvedPlanBytes);
  expect(f.files.get(`${spool}/startup/auth-schema-plan.json`)).toEqual(
    f.input.authSchemaPlan.content,
  );
  const contextBytes = readFile(f.files, `${spool}/startup/context.json`);
  expect(JSON.parse(contextBytes.toString())).toMatchObject({
    app_id: "auth",
    operation: {
      approval_digest: f.input.approvalDigest,
      fence_generation: 7,
      operation_id: operationRef,
    },
    release: { id: plan.authSchema.targetDigest, sha256: plan.authSchema.planDigest },
    resource: {
      database: "pilot_auth",
      resource_id: "isolated-auth",
      runtime_role: "pilot_runtime",
    },
    tenant_targets: [],
  });
  expect(f.bindWorkerContext).toHaveBeenCalledWith({ contextDigest: sha(contextBytes) });
  const startup = [...f.modes.keys()].filter((path) => path.includes("/startup/"));
  expect(f.files.get(`${spool}/startup/direct-database-url.json`)).toEqual(
    bytes(f.input.credentials.migrationUrl),
  );
  expect(startup.every((path) => f.modes.get(path) === 0o600)).toBe(true);
  expect(f.createSandbox).toHaveBeenCalledWith(
    expect.objectContaining({ env: {}, networkPolicy: "allow-all" }),
  );
  expect(f.sandbox.runCommand).toHaveBeenLastCalledWith(
    expect.objectContaining({
      args: [worker.subcommand, "--file-spool", spool, workerAttemptId, "120000"],
      cmd: worker.executablePath,
      env: {},
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
  const { migrationUrl } = f.input.credentials;
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
  if (kind === "approval") {
    f.input.approvalDigest = "f".repeat(64);
  }
  if (kind === "owner") {
    f.input.approvedPlanBytes = bytes({ ...plan, owner: { ...plan.owner, userId: "other" } });
  }
  if (kind === "artifact") {
    f.input.authSchemaPlan.artifactRef = "other";
  }
  if (kind === "schema") {
    f.input.authSchemaPlan.content = bytes({
      ...proposal,
      schemaPlan: { ...proposal.schemaPlan, planDigest: "f".repeat(64) },
    });
  }
  if (kind === "resource") {
    f.input.authSchemaPlan.content = bytes({
      ...proposal,
      resource: { ...resource, database: "other" },
    });
  }
  if (kind === "nested-resource") {
    f.input.authSchemaPlan.content = bytes({
      ...proposal,
      schemaPlan: { ...proposal.schemaPlan, resource: { ...resource, database: "other" } },
    });
  }
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
  if (kind === "credential") {
    f.input.credentials.migrationUrl = f.input.credentials.migrationUrl.replace(
      "pilot_migrator",
      "another_login",
    );
  }
  if (kind === "fence") {
    f.input.fenceGeneration = 0;
  }
  await expect(runAuthSchemaFileSpool(config, f.input, f.dependencies)).rejects.toThrow();
  expect(f.createSandbox).not.toHaveBeenCalled();
  expect(f.bindWorkerContext).not.toHaveBeenCalled();
});
