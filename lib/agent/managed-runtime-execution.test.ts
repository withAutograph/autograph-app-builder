/* oxlint-disable eslint/require-await -- Controlled supported SDK ports exercise the actual managed-runtime adapter without provider calls. */
import { createHash, generateKeyPairSync } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { isDeepStrictEqual, promisify } from "node:util";
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
import { createManagedRuntimeWorkerAsset } from "./managed-runtime-worker-asset";
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
import { createHostedContinuityOperations } from "../provisioning/hosted-operator-continuity";
import type { HostedContinuityDependencies } from "../provisioning/hosted-operator-continuity";
import { createContinuityCapabilityCustody } from "../provisioning/hosted-operator-continuity-custody";

// The native operator executes the real managed suite without agent tool or inference packages.
// oxlint-disable-next-line anti-slop/no-module-mocking -- Reproduce the actual missing deployment dependency; no runtime implementation is replaced.
vi.mock("eve/tools", () => {
  throw new Error("Agent tools are unavailable in the native operator");
});
// oxlint-disable-next-line anti-slop/no-module-mocking -- Reproduce the actual missing inference dependency while exercising the real operator and runner.
vi.mock("ai", () => {
  throw new Error("Model inference is unavailable in the native operator");
});

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const context: HostedOperatorContext = {
  authority,
  target: {
    appId: "orchard",
    branch: "preview",
    environment: "preview",
    installationId: "installation",
    projectId: "app-project",
    scopeId: "team",
    scopeType: "team",
    sessionId: "saved-session",
  },
};
const preparedPlan = hostedOperatorPlanSchema.parse({
  version: 1,
  action: "prepare",
  access: [{ actorId: "actor-one", organizationId: "organization-one", roles: ["custom_role"] }],
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
  contextId: "ordinary-planning-context",
  cost: { class: "shared-recovery-group", description: "Controlled fixture", owner: "Fixture" },
  effects: [
    { description: "Prepare resources", id: "resources", kind: "resources" },
    { description: "Install app", id: "install", kind: "install" },
    { description: "Authorize app", id: "access", kind: "access" },
    { description: "Bind runtime", id: "bindings", kind: "bindings" },
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
    app: { branch: "preview", environment: "preview", projectId: "app-project" },
    gateway: { branch: "preview", environment: "preview", projectId: "gateway-project" },
    operator: {
      deploymentId: "operator-deployment",
      environment: "preview",
      projectId: "builder-project",
    },
    verification: {
      gatewayOrigin: "https://gateway.example",
      jwksUrl: "https://gateway.example/_platform/jwks.json",
      publicOrigin: "https://gateway.example",
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
    appPort: 3000,
    bridgePort: 3100,
    ownerId: "team",
    projectId: "builder-project",
    root: "/controlled/source",
    sandboxId: "owned-sandbox",
  },
  gateway: {
    environment: "preview" as const,
    ownerId: "team",
    projectId: "gateway-project",
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
    app: {
      id: "orchard",
      browserEntryPath: "/orchard",
      routes: ["/orchard"],
      workspacePath: "apps/orchard",
    },
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
        return makeCommand("hash-command", "");
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
      if (
        input.cmd === "/usr/bin/env" &&
        input.args[0] === "mise" &&
        input.args[1] === "run" &&
        input.args[2] === "app:describe"
      ) {
        return makeCommand("describe-command", JSON.stringify(description));
      }
      if (
        input.cmd === "/usr/bin/env" &&
        input.args[0] === "mise" &&
        input.args.includes("test-e2e")
      ) {
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
            domain: "gateway.example",
            name: "session",
            path: "/",
            secure: true,
            value: "controlled-private-session",
          },
        ],
        origins: [],
      }),
    },
  };
  let sourceName = "";
  let sourceBytes: Buffer = workerBytes;
  let sourceCreates = 0;
  const source = {
    get name() {
      return sourceName;
    },
    readFileToBuffer: vi.fn(async () => sourceBytes),
    stop: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
  const installer = {
    ...worker,
    operationScope: "generated-app-release-install-v1",
    subcommand: "protected-generated-app-install",
  } as const;
  const asset = createManagedRuntimeWorkerAsset({
    configuration: {
      projectId: "operator-project",
      teamId: "operator-team",
      source: { snapshotId: "controlled-worker-source", type: "snapshot" },
      accessWorker: installer,
      authWorker: installer,
      resourcesWorker: installer,
      workers: {},
      authProposal: installer,
    },
    token: async () => "controlled-operator-host-oidc",
    create: async (options) => {
      sourceCreates += 1;
      sourceName = options?.name ?? "";
      return source;
    },
  });
  const deps: ManagedRuntimeExecutionDependencies = {
    worker,
    installWorkerAsset: vi.fn<ManagedRuntimeExecutionDependencies["installWorkerAsset"]>(
      async (input) => {
        await asset.install(input);
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
      async (_context, _plan, includeActors) => {
        const execution: Awaited<ReturnType<ManagedRuntimeExecutionDependencies["readExecution"]>> =
          {
            environment,
            proof: {
              actors: 1,
              tenants: 1,
              artifactHash: preparedPlan.release.sha256,
              releaseId: preparedPlan.release.id,
              authenticatedBehavior: "unassessed",
            },
          };
        if (includeActors === true) {
          execution.normalActors = actors;
        }
        return execution;
      },
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
    addEnvironment: (key: string, value: string) => {
      environment = { ...environment, [key]: value };
    },
    capabilities,
    checkpoint,
    commands,
    deps,
    files,
    guard,
    profile,
    provider,
    read: () => structuredClone(record),
    readSourceCreates: () => sourceCreates,
    replace: (next: ContinuityRecord) => {
      record = continuityRecordSchema.parse(next);
    },
    runtime,
    setName: (name: string) => {
      providerName = name;
    },
    setSession: (id: string) => {
      providerSessionId = id;
    },
    setSourceBytes: (bytes: Buffer) => {
      sourceBytes = bytes;
    },
    source,
    start,
    suiteCommand,
    workerCommand,
  };
};

describe("managed runtime execution through supported SDK ports", () => {
  it("launches the verified worker without depending on checksum command stdout", async () => {
    const f = setup();
    await f.start();
    expect(f.files.get(worker.executablePath)).toEqual(workerBytes);
    expect(f.read().current?.state).toBe("ready");
    expect(f.source.delete).toHaveBeenCalledWith({ deleteOrphanSnapshots: false });
    expect(f.provider.runCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "sha256sum" }),
    );
  });
  it("refuses wrong worker bytes before dispatch and retries the same intent after owned cleanup", async () => {
    const f = setup();
    f.setSourceBytes(Buffer.from("wrong worker"));
    await expect(f.start()).rejects.toMatchObject({ code: "resource_mismatch" });
    const failed = f.read();
    expect(failed.locator?.dispatchAttempted).not.toBe(true);
    expect(failed.locator?.commandId).toBeUndefined();
    expect(failed.workerAsset).toMatchObject({ disposed: true, installed: false });
    expect(f.source.delete).toHaveBeenCalledWith({ deleteOrphanSnapshots: false });
    expect(f.provider.runCommand).not.toHaveBeenCalled();
    await f.runtime.close(context, failed, async () => {});
    f.setSourceBytes(workerBytes);
    await f.start();
    expect(f.read()).toMatchObject({
      attemptId: failed.attemptId,
      current: { state: "ready" },
      fence: failed.fence,
      locator: { commandId: "runtime-command" },
      requestId: failed.requestId,
    });
    await f.start();
    expect(f.provider.runCommand).toHaveBeenCalledTimes(1);
    await f.runtime.close(context, f.read(), async () => {});
    expect(f.workerCommand.kill).toHaveBeenCalledWith("SIGTERM");
    expect(f.suiteCommand.kill).not.toHaveBeenCalled();
  });
  it("resumes the same verified setup after a pre-dispatch interruption without another source VM or worker dispatch", async () => {
    const f = setup();
    vi.mocked(f.deps.readExecution).mockRejectedValueOnce(new Error("Interrupted after setup"));
    await expect(f.start()).rejects.toThrow("Interrupted after setup");
    const interrupted = f.read();
    expect(interrupted.workerAsset).toMatchObject({ disposed: true, installed: true });
    expect(interrupted.locator?.dispatchAttempted).not.toBe(true);
    expect(interrupted.locator?.commandId).toBeUndefined();
    expect(f.provider.runCommand).not.toHaveBeenCalled();
    expect(f.readSourceCreates()).toBe(1);
    await f.runtime.close(context, interrupted, async () => {});
    await f.start();
    expect(f.read()).toMatchObject({
      attemptId: interrupted.attemptId,
      current: { state: "ready" },
      fence: interrupted.fence,
      locator: { ...interrupted.locator, commandId: "runtime-command" },
      requestId: interrupted.requestId,
    });
    expect(f.readSourceCreates()).toBe(1);
    expect(f.source.delete).toHaveBeenCalledTimes(1);
    await f.start();
    expect(f.provider.runCommand).toHaveBeenCalledTimes(1);
  });
  it("rebinds an installed but undispatched attempt after persistent sandbox resume, then launches and runs once", async () => {
    const f = setup();
    vi.mocked(f.deps.readExecution).mockRejectedValueOnce(new Error("Interrupted after install"));
    await expect(f.start()).rejects.toThrow("Interrupted after install");
    const original = f.read();
    f.replace({ ...original, state: "reconciliation-required", pendingStage: "runtime" });
    f.setSession("resumed-physical-session");
    await f.start();
    const recovered = f.read();
    expect(recovered).toMatchObject({
      approval: original.approval,
      attemptId: original.attemptId,
      current: { providerSessionId: "resumed-physical-session", state: "ready" },
      fence: original.fence,
      locator: {
        ...original.locator,
        commandId: "runtime-command",
        dispatchAttempted: true,
        providerSessionId: "resumed-physical-session",
      },
      requestId: original.requestId,
      workerAsset: { disposed: true, installed: true },
    });
    expect(f.deps.installWorkerAsset).toHaveBeenCalledTimes(2);
    expect(f.readSourceCreates()).toBe(1);
    expect(f.source.delete).toHaveBeenCalledTimes(1);
    await f.start();
    const checkpointSuite = async (suiteCommandId: string) => {
      f.replace({ ...f.read(), suiteCommandId });
    };
    await f.runtime.runSuite(context, f.read(), f.capabilities, f.guard, checkpointSuite, true);
    await f.runtime.runSuite(context, f.read(), f.capabilities, f.guard, checkpointSuite, false);
    expect(
      vi
        .mocked(f.provider.runCommand)
        .mock.calls.filter(([call]) => call.cmd === worker.executablePath),
    ).toHaveLength(1);
    expect(
      vi
        .mocked(f.provider.runCommand)
        .mock.calls.filter(([call]) => call.args.includes("test-e2e")),
    ).toHaveLength(1);
    await f.runtime.close(context, f.read(), async () => {});
    expect(f.workerCommand.kill).toHaveBeenCalledWith("SIGTERM");
  });
  it("settles the retained approved operation through service CAS, resumed runtime and real suite without replanning or new consent", async () => {
    const f = setup();
    vi.mocked(f.deps.readExecution).mockRejectedValueOnce(new Error("Interrupted after install"));
    await expect(f.start()).rejects.toThrow("Interrupted after install");
    const retained = f.read();
    const custody = createContinuityCapabilityCustody({
      tokenKey: Buffer.alloc(32, 7),
      tokenKeyVersion: "controlled-key",
    });
    f.replace({
      ...retained,
      state: "reconciliation-required",
      pendingStage: "runtime",
      privateState: custody.seal(retained, f.capabilities),
    });
    f.setSession("resumed-physical-session");
    const records: ContinuityRecord[] = [];
    const resolvePlan = vi.fn<HostedContinuityDependencies["resolvePlan"]>(async () => {
      throw new Error("Replanning is forbidden");
    });
    const readApproval = vi.fn<HostedContinuityDependencies["readApproval"]>(async () => {
      throw new Error("New consent is forbidden");
    });
    const publish = vi.fn<HostedContinuityDependencies["projection"]["publish"]>(
      async (_context, _record, _caps, assertCurrent) => {
        await assertCurrent();
      },
    );
    const revoke = vi.fn<HostedContinuityDependencies["projection"]["revoke"]>(
      async (_context, _record, assertCurrent, checkpoint) => {
        await assertCurrent();
        await checkpoint([]);
      },
    );
    const operations = createHostedContinuityOperations({
      assertOwner: async (owner) => {
        expect(owner).toEqual(context);
      },
      assertSetup: async (_context, plan) => {
        expect(plan).toEqual(retained.plan);
      },
      projection: { publish, revoke },
      readApproval,
      resolvePlan,
      runtime: f.runtime,
      seal: (record, caps) => custody.seal(record, caps),
      store: {
        compareAndSet: async (input) => {
          expect(input.expectedRevision).toBe(f.read().revision);
          f.replace(input.record);
          records.push(f.read());
          return f.read();
        },
        read: async (input) => {
          const row = f.read();
          if (
            input.intentId !== row.requestId ||
            !isDeepStrictEqual(input.authority, row.plan.authority)
          ) {
            throw new Error("Foreign controlled journal read");
          }
          return row;
        },
        reserve: async () => {
          throw new Error("Replacement operation is forbidden");
        },
      },
      unseal: (record) => custody.unseal(record),
      withResourceLease: async (input, run) => {
        await input.initializeUnderLock?.();
        const fence = await input.readCurrentFence();
        return await run(async () => {
          expect(await input.readCurrentFence()).toEqual(fence);
        });
      },
    });
    const request = {
      action: "continuity" as const,
      planRef: retained.plan.planRef,
      planDigest: retained.planDigest,
      idempotencyKey: retained.idempotencyKey,
    };
    const result = await operations.execute(context, request, "continuity-call");
    expect(result.state).toBe("settled");
    expect(result.outcome?.exitCode).toBe(0);
    expect(f.read()).toMatchObject({
      approval: retained.approval,
      attemptId: retained.attemptId,
      current: { providerSessionId: "resumed-physical-session", state: "revoked" },
      fence: retained.fence,
    });
    expect(f.read().pendingStage).toBeUndefined();
    expect(
      records.some(
        (row) =>
          row.locator?.providerSessionId === "resumed-physical-session" &&
          row.current?.providerSessionId === "resumed-physical-session" &&
          row.locator.commandId === undefined,
      ),
    ).toBe(true);
    expect(custody.unseal(f.read())).toEqual(f.capabilities);
    expect(f.workerCommand.kill).toHaveBeenCalledWith("SIGTERM");
    expect(f.source.delete).toHaveBeenCalledTimes(1);
    expect(f.readSourceCreates()).toBe(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(resolvePlan).not.toHaveBeenCalled();
    expect(readApproval).not.toHaveBeenCalled();
    const dispatches = vi.mocked(f.provider.runCommand).mock.calls.length;
    await expect(operations.execute(context, request, "continuity-call")).resolves.toEqual(result);
    expect(f.provider.runCommand).toHaveBeenCalledTimes(dispatches);
    expect(
      vi
        .mocked(f.provider.runCommand)
        .mock.calls.filter(([call]) => call.cmd === worker.executablePath),
    ).toHaveLength(1);
    expect(
      vi
        .mocked(f.provider.runCommand)
        .mock.calls.filter(([call]) => call.args.includes("test-e2e")),
    ).toHaveLength(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledTimes(1);
  });
  it.each([
    "command",
    "dispatch",
    "publication",
    "cancelled",
    "suite",
    "owner",
    "fence",
    "approval",
    "attempt",
    "root",
    "superseded",
  ])("refuses session rebind with %s effects or identity mismatch", async (reason) => {
    const f = setup();
    vi.mocked(f.deps.readExecution).mockRejectedValueOnce(new Error("Interrupted after install"));
    await expect(f.start()).rejects.toThrow("Interrupted after install");
    const saved = f.read();
    if (saved.locator === undefined || saved.current === undefined) {
      throw new Error("Missing controlled locator");
    }
    const next = {
      ...saved,
      state: "reconciliation-required" as const,
      pendingStage: "runtime" as const,
    };
    if (reason === "command") {
      next.locator = { ...saved.locator, commandId: "runtime-command" };
    }
    if (reason === "dispatch") {
      next.locator = { ...saved.locator, dispatchAttempted: true };
    }
    if (reason === "publication") {
      next.deliveryAttempted = true;
    }
    if (reason === "cancelled") {
      next.cancelled = true;
    }
    if (reason === "suite") {
      next.suiteDispatched = true;
    }
    if (reason === "owner") {
      next.current = {
        ...saved.current,
        owner: { ...saved.current.owner, sessionId: "foreign-session" },
      };
    }
    if (reason === "fence") {
      next.current = { ...saved.current, fence: saved.fence + 1 };
    }
    if (reason === "approval") {
      next.current = { ...saved.current, approvalRef: "foreign-approval" };
    }
    if (reason === "attempt") {
      next.locator = { ...saved.locator, attemptId: "40000000-0000-4000-8000-000000000004" };
    }
    if (reason === "root") {
      next.locator = { ...saved.locator, root: "/foreign-root" };
    }
    if (reason === "superseded") {
      next.supersededBy = "40000000-0000-4000-8000-000000000004";
    }
    f.replace(next);
    f.setSession("resumed-physical-session");
    await expect(f.start()).rejects.toMatchObject({ code: "reconciliation_required" });
    expect(f.provider.runCommand).not.toHaveBeenCalled();
    expect(f.deps.installWorkerAsset).toHaveBeenCalledTimes(1);
    expect(f.read().locator?.providerSessionId).toBe(saved.locator.providerSessionId);
  });
  it("rechecks the owner fence before persisting a changed provider session", async () => {
    const f = setup();
    vi.mocked(f.deps.readExecution).mockRejectedValueOnce(new Error("Interrupted after install"));
    await expect(f.start()).rejects.toThrow("Interrupted after install");
    f.replace({ ...f.read(), pendingStage: "runtime" });
    f.setSession("resumed-physical-session");
    const guard = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(async () => {})
      .mockRejectedValueOnce(new Error("Owner fence changed"));
    const checkpoint = vi.fn(f.checkpoint);
    await expect(
      f.runtime.start(context, f.read(), f.capabilities, guard, checkpoint),
    ).rejects.toThrow("Owner fence changed");
    expect(guard).toHaveBeenCalledTimes(2);
    expect(checkpoint).not.toHaveBeenCalled();
    expect(f.deps.installWorkerAsset).toHaveBeenCalledTimes(1);
    expect(f.provider.runCommand).not.toHaveBeenCalled();
  });
  it("does not install or launch when the atomic session-rebind checkpoint loses its revision", async () => {
    const f = setup();
    vi.mocked(f.deps.readExecution).mockRejectedValueOnce(new Error("Interrupted after install"));
    await expect(f.start()).rejects.toThrow("Interrupted after install");
    const saved = f.read();
    f.replace({ ...saved, pendingStage: "runtime" });
    f.setSession("resumed-physical-session");
    const checkpoint = vi.fn<Parameters<typeof f.runtime.start>[4]>(async () => {
      throw new Error("Controlled CAS conflict");
    });
    await expect(
      f.runtime.start(context, f.read(), f.capabilities, f.guard, checkpoint),
    ).rejects.toThrow("Controlled CAS conflict");
    expect(checkpoint).toHaveBeenCalledTimes(1);
    const proposed = checkpoint.mock.calls[0]?.[0];
    expect(proposed?.locator?.providerSessionId).toBe("resumed-physical-session");
    expect(proposed?.current?.providerSessionId).toBe("resumed-physical-session");
    expect(f.provider.runCommand).not.toHaveBeenCalled();
    expect(f.deps.installWorkerAsset).toHaveBeenCalledTimes(1);
    expect(f.read().locator).toEqual(saved.locator);
  });
  it("refuses altered target readback before worker launch and cleans its owned source", async () => {
    const f = setup();
    vi.mocked(f.provider.writeFiles).mockImplementation(async (writes) => {
      for (const file of writes) {
        f.files.set(file.path, Buffer.from("corrupted target"));
      }
    });
    await expect(f.start()).rejects.toMatchObject({ code: "reconciliation_required" });
    expect(f.provider.runCommand).not.toHaveBeenCalled();
    expect(f.read().workerAsset?.installed).not.toBe(true);
    expect(f.read().workerAsset?.disposed).toBe(true);
    expect(f.source.delete).toHaveBeenCalledWith({ deleteOrphanSnapshots: false });
  });
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
    expect(record.workerAsset).toMatchObject({ disposed: true, installed: true });
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
      attemptId: retained?.attemptId,
      commandId: retained?.commandId,
      providerSessionId: retained?.providerSessionId,
      worker: retained?.worker,
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
    expect(suite.cmd).toBe("/usr/bin/env");
    expect(suite.args).toEqual(["mise", "run", "app:runtime", "run", "orchard", "test-e2e"]);
    expect(suite.env?.APP_TEST_BASE_URL).toBe(selection.gateway.publicOrigin);
    const identitiesPath = suite.env?.APP_TEST_IDENTITIES_FILE;
    const identities = identitiesPath === undefined ? undefined : f.files.get(identitiesPath);
    if (identities === undefined) {
      throw new Error("Prepared actor identities were not written");
    }
    expect(JSON.parse(identities.toString("utf-8"))).toMatchObject({
      actors: [{ actorId: "actor-one", actorKey: "fixture", organizationId: "organization-one" }],
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

it("runs only the frozen focused continuity selection and resumes without another dispatch", async () => {
  const f = setup();
  await f.start();
  const selected = f.read();
  selected.plan.runtime.browserSelection = {
    maxFailures: 1,
    retries: 0,
    testName: "@acceptance",
    workers: 1,
  };
  selected.planDigest = continuityPlanDigest(selected.plan);
  f.replace(selected);
  const checkpoint = async (id: string) => {
    const record = f.read();
    record.suiteCommandId = id;
    f.replace(record);
  };
  const first = await f.runtime.runSuite(
    context,
    f.read(),
    f.capabilities,
    f.guard,
    checkpoint,
    true,
  );
  expect(first.exitCode).toBe(0);
  const calls = vi
    .mocked(f.provider.runCommand)
    .mock.calls.filter(([call]) => call.args.includes("test-e2e"));
  expect(calls).toHaveLength(1);
  expect(calls[0][0].args).toEqual(
    expect.arrayContaining([
      "--grep",
      "@acceptance",
      "--workers=1",
      "--retries=0",
      "--max-failures=1",
    ]),
  );
  const resumed = await f.runtime.runSuite(
    context,
    f.read(),
    f.capabilities,
    f.guard,
    checkpoint,
    false,
  );
  expect(resumed.exitCode).toBe(0);
  expect(
    vi.mocked(f.provider.runCommand).mock.calls.filter(([call]) => call.args.includes("test-e2e")),
  ).toHaveLength(1);
});
