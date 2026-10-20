/* oxlint-disable eslint/require-await -- Controlled asynchronous ports exercise the real service, dispatcher and client without providers. */
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createLocalJWKSet, SignJWT } from "jose";
import { expect, it } from "vitest";
import {
  createHostedOperatorClient,
  HostedOperatorTransportUnknown,
} from "./hosted-operator-client";
import { createProtectedHostedOperatorHandler } from "./hosted-operator-service";
import type {
  HostedOperatorContext,
  ProtectedHostedOperatorDependencies,
} from "./hosted-operator-service";
import {
  hostedOperatorPlanSchema,
  HostedOperatorError,
  sameOperatorSelection,
} from "./hosted-operator-contract";
import { createHostedContinuityOperations } from "./hosted-operator-continuity";
import type { HostedContinuityDependencies } from "./hosted-operator-continuity";
import {
  createContinuityDispatcher,
  continuityTransportRequestSchema,
} from "./hosted-operator-continuity-transport";
import {
  continuityRecordSchema,
  continuityPlanDigest,
} from "./hosted-operator-continuity-contract";
import type { ContinuityRecord, ContinuityApproval } from "./hosted-operator-continuity-contract";
import { createContinuityCapabilityCustody } from "./hosted-operator-continuity-custody";
import { createOperatorWorkloadVerifier } from "./hosted-operator-workload";

const authority = {
  issuer: "https://builder.fixture.test/api/auth",
  audience: "https://builder.fixture.test/mcp",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const target = {
  appId: "orchard",
  sessionId: "session",
  branch: "feature",
  environment: "preview" as const,
  projectId: "prj_app",
  installationId: "installation",
  scopeId: "team",
  scopeType: "team" as const,
};
const context: HostedOperatorContext = { authority, target };
const gateway = {
  projectId: "prj_gateway",
  ownerId: "team",
  environment: "preview" as const,
  publicOrigin: "https://gateway.fixture.test",
};
const sha = "a".repeat(40);
const preparedPlan = hostedOperatorPlanSchema.parse({
  version: 1,
  action: "prepare",
  contextId: "accepted-spec",
  selection: {
    appId: target.appId,
    sessionId: target.sessionId,
    branch: target.branch,
    environment: target.environment,
    projectId: target.projectId,
  },
  access: [{ actorId: "actor", organizationId: "org", roles: ["ordinary_role"] }],
  appDatabase: {
    database: "app",
    migratorRole: "app_owner",
    resourceId: "app",
    runtimeRole: "app_runtime",
  },
  authDatabase: {
    database: "auth",
    migratorRole: "auth_owner",
    resourceId: "auth",
    runtimeRole: "auth_runtime",
  },
  cost: { class: "shared-recovery-group", description: "Approved managed journey", owner: "owner" },
  installer: { reference: "worker", sha256: "b".repeat(64) },
  neon: {
    branchId: "branch",
    connectionRef: "private",
    endpoint: "ep-fixture.neon.tech",
    projectId: "project",
    source: "synthetic-only",
  },
  release: { artifactRef: "private-release", id: "release", sha256: "c".repeat(64) },
  retention: { expiresAt: "2099-01-01T00:00:00Z", policy: "owned cleanup" },
  publicGateway: {
    projectId: gateway.projectId,
    branch: "gateway-main",
    origin: gateway.publicOrigin,
  },
  gatewayDelivery: {
    projectId: gateway.projectId,
    branch: "gateway-main",
    repoId: "gateway-repo",
    gitSha: sha,
  },
  delivery: { projectId: target.projectId, branch: target.branch, repoId: "app-repo", gitSha: sha },
  deploymentBoundary: {
    authority,
    teamId: "team",
    app: { projectId: target.projectId, branch: target.branch, environment: "preview" },
    gateway: { projectId: gateway.projectId, branch: "gateway-main", environment: "preview" },
    operator: { projectId: "prj_operator", deploymentId: "dpl_operator", environment: "preview" },
    verification: {
      gatewayOrigin: gateway.publicOrigin,
      publicOrigin: gateway.publicOrigin,
      jwksUrl: `${gateway.publicOrigin}/_platform/jwks.json`,
    },
  },
  effects: [
    { id: "resources", kind: "resources", description: "resources" },
    { id: "install", kind: "install", description: "install" },
    { id: "access", kind: "access", description: "access" },
    { id: "bindings", kind: "bindings", description: "bindings" },
    { id: "delivery", kind: "delivery", description: "delivery" },
    {
      id: "gateway-delivery",
      kind: "gateway-delivery",
      description: "Deliver approved managed route",
    },
  ],
});
const ownerContext = {
  adapterGeneration: 1,
  adapterSessionId: "adapter",
  authority,
  kind: "direct" as const,
  principal: { ...authority, scopes: ["autograph:send"] },
  sessionId: target.sessionId,
};
const logicalRuntime = { sandboxId: "sandbox", root: "/owned/source" };
const workloadPolicy = {
  issuer: "https://oidc.vercel.com/fixture-team",
  audience: "https://vercel.com/fixture-team",
  subject: "owner:fixture-team:project:builder:environment:production",
  ownerId: "team",
  projectId: "prj_builder",
  environment: "production" as const,
};
const signing = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = {
  ...signing.publicKey.export({ format: "jwk" }),
  kid: "fixture",
  alg: "RS256",
  use: "sig",
};
const verifyWorkload = createOperatorWorkloadVerifier(
  workloadPolicy,
  createLocalJWKSet({ keys: [publicJwk] }),
);
const signedWorkload = () =>
  new SignJWT({
    owner_id: workloadPolicy.ownerId,
    project_id: workloadPolicy.projectId,
    environment: workloadPolicy.environment,
  })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(workloadPolicy.issuer)
    .setAudience(workloadPolicy.audience)
    .setSubject(workloadPolicy.subject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .setJti(randomUUID())
    .sign(signing.privateKey);
const required = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("Missing controlled continuity fixture value");
  }
  return value;
};
const rejectUnexpected = async () => {
  throw new Error("Ordinary preparation must not execute during continuity");
};

