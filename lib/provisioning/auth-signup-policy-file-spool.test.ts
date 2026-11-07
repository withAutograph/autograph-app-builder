import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { CommandFinished } from "@vercel/sandbox";
import nodePath from "node:path";
import { z } from "zod";
import { expect, it, vi } from "vitest";
import { HostedOperatorError } from "./hosted-operator-contract";
import { runAuthSignupPolicyFileSpool } from "./hosted-operator-sandbox-launcher";
import type { RecordWorkerCheckpoint } from "./hosted-operator-service";

type CreateSandbox = NonNullable<
  NonNullable<Parameters<typeof runAuthSignupPolicyFileSpool>[2]>["createSandbox"]
>;
type OperatorSandbox = Awaited<ReturnType<CreateSandbox>>;

const operationRef = "11111111-1111-4111-a111-111111111111";
const workerAttemptId = "22222222-2222-4222-a222-222222222222";
const spool = `/vercel/sandbox/protected-installer/${workerAttemptId}`;
const bytes = (value: z.infer<ReturnType<typeof z.json>>) => Buffer.from(JSON.stringify(value));
const requiredFile = (files: ReadonlyMap<string, Buffer>, filePath: string) => {
  const content = files.get(filePath);
  if (content === undefined) {
    throw new Error(`Missing worker protocol file: ${filePath}`);
  }
  return content;
};
const readJson = (files: ReadonlyMap<string, Buffer>, filePath: string) =>
  z.json().parse(JSON.parse(requiredFile(files, filePath).toString()));
