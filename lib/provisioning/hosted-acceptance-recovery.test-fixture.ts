/* oxlint-disable sonarjs/no-nested-functions -- Controlled asynchronous lifecycle callbacks retain the same owned test context. */
/* oxlint-disable eslint/require-await -- Faithful controlled asynchronous ports exercise the actual continuity service without provider effects. */
import { expect, vi } from "vitest";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { HostedOperatorError, hostedOperatorPlanSchema } from "./hosted-operator-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";
import {
  hostedContinuityPlanSchema,
  continuityRecordSchema,
} from "./hosted-operator-continuity-contract";
import type { ContinuityRecord } from "./hosted-operator-continuity-contract";

import { createHostedContinuityOperations } from "./hosted-operator-continuity";
import type { HostedContinuityDependencies } from "./hosted-operator-continuity";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createManagedRuntimeBridge } from "../sandbox/managed-runtime-bridge";
import {
  createManagedOwnedChildLauncher,
  createManagedRuntimeSupervisor,
} from "../sandbox/managed-runtime-supervisor";
import {
  createManagedRuntimeIpcClient,
  startManagedRuntimeIpc,
} from "../sandbox/managed-runtime-ipc";
import {
  managedCapabilitySha256,
  managedRuntimePublicProfileSchema,
} from "../sandbox/managed-runtime-capabilities";
import { runAppBrowserTests } from "../agent/app-browser-test-runner";
import { createContinuityCapabilityCustody } from "./hosted-operator-continuity-custody";

const listen = async (server: Server) => {
  // oxlint-disable-next-line promise/avoid-new -- Adapt the owned loopback listener event.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // oxlint-disable-next-line sonarjs/no-nested-functions -- Listener completion owns the corresponding error callback cleanup.
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = z.object({ port: z.number() }).parse(server.address());
  return address.port;
};

