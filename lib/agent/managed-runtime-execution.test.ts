/* oxlint-disable eslint/require-await -- Controlled supported SDK ports exercise the actual managed-runtime adapter without provider calls. */
import { createHash, generateKeyPairSync } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import {
  createManagedRuntimeExecution,
  observeManagedRuntimePorts,
} from "./managed-runtime-execution";
import type {
  ManagedRuntimeExecutionDependencies,
  ManagedRuntimeSandboxPort,
} from "./managed-runtime-execution";
import type { RuntimeCommand } from "./prepared-runtime-execution";
import { managedRuntimeEntryInputSchema } from "./managed-runtime-entry";
import {
  createPrivateManagedRuntimeCapabilities,
  managedRuntimePublicProfileSchema,
} from "../sandbox/managed-runtime-capabilities";
import { hostedOperatorPlanSchema } from "../provisioning/hosted-operator-contract";
import type { HostedOperatorContext } from "../provisioning/hosted-operator-service";
import {
  hostedContinuityPlanSchema,
  continuityPlanDigest,
  continuityRecordSchema,
} from "../provisioning/hosted-operator-continuity-contract";
import type { ContinuityRecord } from "../provisioning/hosted-operator-continuity-contract";

const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace",
  ownerUserId: "owner",
};
const context: HostedOperatorContext = {
  authority,
  target: {
    appId: "orchard",
    branch: "preview",
    environment: "preview",
    projectId: "app-project",
    sessionId: "saved-session",
    installationId: "installation",
    scopeId: "team",
    scopeType: "team",
  },
};
const preparedPlan = hostedOperatorPlanSchema.parse({
  version: 1,
  action: "prepare",
  access: [{ actorId: "actor-one", organizationId: "organization-one", roles: ["custom_role"] }],
  appDatabase: {
    database: "app_db",
    migratorRole: "app_migrator",
    runtimeRole: "app_runtime",
    resourceId: "app-resource",
  },
  authDatabase: {
    database: "auth_db",
    migratorRole: "auth_migrator",
    runtimeRole: "auth_runtime",
    resourceId: "auth-resource",
  },
  contextId: "ordinary-planning-context",
  cost: { class: "shared-recovery-group", description: "Controlled fixture", owner: "Fixture" },
  effects: [
    { id: "resources", kind: "resources", description: "Prepare resources" },
    { id: "install", kind: "install", description: "Install app" },
    { id: "access", kind: "access", description: "Authorize app" },
    { id: "bindings", kind: "bindings", description: "Bind runtime" },
  ],
  installer: { reference: "shared-installer", sha256: "a".repeat(64) },
  neon: {
    branchId: "branch",
    connectionRef: "private-connection",
    endpoint: "ep-controlled.us-east-1.aws.neon.tech",
    projectId: "database-project",
    source: "synthetic-only",
  },
  release: { artifactRef: "retained-app-release", id: "app-release", sha256: "b".repeat(64) },
  retention: { expiresAt: "2027-01-01T00:00:00.000Z", policy: "Original retention" },
  publicGateway: {
    branch: "preview",
    origin: "https://gateway.example",
    projectId: "gateway-project",
  },
  deploymentBoundary: {
    authority,
    teamId: "team",
    app: { projectId: "app-project", branch: "preview", environment: "preview" },
    gateway: { projectId: "gateway-project", branch: "preview", environment: "preview" },
    operator: {
      projectId: "builder-project",
      deploymentId: "operator-deployment",
      environment: "preview",
    },
    verification: {
      gatewayOrigin: "https://gateway.example",
      publicOrigin: "https://gateway.example",
      jwksUrl: "https://gateway.example/_platform/jwks.json",
    },
  },
  selection: {
    appId: context.target.appId,
    branch: context.target.branch,
    environment: "preview",
    projectId: context.target.projectId,
    sessionId: context.target.sessionId,
  },
});
const selection = {
  version: 1 as const,
  kind: "app-continuity-plan" as const,
  authority,
  target: context.target,
  originalSetup: {
    operationRef: "10000000-0000-4000-8000-000000000001",
    planDigest: "c".repeat(64),
    approvalId: "setup-human",
    approvedByCallId: "setup-call",
  },
  preparedPlan,
  runtime: {
    sandboxId: "owned-sandbox",
    root: "/controlled/source",
    projectId: "builder-project",
    ownerId: "team",
    appPort: 3000,
    bridgePort: 3100,
  },
  gateway: {
    projectId: "gateway-project",
    ownerId: "team",
    environment: "preview" as const,
    publicOrigin: "https://gateway.example",
  },
  actors: [{ actorId: "actor-one", organizationId: "organization-one" }],
};
const makePlan = () =>
  hostedContinuityPlanSchema.parse({
    ...selection,
    intentId: "20000000-0000-4000-8000-000000000002",
    planRef: "_protected-operator/continuity-plans/20000000-0000-4000-8000-000000000002",
  });

