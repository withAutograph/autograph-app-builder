import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { CommandFinished } from "@vercel/sandbox";
import nodePath from "node:path";
import { z } from "zod";
import { expect, it, vi } from "vitest";
import { HostedOperatorError } from "./hosted-operator-contract";
import { runAuthOrganizationFileSpool } from "./hosted-operator-sandbox-launcher";
import type { AuthOnlyOrganizationProofBinding } from "./hosted-operator-sandbox-launcher";

import type { RecordWorkerCheckpoint } from "./hosted-operator-service";

type CreateSandbox = NonNullable<
  NonNullable<Parameters<typeof runAuthOrganizationFileSpool>[2]>["createSandbox"]
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
const proof = "private-captured-realm-proof";
const plan = {
  action: "prepare",
  authDatabase: {
    database: "pilot_auth",
    migratorRole: "pilot_migrator",
    resourceId: "isolated-auth",
    runtimeRole: "pilot_runtime",
  },
  authMembership: {
    actorId: "realm-owner",
    bootstrapPlanDigest: "b".repeat(64),
    identityCapture: {
      capturedAt: "2026-01-01T00:00:00.000Z",
      realmSessionId: "live-realm-session",
    },
    identityNonceSha256: "c".repeat(64),
    identityProof: { reference: "private-proof-reference", sha256: sha(Buffer.from(proof)) },
    identityVerification: {
      audience: "https://operator.example",
      issuer: "https://pilot.example",
      jwksUrl: "https://gateway.example/_platform/jwks.json",
      transportSource: {
        audience: "https://vercel.com/team-owned",
        environment: "preview",
        issuer: "https://oidc.vercel.com/team-owned",
        ownerId: "team-owned",
        projectId: "prj-operator",
      },
    },
    kind: "create-owned-organization",
    name: "Pilot",
    organizationId: "pilot-org",
    slug: "pilot-org",
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
  effects: [{ id: "auth-membership", kind: "auth-membership", resourceId: "isolated-auth" }],
  membershipInstaller: { reference: worker.id, sha256: worker.sha256 },
  neon: {
    branchId: "isolated-branch",
    endpoint: "ep-isolated.neon.tech",
    projectId: "isolated-project",
  },
  owner: { userId: "owner-fixture" },
  selection: { sessionId: "saved-session", workspaceId: "workspace-fixture" },
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
        const effectId = options.forbiddenEffect ?? "auth-membership";
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
    assertCurrentOwnerProof: vi.fn((_binding: AuthOnlyOrganizationProofBinding) => {
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
    effectId: "auth-membership",
    fenceGeneration: 7,
    operationRef,
    ownerProof: {
      oidcToken: "private-operator-oidc",
      proof,
      reference: plan.authMembership.identityProof.reference,
    },
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

it("runs only approved organization creation with exact private proof and Auth context", async () => {
  const f = fixture();
  await expect(runAuthOrganizationFileSpool(config, f.input, f.dependencies)).resolves.toBeNull();
  expect(f.files.get(`${spool}/startup/operator-plan.json`)).toEqual(f.input.approvedPlanBytes);
  expect(readJson(f.files, `${spool}/startup/context.json`)).toMatchObject({
    app_id: "auth",
    release: { id: f.input.approvalDigest, sha256: plan.authMembership.identityProof.sha256 },
    resource: {
      database: "pilot_auth",
      migrator_role: "pilot_migrator",
      resource_id: "isolated-auth",
      runtime_role: "pilot_runtime",
    },
    tenant_targets: [],
  });
  expect(readJson(f.files, `${spool}/startup/membership-effect.json`)).toEqual({
    effectId: "auth-membership",
    kind: "auth-membership",
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
    "gateway-readback-oidc.json",
    "membership-effect.json",
    "operator-plan.json",
    "ready.json",
    "realm-identity-proof.json",
  ]);
  expect(f.checkpoint).toHaveBeenCalledOnce();
  expect(f.checkpoint).toHaveBeenCalledWith(
    expect.objectContaining({ effectId: "auth-membership" }),
  );
  expect([...f.modes.values()].every((mode) => mode === 0o600)).toBe(true);
  expect(f.createSandbox).toHaveBeenCalledWith(
    expect.objectContaining({ env: {}, networkPolicy: "allow-all" }),
  );
  expect(f.sandbox.delete).toHaveBeenCalledOnce();
});

it("independently reads the same organization without binding or authorizing a mutation", async () => {
  const f = fixture();
  await expect(
    runAuthOrganizationFileSpool(config, f.inspectInput(), f.dependencies),
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
  "policy",
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
    ["policy", "auth-signup-policy"],
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
    runAuthOrganizationFileSpool(
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
  await expect(runAuthOrganizationFileSpool(config, f.input, f.dependencies)).rejects.toThrow(
    "authorization_required",
  );
  expect(f.files.has(`${spool}/responses/1.ready`)).toBe(false);
  expect(f.kill).toHaveBeenCalledOnce();
  const wrong = fixture({ wrongPin: true });
  await expect(
    runAuthOrganizationFileSpool(config, wrong.input, wrong.dependencies),
  ).rejects.toThrow();
  expect(wrong.files.size).toBe(0);
});

it("supports the worker's organization-scoped effect ID without changing its canonical membership command", async () => {
  const f = fixture();
  const changed = structuredClone(plan);
  changed.effects[0].id += ":pilot-org";
  f.input.effectId = changed.effects[0].id;
  f.input.approvedPlanBytes = bytes(changed);
  f.input.approvalDigest = sha(f.input.approvedPlanBytes);
  await expect(runAuthOrganizationFileSpool(config, f.input, f.dependencies)).resolves.toBeNull();
  expect(
    z
      .object({ effectId: z.string() })
      .parse(readJson(f.files, `${spool}/startup/membership-effect.json`)).effectId,
  ).toBe("auth-membership:pilot-org");
});

it("snapshots approved inputs, worker and execution mode before awaiting custody", async () => {
  const f = fixture();
  const configuration = { ...config, membershipWorker: { ...worker } };
  f.input.assertCurrentOwnerProof.mockImplementationOnce(() => {
    f.input.approvedPlanBytes.fill(32);
    f.input.credentials.migrationUrl = "postgresql://foreign:fixture@foreign.invalid/other";
    f.input.fenceGeneration = 99;
    f.input.ownerProof.proof = "different-proof";
    f.input.ownerProof.oidcToken = "different-oidc";
    Object.assign(f.input, { readbackOnly: true });
    configuration.membershipWorker.sha256 = "f".repeat(64);
    configuration.projectId = "foreign-project";
    configuration.teamId = "foreign-team";
    configuration.image = "foreign-image";
    return Promise.resolve();
  });
  await expect(
    runAuthOrganizationFileSpool(configuration, f.input, f.dependencies),
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

it("requires retained proof authority before allocation and gives each fence an immutable exact binding", async () => {
  const denied = fixture();
  denied.input.assertCurrentOwnerProof.mockRejectedValue(
    new HostedOperatorError("auth_identity_required"),
  );
  await expect(
    runAuthOrganizationFileSpool(config, denied.input, denied.dependencies),
  ).rejects.toThrow("auth_identity_required");
  expect(denied.createSandbox).not.toHaveBeenCalled();
  expect(denied.bindWorkerContext).not.toHaveBeenCalled();
  const f = fixture();
  const originalDigest = f.input.approvalDigest;
  let count = 0;
  f.input.assertCurrentOwnerProof.mockImplementation((binding) => {
    count += 1;
    expect(binding).toMatchObject({
      approvalDigest: originalDigest,
      authResourceId: "isolated-auth",
      effectId: "auth-membership",
      fenceGeneration: 7,
      operationRef,
      organization: plan.authMembership,
      ownerSessionId: "saved-session",
    });
    expect(binding.resource).toMatchObject({
      database: "pilot_auth",
      environment: "preview",
      hostname: "ep-isolated.neon.tech",
    });
    binding.organization.actorId = "mutated";
    binding.resource.hostname = "foreign";
    return Promise.resolve();
  });
  await expect(runAuthOrganizationFileSpool(config, f.input, f.dependencies)).resolves.toBeNull();
  expect(count).toBeGreaterThan(2);
  expect(readJson(f.files, `${spool}/startup/realm-identity-proof.json`)).toEqual({ proof });
  expect(readJson(f.files, `${spool}/startup/gateway-readback-oidc.json`)).toEqual({
    token: "private-operator-oidc",
  });
});

it.each([
  "approval",
  "proof",
  "proof-reference",
  "missing-capture",
  "future-capture",
  "join",
  "group",
  "policy",
  "program",
  "app-database",
  "origin",
  "gateway",
  "oidc-owner",
  "oidc-project",
  "oidc-environment",
  "missing-oidc",
  "extra-effect",
  "effect-resource",
  "effect-id",
  "worker",
  "team",
  "operator",
  "foreign-url",
  "pooled-url",
] as const)("rejects invalid %s before allocating a Sandbox", async (kind) => {
  const f = fixture();
  const changed = structuredClone(plan);
  const mutations: Record<Exclude<typeof kind, "approval">, () => void> = {
    proof: () => {
      f.input.ownerProof.proof = "other";
    },
    "proof-reference": () => {
      f.input.ownerProof.reference = "other";
    },
    "missing-capture": () => {
      Reflect.deleteProperty(changed.authMembership, "identityCapture");
    },
    "future-capture": () => {
      changed.authMembership.identityCapture.capturedAt = "2999-01-01T00:00:00.000Z";
    },
    join: () => {
      changed.authMembership.kind = "join-existing-organization";
    },
    group: () => {
      Object.assign(changed, {
        authMembership: {
          kind: "create-owned-organizations",
          organizations: [changed.authMembership],
        },
      });
    },
    policy: () => {
      Object.assign(changed, { authSignupPolicy: { appId: "unexpected" } });
    },
    program: () => {
      Object.assign(changed, { normalActorProgram: { appId: "unexpected" } });
    },
    "app-database": () => {
      Object.assign(changed, { appDatabase: { database: "unexpected" } });
    },
    origin: () => {
      changed.authMembership.identityVerification.issuer = "https://other.example";
    },
    gateway: () => {
      changed.authMembership.identityVerification.jwksUrl =
        "https://other.example/_platform/jwks.json";
    },
    "oidc-owner": () => {
      changed.authMembership.identityVerification.transportSource.ownerId = "other";
    },
    "oidc-project": () => {
      changed.authMembership.identityVerification.transportSource.projectId = "other";
    },
    "oidc-environment": () => {
      changed.authMembership.identityVerification.transportSource.environment = "production";
    },
    "missing-oidc": () => {
      f.input.ownerProof.oidcToken = "";
    },
    "extra-effect": () => {
      changed.effects.push({ id: "access", kind: "access", resourceId: "other" });
    },
    "effect-resource": () => {
      changed.effects[0].resourceId = "other";
    },
    "effect-id": () => {
      changed.effects[0].id = "auth-membership:other";
      f.input.effectId = changed.effects[0].id;
    },
    worker: () => {
      changed.membershipInstaller.sha256 = "f".repeat(64);
    },
    team: () => {
      changed.deploymentBoundary.teamId = "other";
    },
    operator: () => {
      changed.deploymentBoundary.operator.projectId = "other";
    },
    "foreign-url": () => {
      f.input.credentials.migrationUrl = f.input.credentials.migrationUrl.replace(
        "pilot_migrator",
        "foreign",
      );
    },
    "pooled-url": () => {
      f.input.credentials.migrationUrl = f.input.credentials.migrationUrl.replace(
        "ep-isolated.",
        "ep-isolated-pooler.",
      );
    },
  };
  if (kind !== "approval") {
    mutations[kind]();
  }
  f.input.approvedPlanBytes = bytes(changed);
  f.input.approvalDigest = kind === "approval" ? "f".repeat(64) : sha(f.input.approvedPlanBytes);
  await expect(runAuthOrganizationFileSpool(config, f.input, f.dependencies)).rejects.toThrow();
  expect(f.createSandbox).not.toHaveBeenCalled();
});
