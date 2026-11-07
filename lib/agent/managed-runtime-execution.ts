import { runAppBrowserTests } from "./app-browser-test-runner";
import type { createManagedRuntimeWorkerAsset } from "./managed-runtime-worker-asset";
/* oxlint-disable eslint/no-await-in-loop -- Readiness, retained command and file checkpoints are sequenced under one approved attempt. */
import type { Sandbox } from "@vercel/sandbox";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  HostedOperatorError,
  restrictedOperatorEnvironment,
} from "../provisioning/hosted-operator-contract";
import type { HostedOperatorContext } from "../provisioning/hosted-operator-service";
import type { HostedContinuityDependencies } from "../provisioning/hosted-operator-continuity";
import type {
  ContinuityRecord,
  HostedContinuityPlan,
  ContinuityCapabilities,
} from "../provisioning/hosted-operator-continuity-contract";
import {
  canRebindUndispatchedContinuityRuntime,
  managedRuntimeWorkerDescriptorSchema,
  continuityCurrentSchema,
  continuityIdentitySchema,
  continuityProjectionSchema,
} from "../provisioning/hosted-operator-continuity-contract";
import {
  managedRuntimeEntryInputSchema,
  managedRuntimeReadySchema,
  managedRuntimeOwnerLease,
} from "./managed-runtime-entry";
import type { ManagedRuntimePublicProfile } from "../sandbox/managed-runtime-capabilities";
import {
  readManagedRuntimePublicProfile,
  managedCapabilitySha256,
} from "../sandbox/managed-runtime-capabilities";
import { restorePreparedRuntimeExecution } from "./prepared-runtime-execution-core";
import type { RuntimeCommand, RuntimeTransport } from "./prepared-runtime-execution-core";
import type { HostedRuntimeProof } from "../provisioning/hosted-runtime-service";
import type { NormalActorRuntimeProjection } from "../provisioning/hosted-operator-normal-actor-program";

const unavailable = () => new HostedOperatorError("reconciliation_required");