const setup = () => {
  let record: ContinuityRecord | undefined;
  let approved = false;
  let originalApproved = true;
  let owner = true;
  let held = false;
  let live = false;
  let incoming: Request | undefined;
  const receipts = new Map<string, ContinuityApproval>();
  const custody = createContinuityCapabilityCustody({
    tokenKey: randomBytes(32),
    tokenKeyVersion: "fixture-v1",
  });
  const requests: string[] = [];
  const bound: string[] = [];
  const stats = {
    storeReads: 0,
    reservations: 0,
    authorizations: 0,
    readAuthorizations: 0,
    starts: 0,
    publishes: 0,
    suiteDispatches: 0,
    suiteInspections: 0,
    closes: 0,
    revokes: 0,
    requests,
    bound,
  };
  const faults = {
    mutateCarrier: false,
    loseExecuteResponse: false,
    loseSuiteResult: false,
    invalidToken: false,
  };
  const bindings = new WeakMap<
    HostedOperatorContext,
    { token: () => string; signal: AbortSignal }
  >();
  const snapshots: ContinuityRecord[] = [];
  const read = () => structuredClone(required(record));
  const assertOwner = async (ctx: HostedOperatorContext) => {
    if (
      !owner ||
      !isDeepStrictEqual(ctx.authority, authority) ||
      !isDeepStrictEqual(ctx.target, target) ||
      !isDeepStrictEqual(ctx.ownerContext, ownerContext)
    ) {
      throw new HostedOperatorError("authorization_required");
    }
    const binding = bindings.get(ctx);
    if (binding === undefined) {
      throw new HostedOperatorError("authorization_required");
    }
    expect(binding.token()).not.toBe("changed-after-verification");
  };
  const dependencies: HostedContinuityDependencies = {
    store: {
      async read(input) {
        stats.storeReads += 1;
        if (
          record === undefined ||
          record.requestId !== input.intentId ||
          !isDeepStrictEqual(record.plan.authority, input.authority)
        ) {
          // oxlint-disable-next-line unicorn/no-useless-undefined -- Missing rows and CAS conflicts are explicit optional store results.
          return undefined;
        }
        return read();
      },
      async reserve(input) {
        if (record !== undefined) {
          throw new Error("Duplicate controlled reserve");
        }
        stats.reservations += 1;
        record = continuityRecordSchema.parse(input.record);
        snapshots.push(read());
        return read();
      },
      async compareAndSet(input) {
        if (record?.revision !== input.expectedRevision) {
          // oxlint-disable-next-line unicorn/no-useless-undefined -- Missing rows and CAS conflicts are explicit optional store results.
          return undefined;
        }
        record = continuityRecordSchema.parse(input.record);
        snapshots.push(read());
        return read();
      },
    },
    assertOwner,
    async resolvePlan(ctx, runtime) {
      await assertOwner(ctx);
      expect(runtime).toEqual(logicalRuntime);
      return {
        version: 1,
        kind: "app-continuity-plan",
        authority,
        target,
        originalSetup: {
          operationRef: "40000000-0000-4000-8000-000000000004",
          planDigest: "d".repeat(64),
          approvalId: "original-approved",
          approvedByCallId: "original-call",
        },
        preparedPlan,
        runtime: {
          ...runtime,
          projectId: "prj_builder",
          ownerId: "team",
          appPort: 3000,
          bridgePort: 3443,
        },
        gateway,
        actors: [{ actorId: "actor", organizationId: "org" }],
      };
    },
    async assertSetup(ctx, plan) {
      await assertOwner(ctx);
      if (
        !originalApproved ||
        !isDeepStrictEqual(plan.preparedPlan.release, preparedPlan.release) ||
        plan.originalSetup.approvalId !== "original-approved"
      ) {
        throw new HostedOperatorError("authorization_required");
      }
    },
    async readApproval(ctx, request, callId) {
      await assertOwner(ctx);
      if (!approved) {
        return null;
      }
      const receipt = {
        ...request,
        approvalId: "continuity-approved",
        approvedByCallId: callId ?? "approval-call",
      };
      receipts.set(request.planDigest, receipt);
      return receipt;
    },
    ...custody,
    async withResourceLease(input, run) {
      if (held) {
        throw new HostedOperatorError("operation_in_progress");
      }
      held = true;
      try {
        await input.initializeUnderLock?.();
        const fence = await input.readCurrentFence();
        return await run(async () => {
          expect(await input.readCurrentFence()).toEqual(fence);
        });
      } finally {
        held = false;
      }
    },
    runtime: {
      async start(ctx, current, capabilities, assertCurrent, checkpoint) {
        await assertOwner(ctx);
        await assertCurrent();
        if (live) {
          throw new Error("Duplicate owned start");
        }
        stats.starts += 1;
        live = true;
        expect(custody.unseal(current)).toEqual(capabilities);
        expect(receipts.has(current.planDigest)).toBe(true);
        const ownerScope = { ...authority, sessionId: target.sessionId };
        const provider = {
          projectId: current.plan.runtime.projectId,
          ownerId: current.plan.runtime.ownerId,
          sandboxId: logicalRuntime.sandboxId,
          providerSessionId: "observed-provider-session",
          origin: "https://managed.fixture.test",
          bridgePort: current.plan.runtime.bridgePort,
        };
        const identity = {
          intentId: current.requestId,
          approvalRef: required(current.approval).approvalId,
          owner: ownerScope,
          appId: target.appId,
          runtimeAttemptId: required(current.attemptId),
          fence: current.fence,
          sandboxId: provider.sandboxId,
          providerSessionId: provider.providerSessionId,
        };
        await checkpoint({
          locator: {
            ...logicalRuntime,
            providerSessionId: provider.providerSessionId,
            commandId: "owned-command",
            worker: {
              id: "managed-app-runtime-v1",
              executablePath: "/opt/worker",
              sha256: "e".repeat(64),
              operationScope: "managed-app-runtime-v1",
              subcommand: "protected-managed-app-runtime",
            },
            attemptId: identity.runtimeAttemptId,
            rootDirectory: "/private/attempt",
          },
          current: { ...identity, state: "ready", leaseExpiresAt: "2099-01-01T00:00:00Z" },
        });
      },
      async runSuite(ctx, current, capabilities, assertCurrent, checkpoint, allowDispatch) {
        await assertOwner(ctx);
        await assertCurrent();
        expect(custody.unseal(current)).toEqual(capabilities);
        if (allowDispatch) {
          if (!live) {
            throw new Error("Suite dispatched without live owned runtime");
          }
          stats.suiteDispatches += 1;
          await checkpoint("suite-command");
        } else {
          stats.suiteInspections += 1;
          if (current.suiteCommandId !== "suite-command") {
            throw new HostedOperatorError("reconciliation_required");
          }
        }
        if (faults.loseSuiteResult) {
          faults.loseSuiteResult = false;
          throw new Error("Controlled terminal observation unavailable");
        }
        return { exitCode: 0 };
      },
      async close(ctx) {
        await assertOwner(ctx);
        stats.closes += 1;
        live = false;
      },
      async renew(ctx) {
        await assertOwner(ctx);
        if (!live) {
          throw new Error("Renewed closed owned runtime");
        }
      },
    },
    projection: {
      async publish(ctx, current, _capabilities, assertCurrent, checkpoint) {
        await assertOwner(ctx);
        await assertCurrent();
        if (!live || current.current?.state !== "ready") {
          throw new Error("Published without owned ready runtime");
        }
        stats.publishes += 1;
        await checkpoint({ deliveryAttempted: true });
      },
      async revoke(ctx, _current, assertCurrent, checkpoint) {
        await assertOwner(ctx);
        await assertCurrent();
        if (live) {
          throw new Error("Revoked before owned runtime closed");
        }
        stats.revokes += 1;
        await checkpoint([]);
      },
    },
  };
  const operations = createHostedContinuityOperations(dependencies);
  const authorize: ProtectedHostedOperatorDependencies["authorize"] = async (
    request,
    selection,
    hint,
  ) => {
    stats.authorizations += 1;
    await verifyWorkload(request);
    if (
      !owner ||
      !sameOperatorSelection(selection, preparedPlan.selection) ||
      !isDeepStrictEqual(hint, ownerContext)
    ) {
      throw new HostedOperatorError("authorization_required");
    }
    return { ...context, ownerContext };
  };
  const dispatcher = createContinuityDispatcher({
    store: dependencies.store,
    operations,
    verifyWorkload: async (request) => {
      await verifyWorkload(request);
      if (faults.mutateCarrier) {
        incoming?.headers.set("authorization", "Bearer changed-after-verification");
      }
    },
    authorize,
    authorizeRead: async (request, ctx) => {
      stats.readAuthorizations += 1;
      await verifyWorkload(request);
      if (
        !owner ||
        !isDeepStrictEqual(ctx.authority, authority) ||
        !isDeepStrictEqual(ctx.ownerContext, ownerContext)
      ) {
        throw new HostedOperatorError("authorization_required");
      }
      return ctx;
    },
    bindWorkload: (ctx, token, signal) => {
      bindings.set(ctx, { token, signal });
      stats.bound.push(token());
    },
  });
  const handler = createProtectedHostedOperatorHandler({
    authorize,
    assertAuthorized: rejectUnexpected,
    plan: rejectUnexpected,
    readApproval: rejectUnexpected,
    withResourceLease: rejectUnexpected,
    reconcile: rejectUnexpected,
    executeEffect: rejectUnexpected,
    verify: rejectUnexpected,
    bindings: rejectUnexpected,
    store: {
      read: rejectUnexpected,
      reserve: rejectUnexpected,
      compareAndSet: rejectUnexpected,
      reserveFenceGeneration: rejectUnexpected,
    },
    continuityRequest: dispatcher,
  });
  const transport: typeof fetch = async (url, init) => {
    expect(init).toHaveProperty("dispatcher");
    expect(init?.redirect).toBe("error");
    const outgoing = new Request(url instanceof Request ? url.url : url, init);
    incoming = outgoing;
    const action = continuityTransportRequestSchema.parse(await outgoing.clone().json());
    stats.requests.push(action.action);
    const response = await handler(outgoing);
    if (action.action === "continuity" && faults.loseExecuteResponse) {
      faults.loseExecuteResponse = false;
      throw new TypeError("Controlled response lost after server completion");
    }
    return response;
  };
  const tokens: string[] = [];
  const clientFor = (hint = ownerContext) =>
    createHostedOperatorClient({
      endpoint: "https://operator.fixture.test",
      ownerContext: hint,
      sessionId: target.sessionId,
      fetch: transport,
      token: async () => {
        const token = faults.invalidToken ? "invalid-signature" : await signedWorkload();
        tokens.push(token);
        return token;
      },
    });
  return {
    client: clientFor(),
    clientFor,
    handler,
    stats,
    faults,
    tokens,
    snapshots,
    dependencies,
    custody,
    get record() {
      return read();
    },
    get live() {
      return live;
    },
    approve() {
      approved = true;
    },
    setOwner(value: boolean) {
      owner = value;
    },
    revokeOriginal() {
      originalApproved = false;
    },
  };
};