export const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
export const context: HostedOperatorContext = {
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
export const preparedPlan = hostedOperatorPlanSchema.parse({
  access: [{ actorId: "actor-one", organizationId: "organization-one", roles: ["custom_role"] }],
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
  selection: {
    appId: context.target.appId,
    branch: context.target.branch,
    environment: "preview",
    projectId: context.target.projectId,
    sessionId: context.target.sessionId,
  },
  version: 1,
});
export const selection = {
  version: 1 as const,
  kind: "app-continuity-plan" as const,
  authority,
  target: context.target,
  originalSetup: {
    approvalId: "setup-human",
    approvedByCallId: "setup-call",
    operationRef: "10000000-0000-4000-8000-000000000001",
    planDigest: "c".repeat(64),
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

export const setup = () => {
  let row: ContinuityRecord | undefined;
  const rows = new Map<string, ContinuityRecord>();
  let owner = true;
  let approved = false;
  let setupCurrent = true;
  let held = false;
  let rejectCas = false;
  const events: string[] = [];
  const records: ContinuityRecord[] = [];
  const read = () => {
    if (row === undefined) {
      throw new Error("Missing controlled continuity row");
    }
    return structuredClone(row);
  };
  const custody = createContinuityCapabilityCustody({
    tokenKey: Buffer.alloc(32, 7),
    tokenKeyVersion: "fixture-key",
  });
  const deps: HostedContinuityDependencies = {
    store: {
      async read(input) {
        const saved = rows.get(input.intentId);
        return saved && isDeepStrictEqual(input.authority, saved.plan.authority)
          ? structuredClone(saved)
          : undefined;
      },
      async reserve(input) {
        row =
          rows.get(input.record.requestId) ??
          continuityRecordSchema.parse(structuredClone(input.record));
        rows.set(row.requestId, row);
        records.push(read());
        return read();
      },
      async compareAndSet(input) {
        row = rows.get(input.record.requestId);
        if (rejectCas || row?.revision !== input.expectedRevision) {
          rejectCas = false;
          // oxlint-disable-next-line unicorn/no-useless-undefined -- Optional CAS absence is the supported conflict result.
          // oxlint-disable-next-line unicorn/no-useless-undefined -- Missing workspace is the resolver contract.
          return undefined;
        }
        row = continuityRecordSchema.parse(structuredClone(input.record));
        rows.set(row.requestId, row);
        records.push(read());
        return read();
      },
    },
    assertOwner: vi.fn<HostedContinuityDependencies["assertOwner"]>(async () => {
      if (!owner) {
        throw new HostedOperatorError("authorization_required");
      }
    }),
    assertSetup: vi.fn<HostedContinuityDependencies["assertSetup"]>(async () => {
      if (!owner || !setupCurrent) {
        throw new HostedOperatorError("authorization_required");
      }
    }),
    resolvePlan: vi.fn<HostedContinuityDependencies["resolvePlan"]>(async (_context, runtime) => ({
      ...makePlan(),
      runtime: { ...selection.runtime, ...runtime },
    })),
    readApproval: vi.fn<HostedContinuityDependencies["readApproval"]>(
      async (_context, request, callId) =>
        approved
          ? {
              ...request,
              approvalId: "continuity-human",
              approvedByCallId: callId ?? "continuity-call",
            }
          : null,
    ),
    seal: (record, caps) => custody.seal(record, caps),
    unseal: (record) => custody.unseal(record),
    withResourceLease: async (input, run) => {
      if (held) {
        throw new HostedOperatorError("operation_in_progress");
      }
      held = true;
      try {
        await input.initializeUnderLock?.();
        const fence = await input.readCurrentFence();
        return await run(async () => {
          const current = await input.readCurrentFence();
          if (!isDeepStrictEqual(current, fence)) {
            throw new HostedOperatorError("reconciliation_required");
          }
        });
      } finally {
        held = false;
      }
    },
    runtime: {
      start: vi.fn<HostedContinuityDependencies["runtime"]["start"]>(
        async (_context, record, _capabilities, assertCurrent, checkpoint) => {
          await assertCurrent();
          events.push("start");
          const { attemptId, approval } = record;
          if (approval === undefined) {
            throw new Error("Missing fresh approval");
          }
          if (attemptId === undefined) {
            throw new Error("Missing retained attempt");
          }
          await checkpoint({
            locator: {
              sandboxId: record.plan.runtime.sandboxId,
              root: record.plan.runtime.root,
              providerSessionId: "provider-session",
              commandId: "runtime-command",
              worker: {
                executablePath: "/private/worker",
                id: "managed-worker",
                operationScope: "managed-app-runtime-v1",
                sha256: "d".repeat(64),
                subcommand: "protected-managed-app-runtime",
              },
              attemptId,
              rootDirectory: "/controlled/runtime",
            },
            current: {
              intentId: record.requestId,
              approvalRef: approval.approvalId,
              owner: { ...authority, sessionId: context.target.sessionId },
              appId: context.target.appId,
              runtimeAttemptId: attemptId,
              fence: record.fence,
              sandboxId: record.plan.runtime.sandboxId,
              providerSessionId: "provider-session",
              state: "ready",
              leaseExpiresAt: "2027-01-01T00:00:00.000Z",
            },
          });
        },
      ),
      runSuite: vi.fn<HostedContinuityDependencies["runtime"]["runSuite"]>(
        async (_context, _record, _capabilities, assertCurrent, checkpoint, allowDispatch) => {
          await assertCurrent();
          events.push(allowDispatch ? "dispatch-suite" : "read-suite");
          if (allowDispatch) {
            await checkpoint("suite-command");
          }
          return { exitCode: 0 };
        },
      ),
      close: vi.fn<HostedContinuityDependencies["runtime"]["close"]>(async () => {
        events.push("close");
      }),
      renew: vi.fn<HostedContinuityDependencies["runtime"]["renew"]>(async () => {
        events.push("renew");
      }),
    },
    projection: {
      publish: vi.fn<HostedContinuityDependencies["projection"]["publish"]>(
        async (_context, _record, _capabilities, assertCurrent) => {
          await assertCurrent();
          events.push("publish");
        },
      ),
      revoke: vi.fn<HostedContinuityDependencies["projection"]["revoke"]>(
        async (_context, _record, assertCurrent, checkpoint) => {
          await assertCurrent();
          events.push("revoke-owned-rows");
          await checkpoint([]);
        },
      ),
    },
    now: () => new Date("2026-10-20T14:00:00.000Z"),
  };
  return {
    operations: createHostedContinuityOperations(deps),
    deps,
    events,
    records,
    read,
    rows,
    approve: () => {
      approved = true;
    },
    revokeOwner: () => {
      owner = false;
    },
    invalidateSetup: () => {
      setupCurrent = false;
    },
    rejectNextCas: () => {
      rejectCas = true;
    },
  };
};

export const installManagedAcceptanceSuite = (
  f: ReturnType<typeof setup>,
  root: string,
  fixture: string,
  browserSelection: { testName: string; workers: number; retries: number; maxFailures: number },
) => {
  f.deps.runtime.runSuite = async (
    _context,
    record,
    capabilities,
    assertCurrent,
    checkpoint,
    allowDispatch,
  ) => {
    await assertCurrent();
    expect(allowDispatch).toBe(true);
    expect(record.plan.runtime.root).toBe(root);
    expect(record.plan.runtime.browserSelection).toEqual(browserSelection);
    expect(capabilities.lifecycle).toBeTruthy();
    expect(capabilities.transport).toBeTruthy();
    expect(capabilities.suiteSelector).toBeTruthy();
    await checkpoint("focused-command");
    const result = await runAppBrowserTests({
      appId: context.target.appId,
      root,
      sandbox: {
        run: async () => {
          throw new Error("managed task must use protected runtime");
        },
      },
      selection: record.plan.runtime.browserSelection,
      runtime: {
        environmentPath: "/controlled/private/environment.json",
        stateDirectory: "/controlled/private",
        installationProof: {
          appId: context.target.appId,
          branch: "preview",
          environment: "preview",
          releaseId: preparedPlan.release.id,
          artifactHash: preparedPlan.release.sha256,
          actors: 1,
          tenants: 1,
          observedAt: "2026-10-20T14:00:00.000Z",
          observation: "database-verification",
          authenticatedBehavior: "unassessed",
        },
        prepareAuthenticatedOrigin: async () => {
          await Promise.resolve();
        },
        runTask: async (task) => {
          expect(task.browserSelection).toEqual(browserSelection);
          // The browser terminal and principal verifier are controlled ports; child,
          // loopback forwarding, capability IPC and process replacement are real.
          await assertCurrent();
          const { current } = record;
          if (!current) {
            throw new Error("Managed runtime identity is missing");
          }
          const identity = {
            intentId: current.intentId,
            approvalRef: current.approvalRef,
            owner: current.owner,
            appId: current.appId,
            runtimeAttemptId: current.runtimeAttemptId,
            fence: current.fence,
            sandboxId: current.sandboxId,
            providerSessionId: current.providerSessionId,
          };
          const reservation = createServer();
          const appPort = await listen(reservation);
          // oxlint-disable-next-line promise/avoid-new -- Release the reserved port before owned launch.
          await new Promise<void>((resolve) => {
            reservation.close(() => {
              resolve();
            });
          });
          const childScript = path.join(fixture, "managed-http-child.mjs");
          const durableFile = path.join(fixture, "durable.txt");
          await writeFile(durableFile, "preserved-value");
          await writeFile(
            childScript,
            `import {createServer} from 'node:http';import {readFileSync} from 'node:fs';createServer((req,res)=>res.end(JSON.stringify({pid:process.pid,value:readFileSync(process.env.DURABLE_FILE,'utf8')}))).listen(Number(process.env.APP_PORT),'127.0.0.1');`,
          );
          const owner = new AbortController();
          const supervisor = createManagedRuntimeSupervisor({
            identity,
            expiresAt: Date.now() + 60_000,
            ownershipSignal: owner.signal,
            assertCurrent,
            launchSameEnvironment: createManagedOwnedChildLauncher({
              executable: process.execPath,
              args: [childScript],
              cwd: fixture,
              appEnvironment: { APP_PORT: String(appPort), DURABLE_FILE: durableFile },
            }),
            observeReadiness: async () => {
              await vi.waitFor(
                async () => {
                  // react-doctor-disable-next-line react-doctor/no-fetch-response-used-without-status-check -- This test asserts status 200 before consuming the response.
                  const response = await fetch(`http://127.0.0.1:${appPort}`, {
                    headers: { connection: "close" },
                  });
                  expect(response.status).toBe(200);
                  await response.text();
                },
                { interval: 25, timeout: 3000 },
              );
              return true;
            },
          });
          const ipc = await startManagedRuntimeIpc({
            supervisor,
            lifecycleSha256: managedCapabilitySha256(capabilities.lifecycle),
          });
          const client = createManagedRuntimeIpcClient({
            socketPath: ipc.socketPath,
            lifecycleCapability: capabilities.lifecycle,
          });
          const bridge = createManagedRuntimeBridge({
            identity,
            profile: managedRuntimePublicProfileSchema.parse({
              appId: identity.appId,
              jwksUrl: "https://gateway.example/_platform/jwks.json",
              keys: [
                {
                  ...generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }),
                  kid: "fixture",
                  alg: "EdDSA",
                  use: "sig",
                },
              ],
              publicOrigin: "https://gateway.example",
              version: 1,
            }),
            transportSha256: managedCapabilitySha256(capabilities.transport),
            actors: preparedPlan.access.map(({ actorId, organizationId }) => ({
              actorId,
              organizationId,
            })),
            appPort,
            expiresAt: Date.now() + 60_000,
            ownershipSignal: owner.signal,
            readCurrent: async () => {
              await assertCurrent();
              return current;
            },
            verification: {
              createVerification: () => ({}),
              verifyRequest: async ({ headers }) => {
                if (headers.get("x-platform-principal") !== "controlled-valid-principal") {
                  throw new Error("Principal denied");
                }
                return { sub: "actor-one" };
              },
            },
          });
          try {
            const bridgePort = await listen(bridge.server);
            const invalid = createManagedRuntimeIpcClient({
              lifecycleCapability: "invalid",
              socketPath: ipc.socketPath,
            });
            await expect(invalid.execute({ operation: "status" })).rejects.toThrow();
            await client.execute({ commandId: randomUUID(), operation: "start-same-environment" });
            const before = await client.execute({
              commandId: randomUUID(),
              operation: "observe-readiness",
            });
            expect(before.state).toBe("ready");
            // react-doctor-disable-next-line react-doctor/no-fetch-response-used-without-status-check -- This test asserts the expected denial status before consuming the response.
            const denied = await fetch(`http://127.0.0.1:${bridgePort}`, {
              headers: { connection: "close" },
            });
            expect(denied.status).toBeGreaterThanOrEqual(400);
            await denied.text();
            const readThroughBridge = async () => {
              // react-doctor-disable-next-line react-doctor/no-fetch-response-used-without-status-check -- This test asserts status 200 before consuming the response.
              const response = await fetch(`http://127.0.0.1:${bridgePort}`, {
                headers: {
                  authorization: `Bearer ${capabilities.transport}`,
                  "x-platform-principal": "controlled-valid-principal",
                  "x-platform-managed-suite": capabilities.suiteSelector,
                  connection: "close",
                },
              });
              expect(response.status).toBe(200);
              return await response.text();
            };
            expect(await readThroughBridge()).toContain('"value":"preserved-value"');
            const stopped = await client.execute({
              commandId: randomUUID(),
              operation: "stop-and-wait",
            });
            expect(stopped.state).toBe("stopped");
            if (!before.process) {
              throw new Error("Missing owned child");
            }
            const oldPid = before.process.pid;
            expect(() => process.kill(oldPid, 0)).toThrow();
            await expect(fetch(`http://127.0.0.1:${appPort}`)).rejects.toThrow();
            await client.execute({ commandId: randomUUID(), operation: "start-same-environment" });
            const after = await client.execute({
              commandId: randomUUID(),
              operation: "observe-readiness",
            });
            expect(after.state).toBe("ready");
            expect(after.process?.generation).toBe(2);
            expect(after.process?.pid).not.toBe(before.process.pid);
            expect(await readThroughBridge()).toContain('"value":"preserved-value"');
          } finally {
            await bridge.close();
            await ipc.close();
            await supervisor.close();
          }
          return { exitCode: 0, stderr: "", stdout: "focused managed scenario completed" };
        },
      },
    });
    expect(result).toMatchObject({ status: "passed" });
    return { exitCode: result.exitCode ?? 1 };
  };
};