const workerBytes = Buffer.from("controlled compiled worker bytes");
const worker = {
  id: "managed-worker",
  executablePath: "/private/managed-worker",
  sha256: createHash("sha256").update(workerBytes).digest("hex"),
  operationScope: "managed-app-runtime-v1" as const,
  subcommand: "protected-managed-app-runtime" as const,
};
const makeCommand = (commandId: string, output = "", initialExit: number | null = 0) => {
  let exit = initialExit;
  const command: RuntimeCommand = {
    cmdId: commandId,
    get exitCode() {
      return exit;
    },
    stdout: async () => output,
    logs: () =>
      Object.assign(
        (async function* controlledLogs() {
          yield { stream: "stdout" as const, data: output };
        })(),
        { close: vi.fn() },
      ),
    wait: vi.fn(async () => ({ exitCode: exit ?? 0 })),
    kill: vi.fn(async () => {
      exit = 0;
    }),
  };
  return command;
};
const setup = (expiresAt = new Date(Date.now() + 60_000)) => {
  const plan = makePlan();
  let record = continuityRecordSchema.parse({
    kind: "app-continuity",
    requestId: plan.intentId,
    revision: 1,
    idempotencyKey: "request",
    plan,
    planDigest: continuityPlanDigest(plan),
    state: "starting",
    fence: 1,
    attemptId: "30000000-0000-4000-8000-000000000003",
    approval: {
      action: "continuity",
      planRef: plan.planRef,
      planDigest: continuityPlanDigest(plan),
      idempotencyKey: "request",
      approvalId: "human-approval",
      approvedByCallId: "continuity-call",
    },
    environmentRows: [],
    environmentWrites: [],
    deliveryCandidates: [],
  });
  const capabilities = createPrivateManagedRuntimeCapabilities().private;
  const { publicKey } = generateKeyPairSync("ed25519");
  const profile = managedRuntimePublicProfileSchema.parse({
    version: 1,
    appId: context.target.appId,
    publicOrigin: plan.gateway.publicOrigin,
    jwksUrl: `${plan.gateway.publicOrigin}/_platform/jwks.json`,
    keys: [
      { ...publicKey.export({ format: "jwk" }), kid: "controlled-key", alg: "EdDSA", use: "sig" },
    ],
  });
  const files = new Map<string, Buffer>();
  const commands = new Map<string, RuntimeCommand>();
  const workerCommand = makeCommand("runtime-command", "", null);
  commands.set("runtime-command", workerCommand);
  const suiteCommand = makeCommand("suite-command", "Controlled suite completed", 0);
  commands.set("suite-command", suiteCommand);
  let providerName = plan.runtime.sandboxId;
  let providerSessionId = "physical-session";
  let environment = {
    ORCHARD_DATABASE_URL:
      "postgresql://app_runtime:controlled-secret@ep-controlled.us-east-1.aws.neon.tech/app_db?sslmode=verify-full",
    PLATFORM_ORIGIN: plan.gateway.publicOrigin,
    PLATFORM_PUBLIC_ORIGIN: plan.gateway.publicOrigin,
    PLATFORM_JWKS_URL: `${plan.gateway.publicOrigin}/_platform/jwks.json`,
  };
  const description = {
    version: 1,
    app: { id: "orchard", routes: [], workspacePath: "apps/orchard" },
    backend: {
      authorization: "declared-policy",
      kind: "generated-postgres",
      release: {
        id: preparedPlan.release.id,
        artifactHash: `sha256:${preparedPlan.release.sha256}`,
        directory: "release",
      },
      roles: ["custom_role"],
      runtime: { databaseEnvironment: "ORCHARD_DATABASE_URL" },
      schemaReceipt: null,
    },
    validation: {
      browser: { task: "test-e2e" },
      check: { task: "check" },
      test: { shards: 1, task: "test" },
    },
  };
  const provider: ManagedRuntimeSandboxPort = {
    get name() {
      return providerName;
    },
    expiresAt,
    routes: [{ port: 3000 }],
    fs: {
      mkdir: vi.fn<ManagedRuntimeSandboxPort["fs"]["mkdir"]>(async () => {}),
      chmod: vi.fn<ManagedRuntimeSandboxPort["fs"]["chmod"]>(async () => {}),
      rm: vi.fn<ManagedRuntimeSandboxPort["fs"]["rm"]>(async (file) => {
        files.delete(file);
      }),
      rename: vi.fn<ManagedRuntimeSandboxPort["fs"]["rename"]>(async (from, to) => {
        const bytes = files.get(from);
        if (bytes === undefined) {
          throw new Error("Missing controlled source file");
        }
        files.set(to, bytes);
        files.delete(from);
      }),
    },
    writeFiles: vi.fn<ManagedRuntimeSandboxPort["writeFiles"]>(async (writes) => {
      for (const file of writes) {
        files.set(file.path, Buffer.from(file.content));
      }
    }),
    readFileToBuffer: vi.fn<ManagedRuntimeSandboxPort["readFileToBuffer"]>(
      async ({ path }) => files.get(path) ?? null,
    ),
    listSessions: vi.fn<ManagedRuntimeSandboxPort["listSessions"]>(async () =>
      (async function* controlledSessions() {
        yield { id: providerSessionId, status: "running" };
      })(),
    ),
    getCommand: vi.fn<ManagedRuntimeSandboxPort["getCommand"]>(async (id) => {
      const command = commands.get(id);
      if (command === undefined) {
        throw new Error("Unknown controlled command");
      }
      return command;
    }),
    update: vi.fn<ManagedRuntimeSandboxPort["update"]>(async () => {}),
    domain: () => "https://controlled-sandbox.vercel.run",
    runCommand: vi.fn<ManagedRuntimeSandboxPort["runCommand"]>(async (input) => {
      if (input.cmd === "sha256sum") {
        const selected = input.args[1];
        const bytes = selected === undefined ? undefined : files.get(selected);
        return makeCommand(
          "hash-command",
          bytes === undefined
            ? ""
            : `${createHash("sha256").update(bytes).digest("hex")}  ${selected}`,
          bytes === undefined ? 1 : 0,
        );
      }
      if (input.cmd === worker.executablePath) {
        const inputPath = input.args[2];
        const bytes = inputPath === undefined ? undefined : files.get(inputPath);
        if (bytes === undefined) {
          throw new Error("Missing controlled entry input");
        }
        const parsed = managedRuntimeEntryInputSchema.parse(JSON.parse(bytes.toString("utf-8")));
        files.set(
          `${parsed.rootDirectory}/ready.json`,
          Buffer.from(
            JSON.stringify({
              current: { ...parsed.current, state: "ready" },
              socketPath: `${parsed.rootDirectory}/private.sock`,
              appPort: parsed.appPort,
              bridgePort: parsed.bridgePort,
            }),
          ),
        );
        return workerCommand;
      }
      if (input.cmd === "mise" && input.args[1] === "app:describe") {
        return makeCommand("describe-command", JSON.stringify(description));
      }
      if (input.cmd === "mise" && input.args.includes("test-e2e")) {
        return suiteCommand;
      }
      throw new Error("Unsupported controlled SDK command");
    }),
  };
  const actors = {
    origin: plan.gateway.publicOrigin,
    identities: {
      version: 1 as const,
      actors: [
        {
          actorKey: "fixture",
          actorId: "actor-one",
          organizationId: "organization-one",
          roles: ["custom_role"],
          storageState: "fixture.storage.json",
        },
      ],
    },
    files: {
      "fixture.storage.json": JSON.stringify({
        cookies: [
          {
            name: "session",
            domain: "gateway.example",
            value: "controlled-private-session",
            path: "/",
            secure: true,
          },
        ],
        origins: [],
      }),
    },
  };
  const deps: ManagedRuntimeExecutionDependencies = {
    worker,
    installWorkerAsset: vi.fn<ManagedRuntimeExecutionDependencies["installWorkerAsset"]>(
      async (input) => {
        await input.assertCurrent();
        await input.target.writeFiles([
          { path: input.descriptor.executablePath, content: workerBytes, mode: 0o700 },
        ]);
        await input.checkpoint({ installed: true, disposed: true });
      },
    ),
    disposeWorkerAsset: vi.fn<ManagedRuntimeExecutionDependencies["disposeWorkerAsset"]>(
      async (input) => {
        await input.checkpoint({ ...input.state, disposed: true });
      },
    ),
    getSandbox: vi.fn<ManagedRuntimeExecutionDependencies["getSandbox"]>(async () => provider),
    assertSelectedSandbox: vi.fn<ManagedRuntimeExecutionDependencies["assertSelectedSandbox"]>(
      async () => {},
    ),
    readExecution: vi.fn<ManagedRuntimeExecutionDependencies["readExecution"]>(
      async (_context, _plan, includeActors) => ({
        environment,
        proof: {
          actors: 1,
          tenants: 1,
          artifactHash: preparedPlan.release.sha256,
          releaseId: preparedPlan.release.id,
          authenticatedBehavior: "unassessed",
        },
        ...(includeActors === true ? { normalActors: actors } : {}),
      }),
    ),
    readPublicJwks: vi.fn<ManagedRuntimeExecutionDependencies["readPublicJwks"]>(async () => ({
      keys: profile.keys,
    })),
    // oxlint-disable-next-line unicorn/no-useless-undefined -- An absent AbortSignal is a supported SDK adapter input.
    signal: () => undefined,
  };
  const runtime = createManagedRuntimeExecution(deps);
  const guard = vi.fn(async () => {});
  const checkpoint: Parameters<typeof runtime.start>[4] = async (patch) => {
    record = continuityRecordSchema.parse({ ...record, ...patch });
  };
  const start = async () => {
    await runtime.start(context, record, capabilities, guard, checkpoint);
  };
  return {
    runtime,
    deps,
    provider,
    files,
    commands,
    profile,
    capabilities,
    guard,
    checkpoint,
    start,
    workerCommand,
    suiteCommand,
    read: () => structuredClone(record),
    replace: (next: ContinuityRecord) => {
      record = continuityRecordSchema.parse(next);
    },
    setName: (name: string) => {
      providerName = name;
    },
    setSession: (id: string) => {
      providerSessionId = id;
    },
    addEnvironment: (key: string, value: string) => {
      environment = { ...environment, [key]: value };
    },
  };
};