it("uses the real client/handler/dispatcher/service through exact approval and closes before revocation", async () => {
  const f = setup();
  const planned = await f.client.planContinuity(preparedPlan.selection, logicalRuntime, "journey");
  expect(planned.status.state).toBe("planned");
  expect(f.stats.starts).toBe(0);
  expect(f.stats.publishes).toBe(0);
  expect(await f.client.continuityApproval(planned.request)).toEqual({ approved: false });
  await expect(f.client.runContinuity(planned.request, "execute-call")).rejects.toMatchObject({
    code: "authorization_required",
  });
  expect(f.stats.starts).toBe(0);
  f.approve();
  expect(await f.client.continuityApproval(planned.request)).toEqual({ approved: true });
  const outcome = await f.client.runContinuity(planned.request, "execute-call");
  expect(outcome.state).toBe("settled");
  expect(outcome.outcome?.exitCode).toBe(0);
  expect(outcome.runtime?.state).toBe("revoked");
  expect(f.stats.starts).toBe(1);
  expect(f.stats.publishes).toBe(1);
  expect(f.stats.suiteDispatches).toBe(1);
  expect(f.stats.revokes).toBe(1);
  expect(f.live).toBe(false);
  const counts = {
    starts: f.stats.starts,
    publishes: f.stats.publishes,
    suite: f.stats.suiteDispatches,
  };
  const status = await f.client.continuityStatus(planned.plan.intentId);
  expect(status.state).toBe("settled");
  await f.client.runContinuity(planned.request, "execute-call");
  expect({
    starts: f.stats.starts,
    publishes: f.stats.publishes,
    suite: f.stats.suiteDispatches,
  }).toEqual(counts);
  expect(f.record.plan.originalSetup).toEqual(planned.plan.originalSetup);
  expect(f.record.plan.preparedPlan.release).toEqual(preparedPlan.release);
  expect(f.record.planDigest).toBe(continuityPlanDigest(planned.plan));
});