/** Structural subset of the supported Sandbox SDK, also used by the existing prepared runtime. */
export interface ManagedRuntimeSandboxPort extends Omit<RuntimeTransport, "fs" | "runCommand"> {
  readonly name: string;
  readonly expiresAt: Date | undefined;
  readonly routes: readonly { port: number }[];
  fs: Pick<Sandbox["fs"], "mkdir" | "chmod" | "rename" | "rm">;
  readFileToBuffer: (input: { path: string }) => Promise<Buffer | null>;
  listSessions: (options: {
    sortOrder: "desc";
  }) => Promise<AsyncIterable<{ id: string; status: string }>>;
  runCommand: (input: {
    cmd: string;
    args: string[];
    cwd?: string;
    detached?: boolean;
    env?: Record<string, string>;
    signal?: AbortSignal;
  }) => Promise<RuntimeCommand>;
  getCommand: (commandId: string) => Promise<RuntimeCommand>;
  update: (input: { networkPolicy: "allow-all"; ports: number[] }) => Promise<void>;
  domain: (port: number) => string;
}
const portObservationSource = String.raw`
const net=require("node:net");
const excluded=new Set(JSON.parse(process.argv[1]));
const servers=[];
(async()=>{
  try{
    const ports=[];
    for(let index=0;index<2;index+=1){
      const server=net.createServer();servers.push(server);
      await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
      const port=server.address().port;
      if(excluded.has(port))throw new Error("Managed runtime port is already publicly routed.");
      ports.push(port);
    }
    process.stdout.write(JSON.stringify({appPort:ports[0],bridgePort:ports[1]}));
  }finally{await Promise.all(servers.map(server=>new Promise(resolve=>server.close(()=>resolve()))));}
})().catch(()=>{process.stderr.write("Managed runtime port observation failed.");process.exitCode=1;});
`;
/** Planning observation only: both listeners close before return; a later bind can still fail normally. */
export const observeManagedRuntimePorts = async (
  provider: Pick<ManagedRuntimeSandboxPort, "runCommand" | "routes">,
) => {
  const command = await provider.runCommand({
    args: ["-e", portObservationSource, JSON.stringify(provider.routes.map((route) => route.port))],
    cmd: "node",
    env: {},
  });
  if (command.exitCode !== 0) {
    throw new HostedOperatorError("operator_unavailable");
  }
  const ports = z
    .strictObject({
      appPort: z.number().int().min(1).max(65_535),
      bridgePort: z.number().int().min(1).max(65_535),
    })
    .parse(JSON.parse(await command.stdout()));
  const exposed = new Set(provider.routes.map((route) => route.port));
  if (
    ports.appPort === ports.bridgePort ||
    exposed.has(ports.appPort) ||
    exposed.has(ports.bridgePort)
  ) {
    throw new HostedOperatorError("operator_unavailable");
  }
  return ports;
};
export interface ManagedRuntimeExecutionDependencies {
  installWorkerAsset: ReturnType<typeof createManagedRuntimeWorkerAsset>["install"];
  disposeWorkerAsset: ReturnType<typeof createManagedRuntimeWorkerAsset>["dispose"];
  /** Host-only SDK access using the exact verified originating Builder workload. */
  getSandbox: (
    context: HostedOperatorContext,
    selection: HostedContinuityPlan["runtime"],
  ) => Promise<ManagedRuntimeSandboxPort>;
  assertSelectedSandbox: (
    context: HostedOperatorContext,
    selection: HostedContinuityPlan["runtime"],
  ) => Promise<void>;
  worker: z.input<typeof managedRuntimeWorkerDescriptorSchema> | undefined;
  readExecution: (
    context: HostedOperatorContext,
    plan: HostedContinuityPlan,
    includeActors?: boolean,
  ) => Promise<{
    environment: Record<string, string>;
    proof: HostedRuntimeProof;
    normalActors?: NormalActorRuntimeProjection;
  }>;
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- The existing public-profile reader parses external JWKS JSON before any cryptographic use.
  readPublicJwks: (context: HostedOperatorContext, url: string) => Promise<unknown>;
  signal: (context: HostedOperatorContext) => AbortSignal | undefined;
}
const readReady = async (provider: ManagedRuntimeSandboxPort, file: string) => {
  const bytes = await provider.readFileToBuffer({ path: file });
  if (bytes === null) {
    return null;
  }
  return managedRuntimeReadySchema.parse(JSON.parse(bytes.toString("utf-8")));
};
const currentSession = async (provider: ManagedRuntimeSandboxPort) => {
  const sessions = await provider.listSessions({ sortOrder: "desc" });
  for await (const session of sessions) {
    if (session.status === "running") {
      return session;
    }
  }
  throw unavailable();
};
const awaitReady = async (
  provider: ManagedRuntimeSandboxPort,
  locator: NonNullable<ContinuityRecord["locator"]>,
  assertCurrent: () => Promise<void>,
  signal?: AbortSignal,
) => {
  if (locator.commandId === undefined) {
    throw unavailable();
  }
  let waitMs = 250;
  while (true) {
    await assertCurrent();
    const command = await provider.getCommand(locator.commandId);
    if (command.exitCode !== null) {
      throw unavailable();
    }
    const ready = await readReady(provider, `${locator.rootDirectory}/ready.json`);
    if (ready !== null) {
      return ready;
    }
    await delay(waitMs, undefined, { signal });
    waitMs = Math.min(waitMs * 2, 5000);
  }
};
const assertReadyIdentity = (
  record: ContinuityRecord,
  locator: NonNullable<ContinuityRecord["locator"]>,
  ready: z.infer<typeof managedRuntimeReadySchema>,
) => {
  if (record.approval === undefined) {
    throw unavailable();
  }
  const expected = {
    appId: record.plan.target.appId,
    approvalRef: record.approval.approvalId,
    fence: record.fence,
    intentId: record.requestId,
    owner: { ...record.plan.authority, sessionId: record.plan.target.sessionId },
    providerSessionId: locator.providerSessionId,
    runtimeAttemptId: record.attemptId,
    sandboxId: locator.sandboxId,
  };
  if (!isDeepStrictEqual(continuityIdentitySchema.strip().parse(ready.current), expected)) {
    throw unavailable();
  }
  return record.approval;
};
/** Narrow private wrapper; the underlying prepared execution remains the only app test runner. */
export const managedSuiteEnvironment = (input: {
  capabilities: ContinuityCapabilities;
  socketPath: string;
  publicProfile: ManagedRuntimePublicProfile;
}) => ({
  APP_TEST_MANAGED_LIFECYCLE_CAPABILITY: input.capabilities.lifecycle,
  APP_TEST_MANAGED_LIFECYCLE_SOCKET: input.socketPath,
  APP_TEST_MANAGED_PUBLIC_PROFILE: JSON.stringify(input.publicProfile),
  APP_TEST_MANAGED_SUITE_SELECTOR: input.capabilities.suiteSelector,
});
export const createManagedRuntimeExecution = (deps: ManagedRuntimeExecutionDependencies) => {
  const providers = new WeakMap<HostedOperatorContext, Promise<ManagedRuntimeSandboxPort>>();
  const providerFor = async (context: HostedOperatorContext, plan: HostedContinuityPlan) => {
    let pending = providers.get(context);
    if (pending === undefined) {
      pending = (async () => {
        await deps.assertSelectedSandbox(context, plan.runtime);
        const provider = await deps.getSandbox(context, plan.runtime);
        if (provider.name !== plan.runtime.sandboxId) {
          throw unavailable();
        }
        return provider;
      })();
      providers.set(context, pending);
    }
    return await pending;
  };
  const assertLocator = async (context: HostedOperatorContext, record: ContinuityRecord) => {
    const { locator } = record;
    if (
      locator === undefined ||
      locator.attemptId !== record.attemptId ||
      locator.sandboxId !== record.plan.runtime.sandboxId ||
      locator.root !== record.plan.runtime.root
    ) {
      throw unavailable();
    }
    const provider = await providerFor(context, record.plan);
    const session = await currentSession(provider);
    if (session.id !== locator.providerSessionId) {
      throw unavailable();
    }
    return { locator, provider };
  };
  const writeCurrent = async (provider: ManagedRuntimeSandboxPort, record: ContinuityRecord) => {
    if (record.current === undefined || record.locator === undefined) {
      return;
    }
    const file = `${record.locator.rootDirectory}/current.json`;
    const temporary = `${file}.${record.fence}.next`;
    await provider.writeFiles([
      {
        content: JSON.stringify({
          ...record.current,
          leaseExpiresAt: managedRuntimeOwnerLease(record.current.leaseExpiresAt),
        }),
        mode: 0o600,
        path: temporary,
      },
    ]);
    await provider.fs.rename(temporary, file);
  };
  const closeOwnedCommand = async (context: HostedOperatorContext, record: ContinuityRecord) => {
    if (record.locator === undefined) {
      return;
    }
    const { provider, locator } = await assertLocator(context, record);
    if (locator.commandId === undefined) {
      if (locator.dispatchAttempted === true) {
        throw unavailable();
      }
      return;
    }
    const command = await provider.getCommand(locator.commandId);
    if (command.exitCode !== null && command.exitCode !== 0) {
      throw unavailable();
    }
    if (command.exitCode === null) {
      await command.kill("SIGTERM");
      const result = await command.wait();
      if (result.exitCode !== 0) {
        throw unavailable();
      }
    }
  };
  const recoverUndispatchedLocator = async (
    provider: ManagedRuntimeSandboxPort,
    record: ContinuityRecord,
    locator: NonNullable<ContinuityRecord["locator"]>,
    assertCurrent: Parameters<HostedContinuityDependencies["runtime"]["start"]>[3],
    checkpoint: Parameters<HostedContinuityDependencies["runtime"]["start"]>[4],
  ) => {
    if (
      locator.attemptId !== record.attemptId ||
      locator.sandboxId !== record.plan.runtime.sandboxId ||
      locator.root !== record.plan.runtime.root
    ) {
      throw unavailable();
    }
    if (locator.commandId === undefined && locator.dispatchAttempted === true) {
      throw unavailable();
    }
    const session = await currentSession(provider);
    if (session.id === locator.providerSessionId) {
      return { current: record.current, locator };
    }
    if (!canRebindUndispatchedContinuityRuntime(record)) {
      throw unavailable();
    }
    const expiresAt = provider.expiresAt?.toISOString();
    if (expiresAt === undefined || Date.parse(expiresAt) <= Date.now()) {
      throw unavailable();
    }
    const recoveredLocator = { ...locator, providerSessionId: session.id };
    const current = continuityCurrentSchema.parse({
      ...record.current,
      leaseExpiresAt: expiresAt,
      providerSessionId: session.id,
    });
    await assertCurrent();
    await checkpoint({ current, locator: recoveredLocator });
    return { current, locator: recoveredLocator };
  };
  const runtime: HostedContinuityDependencies["runtime"] = {
    async close(context, record, checkpoint) {
      let failure: unknown;
      try {
        await closeOwnedCommand(context, record);
      } catch (error) {
        failure = error;
      }
      if (
        record.workerAsset?.sourceCreationAttempted === true &&
        record.workerAsset.disposed !== true
      ) {
        try {
          if (record.attemptId === undefined) {
            throw unavailable();
          }
          await deps.disposeWorkerAsset({
            attemptId: record.attemptId,
            checkpoint,
            state: record.workerAsset,
          });
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure !== undefined) {
        throw failure instanceof Error ? failure : unavailable();
      }
    },
    async renew(context, record) {
      if (record.current === undefined || record.locator === undefined) {
        return;
      }
      const provider = await providerFor(context, record.plan);
      await writeCurrent(provider, record);
    },
    async runSuite(context, record, capabilities, assertCurrent, checkpoint, allowDispatch) {
      await assertCurrent();
      const { provider, locator } = await assertLocator(context, record);
      if (allowDispatch) {
        if (locator.commandId === undefined) {
          throw unavailable();
        }
        const runtimeCommand = await provider.getCommand(locator.commandId);
        if (runtimeCommand.exitCode !== null) {
          throw unavailable();
        }
      }
      const ready = await readReady(provider, `${locator.rootDirectory}/ready.json`);
      if (ready === null) {
        throw unavailable();
      }
      const material = await deps.readExecution(context, record.plan, true);
      const profile = record.publicProfile;
      if (profile === undefined) {
        throw unavailable();
      }
      const prepared = await restorePreparedRuntimeExecution({
        appId: record.plan.target.appId,
        binding: {
          branch: record.plan.target.branch,
          environment: material.environment,
          files: { "environment.json": JSON.stringify(material.environment) },
          persistFiles: async () => {},
          projectId: record.plan.target.projectId,
          stateDirectory: `${locator.rootDirectory}/suite`,
        },
        browserTestBaseUrl: record.plan.gateway.publicOrigin,
        normalActors: material.normalActors,
        observeInstallation: async () => material.proof,
        privateValues: [capabilities.suiteSelector, capabilities.lifecycle],
        provider,
        resumeCommand: async (commandId) => await provider.getCommand(commandId),
        root: record.plan.runtime.root,
        signal: deps.signal(context),
      });
      const privateEnvironment = managedSuiteEnvironment({
        capabilities,
        publicProfile: profile,
        socketPath: ready.socketPath,
      });
      const { runTask } = prepared;
      const managed = {
        ...prepared,
        runTask: async (input: Parameters<typeof runTask>[0]) =>
          await runTask({
            ...input,
            ...(record.plan.runtime.browserSelection === undefined
              ? {}
              : {
                  browserSelection: record.plan.runtime.browserSelection,
                  frozenBrowserSelection: true,
                }),
            allowDispatch,
            commandCheckpoint: checkpoint,
            commandId: record.suiteCommandId,
            environment: { ...input.environment, ...privateEnvironment },
          }),
      };
      const result = await runAppBrowserTests({
        appId: record.plan.target.appId,
        continuation: {
          allowDispatch,
          commandCheckpoint: checkpoint,
          commandId: record.suiteCommandId,
        },
        root: record.plan.runtime.root,
        runtime: managed,
        sandbox: {
          run: async () => {
            throw unavailable();
          },
        },
        signal: deps.signal(context),
      });
      if (result.exitCode === null) {
        throw unavailable();
      }
      return { exitCode: result.exitCode };
    },
    async start(context, record, _capabilities, assertCurrent, checkpoint) {
      const descriptor = managedRuntimeWorkerDescriptorSchema.parse(
        record.locator?.worker ?? deps.worker,
      );
      const { appPort, bridgePort } = record.plan.runtime;
      await assertCurrent();
      const provider = await providerFor(context, record.plan);
      let { locator } = record;
      let retainedCurrent = record.current;
      if (locator === undefined) {
        if (record.attemptId === undefined || record.approval === undefined) {
          throw unavailable();
        }
        const session = await currentSession(provider);
        const expiresAt = provider.expiresAt?.toISOString();
        if (expiresAt === undefined || Date.parse(expiresAt) <= Date.now()) {
          throw unavailable();
        }
        const directory = `/tmp/autograph-managed-runtime/${record.requestId}/${record.attemptId}`;
        locator = {
          attemptId: record.attemptId,
          providerSessionId: session.id,
          root: record.plan.runtime.root,
          rootDirectory: directory,
          sandboxId: record.plan.runtime.sandboxId,
          worker: descriptor,
        };
        const current = continuityCurrentSchema.parse({
          appId: record.plan.target.appId,
          approvalRef: record.approval.approvalId,
          fence: record.fence,
          intentId: record.requestId,
          leaseExpiresAt: expiresAt,
          owner: { ...record.plan.authority, sessionId: record.plan.target.sessionId },
          providerSessionId: session.id,
          runtimeAttemptId: record.attemptId,
          sandboxId: provider.name,
          state: "starting",
        });
        await checkpoint({ current, locator });
      } else {
        ({ locator, current: retainedCurrent } = await recoverUndispatchedLocator(
          provider,
          record,
          locator,
          assertCurrent,
          checkpoint,
        ));
      }
      if (locator.commandId === undefined) {
        const current =
          retainedCurrent ??
          continuityCurrentSchema.parse({
            appId: record.plan.target.appId,
            approvalRef: record.approval?.approvalId,
            fence: record.fence,
            intentId: record.requestId,
            leaseExpiresAt: provider.expiresAt?.toISOString(),
            owner: { ...record.plan.authority, sessionId: record.plan.target.sessionId },
            providerSessionId: locator.providerSessionId,
            runtimeAttemptId: record.attemptId,
            sandboxId: provider.name,
            state: "starting",
          });
        if (record.attemptId === undefined) {
          throw unavailable();
        }
        await deps.installWorkerAsset({
          assertCurrent,
          attemptId: record.attemptId,
          checkpoint: async (workerAsset) => {
            await checkpoint({ workerAsset });
          },
          descriptor,
          state: record.workerAsset,
          target: provider,
        });
        // Installation verifies the configured binary and target readback through the file API.
        const material = await deps.readExecution(context, record.plan);
        const profile =
          record.publicProfile ??
          (await readManagedRuntimePublicProfile({
            appId: record.plan.target.appId,
            publicOrigin: record.plan.gateway.publicOrigin,
            readPublicJwks: async (url) => await deps.readPublicJwks(context, url),
          }));
        await checkpoint({ publicProfile: profile });
        const capabilities = _capabilities;
        const input = managedRuntimeEntryInputSchema.parse({
          actors: record.plan.actors,
          appEnvironment: restrictedOperatorEnvironment(
            record.plan.preparedPlan,
            material.environment,
            record.plan.authority,
          ),
          appPort,
          bridgePort,
          current,
          lifecycleSha256: managedCapabilitySha256(capabilities.lifecycle),
          profile,
          root: record.plan.runtime.root,
          rootDirectory: locator.rootDirectory,
          transportSha256: managedCapabilitySha256(capabilities.transport),
          version: 1,
        });
        // File API transports private runtime bytes; they are never command arguments or workflow/model results.
        await provider.fs.mkdir(locator.rootDirectory, { recursive: true });
        await provider.fs.chmod(locator.rootDirectory, 0o700);
        const file = `${locator.rootDirectory}/input.json`;
        await provider.writeFiles([{ content: JSON.stringify(input), mode: 0o600, path: file }]);
        await provider.update({
          networkPolicy: "allow-all",
          ports: [...new Set([...provider.routes.map((route) => route.port), bridgePort])],
        });
        await assertCurrent();
        locator = { ...locator, dispatchAttempted: true };
        await checkpoint({ locator });
        const command = await provider.runCommand({
          args: [descriptor.subcommand, "--input-file", file],
          cmd: descriptor.executablePath,
          detached: true,
          env: {},
          signal: deps.signal(context),
        });
        locator = { ...locator, commandId: command.cmdId };
        await checkpoint({ locator });
      }
      if (locator.commandId === undefined) {
        throw unavailable();
      }
      const ready = await awaitReady(provider, locator, assertCurrent, deps.signal(context));
      const approval = assertReadyIdentity(record, locator, ready);
      const target = {
        bridgePort,
        origin: new URL(provider.domain(bridgePort)).origin,
        ownerId: record.plan.runtime.ownerId,
        projectId: record.plan.runtime.projectId,
        providerSessionId: locator.providerSessionId,
        sandboxId: provider.name,
      };
      const projection = continuityProjectionSchema.parse({
        actors: record.plan.actors,
        appId: record.plan.target.appId,
        approvalRef: approval.approvalId,
        approvedTarget: target,
        fence: record.fence,
        gateway: record.plan.gateway,
        intentId: record.requestId,
        leaseExpiresAt: ready.current.leaseExpiresAt,
        observation: { ...target, expiresAt: ready.current.leaseExpiresAt },
        owner: ready.current.owner,
        preparedOperationRef: record.plan.originalSetup.operationRef,
        provenance: "trusted-operator-published-managed-target",
        runtimeAttemptId: record.attemptId,
        state: "ready",
        suiteSelectorSha256: managedCapabilitySha256(_capabilities.suiteSelector),
        transportSha256: managedCapabilitySha256(_capabilities.transport),
        version: 1,
      });
      await checkpoint({ current: ready.current, projection });
    },
  };
  return runtime;
};