describe("managed runtime execution through supported SDK ports", () => {
  it("rejects stale ready metadata from a terminal retained runtime before any new suite dispatch", async () => {
    const f = setup();
    await f.start();
    vi.spyOn(f.workerCommand, "exitCode", "get").mockReturnValue(0);
    const reads = vi.mocked(f.provider.readFileToBuffer).mock.calls.length;
    await expect(f.start()).rejects.toMatchObject({ code: "reconciliation_required" });
    expect(vi.mocked(f.provider.readFileToBuffer).mock.calls.length).toBe(reads);
    await expect(
      f.runtime.runSuite(context, f.read(), f.capabilities, f.guard, async () => {}, true),
    ).rejects.toMatchObject({ code: "reconciliation_required" });
    expect(f.suiteCommand.wait).not.toHaveBeenCalled();
  });
  it("renews a short local owner lease without extending the approved publication expiry", async () => {
    const f = setup(new Date(Date.now() + 300_000));
    await f.start();
    const record = f.read();
    const before = Date.now();
    await f.runtime.renew(context, record);
    const bytes = f.files.get(`${record.locator?.rootDirectory}/current.json`);
    expect(bytes).toBeDefined();
    const local = continuityRecordSchema.shape.current
      .unwrap()
      .parse(JSON.parse(bytes?.toString() ?? "null"));
    expect(Date.parse(local.leaseExpiresAt)).toBeGreaterThanOrEqual(before + 60_000);
    expect(Date.parse(local.leaseExpiresAt)).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(f.read().current?.leaseExpiresAt).toBe(record.current?.leaseExpiresAt);
    expect(Date.parse(local.leaseExpiresAt)).toBeLessThan(
      Date.parse(record.current?.leaseExpiresAt ?? ""),
    );
  });
  it("materializes and launches only the selected runtime with private hash-only restricted input", async () => {
    const f = setup();
    await f.start();
    const record = f.read();
    expect(record.current?.state).toBe("ready");
    expect(record.locator?.providerSessionId).toBe("physical-session");
    const inputs = [...f.files].filter(([name]) => name.endsWith("/input.json"));
    expect(inputs).toHaveLength(1);
    const content = inputs[0]?.[1];
    if (content === undefined) {
      throw new Error("No private input");
    }
    const input = managedRuntimeEntryInputSchema.parse(JSON.parse(content.toString("utf-8")));
    expect(input.appEnvironment.ORCHARD_DATABASE_URL).toContain("app_runtime:");
    expect(input.lifecycleSha256).toBe(
      createHash("sha256").update(f.capabilities.lifecycle).digest("hex"),
    );
    expect(input.transportSha256).toBe(
      createHash("sha256").update(f.capabilities.transport).digest("hex"),
    );
    for (const bearer of Object.values(f.capabilities)) {
      expect(content.toString("utf-8")).not.toContain(bearer);
      expect(JSON.stringify(vi.mocked(f.provider.runCommand).mock.calls)).not.toContain(bearer);
    }
    expect(input.appEnvironment.BETTER_AUTH_SECRET).toBeUndefined();
    expect(input.appEnvironment.VERCEL_OIDC_TOKEN).toBeUndefined();
    expect(input.appEnvironment.PLATFORM_AUTH_DATABASE_URL).toBeUndefined();
    expect(record.workerAsset).toMatchObject({ installed: true, disposed: true });
    expect(
      vi
        .mocked(f.provider.runCommand)
        .mock.calls.some(
          ([call]) =>
            call.cmd === worker.executablePath &&
            call.detached === true &&
            call.env !== undefined &&
            Object.keys(call.env).length === 0,
        ),
    ).toBe(true);
  });
  it("rejects physical Sandbox or session mismatch without a launch", async () => {
    const foreign = setup();
    foreign.setName("foreign-sandbox");
    await expect(foreign.start()).rejects.toThrow();
    expect(vi.mocked(foreign.provider.runCommand).mock.calls).toEqual([]);
    const f = setup();
    await f.start();
    f.setSession("replacement-physical-session");
    const before = vi.mocked(f.provider.runCommand).mock.calls.length;
    await expect(f.start()).rejects.toThrow();
    expect(vi.mocked(f.provider.runCommand).mock.calls.length).toBe(before);
  });
  it("refuses a dispatch marker without a command ID instead of dispatching a replacement", async () => {
    const f = setup();
    await f.start();
    const record = f.read();
    if (record.locator === undefined) {
      throw new Error("Missing locator");
    }
    delete record.locator.commandId;
    record.locator.dispatchAttempted = true;
    f.replace(record);
    vi.mocked(f.provider.runCommand).mockClear();
    await expect(f.start()).rejects.toThrow();
    expect(vi.mocked(f.provider.runCommand).mock.calls).toEqual([]);
  });
  it("reconciles an existing runtime using its retained worker and public profile after ordinary configuration changes", async () => {
    const f = setup();
    await f.start();
    const retained = f.read().locator;
    f.deps.worker = { ...worker, executablePath: "/private/new-worker", sha256: "f".repeat(64) };
    vi.mocked(f.provider.runCommand).mockClear();
    const previousReads = vi.mocked(f.deps.readPublicJwks).mock.calls.length;
    await f.start();
    expect(f.read().locator).toMatchObject({
      worker: retained?.worker,
      commandId: retained?.commandId,
      providerSessionId: retained?.providerSessionId,
      attemptId: retained?.attemptId,
    });
    expect(vi.mocked(f.provider.runCommand).mock.calls).toEqual([]);
    expect(vi.mocked(f.deps.readPublicJwks).mock.calls.length).toBe(previousReads);
    expect(vi.mocked(f.deps.getSandbox).mock.calls).toHaveLength(1);
    expect(vi.mocked(f.deps.assertSelectedSandbox).mock.calls).toHaveLength(1);
  });
  it("rejects provider credentials in the app execution environment before launching the worker", async () => {
    const f = setup();
    f.addEnvironment("VERCEL_OIDC_TOKEN", "controlled-forbidden-provider-credential");
    await expect(f.start()).rejects.toThrow();
    expect(
      vi
        .mocked(f.provider.runCommand)
        .mock.calls.some(([call]) => call.cmd === worker.executablePath),
    ).toBe(false);
  });
  it("runs the declared suite through real prepared execution and resumes a retained command without redispatch", async () => {
    const f = setup();
    await f.start();
    const checkpoints: string[] = [];
    const first = await f.runtime.runSuite(
      context,
      f.read(),
      f.capabilities,
      f.guard,
      async (id) => {
        checkpoints.push(id);
        const record = f.read();
        record.suiteCommandId = id;
        f.replace(record);
      },
      true,
    );
    expect(first.exitCode).toBe(0);
    expect(checkpoints).toEqual(["suite-command"]);
    expect(vi.mocked(f.deps.readExecution).mock.calls.some((call) => call[2] === true)).toBe(true);
    const suite = vi
      .mocked(f.provider.runCommand)
      .mock.calls.find(([call]) => call.args.includes("test-e2e"))?.[0];
    if (suite === undefined) {
      throw new Error("Suite was not dispatched");
    }
    expect(suite.cmd).toBe("mise");
    expect(suite.args).toEqual(["run", "app:runtime", "run", "orchard", "test-e2e"]);
    expect(suite.env?.APP_TEST_BASE_URL).toBe(selection.gateway.publicOrigin);
    const identitiesPath = suite.env?.APP_TEST_IDENTITIES_FILE;
    const identities = identitiesPath === undefined ? undefined : f.files.get(identitiesPath);
    if (identities === undefined) {
      throw new Error("Prepared actor identities were not written");
    }
    expect(JSON.parse(identities.toString("utf-8"))).toMatchObject({
      actors: [{ actorKey: "fixture", actorId: "actor-one", organizationId: "organization-one" }],
    });
    expect(suite.env?.APP_TEST_MANAGED_SUITE_SELECTOR).toBe(f.capabilities.suiteSelector);
    expect(suite.env?.APP_TEST_MANAGED_LIFECYCLE_CAPABILITY).toBe(f.capabilities.lifecycle);
    expect(
      managedRuntimePublicProfileSchema.parse(
        JSON.parse(suite.env?.APP_TEST_MANAGED_PUBLIC_PROFILE ?? "null"),
      ),
    ).toEqual(f.profile);
    expect(Object.values(suite.env ?? {})).not.toContain(f.capabilities.transport);
    const dispatches = vi
      .mocked(f.provider.runCommand)
      .mock.calls.filter(([call]) => call.args.includes("test-e2e")).length;
    const resumed = await f.runtime.runSuite(
      context,
      f.read(),
      f.capabilities,
      f.guard,
      async () => {
        throw new Error("Unexpected new command");
      },
      false,
    );
    expect(resumed.exitCode).toBe(0);
    expect(
      vi.mocked(f.provider.runCommand).mock.calls.filter(([call]) => call.args.includes("test-e2e"))
        .length,
    ).toBe(dispatches);
    expect(vi.mocked(f.provider.getCommand).mock.calls.some(([id]) => id === "suite-command")).toBe(
      true,
    );
  });
  it("refuses an unrecorded suite dispatch when read-only reconciliation was requested", async () => {
    const f = setup();
    await f.start();
    await expect(
      f.runtime.runSuite(context, f.read(), f.capabilities, f.guard, async () => {}, false),
    ).rejects.toThrow();
    expect(
      vi.mocked(f.provider.runCommand).mock.calls.some(([call]) => call.args.includes("test-e2e")),
    ).toBe(false);
  });
  it("preserves terminal cleanup failure as reconciliation without redispatching or claiming a closed runtime", async () => {
    const f = setup();
    await f.start();
    vi.spyOn(f.workerCommand, "exitCode", "get").mockReturnValue(1);
    await expect(
      f.runtime.close(context, f.read(), async (workerAsset) => {
        f.replace({ ...f.read(), workerAsset });
      }),
    ).rejects.toMatchObject({ code: "reconciliation_required" });
    expect(f.workerCommand.kill).not.toHaveBeenCalled();
    expect(f.workerCommand.wait).not.toHaveBeenCalled();
    expect(f.suiteCommand.kill).not.toHaveBeenCalled();
  });
  it("closes only the retained runtime command with SIGTERM and waits for its actual result", async () => {
    const f = setup();
    await f.start();
    await f.runtime.close(context, f.read(), async (workerAsset) => {
      f.replace({ ...f.read(), workerAsset });
    });
    expect(vi.mocked(f.workerCommand.kill).mock.calls).toEqual([["SIGTERM"]]);
    expect(vi.mocked(f.workerCommand.wait).mock.calls).toHaveLength(1);
    expect(vi.mocked(f.suiteCommand.kill).mock.calls).toEqual([]);
  });
});