it("rejects missing or invalid signed workload before any private hint lookup", async () => {
  const f = setup();
  f.faults.invalidToken = true;
  await expect(f.client.continuityStatus(randomUUID())).rejects.toMatchObject({
    code: "authorization_required",
  });
  expect(f.stats.storeReads).toBe(0);
  expect(f.stats.starts).toBe(0);
  const response = await f.handler(
    new Request("https://operator.fixture.test/v1/runtime", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "continuity-status", intentId: randomUUID(), ownerContext }),
    }),
  );
  expect(await response.json()).toMatchObject({
    code: "authorization_required",
    status: "blocked",
  });
  expect(f.stats.storeReads).toBe(0);
});

it("rejects a changed canonical owner and mismatched approval request before runtime or publication effects", async () => {
  const f = setup();
  const altered = structuredClone(ownerContext);
  altered.authority.ownerUserId = "different-owner";
  altered.principal.ownerUserId = "different-owner";
  await expect(
    f.clientFor(altered).planContinuity(preparedPlan.selection, logicalRuntime, "foreign"),
  ).rejects.toMatchObject({ code: "authorization_required" });
  expect(f.stats.reservations).toBe(0);
  const planned = await f.client.planContinuity(preparedPlan.selection, logicalRuntime, "journey");
  f.approve();
  await expect(
    f.client.runContinuity({ ...planned.request, planDigest: "f".repeat(64) }, "execute-call"),
  ).rejects.toMatchObject({ code: "resource_mismatch" });
  f.setOwner(false);
  await expect(f.client.runContinuity(planned.request, "execute-call")).rejects.toMatchObject({
    code: "authorization_required",
  });
  expect(f.stats.starts).toBe(0);
  expect(f.stats.publishes).toBe(0);
});

