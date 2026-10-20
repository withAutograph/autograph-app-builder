/* oxlint-disable eslint/require-await, sonarjs/no-hardcoded-passwords -- Only synthetic SDK fixtures run. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  PreparedRuntimeExecutionDependencies,
  RuntimeTransport,
} from "./prepared-runtime-execution";
import {
  resolvePreparedRuntimeExecution,
  restorePreparedRuntimeExecution,
  runtimeFilesForOrigin,
} from "./prepared-runtime-execution";
import {
  hostedOperatorPlanSchema,
  operatorPlanDigest,
  HostedOperatorError,
} from "../provisioning/hosted-operator-contract";
import { HostedRuntimeProviderError } from "../provisioning/hosted-runtime-provider";

const capturedActors = () => ({
  origin: "https://apps-preview.example.test",
  identities: {
    version: 1 as const,
    actors: [
      {
        actorKey: "member",
        actorId: "actual-member-id",
        organizationId: "actual-org-id",
        roles: ["member"],
        storageState: "member.storage.json",
      },
    ],
  },
  files: {
    "member.storage.json": JSON.stringify({
      cookies: [
        {
          name: "session",
          domain: "apps-preview.example.test",
          value: "captured-private-session",
          path: "/",
          secure: true,
        },
      ],
      origins: [
        {
          origin: "https://apps-preview.example.test",
          localStorage: [{ name: "selected-org", value: "captured-private-org" }],
        },
      ],
    }),
  },
});

const mocks = {
  assertAuthority: vi.fn<PreparedRuntimeExecutionDependencies["assertAuthority"]>(),
  getProvider: vi.fn<PreparedRuntimeExecutionDependencies["getProvider"]>(),
  observeInstallation: vi.fn<PreparedRuntimeExecutionDependencies["observeInstallation"]>(),
  readBinding: vi.fn<PreparedRuntimeExecutionDependencies["readBinding"]>(),
};

const proof = {
  actors: 8,
  appId: "spend-review",
  artifactHash: "a".repeat(64),
  authenticatedBehavior: "unassessed" as const,
  environment: "preview",
  releaseId: "release_1",
  tenants: 2,
};
const descriptor = {
  app: { id: "spend-review", routes: [], workspacePath: "apps/spend-review" },
  backend: {
    authorization: "declared-policy",
    kind: "generated-postgres",
    release: {
      artifactHash: `sha256:${proof.artifactHash}`,
      directory: "release",
      id: proof.releaseId,
    },
    roles: ["requester", "reviewer"],
    runtime: { databaseEnvironment: "SPEND_REVIEW_DATABASE_URL" },
    schemaReceipt: null,
  },
  validation: {
    browser: { task: "test-e2e" },
    check: { task: "check" },
    test: { shards: 1, task: "test" },
  },
  version: 1,
};
const files = () => ({
  "environment.json": JSON.stringify({
    APP_TEST_BASE_URL: "https://old.vercel.run",
    BETTER_AUTH_SECRET: "synthetic-auth-secret",
    BETTER_AUTH_URL: "https://old.vercel.run",
    PLATFORM_AUTH_DATABASE_URL:
      "postgres://restricted:synthetic@ep-owner.neon.tech/auth?sslmode=verify-full",
  }),
  "identities.json": JSON.stringify({
    identities: [{ actorId: "requester", storageState: "/private-state/requester.storage.json" }],
  }),
  "requester.storage.json": JSON.stringify({
    cookies: [
      {
        domain: "old.vercel.run",
        name: "session",
        path: "/",
        secure: true,
        value: "synthetic-session-token",
      },
    ],
    origins: [{ localStorage: [], origin: "https://old.vercel.run" }],
  }),
  "state.json": JSON.stringify({
    clusterUrl: "private-installer-url",
    plan: {
      appId: "spend-review",
      environment: "preview",
      roles: ["requester", "reviewer"],
      runtimeId: "runtime_owned",
    },
  }),
});
const binding = () => ({
  branch: "builder/spend-review",
  environment: z.record(z.string(), z.string()).parse(JSON.parse(files()["environment.json"])),
  files: files(),
  persistFiles: vi.fn(),
  projectId: "prj_owned",
  stateDirectory: "/private-state",
});
const transport = (description = descriptor, chunks = ["8 passed synthetic-auth-secret"]) => {
  const close = vi.fn();
  const logs = Object.assign(
    async function* logs() {
      for (const data of chunks) {
        yield { data, stream: "stdout" as const };
      }
    },
    { close },
  );
  const command = {
    exitCode: 0,
    kill: vi.fn(),
    logs: () => Object.assign(logs(), { close }),
    stdout: async () => "",
    wait: async () => ({ exitCode: 0 }),
  };
  const runCommand = vi
    .fn<RuntimeTransport["runCommand"]>()
    .mockResolvedValueOnce({
      ...command,
      exitCode: 0,
      stdout: async () => JSON.stringify(description),
    })
    .mockResolvedValue(command);
  return {
    close,
    command,
    provider: {
      fs: { mkdir: vi.fn(), rm: vi.fn() },
      runCommand,
      writeFiles: vi.fn<RuntimeTransport["writeFiles"]>(),
    },
  };
};
const context = {
  appId: "spend-review",
  root: "/workspace/repository",
  sandboxId: "sandbox_replacement",
  sessionAuth: {},
  sessionId: "session_1",
  state: { phase: "empty", version: 17 },
};
const selection = {
  appId: context.appId,
  branch: "builder/spend-review",
  projectId: "prj_owned",
  sessionId: context.sessionId,
};
const operatorPlan = hostedOperatorPlanSchema.parse({
  access: [{ actorId: "synthetic-reviewer", organizationId: "synthetic-org", roles: ["reviewer"] }],
  action: "prepare",
  appDatabase: {
    database: "spend",
    migratorRole: "spend_owner",
    resourceId: "app-resource",
    runtimeRole: "spend_runtime",
  },
  authDatabase: {
    database: "shared_auth",
    migratorRole: "shared_auth_owner",
    resourceId: "auth-resource",
    runtimeRole: "shared_auth_runtime",
  },
  contextId: "synthetic-context",
  cost: {
    class: "shared-recovery-group",
    description: "Approved disposable compute",
    owner: "Fixture owner",
  },
  deploymentBoundary: {
    app: {
      branch: selection.branch,
      deploymentId: "dpl_app",
      environment: "preview",
      projectId: selection.projectId,
    },
    authority: {
      audience: "https://builder.example/mcp",
      issuer: "https://builder.example/api/auth",
      ownerUserId: "owner",
      workspaceId: "workspace",
    },
    gateway: {
      branch: selection.branch,
      deploymentId: "dpl_gateway",
      environment: "preview",
      projectId: "prj_gateway",
    },
    operator: {
      deploymentId: "dpl_operator",
      environment: "production",
      projectId: "prj_operator",
    },
    teamId: "team_fixture",
    verification: {
      gatewayOrigin: "https://gateway-preview.example.test",
      jwksUrl: "https://gateway-preview.example.test/_platform/jwks.json",
      publicOrigin: "https://apps-preview.example.test",
    },
  },
  effects: [
    {
      description: "Verify selected resources and their roles",
      id: "resources",
      kind: "resources",
    },

    { description: "Install the selected checked release", id: "install", kind: "install" },
    { description: "Grant approved Auth app access after install", id: "access", kind: "access" },
    {
      description: "Bind restricted app and shared Auth credentials",
      id: "bind",
      kind: "bindings",
    },
  ],
  installer: { reference: "trusted-toolchain", sha256: "a".repeat(64) },
  neon: {
    branchId: "br_synthetic",
    connectionRef: "explicit-owner-connection",
    endpoint: "ep-fixture.us-east-1.aws.neon.tech",
    projectId: "synthetic-project",
    source: "synthetic-only",
  },
  publicGateway: {
    branch: selection.branch,
    origin: "https://apps-preview.example.test",
    projectId: "prj_gateway",
  },
  release: { artifactRef: "verified-artifact", id: proof.releaseId, sha256: "b".repeat(64) },
  retention: {
    expiresAt: "2027-01-01T00:00:00.000Z",
    policy: "Retain while context consumers exist",
  },
  selection: { ...selection, environment: "preview" },
  version: 1,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.observeInstallation.mockResolvedValue({
    actors: proof.actors,
    artifactHash: proof.artifactHash,
    authenticatedBehavior: proof.authenticatedBehavior,
    releaseId: proof.releaseId,
    tenants: proof.tenants,
  });
});

describe("approved hosted runtime consumers", () => {
  it.each([
    ["repository-check", undefined, undefined],
    ["repository-test", "1/1", undefined],
    ["repository-check", undefined, true],
    ["repository-test", "1/1", true],
    ["test-e2e", undefined, true],
  ] as const)(
    "forwards compiler operation inputs to the provider for %s",
    async (task, shard, alreadyCompiled) => {
      const fixture = transport();
      const runtime = await restorePreparedRuntimeExecution({
        appId: context.appId,
        binding: binding(),
        observeInstallation: async () =>
          await mocks.observeInstallation({
            ...context,
            files: files(),
            stateDirectory: "/private-state",
          }),
        provider: fixture.provider,
        root: context.root,
      });
      expect(fixture.provider.runCommand).toHaveBeenNthCalledWith(1, {
        args: ["mise", "run", "app:describe", context.appId],
        cmd: "/usr/bin/env",
        cwd: context.root,
        signal: undefined,
      });
      await runtime.runTask({
        task,
        shard,
        alreadyCompiled,
        environment: {
          APP_SCHEMA_TRANSITION_PREDECESSOR_FILES: '["original.json"]',
          PATH: "/sandbox/custom/bin:/usr/bin",
          APP_RUNTIME_STATE_DIR: "/untrusted-state-directory",
          OPTIONAL_INPUT: undefined,
          APP_RUNTIME_ALREADY_COMPILED: "untrusted",
        },
      });
      expect(fixture.provider.runCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          args: [
            "mise",
            "run",
            "app:runtime",
            "run",
            context.appId,
            task,
            ...(shard ? [shard] : []),
          ],
          cmd: "/usr/bin/env",
          cwd: context.root,
          detached: true,
          env: {
            APP_SCHEMA_TRANSITION_PREDECESSOR_FILES: '["original.json"]',
            PATH: "/sandbox/custom/bin:/usr/bin",
            APP_RUNTIME_STATE_DIR: "/private-state",
            ...(alreadyCompiled && task !== "test-e2e"
              ? { APP_RUNTIME_ALREADY_COMPILED: "1" }
              : {}),
          },
        }),
      );
    },
  );
  it.each([undefined, "https://apps-preview.example.test"])(
    "preserves the verified native browser origin %s without adding runtime bindings",
    async (publicOrigin) => {
      const fixture = transport();
      const operationRef = "11111111-1111-4111-8111-111111111111";
      const environment = {
        SPEND_REVIEW_DATABASE_URL:
          "postgres://spend_runtime:synthetic@ep-fixture.neon.tech/spend?sslmode=verify-full",
        PLATFORM_PUBLIC_ORIGIN: "https://apps-preview.example.test",
        PLATFORM_ORIGIN: "https://gateway-preview.example.test",
        PLATFORM_JWKS_URL: "https://gateway-preview.example.test/_platform/jwks.json",
      };
      const bindings = vi.fn().mockResolvedValue({
        environment,
        nativePreview: publicOrigin === undefined ? undefined : { publicOrigin },
        operationRef,
        plan: operatorPlan,
        proof: {
          actors: proof.actors,
          artifactHash: proof.artifactHash,
          authenticatedBehavior: proof.authenticatedBehavior,
          releaseId: proof.releaseId,
          tenants: proof.tenants,
        },
      });
      const operatorClient = vi.fn().mockResolvedValue({ sessionId: context.sessionId, bindings });
      mocks.getProvider.mockResolvedValue(fixture.provider);
      const runtime = await resolvePreparedRuntimeExecution(
        context,
        {
          ...selection,
          operationRef,
          planDigest: operatorPlanDigest(operatorPlan),
        },
        { ...mocks, operatorClient },
      );
      expect(runtime?.browserTestBaseUrl).toBe(publicOrigin);
      const restoredEnvironment = fixture.provider.writeFiles.mock.calls
        .flatMap(([restored]) => restored)
        .find((file) => file.path.endsWith("/environment.json"));
      expect(JSON.parse(String(restoredEnvironment?.content))).toEqual(environment);
      expect(mocks.readBinding).not.toHaveBeenCalled();
      expect(mocks.observeInstallation).not.toHaveBeenCalled();
      await runtime?.runTask({ task: "repository-check" });
      expect(fixture.provider.runCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          args: ["mise", "run", "app:runtime", "run", context.appId, "repository-check"],
          env: { APP_RUNTIME_STATE_DIR: `/tmp/app-builder-operator/${operationRef}` },
        }),
      );
      await runtime?.runTask({
        task: "test-e2e",
        environment: publicOrigin === undefined ? undefined : { APP_TEST_BASE_URL: publicOrigin },
      });
      expect(fixture.provider.runCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          args: ["mise", "run", "app:runtime", "run", context.appId, "test-e2e"],
          env: {
            APP_RUNTIME_STATE_DIR: `/tmp/app-builder-operator/${operationRef}`,
            ...(publicOrigin === undefined ? {} : { APP_TEST_BASE_URL: publicOrigin }),
          },
        }),
      );
    },
  );
  it("restores captured normal actors in replacement sandboxes and only supplies the private path to browser tasks", async () => {
    const captured = capturedActors();
    await Promise.all(
      ["first", "replacement"].map(async (sandbox) => {
        const fixture = transport(descriptor, [
          "captured-private-",
          "session actual-member-id captured-private-org",
        ]);
        const retainedBinding = binding();
        const runtime = await restorePreparedRuntimeExecution({
          appId: context.appId,
          binding: retainedBinding,
          browserTestBaseUrl: captured.origin,
          normalActors: captured,
          observeInstallation: async () => ({
            actors: proof.actors,
            artifactHash: proof.artifactHash,
            authenticatedBehavior: proof.authenticatedBehavior,
            releaseId: proof.releaseId,
            tenants: proof.tenants,
          }),
          provider: fixture.provider,
          root: `/workspace/${sandbox}`,
        });
        expect(
          fixture.provider.writeFiles.mock.calls.flatMap(([written]) => written),
        ).toContainEqual({
          content: captured.files["member.storage.json"],
          mode: 0o600,
          path: "/private-state/normal-actors/member.storage.json",
        });
        const result = await runtime.runTask({
          task: "test-e2e",
          environment: {
            APP_TEST_BASE_URL: "https://untrusted.example.test",
            APP_TEST_IDENTITIES_FILE: "/untrusted",
          },
        });
        expect(result.stdout).not.toContain("captured-private-");
        expect(result.stdout).not.toContain("actual-member-id");
        expect(fixture.provider.runCommand).toHaveBeenLastCalledWith(
          expect.objectContaining({
            env: {
              APP_RUNTIME_STATE_DIR: "/private-state",
              APP_TEST_BASE_URL: captured.origin,
              APP_TEST_IDENTITIES_FILE: "/private-state/normal-actors/identities.json",
            },
          }),
        );
        await runtime.runTask({ task: "repository-check" });
        expect(fixture.provider.runCommand).toHaveBeenLastCalledWith(
          expect.objectContaining({
            env: { APP_RUNTIME_STATE_DIR: "/private-state" },
          }),
        );
        expect(JSON.stringify(fixture.provider.runCommand.mock.calls)).not.toContain(
          "captured-private-session",
        );
        await expect(
          runtime.prepareAuthenticatedOrigin("https://replacement.vercel.run"),
        ).rejects.toThrow("normal_actor_browser_origin_mismatch");
        await runtime.prepareAuthenticatedOrigin(captured.origin);
        expect(retainedBinding.persistFiles).not.toHaveBeenCalled();
      }),
    );
  });
  it("redacts captured credentials from private file and command provider errors", async () => {
    const captured = capturedActors();
    const fixture = transport();
    const restore = async () =>
      await restorePreparedRuntimeExecution({
        appId: context.appId,
        binding: binding(),
        normalActors: captured,
        browserTestBaseUrl: captured.origin,
        provider: fixture.provider,
        root: context.root,
        observeInstallation: async () => ({
          actors: proof.actors,
          artifactHash: proof.artifactHash,
          authenticatedBehavior: proof.authenticatedBehavior,
          releaseId: proof.releaseId,
          tenants: proof.tenants,
        }),
      });
    fixture.provider.writeFiles.mockRejectedValueOnce(
      new Error("write failed captured-private-session actual-member-id"),
    );
    await expect(restore()).rejects.toThrow("write failed [REDACTED] [REDACTED]");
    const runtime = await restore();
    fixture.provider.runCommand.mockRejectedValueOnce(
      new Error("command failed captured-private-org"),
    );
    await expect(runtime.runTask({ task: "test-e2e" })).rejects.toThrow(
      "command failed [REDACTED]",
    );
  });
  it("never falls back to legacy credential decryption when the operator is unavailable", async () => {
    const operatorClient = vi.fn(() => {
      throw new Error("protected_operator_required");
    });
    await expect(
      resolvePreparedRuntimeExecution(
        context,
        { ...selection, operationRef: "11111111-1111-4111-8111-111111111111" },
        { ...mocks, operatorClient },
      ),
    ).rejects.toThrow("protected_operator_required");
    expect(mocks.readBinding).not.toHaveBeenCalled();
    expect(mocks.observeInstallation).not.toHaveBeenCalled();
    expect(mocks.getProvider).not.toHaveBeenCalled();
  });

  it("redacts explicit suite capabilities and captured actors across both split output streams", async () => {
    const selector = "controlled-suite-selector-capability";
    const lifecycle = "controlled-lifecycle-capability";
    const fixture = transport();
    const runtime = await restorePreparedRuntimeExecution({
      appId: context.appId,
      binding: binding(),
      normalActors: capturedActors(),
      privateValues: [selector, lifecycle, ""],
      observeInstallation: async () => ({
        actors: proof.actors,
        artifactHash: proof.artifactHash,
        authenticatedBehavior: proof.authenticatedBehavior,
        releaseId: proof.releaseId,
        tenants: proof.tenants,
      }),
      provider: fixture.provider,
      root: context.root,
    });
    fixture.provider.runCommand.mockResolvedValueOnce({
      ...fixture.command,
      logs: () =>
        Object.assign(
          (async function* output() {
            yield { stream: "stdout" as const, data: `out ${selector.slice(0, 14)}` };
            yield { stream: "stderr" as const, data: `err ${lifecycle.slice(0, 13)}` };
            yield {
              stream: "stdout" as const,
              data: `${selector.slice(14)} captured-private-session done`,
            };
            yield { stream: "stderr" as const, data: `${lifecycle.slice(13)} done` };
          })(),
          { close: fixture.close },
        ),
    });
    const onChunk = vi.fn();
    const result = await runtime.runTask({
      task: "test-e2e",
      onChunk,
      environment: {
        APP_TEST_MANAGED_SUITE_SELECTOR: selector,
        APP_TEST_MANAGED_LIFECYCLE_CAPABILITY: lifecycle,
      },
    });
    expect(result.stdout).toBe("out [REDACTED] [REDACTED] done");
    expect(result.stderr).toBe("err [REDACTED] done");
    const durable = JSON.stringify(onChunk.mock.calls);
    for (const secret of [selector, lifecycle, "captured-private-session"]) {
      expect(durable).not.toContain(secret);
      expect(result.stdout + result.stderr).not.toContain(secret);
    }
    expect(fixture.provider.runCommand.mock.calls.at(-1)?.[0].env).toMatchObject({
      APP_TEST_MANAGED_SUITE_SELECTOR: selector,
      APP_TEST_MANAGED_LIFECYCLE_CAPABILITY: lifecycle,
    });
  });

  it.each(["dispatch", "resume", "logs", "iteration", "wait", "kill", "close"] as const)(
    "redacts explicit capabilities from %s SDK errors even without captured actors",
    async (failure) => {
      const selector = "controlled-suite-selector-capability";
      const lifecycle = "controlled-lifecycle-capability";
      const privateError = new Error(`SDK failure ${selector} and ${lifecycle}`);
      const fixture = transport();
      const runtime = await restorePreparedRuntimeExecution({
        appId: context.appId,
        binding: binding(),
        privateValues: [selector, lifecycle],
        observeInstallation: async () => ({
          actors: proof.actors,
          artifactHash: proof.artifactHash,
          authenticatedBehavior: proof.authenticatedBehavior,
          releaseId: proof.releaseId,
          tenants: proof.tenants,
        }),
        provider: fixture.provider,
        resumeCommand: async () => {
          throw privateError;
        },
        root: context.root,
      });
      const command = { ...fixture.command };
      if (failure === "dispatch") {
        fixture.provider.runCommand.mockRejectedValueOnce(privateError);
      }
      if (failure === "logs") {
        command.logs = () => {
          throw privateError;
        };
      }
      if (failure === "iteration" || failure === "kill") {
        command.logs = () =>
          Object.assign(
            (async function* failedOutput() {
              yield { stream: "stdout" as const, data: "before SDK failure" };
              throw failure === "kill" ? new Error("controlled iteration failure") : privateError;
            })(),
            { close: fixture.close },
          );
      }
      if (failure === "wait") {
        command.wait = async () => {
          throw privateError;
        };
      }
      if (failure === "kill") {
        fixture.command.kill.mockRejectedValueOnce(privateError);
      }
      if (failure === "close") {
        fixture.close.mockImplementationOnce(() => {
          throw privateError;
        });
      }
      if (failure !== "dispatch") {
        fixture.provider.runCommand.mockResolvedValueOnce(command);
      }
      await expect(
        runtime.runTask({
          task: "test-e2e",
          ...(failure === "resume" ? { commandId: "retained-command", allowDispatch: false } : {}),
        }),
      ).rejects.toThrow("SDK failure [REDACTED] and [REDACTED]");
      if (failure === "resume") {
        expect(fixture.provider.runCommand).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("preserves an already-safe typed reconciliation error with explicit private values", async () => {
    const fixture = transport();
    const closedError = new HostedOperatorError("reconciliation_required");
    const runtime = await restorePreparedRuntimeExecution({
      appId: context.appId,
      binding: binding(),
      privateValues: ["controlled-suite-selector-capability"],
      observeInstallation: async () => ({
        actors: proof.actors,
        artifactHash: proof.artifactHash,
        authenticatedBehavior: proof.authenticatedBehavior,
        releaseId: proof.releaseId,
        tenants: proof.tenants,
      }),
      provider: fixture.provider,
      resumeCommand: async () => {
        throw closedError;
      },
      root: context.root,
    });
    await expect(
      runtime.runTask({ task: "test-e2e", commandId: "retained", allowDispatch: false }),
    ).rejects.toBe(closedError);
  });

  it("resumes the retained task identity without redispatching through env", async () => {
    const fixture = transport();
    const resumeCommand = vi.fn().mockResolvedValue(fixture.command);
    const commandCheckpoint = vi.fn();
    const runtime = await restorePreparedRuntimeExecution({
      appId: context.appId,
      binding: binding(),
      observeInstallation: async () => ({
        actors: proof.actors,
        artifactHash: proof.artifactHash,
        authenticatedBehavior: proof.authenticatedBehavior,
        releaseId: proof.releaseId,
        tenants: proof.tenants,
      }),
      provider: fixture.provider,
      resumeCommand,
      root: context.root,
    });
    await expect(
      runtime.runTask({
        task: "test-e2e",
        commandId: "retained-command",
        commandCheckpoint,
        allowDispatch: false,
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(resumeCommand).toHaveBeenCalledExactlyOnceWith("retained-command");
    expect(commandCheckpoint).not.toHaveBeenCalled();
    expect(fixture.provider.runCommand).toHaveBeenCalledTimes(1);
    expect(fixture.provider.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: "/usr/bin/env",
        args: ["mise", "run", "app:describe", context.appId],
      }),
    );
  });

  it("redacts a session token split across provider log chunks before durable output", async () => {
    const fixture = transport(descriptor, [
      "Authenticated ",
      "synthetic-session-",
      "token result\n",
    ]);
    const runtime = await restorePreparedRuntimeExecution({
      appId: context.appId,
      binding: binding(),
      observeInstallation: async () =>
        await mocks.observeInstallation({
          ...context,
          files: files(),
          stateDirectory: "/private-state",
        }),
      provider: fixture.provider,
      root: context.root,
    });
    const onChunk = vi.fn();
    const result = await runtime.runTask({ onChunk, task: "test-e2e" });
    expect(result.stdout).toBe("Authenticated [REDACTED] result\n");
    expect(JSON.stringify(onChunk.mock.calls)).not.toContain("synthetic-session-");
  });
  it("restores replacement Sandbox state, verifies the installed source release, and runs using SDK env", async () => {
    const fixture = transport();
    const original = binding();
    mocks.readBinding.mockResolvedValue(original);
    mocks.getProvider.mockResolvedValue(fixture.provider);
    const runtime = await resolvePreparedRuntimeExecution(context, selection, mocks);
    expect(fixture.provider.writeFiles).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ mode: 0o600, path: "/private-state/environment.json" }),
      ]),
      expect.anything(),
    );
    expect(JSON.stringify(fixture.provider.writeFiles.mock.calls)).not.toContain(
      "private-installer-url",
    );
    expect(JSON.stringify(fixture.provider.writeFiles.mock.calls)).not.toContain("state.json");
    expect(fixture.provider.fs.rm).toHaveBeenCalledWith(
      "/private-state/state.json",
      expect.objectContaining({ force: true }),
    );
    expect(mocks.observeInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ files: original.files, sandboxId: context.sandboxId }),
    );
    expect(runtime?.installationProof).toMatchObject({
      ...proof,
      branch: selection.branch,
      observation: "database-verification",
    });
    expect(runtime?.installationProof.observedAt).toMatch(/^\d{4}-/u);
    const onChunk = vi.fn();
    const result = await runtime?.runTask({ onChunk, task: "test-e2e" });
    expect(result).toMatchObject({ exitCode: 0, stdout: "8 passed [REDACTED]" });
    expect(onChunk).toHaveBeenCalledWith("stdout", "8 passed [REDACTED]");
    expect(fixture.provider.runCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        args: ["mise", "run", "app:runtime", "run", "spend-review", "test-e2e"],
        env: { APP_RUNTIME_STATE_DIR: "/private-state" },
      }),
    );
    expect(JSON.stringify(fixture.provider.runCommand.mock.calls)).not.toContain(
      "synthetic-auth-secret",
    );
    expect(fixture.close).toHaveBeenCalled();
  });
  it("persists only an updated browser origin and cookies without preparing the database again", async () => {
    const fixture = transport();
    const original = binding();
    const runtime = await restorePreparedRuntimeExecution({
      appId: context.appId,
      binding: original,
      observeInstallation: async () =>
        await mocks.observeInstallation({
          ...context,
          files: files(),
          stateDirectory: "/private-state",
        }),
      provider: fixture.provider,
      root: context.root,
    });
    await runtime.prepareAuthenticatedOrigin("https://new-gateway.vercel.run");
    const saved = z.record(z.string(), z.string()).parse(original.persistFiles.mock.calls[0]?.[0]);
    expect(saved["state.json"]).toBe(original.files["state.json"]);
    expect(saved["requester.storage.json"]).toContain("synthetic-session-token");
    expect(
      z
        .object({ cookies: z.array(z.object({ domain: z.string() })) })
        .parse(JSON.parse(saved["requester.storage.json"])).cookies[0]?.domain,
    ).toBe("new-gateway.vercel.run");
    expect(
      z.record(z.string(), z.string()).parse(JSON.parse(saved["environment.json"])).BETTER_AUTH_URL,
    ).toBe("https://new-gateway.vercel.run");
    expect(fixture.provider.runCommand).toHaveBeenCalledTimes(1);
    expect(() => runtimeFilesForOrigin(original.files, "https://unowned.example")).toThrow();
  });
  it("blocks a changed selected release rather than reporting journal metadata as installation proof", async () => {
    const fixture = transport({
      ...descriptor,
      backend: {
        ...descriptor.backend,
        release: { ...descriptor.backend.release, id: "release_2" },
      },
    });
    await expect(
      restorePreparedRuntimeExecution({
        appId: context.appId,
        binding: binding(),
        observeInstallation: async () =>
          await mocks.observeInstallation({
            ...context,
            files: files(),
            stateDirectory: "/private-state",
          }),
        provider: fixture.provider,
        root: context.root,
      }),
    ).rejects.toMatchObject({ code: "resource_mismatch" });
  });
  it.each(["authorization_required", "connection_required"] as const)(
    "never downgrades an approved %s failure to local data",
    async (code) => {
      mocks.readBinding.mockRejectedValue(new HostedRuntimeProviderError(code));
      await expect(
        resolvePreparedRuntimeExecution(context, selection, mocks),
      ).rejects.toMatchObject({
        code,
      });
      expect(mocks.getProvider).not.toHaveBeenCalled();
    },
  );
  it("does not prepare a local database when an approved binding is missing", async () => {
    mocks.readBinding.mockResolvedValue(null);
    await expect(resolvePreparedRuntimeExecution(context, selection, mocks)).rejects.toMatchObject({
      code: "connection_required",
    });
  });
  it("preserves static/local consumers with no hosted selection", async () => {
    expect(await resolvePreparedRuntimeExecution(context, null, mocks)).toBeNull();
    expect(mocks.readBinding).not.toHaveBeenCalled();
  });
  it("supports the selected source branch for earlier journal records", async () => {
    const state = {
      ...context.state,
      githubSource: { resolvedRef: "refs/heads/selected-preview" },
    };
    mocks.readBinding.mockResolvedValue(null);
    expect(await resolvePreparedRuntimeExecution({ ...context, state }, null, mocks)).toBeNull();
    expect(mocks.readBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: "selected-preview",
        optionalProject: true,
        sessionId: context.sessionId,
      }),
    );
  });
  it("preserves an earlier approved source-branch blocker when Eve selection metadata is absent", async () => {
    const state = {
      ...context.state,
      githubSource: { resolvedRef: "refs/heads/selected-preview" },
    };
    mocks.readBinding.mockRejectedValue(new HostedRuntimeProviderError("connection_required"));
    await expect(
      resolvePreparedRuntimeExecution({ ...context, state }, null, mocks),
    ).rejects.toMatchObject({ code: "connection_required" });
    expect(mocks.getProvider).not.toHaveBeenCalled();
  });
  it("rejects a runtime selection owned by another session", async () => {
    await expect(
      resolvePreparedRuntimeExecution(
        context,
        { ...selection, sessionId: "another_session" },
        mocks,
      ),
    ).rejects.toMatchObject({ code: "authorization_required" });
    expect(mocks.readBinding).not.toHaveBeenCalled();
  });
});

it("reports the failed description command stage without exposing its output", async () => {
  const fixture = transport();
  const stdout = vi.fn().mockResolvedValue("private-output-canary token=private-token-canary");
  fixture.provider.runCommand
    .mockReset()
    .mockResolvedValue({ ...fixture.command, exitCode: 23, stdout });
  const result = restorePreparedRuntimeExecution({
    appId: context.appId,
    binding: binding(),
    observeInstallation: async () =>
      await mocks.observeInstallation({
        ...context,
        files: files(),
        stateDirectory: "/private-state",
      }),
    provider: fixture.provider,
    root: context.root,
  });
  await expect(result).rejects.toBeInstanceOf(HostedRuntimeProviderError);
  await expect(result).rejects.toMatchObject({
    name: "HostedRuntimeProviderError",
    code: "resource_mismatch",
    message: "resource_mismatch: runtime restore app-description-command (exit 23)",
  });
  expect(stdout).not.toHaveBeenCalled();
});

it.each([
  {
    stage: "app-identity",
    description: { ...descriptor, app: { ...descriptor.app, id: "private-app-canary" } },
  },
  { stage: "backend-kind", description: { ...descriptor, backend: { kind: "static" } } },
  {
    stage: "release-identity",
    description: {
      ...descriptor,
      backend: {
        ...descriptor.backend,
        release: { ...descriptor.backend.release, id: "private-release-canary" },
      },
    },
  },
  {
    stage: "artifact-identity",
    description: {
      ...descriptor,
      backend: {
        ...descriptor.backend,
        release: { ...descriptor.backend.release, artifactHash: "sha256:private-artifact-canary" },
      },
    },
  },
])("reports only the closed $stage mismatch stage", async ({ stage, description }) => {
  const fixture = transport();
  fixture.provider.runCommand.mockReset().mockResolvedValue({
    ...fixture.command,
    stdout: async () => JSON.stringify(description),
  });
  const result = restorePreparedRuntimeExecution({
    appId: context.appId,
    binding: binding(),
    observeInstallation: async () =>
      await mocks.observeInstallation({
        ...context,
        files: files(),
        stateDirectory: "/private-state",
      }),
    provider: fixture.provider,
    root: context.root,
  });
  await expect(result).rejects.toBeInstanceOf(HostedRuntimeProviderError);
  await expect(result).rejects.toMatchObject({
    name: "HostedRuntimeProviderError",
    code: "resource_mismatch",
    message: `resource_mismatch: runtime restore ${stage}`,
  });
});

it("reports a selected project mismatch before restoring provider state", async () => {
  mocks.readBinding.mockResolvedValue({ ...binding(), projectId: "private-project-canary" });
  const result = resolvePreparedRuntimeExecution(context, selection, mocks);
  await expect(result).rejects.toBeInstanceOf(HostedRuntimeProviderError);
  await expect(result).rejects.toMatchObject({
    name: "HostedRuntimeProviderError",
    code: "resource_mismatch",
    message: "resource_mismatch: runtime restore project-identity",
  });
  expect(mocks.getProvider).not.toHaveBeenCalled();
});