const launcherCommandSchema = z.object({
  args: z.array(z.string()).optional(),
  cmd: z.string(),
  detached: z.boolean().optional(),
});
// Parse only the fields the synthetic worker reads; hash the original complete wire bytes.
const workerContextSchema = z.object({
  app_id: z.string(),
  installer: z.object({ id: z.string(), sha256: z.string() }),
  operation: z.object({
    approval_digest: z.string(),
    fence_generation: z.number(),
    operation_id: z.string(),
  }),
  release: z.object({ id: z.string() }),
  resource: z.object({ resource_id: z.string() }),
});
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const worker = {
  executablePath: "/worker/membership",
  id: "auth-owned-organization-v1",
  operationScope: "auth-protected-membership-v1",
  sha256: "a".repeat(64),
  subcommand: "auth-protected-membership",
} as const;
const config = {
  image: "pinned-control",
  membershipWorker: worker,
  projectId: "prj-operator",
  teamId: "team-owned",
  workers: {},
};
const plan = {
  action: "prepare",
  authDatabase: {
    database: "pilot_auth",
    migratorRole: "pilot_migrator",
    resourceId: "isolated-auth",
    runtimeRole: "pilot_runtime",
  },
  authSignupPolicy: {
    allowedEmails: ["controlled@example.test"],
    appId: "signup-pilot",
    appPath: "/pilot",
    appRoles: ["pilot_user"],
    authResourceId: "isolated-auth",
    eligibility: "approved-email",
    membershipRole: "member",
    organizationId: "pilot-org",
    origin: "https://pilot.example",
    policyId: "pilot-signup",
    version: 1,
  },
  deploymentBoundary: {
    operator: { environment: "preview", projectId: "prj-operator" },
    teamId: "team-owned",
    verification: {
      gatewayOrigin: "https://gateway.example",
      jwksUrl: "https://gateway.example/_platform/jwks.json",
      publicOrigin: "https://pilot.example",
    },
  },
  effects: [{ id: "auth-signup-policy", kind: "auth-signup-policy", resourceId: "isolated-auth" }],
  neon: {
    branchId: "isolated-branch",
    endpoint: "ep-isolated.neon.tech",
    projectId: "isolated-project",
  },
  normalActorProgram: {
    appAccess: [{ appId: "signup-pilot", organizationId: "pilot-org", roles: ["pilot_user"] }],
    appId: "signup-pilot",
    organizations: [{ organizationId: "pilot-org" }],
    origin: "https://pilot.example",
  },
  owner: { userId: "owner-fixture" },
  selection: { sessionId: "saved-session", workspaceId: "workspace-fixture" },
  signupPolicyInstaller: { reference: worker.id, sha256: worker.sha256 },
  source: { sha256: "b".repeat(64) },
  version: 1,
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
  const checkpoint = vi.fn<RecordWorkerCheckpoint>(() => Promise.resolve());
  const bindWorkerContext = vi.fn((_value: { contextDigest: string }) =>
    Promise.resolve(checkpoint),
  );
  const kill = vi.fn(() => Promise.resolve());
  const frame = (name: string, value: z.infer<ReturnType<typeof z.json>>) =>
    files.set(`${spool}/${name}`, bytes(value));
  const sandbox = {
    delete: vi.fn(() => Promise.resolve()),
    extendTimeout: vi.fn(() => Promise.resolve()),
    fs: {
      readFile: vi.fn(() =>
        Promise.reject(new Error("Expected launcher file reads through readFileToBuffer")),
      ),
      lstat: vi.fn((path: string) =>
        Promise.resolve(
          Object.assign(statSync(new URL(import.meta.url)), {
            isFile: () => files.has(path),
            size: files.get(path)?.length ?? 0,
          }),
        ),
      ),
      // oxlint-disable-next-line unicorn/no-useless-undefined -- mkdir resolves an absent path, whereas resolve() would infer void outside the SDK contract.
      mkdir: vi.fn(() => Promise.resolve(undefined)),
      rm: vi.fn(() => Promise.resolve()),
    },
    readFileToBuffer: vi.fn(({ path }: { path: string }) =>
      Promise.resolve(files.get(path) ?? null),
    ),
    runCommand: vi.fn((input: string | Parameters<OperatorSandbox["runCommand"]>[0]) => {
      const command = launcherCommandSchema.parse(input);
      // Cached output and overridden process methods keep this SDK instance inert.
      const completed = new CommandFinished({
        cmd: {
          args: command.args ?? [],
          cwd: spool,
          exitCode: 0,
          id: "fixture-command",
          name: command.cmd,
          sessionId: workerAttemptId,
          startedAt: 0,
        },
        exitCode: 0,
        output: {
          stderr: "",
          stdout: `${options.wrongPin === true ? "f".repeat(64) : worker.sha256}  ${worker.executablePath}\n`,
        },
        sessionId: workerAttemptId,
      });
      if (command.detached !== true) {
        return Promise.resolve(completed);
      }
      const contextBytes = requiredFile(files, `${spool}/startup/context.json`);
      const context = workerContextSchema.parse(readJson(files, `${spool}/startup/context.json`));
      const contextDigest = sha(contextBytes);
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
      const inspect = command.args?.[0] === "auth-protected-membership-readback";
      const notices: [string, number][] = [
        ["protected_installer_lifecycle_ready", 1],
        ["protected_installer_frame_ready", 1],
      ];
      frame("requests/1.json", { ...common, kind: "check_fence" });
      frame("requests/1.ready", { version: 1, run_id: workerAttemptId, frame_id: 1 });
      if (!inspect || options.mutateInspect === true) {
        const effectId = options.forbiddenEffect ?? "auth-signup-policy";
        const resourceId = options.foreignResource === true ? "foreign-auth" : common.resource_id;
        const tenantId = options.tenant === true ? "foreign-tenant" : null;
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
      if (inspect) {
        frame("readback.json", {
          version: 1,
          operation_id: operationRef,
          context_digest: options.wrongReadback === true ? "f".repeat(64) : contextDigest,
          fence_generation: context.operation.fence_generation,
          status: "applied",
          readback_sha256: "d".repeat(64),
        });
      }
      return Promise.resolve(
        Object.assign(completed, {
          kill,
          wait: () => Promise.resolve(completed),
          logs: () => {
            const stream = (async function* logs() {
              for (const [kind, frameId] of notices) {
                if (kind === "protected_installer_frame_ready" && frameId === 1) {
                  fenceRequested = true;
                }
                yield {
                  stream: "stdout" as const,
                  data: `${JSON.stringify({ kind, version: 1, run_id: workerAttemptId, frame_id: frameId })}\n`,
                };
              }
            })();
            return Object.assign(stream, {
              close: vi.fn<() => void>(),
              [Symbol.dispose]: vi.fn<() => void>(),
            });
          },
        }),
      );
    }),
    writeFiles: vi.fn((rows: { path: string; content: Buffer; mode?: number }[]) => {
      for (const row of rows) {
        files.set(row.path, row.content);
        modes.set(row.path, row.mode);
      }
      return Promise.resolve();
    }),
  } satisfies OperatorSandbox;
  const createSandbox = vi.fn(() => Promise.resolve(sandbox));
  const input = {
    approvalDigest: sha(bytes(plan)),
    approvedPlanBytes: bytes(plan),
    assertCurrent: vi.fn(() => {
      if (options.denyFence === true && fenceRequested) {
        return Promise.reject(new HostedOperatorError("authorization_required"));
      }
      return Promise.resolve();
    }),
    bindWorkerContext,
    credentials: {
      migrationUrl:
        "postgresql://pilot_migrator:fixture@ep-isolated.neon.tech/pilot_auth?sslmode=verify-full",
    },
    effectId: "auth-signup-policy",
    fenceGeneration: 7,
    operationRef,
    workerAttemptId,
  };
  const dependencies = { createSandbox };
  const inspectInput = () => ({
    ...input,
    bindWorkerContext: undefined,
    readbackOnly: true as const,
  });
  return {
    bindWorkerContext,
    checkpoint,
    createSandbox,
    dependencies,
    files,
    input,
    inspectInput,
    kill,
    modes,
    sandbox,
  };
};

it("runs only the approved policy with complete unchanged bytes and an exact Auth context", async () => {
  const f = fixture();
  await expect(runAuthSignupPolicyFileSpool(config, f.input, f.dependencies)).resolves.toBeNull();
  expect(f.files.get(`${spool}/startup/operator-plan.json`)).toEqual(f.input.approvedPlanBytes);
  expect(readJson(f.files, `${spool}/startup/context.json`)).toMatchObject({
    app_id: "auth",
    release: { id: f.input.approvalDigest, sha256: f.input.approvalDigest },
    resource: {
      database: "pilot_auth",
      migrator_role: "pilot_migrator",
      resource_id: "isolated-auth",
      runtime_role: "pilot_runtime",
    },
    tenant_targets: [],
  });
  expect(readJson(f.files, `${spool}/startup/membership-effect.json`)).toEqual({
    effectId: "auth-signup-policy",
    kind: "auth-signup-policy",
    version: 1,
  });
  expect(
    [...f.files.keys()]
      .filter((name) => name.includes("/startup/"))
      .map((name) => nodePath.basename(name))
      .toSorted((left, right) => left.localeCompare(right)),
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
  ).resolves.toMatchObject({ fence_generation: 7, status: "applied" });
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
  const effects = new Map<string, string>([
    ["app-grant", "generated_app.grant_access"],
    ["membership", "auth-membership"],
    ["resources", "resources:database"],
    ["schema", "auth:apply-schema-plan"],
  ]);
  const f = fixture({
    forbiddenEffect: effects.get(kind),
    foreignResource: kind === "resource",
    mutateInspect: kind === "inspect-mutation",
    tenant: kind === "tenant",
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
  changed.effects[0].id += ":pilot-org";
  f.input.effectId = changed.effects[0].id;
  f.input.approvedPlanBytes = bytes(changed);
  f.input.approvalDigest = sha(f.input.approvedPlanBytes);
  await expect(runAuthSignupPolicyFileSpool(config, f.input, f.dependencies)).resolves.toBeNull();
  expect(
    z
      .object({ effectId: z.string() })
      .parse(readJson(f.files, `${spool}/startup/membership-effect.json`)).effectId,
  ).toBe("auth-signup-policy:pilot-org");
});

it("snapshots approved inputs, worker and execution mode before awaiting custody", async () => {
  const f = fixture();
  const configuration = { ...config, membershipWorker: { ...worker } };
  f.input.assertCurrent.mockImplementationOnce(() => {
    f.input.approvedPlanBytes.fill(32);
    f.input.credentials.migrationUrl = "postgresql://foreign:fixture@foreign.invalid/other";
    f.input.fenceGeneration = 99;
    Object.assign(f.input, { readbackOnly: true });
    configuration.membershipWorker.sha256 = "f".repeat(64);
    configuration.projectId = "foreign-project";
    configuration.teamId = "foreign-team";
    configuration.image = "foreign-image";
    return Promise.resolve();
  });
  await expect(
    runAuthSignupPolicyFileSpool(configuration, f.input, f.dependencies),
  ).resolves.toBeNull();
  expect(f.checkpoint).toHaveBeenCalledOnce();
  expect(f.createSandbox).toHaveBeenCalledWith(
    expect.objectContaining({
      image: "pinned-control",
      projectId: "prj-operator",
      teamId: "team-owned",
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
  if (kind === "public-policy") {
    changed.authSignupPolicy.eligibility = "public";
  }
  if (kind === "admin-role") {
    changed.authSignupPolicy.appRoles = ["app_admin"];
  }
  if (kind === "duplicate-email") {
    changed.authSignupPolicy.allowedEmails.push("CONTROLLED@example.test");
  }
  if (kind === "organization") {
    changed.normalActorProgram.organizations[0].organizationId = "other";
  }
  if (kind === "roles") {
    changed.normalActorProgram.appAccess[0].roles = ["other"];
  }
  if (kind === "app") {
    changed.normalActorProgram.appId = "other";
  }
  if (kind === "origin") {
    changed.authSignupPolicy.origin = "https://other.example";
  }
  if (kind === "gateway") {
    changed.deploymentBoundary.verification.jwksUrl = "https://other.example/_platform/jwks.json";
  }
  if (kind === "auth-resource") {
    changed.authSignupPolicy.authResourceId = "other";
  }
  if (kind === "app-database") {
    Object.assign(changed, { appDatabase: { database: "not-approved" } });
  }
  if (kind === "membership") {
    Object.assign(changed, { authMembership: { organizationId: "not-approved" } });
  }
  if (kind === "extra-effect") {
    changed.effects.push({ id: "access", kind: "access", resourceId: "other" });
  }
  if (kind === "effect-resource") {
    changed.effects[0].resourceId = "other";
  }
  if (kind === "worker") {
    changed.signupPolicyInstaller.sha256 = "f".repeat(64);
  }
  if (kind === "team") {
    changed.deploymentBoundary.teamId = "other";
  }
  if (kind === "operator") {
    changed.deploymentBoundary.operator.projectId = "other";
  }
  if (kind === "foreign-url") {
    f.input.credentials.migrationUrl = f.input.credentials.migrationUrl.replace(
      "pilot_migrator",
      "foreign",
    );
  }
  if (kind === "pooled-url") {
    f.input.credentials.migrationUrl = f.input.credentials.migrationUrl.replace(
      "ep-isolated.",
      "ep-isolated-pooler.",
    );
  }
  f.input.approvedPlanBytes = bytes(changed);
  f.input.approvalDigest = kind === "approval" ? "f".repeat(64) : sha(f.input.approvedPlanBytes);
  await expect(runAuthSignupPolicyFileSpool(config, f.input, f.dependencies)).rejects.toThrow();
  expect(f.createSandbox).not.toHaveBeenCalled();
});