it("keeps GET and continuity status read-only and rechecks original setup authority before execution", async () => {
  const f = setup();
  const planned = await f.client.planContinuity(preparedPlan.selection, logicalRuntime, "journey");
  const before = f.stats.storeReads;
  const response = await f.handler(new Request("https://operator.fixture.test/v1/runtime"));
  expect(response.status).toBe(404);
  expect(f.stats.storeReads).toBe(before);
  const status = await f.client.continuityStatus(planned.plan.intentId);
  expect(status.state).toBe("planned");
  expect(f.stats.readAuthorizations).toBe(1);
  expect(f.stats.starts).toBe(0);
  expect(f.stats.publishes).toBe(0);
  f.approve();
  f.revokeOriginal();
  await expect(f.client.runContinuity(planned.request, "execute-call")).rejects.toMatchObject({
    code: "authorization_required",
  });
  expect(f.stats.starts).toBe(0);
});

it("retains the exact cryptographically verified carrier in the bound request closure across header mutation", async () => {
  const f = setup();
  f.faults.mutateCarrier = true;
  const planned = await f.client.planContinuity(preparedPlan.selection, logicalRuntime, "journey");
  expect(f.stats.bound).toEqual(f.tokens);
  f.approve();
  await f.client.runContinuity(planned.request, "execute-call");
  expect(f.stats.bound).toEqual(f.tokens);
  expect(f.stats.bound).not.toContain("changed-after-verification");
  expect(f.stats.starts).toBe(1);
});