// oxlint-disable-next-line typescript/strict-void-return -- Node execFile also returns its child handle alongside the documented completion callback.
const executePortCommand = promisify(execFile);
/* oxlint-disable promise/avoid-new -- Owned local listeners expose Node event-to-Promise interfaces. */
const listenLocally = async (server: ReturnType<typeof createServer>, port: number) => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return z.object({ port: z.number().int().positive() }).parse(server.address()).port;
};
const closeListener = async (server: ReturnType<typeof createServer>) => {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
};

describe("managed runtime planning port observation", () => {
  it("runs one fixed Node command, excludes actual public routes and closes both observed listeners", async () => {
    const publicRoute = createServer();
    const app = createServer();
    const bridge = createServer();
    try {
      const publicPort = await listenLocally(publicRoute, 0);
      const runCommand = vi.fn<ManagedRuntimeSandboxPort["runCommand"]>(async (input) => {
        expect(input.cmd).toBe("node");
        expect(input.args).toHaveLength(3);
        expect(input.args[0]).toBe("-e");
        expect(JSON.parse(input.args[2] ?? "null")).toEqual([publicPort]);
        expect(input.env).toEqual({});
        expect(input.cwd).toBeUndefined();
        expect(input.detached).toBeUndefined();
        const { stdout } = await executePortCommand(process.execPath, input.args);
        return makeCommand("local-port-observation", stdout);
      });
      const ports = await observeManagedRuntimePorts({
        routes: [{ port: publicPort }],
        runCommand,
      });
      expect(runCommand).toHaveBeenCalledTimes(1);
      expect(ports.appPort).not.toBe(ports.bridgePort);
      expect([ports.appPort, ports.bridgePort]).not.toContain(publicPort);
      // Both can be held again concurrently only after the owned command closes its listeners.
      await expect(listenLocally(app, ports.appPort)).resolves.toBe(ports.appPort);
      await expect(listenLocally(bridge, ports.bridgePort)).resolves.toBe(ports.bridgePort);
    } finally {
      await Promise.all([publicRoute, app, bridge].map(closeListener));
    }
  });

  it("rejects returned metadata that selects an already publicly routed port", async () => {
    const runCommand = vi.fn<ManagedRuntimeSandboxPort["runCommand"]>(async () =>
      makeCommand(
        "controlled-port-observation",
        JSON.stringify({ appPort: 43_101, bridgePort: 43_102 }),
      ),
    );
    await expect(
      observeManagedRuntimePorts({ routes: [{ port: 43_102 }], runCommand }),
    ).rejects.toMatchObject({ code: "operator_unavailable" });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
});
