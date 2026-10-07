/* oxlint-disable eslint/sort-keys, eslint/consistent-type-definitions, eslint/require-await, eslint/object-shorthand, eslint/func-names, eslint/curly, eslint/no-await-in-loop, unicorn/no-useless-undefined, unicorn/no-useless-spread, typescript/no-non-null-assertion, typescript/strict-boolean-expressions, typescript/no-unsafe-type-assertion, typescript/no-unnecessary-type-assertion, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-conditional-empty-object-spread, anti-slop/require-safety-comment-for-type-assertion -- Synthetic SDK fakes use minimal opaque fixtures to exercise the real protocol boundary without provider calls. */
import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  HostedOperatorError,
  hostedOperatorPlanSchema,
  operatorPlanDigest,
} from "./hosted-operator-contract";
import type { HostedOperatorWorkerEffectContext } from "./hosted-operator-service";
import {
  buildProtectedInstallContext,
  createHostedOperatorSandboxLauncher,
} from "./hosted-operator-sandbox-launcher";

const runId = "a79c7cc3-9236-4a09-9e4a-5f772d08a255";
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
    appId: "spend-review",
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

const requestAuthorization = (overrides: Record<string, unknown> = {}) => ({
  kind: "authorize_effect",
  version: 1,
  operation_id: runId,
  approval_digest: operatorPlanDigest(plan),
  context_digest: contextDigest,
  fence_generation: 3,
  sequence: 1,
  effect_id: "install",
  app_id: "spend-review",
  resource_id: "app-resource",
  release_id: "release-fixture",
  installer_id: "trusted-worker",
  installer_sha256: workerDigest,
  tenant_id: "tenant-a",
  ...overrides,
});
const requestCheckpoint = (state: "applied" | "unknown") => ({
  kind: "checkpoint_effect",
  version: 1,
  operation_id: runId,
  context_digest: contextDigest,
  fence_generation: 3,
  sequence: 1,
  effect_id: "install",
  resource_id: "app-resource",
  tenant_id: "tenant-a",
  receipt: {
    state,
    ...(state === "applied" ? { readback_sha256: readbackDigest } : {}),
  },
});
const ready = (frameId: number) => frame({ version: 1, run_id: runId, frame_id: frameId });
const authorityNotice = (frameId: number) => ({
  kind: "protected_installer_frame_ready",
  version: 1,
  run_id: runId,
  frame_id: frameId,
});
type Notice = { stream: "stdout" | "stderr"; data: string };

const makeFixture = (
  options: {
    unknown?: boolean;
    staleAtAuthority?: boolean;
    wrongResource?: boolean;
    pinMatches?: boolean;
    abortBeforeAuthority?: AbortController;
  } = {},
) => {
  const files = new Map<string, Buffer>();
  const written: string[] = [];
  const records: unknown[] = [];
  let workerCommand:
    | { kill: ReturnType<typeof vi.fn>; logs: () => AsyncGenerator<Notice>; wait: ReturnType<typeof vi.fn> }
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
    runCommand: vi.fn(async (commandOptions: { cmd: string; detached?: boolean }) => {
      if (!commandOptions.detached) {
        return {
          exitCode: 0,
          stdout: async () =>
            `${options.pinMatches === false ? "d".repeat(64) : workerDigest}  /opt/trusted-worker\n`,
        };
      }

      const request = requestAuthorization({
        ...(options.wrongResource ? { resource_id: "other-resource" } : {}),
      });
      files.set(
        `/vercel/sandbox/protected-installer/${runId}/lifecycle/1.json`,
        frame({ version: 1, run_id: runId, kind: "worker_started" }),
      );
      files.set(`/vercel/sandbox/protected-installer/${runId}/lifecycle/1.ready`, ready(1));
      files.set(`/vercel/sandbox/protected-installer/${runId}/requests/1.json`, frame(request));
      files.set(`/vercel/sandbox/protected-installer/${runId}/requests/1.ready`, ready(1));
      if (!options.wrongResource && !options.staleAtAuthority) {
        files.set(
          `/vercel/sandbox/protected-installer/${runId}/requests/2.json`,
          frame(requestCheckpoint(options.unknown ? "unknown" : "applied")),
        );
        files.set(`/vercel/sandbox/protected-installer/${runId}/requests/2.ready`, ready(2));
        files.set(
          `/vercel/sandbox/protected-installer/${runId}/lifecycle/2.json`,
          frame({
            version: 1,
            run_id: runId,
            kind: options.unknown ? "worker_failed" : "worker_succeeded",
            ...(options.unknown ? { failure_code: "readback_unknown" } : {}),
          }),
        );
        files.set(`/vercel/sandbox/protected-installer/${runId}/lifecycle/2.ready`, ready(2));
      }

      const notices: Notice[] = [
        { stream: "stderr", data: "installer private diagnostic that must not be forwarded" },
        {
          stream: "stdout",
          data: `${JSON.stringify({ kind: "protected_installer_lifecycle_ready", version: 1, run_id: runId, frame_id: 1 })}\n`,
        },
        { stream: "stdout", data: `${JSON.stringify(authorityNotice(1))}\n` },
      ];
      if (!options.staleAtAuthority && !options.wrongResource) {
        notices.push(
          { stream: "stdout", data: `${JSON.stringify(authorityNotice(2))}\n` },
          {
            stream: "stdout",
            data: `${JSON.stringify({ kind: "protected_installer_lifecycle_ready", version: 1, run_id: runId, frame_id: 2 })}\n`,
          },
        );
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
    }),
  };

  const createSandbox = vi.fn(async () => sandbox as never);
  const assertCurrent = vi.fn(async () => {
    if (options.staleAtAuthority && assertCurrent.mock.calls.length > 2) {
      throw new HostedOperatorError("authorization_required");
    }
  });
  const bindWorkerContext = vi.fn(async ({ contextDigest: digest }: { contextDigest: string }) => {
    expect(digest).toBe(contextDigest);
    return async (checkpoint: unknown) => {
      records.push(checkpoint);
    };
  });
  const input = {
    authority: {} as HostedOperatorWorkerEffectContext["authority"],
    target: {} as HostedOperatorWorkerEffectContext["target"],
    effect: plan.effects[1]!,
    fenceGeneration: 3,
    operationRef: runId,
    plan,
    workerCheckpoints: [],
    checkpoint: async () => undefined,
    workerAttemptId: runId,
    assertCurrent,
    bindWorkerContext,
    signal: new AbortController().signal,
    database: "appDatabase" as const,
    directDatabaseUrl:
      "postgresql://migrator:secret@ep-fixture.us-east-1.aws.neon.tech/app_db?sslmode=require",
  } as HostedOperatorWorkerEffectContext & {
    signal: AbortSignal;
    database: "appDatabase";
    directDatabaseUrl: string;
  };
  const launcher = createHostedOperatorSandboxLauncher(
    {
      projectId: "control-project",
      teamId: "control-team",
      image: "protected-installer-control-image",
      workers: {
        "spend-review": {
          executablePath: "/opt/trusted-worker",
          id: "trusted-worker",
          sha256: workerDigest,
          subcommand: "protected-install",
        },
      },
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
  it("relays pinned worker requests through current authority and durable checkpoint callbacks", async () => {
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
        effectId: "install",
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
        effect_id: "install",
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
    for (const options of [{ staleAtAuthority: true }, { wrongResource: true }]) {
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
});