it("treats a lost execute response as unknown and observes completion without automatic redispatch", async () => {
  const f = setup();
  const planned = await f.client.planContinuity(preparedPlan.selection, logicalRuntime, "journey");
  f.approve();
  f.faults.loseExecuteResponse = true;
  await expect(f.client.runContinuity(planned.request, "execute-call")).rejects.toBeInstanceOf(
    HostedOperatorTransportUnknown,
  );
  expect(f.stats.requests.filter((action) => action === "continuity")).toHaveLength(1);
  expect(f.stats.suiteDispatches).toBe(1);
  expect(f.live).toBe(false);
  const status = await f.client.continuityStatus(planned.plan.intentId);
  expect(status.state).toBe("settled");
  expect(f.stats.starts).toBe(1);
  expect(f.stats.publishes).toBe(1);
  await f.client.runContinuity(planned.request, "execute-call");
  expect(f.stats.suiteDispatches).toBe(1);
});

it("closes on an uncertain suite observation and reconciles its retained command without redispatch", async () => {
  const f = setup();
  const planned = await f.client.planContinuity(preparedPlan.selection, logicalRuntime, "journey");
  f.approve();
  f.faults.loseSuiteResult = true;
  await expect(f.client.runContinuity(planned.request, "execute-call")).rejects.toMatchObject({
    code: "reconciliation_required",
  });
  expect(f.live).toBe(false);
  expect(f.record.state).toBe("reconciliation-required");
  expect(f.record.suiteDispatched).toBe(true);
  const reconciled = await f.client.runContinuity(planned.request, "execute-call");
  expect(reconciled.state).toBe("settled");
  expect(f.stats.starts).toBe(1);
  expect(f.stats.publishes).toBe(1);
  expect(f.stats.suiteDispatches).toBe(1);
  expect(f.stats.suiteInspections).toBe(1);
});

it("uses actual private capability custody bound to owner, session, attempt and fence without journaling plaintext", async () => {
  const f = setup();
  const planned = await f.client.planContinuity(preparedPlan.selection, logicalRuntime, "journey");
  f.approve();
  await f.client.runContinuity(planned.request, "execute-call");
  const current = f.record;
  const capabilities = f.custody.unseal(current);
  const encoded = JSON.stringify(f.snapshots);
  for (const value of Object.values(capabilities)) {
    expect(encoded).not.toContain(value);
  }
  for (const change of [
    (r: ContinuityRecord) => {
      r.plan.authority.ownerUserId = "other-owner";
    },
    (r: ContinuityRecord) => {
      r.plan.target.sessionId = "other-session";
    },
    (r: ContinuityRecord) => {
      r.attemptId = randomUUID();
    },
    (r: ContinuityRecord) => {
      r.fence += 1;
    },
  ]) {
    const altered = structuredClone(current);
    change(altered);
    expect(() => f.custody.unseal(altered)).toThrow();
  }
});
