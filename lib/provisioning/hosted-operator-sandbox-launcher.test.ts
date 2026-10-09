/* oxlint-disable eslint/sort-keys, eslint/consistent-type-definitions, eslint/require-await, eslint/object-shorthand, eslint/func-names, eslint/curly, eslint/no-await-in-loop, unicorn/no-useless-undefined, unicorn/no-useless-spread, typescript/no-non-null-assertion, typescript/strict-boolean-expressions, typescript/no-unsafe-type-assertion, typescript/no-unnecessary-type-assertion, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-conditional-empty-object-spread, anti-slop/require-safety-comment-for-type-assertion -- Synthetic SDK fakes use minimal opaque fixtures to exercise the real protocol boundary without provider calls. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { HostedOperatorError, hostedOperatorPlanSchema } from "./hosted-operator-contract";
import type { HostedOperatorWorkerEffectContext } from "./hosted-operator-service";
import {
  buildProtectedInstallContext,
  buildResourceBootstrapContext,
  createHostedOperatorSandboxLauncher,
} from "./hosted-operator-sandbox-launcher";
import type { GeneratedAppReleaseFiles } from "./hosted-operator-sandbox-launcher";

const runId = "a79c7cc3-9236-4a09-9e4a-5f772d08a255";
const rustWire = JSON.parse(
  readFileSync(new URL("fixtures/protected-installer-rust-frames.json", import.meta.url), "utf-8"),
) as { authorization: string; checkpoint: string; context: string; contextDigest: string };
const rustAuthorization = JSON.parse(rustWire.authorization) as Record<string, unknown>;
const rustCheckpoint = JSON.parse(rustWire.checkpoint) as {
  receipt: { readback_sha256: string; state: "applied" | "no_change" };
} & Record<string, unknown>;
const workerDigest = "a".repeat(64);
const readbackDigest = "c".repeat(64);
const plan = hostedOperatorPlanSchema.parse({
  access: [
    { actorId: "reviewer", organizationId: "tenant-a", roles: ["reviewer"] },
    { actorId: "second-reviewer", organizationId: "tenant-a", roles: ["reviewer"] },
  ],
  action: "prepare",
  appDatabase: {
    database: "app_db",
    migratorRole: "app_migrator",
    resourceId: "app-resource",
    runtimeRole: "app_runtime",
  },
  authDatabase: {
    database: "auth_db",
    migratorRole: "auth_migrator",
    resourceId: "auth-resource",
    runtimeRole: "auth_runtime",
  },
  contextId: "fixture-context",
  cost: { class: "shared-recovery-group", description: "Disposable", owner: "Fixture" },
  effects: [
    { description: "Inspect resources", id: "resources", kind: "resources" },
    { description: "Install release", id: "install", kind: "install" },
    { description: "Verify access", id: "access", kind: "access" },
    { description: "Bind runtime", id: "bindings", kind: "bindings" },
  ],
  installer: { reference: "trusted-worker", sha256: workerDigest },
  neon: {
    branchId: "br_fixture",
    connectionRef: "owner-connection",
    endpoint: "ep-fixture.us-east-1.aws.neon.tech",
    projectId: "neon-fixture",
    source: "synthetic-only",
  },
  publicGateway: {
    branch: "preview",
    origin: "https://preview.example.test",
    projectId: "prj_fixture",
  },
  release: { artifactRef: "verified-artifact", id: "release-fixture", sha256: "b".repeat(64) },
  retention: { expiresAt: "2027-01-01T00:00:00.000Z", policy: "Fixture retention" },
  selection: {
    appId: "hc",
    branch: "preview",
    environment: "preview",
    projectId: "prj_fixture",
    sessionId: "session-fixture",
  },
  version: 1,
});

const context = buildProtectedInstallContext({
  database: "appDatabase",
  fenceGeneration: 3,
  operationRef: runId,
  plan,
});
const contextDigest = createHash("sha256").update(JSON.stringify(context)).digest("hex");
const frame = (value: unknown) => Buffer.from(JSON.stringify(value));

const authorityNotice = (frameId: number) => ({
  kind: "protected_installer_frame_ready",
  version: 1,
  run_id: runId,
  frame_id: frameId,
});
type Notice = { stream: "stdout" | "stderr"; data: string };
const fixtureFilesystemSource = (snapshotId?: string) =>
  snapshotId
    ? { source: { type: "snapshot" as const, snapshotId } }
    : { image: "protected-installer-control-image" };
// oxlint-disable-next-line sonarjs/cognitive-complexity -- One owned SDK fixture covers the closed installer and guard-only protocol variants.
const makeFixture = (
  options: {
    access?: boolean;
    fenceOnly?: boolean;
    readbackStatus?: "applied" | "incomplete";
    unknown?: boolean;
    staleAtAuthority?: boolean;
    wrongResource?: boolean;
    effectId?: string;
    tenantId?: string | null;
    pinMatches?: boolean;
    abortBeforeAuthority?: AbortController;
    delayCreate?: Promise<void>;
    generated?: boolean;
    auth?: boolean;
    snapshotId?: string;
  } = {},
) => {
  const generatedFiles = Object.fromEntries(
    [
      "app-artifact.json",
      "cue-to-sql-source-map.json",
      "data-operations.md",
      "data-operations.ts",
      "data-server.ts",
      "operation-manifest.json",
      "release-manifest.json",
      "runtime-coverage.json",
      "sql-bundle.sql",
      "sql-manifest.json",
      "transition-contract.json",
      "transition-plan.json",
    ].map((member) => [member, Buffer.from(`synthetic relay member: ${member}`)]),
  ) as GeneratedAppReleaseFiles;
  let selectedPlan = plan;
  if (options.generated) {
    selectedPlan = hostedOperatorPlanSchema.parse({
      ...plan,
      installer: { ...plan.installer, reference: "generated-app-protected-installer-v1" },
      release: {
        ...plan.release,
        sha256: createHash("sha256").update(generatedFiles["release-manifest.json"]).digest("hex"),
      },
      selection: { ...plan.selection, appId: "spend-review" },
    });
  } else if (options.auth) {
    selectedPlan = hostedOperatorPlanSchema.parse({
      ...plan,
      authSchema: {
        artifactRef: "auth-plan-artifact",
        planDigest: "d".repeat(64),
        targetDigest: "e".repeat(64),
        installer: { reference: "auth-protected-schema-v1", sha256: "f".repeat(64) },
      },
    });
  }
  const customWorker = options.generated === true || options.auth === true;
  const selectedContext = buildProtectedInstallContext({
    plan: selectedPlan,
    database: options.auth ? "authDatabase" : "appDatabase",
    ...(options.auth ? { subject: "auth" as const } : {}),
    fenceGeneration: 3,
    operationRef: runId,
  });
  const selectedDigest = createHash("sha256").update(JSON.stringify(selectedContext)).digest("hex");
  const reportedDigest =
    options.pinMatches === false ? "d".repeat(64) : selectedContext.installer.sha256;
  let selectedEffectId = "generated_app.prepare_schema_revision";
  if (options.access) {
    selectedEffectId = "generated_app.grant_access";
  }
  if (options.auth) {
    selectedEffectId = "auth:apply-schema-plan";
  }
  const scopedAuthorization = customWorker
    ? {
        ...rustAuthorization,
        approval_digest: selectedContext.operation.approval_digest,
        context_digest: selectedDigest,
        app_id: selectedContext.app_id,
        installer_id: selectedContext.installer.id,
        installer_sha256: selectedContext.installer.sha256,
        effect_id: selectedEffectId,
        release_id: selectedContext.release.id,
        resource_id: selectedContext.resource.resource_id,
        tenant_id: options.auth ? null : rustAuthorization.tenant_id,
      }
    : rustAuthorization;
  const files = new Map<string, Buffer>();
  const written: string[] = [];
  const records: unknown[] = [];
  let workerCommand:
    | {
        kill: ReturnType<typeof vi.fn>;
        logs: () => AsyncGenerator<Notice>;
        wait: ReturnType<typeof vi.fn>;
      }
    | undefined;
  const sandbox = {
    delete: vi.fn(async () => undefined),
    extendTimeout: vi.fn(async () => undefined),
    fs: {
      lstat: vi.fn(async (filePath: string) => ({
        isFile: () => files.has(filePath),
        size: files.get(filePath)?.length ?? 0,
      })),
      mkdir: vi.fn(async () => undefined),
      rm: vi.fn(async () => undefined),
      readFile: vi.fn(),
    },
    readFileToBuffer: vi.fn(
      async ({ path: filePath }: { path: string }) => files.get(filePath) ?? null,
    ),
    writeFiles: vi.fn(async (entries: { path: string; content: Buffer }[]) => {
      for (const entry of entries) {
        files.set(entry.path, entry.content);
        written.push(entry.path);
      }
    }),
    runCommand: vi.fn(
      async (commandOptions: {
        args?: string[];
        cmd: string;
        detached?: boolean;
        env?: Record<string, string>;
      }) => {
        if (!commandOptions.detached) {
          return {
            exitCode: 0,
            stdout: async () => `${reportedDigest}  /opt/trusted-worker\n`,
          };
        }

        const transportRunId = commandOptions.args?.[3] ?? runId;
        const ready = (frameId: number) =>
          frame({ version: 1, run_id: transportRunId, frame_id: frameId });
        const request = {
          ...scopedAuthorization,
          ...(options.wrongResource ? { resource_id: "other-resource" } : {}),
          ...(options.effectId ? { effect_id: options.effectId } : {}),
          ...(options.tenantId === undefined ? {} : { tenant_id: options.tenantId }),
        };
        files.set(
          `/vercel/sandbox/protected-installer/${transportRunId}/lifecycle/1.json`,
          frame({ version: 1, run_id: transportRunId, kind: "worker_started" }),
        );
        files.set(
          `/vercel/sandbox/protected-installer/${transportRunId}/lifecycle/1.ready`,
          ready(1),
        );
        const wireRequest = { ...request };
        if (options.fenceOnly) {
          Object.assign(wireRequest, { kind: "check_fence" });
          Reflect.deleteProperty(wireRequest, "effect_id");
          Reflect.deleteProperty(wireRequest, "sequence");
        }
        files.set(
          `/vercel/sandbox/protected-installer/${transportRunId}/requests/1.json`,
          frame(wireRequest),
        );
        files.set(
          `/vercel/sandbox/protected-installer/${transportRunId}/requests/1.ready`,
          ready(1),
        );
        const requestCanContinue =
          options.wrongResource !== true && options.staleAtAuthority !== true;
        if (requestCanContinue) {
          files.set(
            `/vercel/sandbox/protected-installer/${transportRunId}/requests/2.json`,
            frame({
              ...rustCheckpoint,
              ...(customWorker
                ? {
                    context_digest: selectedDigest,
                    effect_id: request.effect_id,
                    tenant_id: request.tenant_id,
                    resource_id: request.resource_id,
                  }
                : {}),
              receipt: options.unknown ? { state: "unknown" } : rustCheckpoint.receipt,
            }),
          );
          files.set(
            `/vercel/sandbox/protected-installer/${transportRunId}/requests/2.ready`,
            ready(2),
          );
          files.set(
            `/vercel/sandbox/protected-installer/${transportRunId}/lifecycle/2.json`,
            frame({
              version: 1,
              run_id: transportRunId,
              kind: options.unknown ? "worker_failed" : "worker_succeeded",
              ...(options.unknown ? { failure_code: "readback_unknown" } : {}),
            }),
          );
          files.set(
            `/vercel/sandbox/protected-installer/${transportRunId}/lifecycle/2.ready`,
            ready(2),
          );
        }

        if (options.readbackStatus !== undefined) {
          files.set(
            `/vercel/sandbox/protected-installer/${transportRunId}/readback.json`,
            frame({
              version: 1,
              operation_id: runId,
              context_digest: selectedDigest,
              fence_generation: 3,
              status: options.readbackStatus,
              readback_sha256: "9".repeat(64),
            }),
          );
        }
        const notices: Notice[] = [
          { stream: "stderr", data: "installer private diagnostic that must not be forwarded" },
          {
            stream: "stdout",
            data: `${JSON.stringify({ kind: "protected_installer_lifecycle_ready", version: 1, run_id: transportRunId, frame_id: 1 })}\n`,
          },
          {
            stream: "stdout",
            data: `${JSON.stringify({ ...authorityNotice(1), run_id: transportRunId })}\n`,
          },
        ];
        if (!options.staleAtAuthority && !options.wrongResource) {
          if (!options.fenceOnly) {
            notices.push({
              stream: "stdout",
              data: `${JSON.stringify({ ...authorityNotice(2), run_id: transportRunId })}\n`,
            });
          }
          notices.push({
            stream: "stdout",
            data: `${JSON.stringify({ kind: "protected_installer_lifecycle_ready", version: 1, run_id: transportRunId, frame_id: 2 })}\n`,
          });
        }
        workerCommand = {
          kill: vi.fn(async () => undefined),
          logs: async function* () {
            for (const notice of notices) {
              if (
                options.abortBeforeAuthority !== undefined &&
                notice.data.includes('"protected_installer_frame_ready"')
              ) {
                options.abortBeforeAuthority.abort();
              }
              yield notice;
            }
          },
          wait: vi.fn(async () => ({ exitCode: 0 })),
        };
        return workerCommand;
      },
    ),
  };

  const createSandbox = vi.fn(async (_options: unknown) => {
    await options.delayCreate;
    return sandbox as never;
  });
  const assertCurrent = vi.fn(async () => {
    if (options.staleAtAuthority && assertCurrent.mock.calls.length > 2) {
      throw new HostedOperatorError("authorization_required");
    }
  });
  const bindWorkerContext = vi.fn(async ({ contextDigest: digest }: { contextDigest: string }) => {
    expect(digest).toBe(selectedDigest);
    return async (checkpoint: unknown) => {
      records.push(checkpoint);
    };
  });
  const input = {
    authority: {} as HostedOperatorWorkerEffectContext["authority"],
    target: {} as HostedOperatorWorkerEffectContext["target"],
    effect: options.access
      ? selectedPlan.effects.find((effect) => effect.kind === "access")!
      : plan.effects[1]!,
    fenceGeneration: 3,
    operationRef: runId,
    plan: selectedPlan,
    ...(options.auth
      ? {
          authSchemaPlan: {
            artifactRef: "auth-plan-artifact",
            content: frame({
              version: 1,
              resource: {
                version: 1,
                environment: "preview",
                hostname: plan.neon.endpoint,
                port: 5432,
                database: plan.authDatabase.database,
                schema: "public",
                migratorRole: plan.authDatabase.migratorRole,
                runtimeRole: plan.authDatabase.runtimeRole,
                neon: { projectId: plan.neon.projectId, branchId: plan.neon.branchId },
              },
              schemaPlan: {
                planDigest: selectedPlan.authSchema!.planDigest,
                targetDigest: selectedPlan.authSchema!.targetDigest,
                resource: {
                  version: 1,
                  environment: "preview",
                  hostname: plan.neon.endpoint,
                  port: 5432,
                  database: plan.authDatabase.database,
                  schema: "public",
                  migratorRole: plan.authDatabase.migratorRole,
                  runtimeRole: plan.authDatabase.runtimeRole,
                  neon: { projectId: plan.neon.projectId, branchId: plan.neon.branchId },
                },
              },
            }),
          },
        }
      : {}),
    ...(options.generated
      ? {
          generatedRelease: {
            artifactRef: selectedPlan.release.artifactRef,
            files: generatedFiles,
          },
        }
      : {}),
    workerCheckpoints: [],
    checkpoint: async () => undefined,
    workerAttemptId: runId,
    assertCurrent,
    bindWorkerContext,
    signal: new AbortController().signal,
    database: options.auth ? "authDatabase" : "appDatabase",
    ...(options.access
      ? {
          accessConnections: {
            appMigrator:
              "postgresql://migrator:secret@ep-fixture.us-east-1.aws.neon.tech/app_db?sslmode=require",
            appRuntime: "private-owned-app-runtime",
            authMigrator: "private-owned-auth-migrator",
            authRuntime: "private-owned-auth-runtime",
          },
        }
      : {}),
    directDatabaseUrl:
      "postgresql://migrator:secret@ep-fixture.us-east-1.aws.neon.tech/app_db?sslmode=require",
  } as HostedOperatorWorkerEffectContext & {
    signal: AbortSignal;
    database: "appDatabase" | "authDatabase";
    directDatabaseUrl: string;
  };
  const launcher = createHostedOperatorSandboxLauncher(
    {
      projectId: "control-project",
      teamId: "control-team",
      ...fixtureFilesystemSource(options.snapshotId),
      accessWorker: {
        executablePath: "/opt/trusted-worker",
        id: selectedPlan.installer.reference,
        operationScope: "generated-app-access-v1",
        sha256: workerDigest,
        subcommand: "protected-generated-app-access",
      },
      workers: {
        [selectedPlan.selection.appId]: {
          executablePath: "/opt/trusted-worker",
          id: selectedPlan.installer.reference,
          operationScope: options.generated
            ? "generated-app-release-install-v1"
            : "hc-protected-install-v1",
          sha256: workerDigest,
          subcommand: options.generated ? "protected-generated-app-install" : "protected-install",
        },
      },
      ...(options.auth
        ? {
            authWorker: {
              executablePath: "/opt/auth-worker",
              id: selectedPlan.authSchema!.installer.reference,
              sha256: selectedPlan.authSchema!.installer.sha256,
              operationScope: "auth-protected-schema-v1" as const,
              subcommand: "auth-protected-schema" as const,
            },
          }
        : {}),
    },
    { createSandbox },
  );
  return {
    assertCurrent,
    bindWorkerContext,
    createSandbox,
    files,
    input,
    launcher,
    records,
    sandbox,
    workerCommand: () => workerCommand,
    written,
  };
};

describe("hosted protected installer Sandbox launcher", () => {
  it("runs the pinned worker from the configured snapshot without an image or source clone", async () => {
    const fixture = makeFixture({ snapshotId: "snap_owned_workers" });
    await fixture.launcher.execute(fixture.input);
    const options = fixture.createSandbox.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      source: { type: "snapshot", snapshotId: "snap_owned_workers" },
      networkPolicy: "allow-all",
      env: {},
      persistent: false,
      projectId: "control-project",
      teamId: "control-team",
    });
    expect(options).not.toHaveProperty("image");
    expect(fixture.records).toHaveLength(1);
  });

  it("independently inspects access under the real leased context without a new worker attempt or receipt", async () => {
    const fixture = makeFixture({
      access: true,
      fenceOnly: true,
      generated: true,
      readbackStatus: "incomplete",
    });
    const observed = await fixture.launcher.inspect({ ...fixture.input, readbackOnly: true });
    expect(observed).toMatchObject({ status: "incomplete", readback_sha256: "9".repeat(64) });
    expect(fixture.bindWorkerContext).not.toHaveBeenCalled();
    expect(fixture.records).toHaveLength(0);
    const command = fixture.sandbox.runCommand.mock.calls.at(-1)?.[0];
    expect(command?.args?.[0]).toBe("protected-generated-app-access-readback");
    expect(command?.env).toEqual({});
  });
  it("denies a mutating authorization frame in the fixed read-only inspection lane", async () => {
    const fixture = makeFixture({ access: true, generated: true, readbackStatus: "applied" });
    await expect(
      fixture.launcher.inspect({ ...fixture.input, readbackOnly: true }),
    ).rejects.toThrow();
    expect(fixture.bindWorkerContext).not.toHaveBeenCalled();
    expect(fixture.records).toHaveLength(0);
  });

  it("checks the current real fence without authorizing an effect or recording a receipt", async () => {
    const fixture = makeFixture({ fenceOnly: true });
    await fixture.launcher.execute(fixture.input);
    expect(fixture.records).toHaveLength(0);
    expect(
      JSON.parse(
        fixture.files
          .get(`/vercel/sandbox/protected-installer/${runId}/responses/1.json`)!
          .toString(),
      ),
    ).toMatchObject({
      kind: "fence_current",
      current: true,
      context_digest: contextDigest,
      fence_generation: 3,
    });
  });

  it.each([
    { fenceOnly: true, staleAtAuthority: true },
    { fenceOnly: true, wrongResource: true },
  ])("denies stale or foreign fence checks without a receipt: %j", async (options) => {
    const fixture = makeFixture(options);
    await expect(fixture.launcher.execute(fixture.input)).rejects.toThrow();
    expect(fixture.records).toHaveLength(0);
  });

  it("uses a separate approved Auth worker and a resource-wide Auth context", async () => {
    const fixture = makeFixture({ auth: true });
    await fixture.launcher.execute(fixture.input);
    const startup = `/vercel/sandbox/protected-installer/${runId}/startup`;
    expect(JSON.parse(fixture.files.get(`${startup}/context.json`)!.toString())).toMatchObject({
      app_id: "auth",
      tenant_targets: [],
      resource: { resource_id: plan.authDatabase.resourceId },
      release: { id: "e".repeat(64), sha256: "d".repeat(64) },
      installer: { id: "auth-protected-schema-v1", sha256: "f".repeat(64) },
    });
    expect(fixture.files.has(`${startup}/auth-schema-plan.json`)).toBe(true);
    expect(fixture.written.filter((file) => file.includes("/release/"))).toHaveLength(0);
    expect(fixture.records).toHaveLength(1);
    expect(fixture.sandbox.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: "/opt/auth-worker",
        args: [
          "auth-protected-schema",
          "--file-spool",
          `/vercel/sandbox/protected-installer/${runId}`,
          runId,
          "120000",
        ],
      }),
    );
  });

  it.each([
    ["auth:apply-schema-plan", "tenant-a"],
    ["hc:prepare-schema:tenant-a", null],
    ["auth:execute-sql", null],
  ])("rejects Auth effect %s with tenant %s", async (effectId, tenantId) => {
    const fixture = makeFixture({ auth: true, effectId: effectId!, tenantId });
    await expect(fixture.launcher.execute(fixture.input)).rejects.toMatchObject({
      code: "resource_mismatch",
    });
    expect(fixture.records).toHaveLength(0);
  });

  it("transports the explicit new-empty proposal without converting it into observed readiness", async () => {
    const fixture = makeFixture({ auth: true });
    const input = fixture.input as typeof fixture.input & {
      authSchemaPlan: { artifactRef: string; content: Buffer };
    };
    const artifact = input.authSchemaPlan;
    if (artifact === undefined) {
      throw new Error("Auth fixture is missing its private artifact.");
    }
    artifact.content = frame({ ...JSON.parse(artifact.content.toString()), proposal: "new-empty" });
    await fixture.launcher.execute(fixture.input);
    const startup = `/vercel/sandbox/protected-installer/${runId}/startup`;
    expect(
      JSON.parse(fixture.files.get(`${startup}/auth-schema-plan.json`)!.toString()),
    ).toMatchObject({
      proposal: "new-empty",
    });
  });

  it("rejects an Auth artifact reference outside the approved plan", async () => {
    const fixture = makeFixture({ auth: true });
    const input = fixture.input as typeof fixture.input & {
      authSchemaPlan: { artifactRef: string; content: Buffer };
    };
    input.authSchemaPlan.artifactRef = "other-auth-plan";
    await expect(fixture.launcher.execute(input)).rejects.toMatchObject({
      code: "resource_mismatch",
    });
    expect(fixture.createSandbox).not.toHaveBeenCalled();
  });

  it("requires the separately approved Auth installer digest", async () => {
    const fixture = makeFixture({ auth: true });
    fixture.input.plan.authSchema!.installer.sha256 = workerDigest;
    await expect(fixture.launcher.execute(fixture.input)).rejects.toMatchObject({
      code: "resource_mismatch",
    });
    expect(fixture.createSandbox).not.toHaveBeenCalled();
  });

  it("transfers the frozen generated release privately and retains its selected app identity", async () => {
    const fixture = makeFixture({ generated: true });
    await fixture.launcher.execute(fixture.input);
    const startup = `/vercel/sandbox/protected-installer/${runId}/startup`;
    expect(JSON.parse(fixture.files.get(`${startup}/context.json`)!.toString())).toMatchObject({
      app_id: "spend-review",
    });
    expect(
      JSON.parse(fixture.files.get(`${startup}/generated-app-release.json`)!.toString()),
    ).toMatchObject({
      app_id: "spend-review",
      release_manifest_sha256: fixture.input.plan.release.sha256,
    });
    expect(fixture.written.filter((file) => file.includes("/release/"))).toHaveLength(12);
    expect(fixture.sandbox.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [
          "protected-generated-app-install",
          "--file-spool",
          `/vercel/sandbox/protected-installer/${runId}`,
          runId,
          "120000",
          "--release-directory",
          `/vercel/sandbox/protected-installer/${runId}/release`,
        ],
      }),
    );
    expect(fixture.records).toHaveLength(1);
  });

  it("rejects generated workers on the Auth database before Sandbox creation", async () => {
    const fixture = makeFixture({ generated: true });
    await expect(
      fixture.launcher.execute({ ...fixture.input, database: "authDatabase" }),
    ).rejects.toMatchObject({ code: "resource_mismatch" });
    expect(fixture.createSandbox).not.toHaveBeenCalled();
  });

  it("rejects a generated release whose manifest no longer matches the frozen plan", async () => {
    const fixture = makeFixture({ generated: true });
    const input = fixture.input as typeof fixture.input & {
      generatedRelease: { artifactRef: string; files: GeneratedAppReleaseFiles };
    };
    input.generatedRelease.files["release-manifest.json"] = Buffer.from("other manifest");
    await expect(fixture.launcher.execute(input)).rejects.toMatchObject({
      code: "resource_mismatch",
    });
    expect(fixture.createSandbox).not.toHaveBeenCalled();
  });

  it.each([
    ["generated_app.prepare_schema_revision", null],
    ["generated_app.activate_app_base", "tenant-a"],
    ["generated_app.prepare_schema_revision", "other-tenant"],
    ["generated_app.execute_sql", "tenant-a"],
  ])("rejects generated effect %s with tenant %s", async (effectId, tenantId) => {
    const fixture = makeFixture({ generated: true, effectId: effectId!, tenantId });
    await expect(fixture.launcher.execute(fixture.input)).rejects.toMatchObject({
      code: "resource_mismatch",
    });
    expect(fixture.records).toHaveLength(0);
  });

  it("relays pinned worker requests through current authority and durable checkpoint callbacks", async () => {
    expect(contextDigest).toBe(rustWire.contextDigest);
    expect(JSON.stringify(context)).toBe(rustWire.context);
    const fixture = makeFixture();
    await fixture.launcher.execute(fixture.input);

    expect(fixture.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {},
        networkPolicy: "allow-all",
        persistent: false,
        projectId: "control-project",
        teamId: "control-team",
      }),
    );
    expect(fixture.bindWorkerContext).toHaveBeenCalledOnce();
    expect(fixture.records).toEqual([
      expect.objectContaining({
        contextDigest,
        effectId: "hc:prepare-schema:tenant-a",
        fenceGeneration: 3,
        operationId: runId,
        resourceId: "app-resource",
        sequence: 1,
        tenantId: "tenant-a",
        receipt: { state: "applied", readbackSha256: readbackDigest },
      }),
    ]);
    expect(
      fixture.files.get(`/vercel/sandbox/protected-installer/${runId}/responses/2.json`),
    ).toEqual(
      frame({
        kind: "checkpoint_recorded",
        version: 1,
        operation_id: runId,
        context_digest: contextDigest,
        fence_generation: 3,
        sequence: 1,
        effect_id: "hc:prepare-schema:tenant-a",
        recorded: true,
      }),
    );
    expect(fixture.written.some((filePath) => filePath.endsWith("direct-database-url.json"))).toBe(
      true,
    );
    expect(
      JSON.parse(
        fixture.files
          .get(`/vercel/sandbox/protected-installer/${runId}/startup/direct-database-url.json`)
          ?.toString() ?? "null",
      ),
    ).toBe(fixture.input.directDatabaseUrl);
    expect(fixture.sandbox.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [
          "protected-install",
          "--file-spool",
          `/vercel/sandbox/protected-installer/${runId}`,
          runId,
          "120000",
        ],
        cmd: "/opt/trusted-worker",
        detached: true,
        env: {},
      }),
    );
  });

  it("durably records and acknowledges unknown readback, then fails closed", async () => {
    const fixture = makeFixture({ unknown: true });
    await expect(fixture.launcher.execute(fixture.input)).rejects.toMatchObject({
      code: "reconciliation_required",
    });

    expect(fixture.records).toEqual([expect.objectContaining({ receipt: { state: "unknown" } })]);
    expect(
      JSON.parse(
        fixture.files
          .get(`/vercel/sandbox/protected-installer/${runId}/responses/2.json`)!
          .toString(),
      ),
    ).toMatchObject({ kind: "checkpoint_recorded", recorded: true });
  });

  it("rejects stale authority or mismatched protected identity without replying", async () => {
    for (const options of [
      { staleAtAuthority: true },
      { wrongResource: true },
      { effectId: "hc:drop-table:tenant-a" },
      { effectId: "hc:prepare-schema:tenant-b" },
    ]) {
      const fixture = makeFixture(options);
      await expect(fixture.launcher.execute(fixture.input)).rejects.toBeInstanceOf(
        HostedOperatorError,
      );
      expect(
        fixture.files.has(`/vercel/sandbox/protected-installer/${runId}/responses/1.ready`),
      ).toBe(false);
      expect(fixture.sandbox.delete).toHaveBeenCalledOnce();
    }
  });

  it("rejects a worker whose independently checked executable pin differs", async () => {
    const fixture = makeFixture({ pinMatches: false });
    await expect(fixture.launcher.execute(fixture.input)).rejects.toMatchObject({
      code: "resource_mismatch",
    });
    expect(fixture.sandbox.runCommand).toHaveBeenCalledOnce();
    expect(fixture.written.some((filePath) => filePath.endsWith("direct-database-url.json"))).toBe(
      false,
    );
    expect(fixture.sandbox.delete).toHaveBeenCalledOnce();
  });

  it("kills the worker and deletes the ephemeral Sandbox after caller cancellation", async () => {
    const abortController = new AbortController();
    const fixture = makeFixture({ abortBeforeAuthority: abortController });
    fixture.input.signal = abortController.signal;

    await expect(fixture.launcher.execute(fixture.input)).rejects.toMatchObject({
      code: "operator_unavailable",
    });
    expect(fixture.workerCommand()?.kill).toHaveBeenCalledOnce();
    expect(fixture.sandbox.delete).toHaveBeenCalledOnce();
  });

  it("renews the durable operator lease while Sandbox creation is still pending", async () => {
    vi.useFakeTimers();
    const { promise: delayCreate, resolve: releaseSandbox } = Promise.withResolvers<undefined>();
    const fixture = makeFixture({ delayCreate });
    try {
      const execution = fixture.launcher.execute(fixture.input);
      await vi.waitFor(() => {
        expect(fixture.createSandbox).toHaveBeenCalledOnce();
      });
      await vi.advanceTimersByTimeAsync(41_000);
      expect(fixture.assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(3);
      releaseSandbox(undefined);
      await execution;
    } finally {
      releaseSandbox(undefined);
      vi.useRealTimers();
    }
  });
});

describe("resource bootstrap launcher", () => {
  const bootstrapPlan = hostedOperatorPlanSchema.parse({
    ...plan,
    bootstrap: { maintenanceDatabase: "neondb", role: "bootstrap_owner", endpointId: "ep-fixture" },
    resourcesInstaller: { reference: "neon-resource-bootstrap-v1", sha256: workerDigest },
    effects: [
      {
        id: "auth-resources",
        description: "Auth allocation",
        kind: "resources",
        resourceId: "auth-resource",
      },
      {
        id: "app-resources",
        description: "App allocation",
        kind: "resources",
        resourceId: "app-resource",
      },
      ...plan.effects.filter((effect) => effect.kind !== "resources"),
    ],
  });
  const credentials = Buffer.from(
    JSON.stringify({ migratorPassword: "m".repeat(32), runtimePassword: "r".repeat(32) }),
  );
  const resourceInput = () => ({
    ...makeFixture().input,
    plan: bootstrapPlan,
    effect: bootstrapPlan.effects[1]!,
    directDatabaseUrl:
      "postgresql://bootstrap_owner:secret@ep-fixture.us-east-1.aws.neon.tech/neondb?sslmode=require",
    resourceCredentials: {
      bytes: credentials,
      sha256: createHash("sha256").update(credentials).digest("hex"),
      privateState: {
        encryptedToken: "ciphertext",
        keyVersion: "v1",
        tokenIv: "iv",
        tokenTag: "tag",
      },
    },
  });
  it("serializes the kind-first Node bootstrap ABI and no tenant authority", () => {
    const bootstrapContext = buildResourceBootstrapContext(resourceInput());
    expect(Object.keys(bootstrapContext)).toEqual([
      "kind",
      "version",
      "operation",
      "app_id",
      "resource",
      "release",
      "installer",
      "tenant_targets",
    ]);
    expect(bootstrapContext.resource).toMatchObject({
      scope: "app_database",
      bootstrap_role: "bootstrap_owner",
      maintenance_database: "neondb",
      provider_endpoint_id: "ep-fixture",
    });
    expect(bootstrapContext.tenant_targets).toEqual([]);
  });
  it("rejects credential byte changes and pooled or target database URLs", () => {
    const input = resourceInput();
    expect(() =>
      buildResourceBootstrapContext({
        ...input,
        resourceCredentials: { ...input.resourceCredentials, bytes: Buffer.from("{}") },
      }),
    ).toThrow(HostedOperatorError);
    expect(() =>
      buildResourceBootstrapContext({
        ...input,
        directDatabaseUrl: input.directDatabaseUrl.replace("/neondb", "/app_db"),
      }),
    ).toThrow(HostedOperatorError);
    expect(() =>
      buildResourceBootstrapContext({
        ...input,
        directDatabaseUrl: `${input.directDatabaseUrl}&options=unsafe`,
      }),
    ).toThrow(HostedOperatorError);
  });
  it("accepts the exact app retirement effect from an approved cleanup plan", () => {
    const cleanup = hostedOperatorPlanSchema.parse({
      ...bootstrapPlan,
      action: "cleanup",
      effects: [
        { description: "Revoke app access", id: "revoke", kind: "revoke" },
        { description: "Remove app bindings", id: "remove-bindings", kind: "remove-bindings" },
        {
          description: "Retire the owned app resource",
          id: "retire",
          kind: "retire",
          resourceId: bootstrapPlan.appDatabase.resourceId,
        },
      ],
    });
    const input = { ...resourceInput(), plan: cleanup, effect: cleanup.effects[2]! };
    expect(buildResourceBootstrapContext(input).resource.scope).toBe("app_database");
    expect(() =>
      buildResourceBootstrapContext({ ...input, effect: { ...input.effect, id: "unapproved" } }),
    ).toThrow(HostedOperatorError);
    expect(() =>
      buildResourceBootstrapContext({ ...input, effect: { ...input.effect, kind: "resources" } }),
    ).toThrow(HostedOperatorError);
    expect(() => buildResourceBootstrapContext({ ...input, database: "authDatabase" })).toThrow(
      HostedOperatorError,
    );
    expect(() => buildResourceBootstrapContext({ ...input, plan: bootstrapPlan })).toThrow(
      HostedOperatorError,
    );
  });
  it("does not allocate a Sandbox when the private credential checkpoint fails", async () => {
    const createSandbox = vi.fn();
    const launcher = createHostedOperatorSandboxLauncher(
      {
        projectId: "project",
        teamId: "team",
        image: "image",
        workers: {},
        resourcesWorker: {
          executablePath: "/opt/resource-worker",
          id: "neon-resource-bootstrap-v1",
          operationScope: "neon-resource-bootstrap-v1",
          subcommand: "neon-resource-bootstrap",
          sha256: workerDigest,
        },
      },
      { createSandbox },
    );
    await expect(
      launcher.execute({
        ...resourceInput(),
        checkpoint: async () => {
          throw new Error("checkpoint unavailable");
        },
      }),
    ).rejects.toThrow("checkpoint unavailable");
    expect(createSandbox).not.toHaveBeenCalled();
  });
});
