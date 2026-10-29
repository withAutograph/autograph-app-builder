import { createParticipantSuccessorPlan } from "./hosted-operator-participant-successor";
/* oxlint-disable eslint/require-await -- In-memory service authority ports resolve immediately and perform no provider or database calls. */
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { createHostedOperatorClient } from "./hosted-operator-client";
import { createProtectedHostedOperatorHandler } from "./hosted-operator-service";
import type { ProtectedHostedOperatorDependencies } from "./hosted-operator-service";
import {
  HostedOperatorError,
  hostedOperatorPlanSchema,
  operatorPlanDigest,
} from "./hosted-operator-contract";
import type { OperatorSelection } from "./hosted-operator-contract";
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import type { HostedRuntimeJournalRow, HostedRuntimeJournalStore } from "./hosted-runtime-journal";
import {
  initialNormalActorState,
  normalActorProgramDigest,
  normalActorProgramSchema,
} from "./hosted-operator-normal-actor-program";
import type { NormalActorAccountPreparation } from "./hosted-operator-normal-actor-journal";
import { createNormalActorJournalAuthority } from "./hosted-operator-normal-actor-authority";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const selection: OperatorSelection = {
  appId: "spend-review",
  branch: "preview",
  environment: "preview",
  projectId: "prj_fixture",
  sessionId: "session_fixture",
};
const ownerContext = {
  adapterGeneration: 1,
  adapterSessionId: "adapter-session",
  authority,
  kind: "direct" as const,
  principal: { ...authority, scopes: ["autograph:send"] },
  sessionId: selection.sessionId,
};
const target = {
  ...selection,
  installationId: "icfg_fixture",
  scopeId: "team_fixture",
  scopeType: "team" as const,
};
const plan = hostedOperatorPlanSchema.parse({
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
    authority,
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
  release: { artifactRef: "verified-artifact", id: "release_fixture", sha256: "b".repeat(64) },
  retention: {
    expiresAt: "2027-01-01T00:00:00.000Z",
    policy: "Retain while context consumers exist",
  },
  selection,
  version: 1,
});
const proof = {
  actors: 2,
  artifactHash: "c".repeat(64),
  authenticatedBehavior: "unassessed" as const,
  manifestSha256: plan.release.sha256,
  releaseId: plan.release.id,
  tenants: 2,
};
const appBoundary = {
  appId: selection.appId,
  mode: "protected-gateway-v1",
  runtime: {
    database: plan.appDatabase.database,
    environment: "hosted",
    hostname: plan.neon.endpoint,
    port: 5432,
    runtimeRole: plan.appDatabase.runtimeRole,
  },
  verification: {
    jwksUrl: plan.deploymentBoundary?.verification.jwksUrl,
    publicOrigin: plan.deploymentBoundary?.verification.publicOrigin,
  },
  version: 1,
};
const environment = {
  PLATFORM_APP_BOUNDARY: JSON.stringify(appBoundary),
  PLATFORM_JWKS_URL: "https://gateway-preview.example.test/_platform/jwks.json",
  PLATFORM_ORIGIN: "https://gateway-preview.example.test",
  PLATFORM_PUBLIC_ORIGIN: "https://apps-preview.example.test",
  SPEND_REVIEW_DATABASE_URL: `postgres://spend_runtime:synthetic-app@${plan.neon.endpoint}/spend?sslmode=verify-full`,
};

const fixture = () => {
  let row: HostedRuntimeJournalRow | undefined;
  let member = true;
  let approved = false;
  let uncertain = false;
  let fence = true;
  let nextFenceGeneration = 0;
  const applied = new Map<
    string,
    { effectId: string; fenceGeneration: number; observedAt: string; resourceVersion: string }
  >();
  const store: HostedRuntimeJournalStore = {
    async compareAndSet(input) {
      if (row?.revision !== input.expectedRevision) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- CAS failure is the explicit optional-row return contract.
        return undefined;
      }
      row = {
        record: hostedRuntimeJournalRecordSchema.parse(input.record),
        revision: input.expectedRevision + 1,
      };
      return structuredClone(row);
    },
    async read() {
      return row ? structuredClone(row) : undefined;
    },
    async reserve(input) {
      row ??= {
        record: hostedRuntimeJournalRecordSchema.parse({
          approvedByCallId: input.approvedByCallId,
          kind: "app-runtime",
          operator: input.operator,
          request: input.target,
          status: "pending",
          step: "reserved",
          version: 1,
        }),
        revision: 1,
      };
      return structuredClone(row);
    },
    async reserveFenceGeneration(input) {
      if (row === undefined) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- The journal CAS reports no allocated row.
        return undefined;
      }
      if (
        row.revision !== input.expectedRevision ||
        row.record.leaseId !== input.leaseId ||
        row.record.operator?.operationRef !== input.operationRef ||
        row.record.operator.fenceGeneration !== undefined
      ) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- A stale CAS must not allocate a generation.
        return undefined;
      }
      nextFenceGeneration += 1;
      const generation = nextFenceGeneration;
      row = {
        record: hostedRuntimeJournalRecordSchema.parse({
          ...row.record,
          operator: { ...row.record.operator, fenceGeneration: generation },
        }),
        revision: row.revision + 1,
      };
      return structuredClone(row);
    },
  };
  const deps: ProtectedHostedOperatorDependencies = {
    async assertAuthorized() {
      if (!member) {
        throw new HostedOperatorError("authorization_required");
      }
    },
    async authorize(request, selected) {
      if (
        request.headers.get("authorization") !== "Bearer fixture-service-identity" ||
        request.headers.get("x-vercel-trusted-oidc-idp-token") !== "fixture-service-identity" ||
        selected.sessionId !== selection.sessionId
      ) {
        throw new HostedOperatorError("authorization_required");
      }
      return { authority, target };
    },
    async bindings() {
      return environment;
    },
    executeEffect: vi.fn<ProtectedHostedOperatorDependencies["executeEffect"]>(async (input) => {
      await input.assertCurrent();
      await input.checkpoint({
        encryptedToken: "ciphertext",
        keyVersion: "key-v1",
        tokenIv: "iv",
        tokenTag: "tag",
      });
      const receipt = {
        effectId: input.effect.id,
        fenceGeneration: input.fenceGeneration,
        observedAt: new Date().toISOString(),
        resourceVersion: "provider-observed-v1",
      };
      applied.set(input.effect.id, receipt);
      return receipt;
    }),
    plan: vi.fn(async () => plan),
    async readApproval(input) {
      return approved
        ? {
            action: input.action,
            approvalId: "durable-human-decision",
            approved: true,
            callId: input.callId,
            planDigest: input.planDigest,
          }
        : null;
    },
    async reconcile(input) {
      if (uncertain) {
        return { status: "unknown" };
      }
      const receipt = applied.get(input.effect.id);
      return receipt ? { receipt, status: "applied" } : { status: "absent" };
    },
    store,
    async verify() {
      return proof;
    },
    async withResourceLease(_input, run) {
      return await run(async () => {
        if (!fence) {
          throw new HostedOperatorError("operation_in_progress");
        }
      });
    },
  };
  const handler = createProtectedHostedOperatorHandler(deps);
  const client = createHostedOperatorClient({
    endpoint: "https://operator.example",
    fetch: async (url, init) =>
      await handler(new Request(url instanceof Request ? url.url : url, init)),
    ownerContext,
    token: async () => "fixture-service-identity",
  });
  return {
    applied,
    approve() {
      approved = true;
    },
    client,
    deps,
    handler,
    known() {
      uncertain = false;
    },
    loseFence() {
      fence = false;
    },
    revoke() {
      member = false;
    },
    get row() {
      return row;
    },
    set row(value) {
      row = value;
    },
    unknown() {
      uncertain = true;
    },
  };
};
const prepared = async (f: ReturnType<typeof fixture>) => {
  const planned = await f.client.request({ action: "plan", operation: "prepare", selection });
  expect(planned.status).toBe("planned");
  return {
    action: "execute" as const,
    callId: "actual-eve-call",
    operationRef: z.uuid().parse(planned.operationRef),
    planDigest: z.string().parse(planned.planDigest),
    selection,
  };
};

const participantServiceFixture = () => {
  const f = fixture();
  const program = normalActorProgramSchema.parse({
    version: 1,
    appId: selection.appId,
    origin: plan.publicGateway?.origin,
    actors: [
      {
        actorKey: "owner",
        name: "Owner",
        email: "owner@example.test",
        account: "capture-existing",
      },
    ],
    organizations: [],
    memberships: [],
    appAccess: [],
  });
  const accountPlan = hostedOperatorPlanSchema.parse({
    ...plan,
    stage: "auth-participants",
    normalActorProgram: program,
    access: [],
    effects: [
      {
        id: "normal-accounts",
        kind: "normal-accounts",
        description: "Normal participant accounts only",
      },
    ],
  });
  f.deps.plan = vi.fn(async () => accountPlan);
  f.deps.ensureNormalActorCapture = vi.fn(async () => "ready" as const);
  f.deps.verify = vi.fn(async () => {
    throw new Error("App verification must not run for participants");
  });
  return { f, program, accountPlan };
};
const participantAccountCompletion = (
  fixtureInput: ReturnType<typeof participantServiceFixture>,
  operationRef: string,
) => {
  const { program, accountPlan } = fixtureInput;
  const state = initialNormalActorState(program, operationRef);
  state.actors[0] = {
    actorKey: "owner",
    signup: "complete",
    session: {
      reference: "00000000-0000-4000-8000-000000000099",
      actorId: "actual-normal-owner",
      realmSessionId: "actual-normal-session",
      origin: program.origin,
      expiresAt: "2027-01-01T00:00:00.000Z",
    },
    storageState: { cookies: [], origins: [] },
  };
  const preparation: NormalActorAccountPreparation = {
    program,
    programDigest: normalActorProgramDigest(program),
    accountOperationRef: operationRef,
    accountPlan,
    accountPlanDigest: operatorPlanDigest(accountPlan),
    accountApprovalId: "durable-human-decision",
    accountApprovedByCallId: "actual-eve-call",
    captures: [],
    accountsCompletedAt: "2026-10-14T12:00:00.000Z",
    sealedState: {
      encryptedToken: "private-normal-account-ciphertext",
      keyVersion: "fixture-key",
      tokenIv: "fixture-iv",
      tokenTag: "fixture-tag",
    },
  };
  return { state, preparation };
};

describe("participant preparation service branch", () => {
  it("passes the accepted participant program through the actual plan request", async () => {
    const { f, program } = participantServiceFixture();
    const result = await f.client.request({
      action: "plan",
      operation: "prepare",
      selection,
      normalActorProgram: program,
    });
    expect(result.status).toBe("planned");
    expect(f.deps.plan).toHaveBeenCalledWith(
      expect.objectContaining({ normalActorProgram: program }),
    );
  });
  it("completes participants before app verification and preserves the first approval and encryption scope on replan", async () => {
    const fixtureInput = participantServiceFixture();
    const { f, program } = fixtureInput;
    const execution = await prepared(f);
    const { state, preparation } = participantAccountCompletion(
      fixtureInput,
      execution.operationRef,
    );
    f.deps.executeEffect = vi.fn<ProtectedHostedOperatorDependencies["executeEffect"]>(
      async (input) => {
        if (input.checkpointAccountPreparation === undefined) {
          throw new Error("Missing account checkpoint");
        }
        await input.checkpointAccountPreparation(preparation);
        return {
          effectId: input.effect.id,
          observedAt: "2026-10-14T12:00:00.000Z",
          resourceVersion: "actual-account-readback",
        };
      },
    );
    f.deps.verifyNormalActorAccounts = vi.fn<
      NonNullable<ProtectedHostedOperatorDependencies["verifyNormalActorAccounts"]>
    >(async (input) => {
      await input.assertCurrent();
      return state;
    });
    f.approve();
    const result = await f.client.request(execution);
    expect(result.status).toBe("participants-prepared");
    expect(f.row?.record.status).toBe("participants-prepared");
    expect(f.deps.verify).not.toHaveBeenCalled();
    expect(f.row?.record.leaseId).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("private-normal-account-ciphertext");
    const original = structuredClone(f.row?.record.accountPreparation);
    const appPlan = hostedOperatorPlanSchema.parse({
      ...plan,
      access: [],
      stage: "app",
      normalActorProgram: program,
      normalActorPreparation: {
        accountOperationRef: preparation.accountOperationRef,
        programDigest: preparation.programDigest,
        accountPlanDigest: preparation.accountPlanDigest,
        accountApprovalId: preparation.accountApprovalId,
        accountApprovedByCallId: preparation.accountApprovedByCallId,
      },
    });
    f.deps.plan = vi.fn(async () => appPlan);
    const replanned = await f.client.request({ action: "plan", operation: "prepare", selection });
    expect(replanned.status).toBe("planned");
    expect(replanned.operationRef).not.toBe(execution.operationRef);
    expect(f.row?.record.accountPreparation).toEqual(original);
    expect(f.row?.record.accountPreparation?.accountOperationRef).toBe(execution.operationRef);
  });
  it("checkpoints verified account completion on resume without replaying a receipted account effect", async () => {
    const fixtureInput = participantServiceFixture();
    const { f } = fixtureInput;
    const execution = await prepared(f);
    const { state, preparation } = participantAccountCompletion(
      fixtureInput,
      execution.operationRef,
    );
    delete preparation.accountsCompletedAt;
    const originalReceipt = {
      effectId: "normal-accounts",
      fenceGeneration: 7,
      observedAt: "2026-10-14T12:00:00.000Z",
      resourceVersion: "original-verified-accounts",
    };
    if (f.row?.record.operator === undefined) {
      throw new Error("Missing approved participant operation");
    }
    f.row = {
      ...f.row,
      record: hostedRuntimeJournalRecordSchema.parse({
        ...f.row.record,
        approvedByCallId: execution.callId,
        accountPreparation: preparation,
        status: "participants-prepared",
        operator: {
          ...f.row.record.operator,
          approvalId: preparation.accountApprovalId,
          receipts: [originalReceipt],
        },
      }),
    };
    f.deps.verifyNormalActorAccounts = vi.fn<
      NonNullable<ProtectedHostedOperatorDependencies["verifyNormalActorAccounts"]>
    >(async (input) => {
      await input.assertCurrent();
      const current = await f.deps.store.read(input);
      if (current === undefined) {
        throw new Error("Missing leased account preparation");
      }
      const journalAuthority = createNormalActorJournalAuthority({
        store: f.deps.store,
        keyring: { tokenKey: Buffer.alloc(32, 1), tokenKeyVersion: "fixture-key" },
        now: Date.now,
        assertCanonicalOwner: async () => {
          await f.deps.assertAuthorized({ authority, target, plan: fixtureInput.accountPlan });
        },
        assertApprovedOwner: f.deps.assertAuthorized,
        readApproval: f.deps.readApproval,
      });
      await journalAuthority.assertMutationAuthority(input, current);
      await input.checkpointAccountPreparation({
        ...input.accountPreparation,
        accountsCompletedAt: "2026-10-14T12:05:00.000Z",
      });
      await input.assertCurrent();
      return state;
    });
    f.approve();

    const result = await f.client.request(execution);

    expect(result.status).toBe("participants-prepared");
    expect(f.row?.record.accountPreparation?.accountsCompletedAt).toBe("2026-10-14T12:05:00.000Z");
    expect(f.row?.record.accountPreparation?.accountOperationRef).toBe(execution.operationRef);
    expect(f.row?.record.accountPreparation?.accountApprovalId).toBe(preparation.accountApprovalId);
    expect(f.row?.record.accountPreparation?.programDigest).toBe(preparation.programDigest);
    expect(f.row?.record.operator?.receipts).toEqual([originalReceipt]);
    expect(f.row?.record.leaseId).toBeUndefined();
    expect(f.row?.record.operator?.pendingEffectId).toBeUndefined();
    expect(f.deps.executeEffect).not.toHaveBeenCalled();
    expect(f.deps.verify).not.toHaveBeenCalled();
  });
  it("requires capture after real approval and before leases, fences or pending account effects", async () => {
    const { f } = participantServiceFixture();
    const execution = await prepared(f);
    f.deps.ensureNormalActorCapture = vi.fn<
      NonNullable<ProtectedHostedOperatorDependencies["ensureNormalActorCapture"]>
    >(async () => "required");
    const unapproved = await f.client.request(execution);
    expect(unapproved.code).toBe("authorization_required");
    expect(f.deps.ensureNormalActorCapture).not.toHaveBeenCalled();
    f.approve();
    const result = await f.client.request(execution);
    expect(result.code).toBe("auth_identity_required");
    expect(f.row?.record.leaseId).toBeUndefined();
    expect(f.row?.record.operator?.fenceGeneration).toBeUndefined();
    expect(f.row?.record.operator?.pendingEffectId).toBeUndefined();
    expect(f.deps.executeEffect).not.toHaveBeenCalled();
  });
  it("does not report participant completion when current normal account readback is incomplete", async () => {
    const fixtureInput = participantServiceFixture();
    const { f, program } = fixtureInput;
    const execution = await prepared(f);
    const { preparation } = participantAccountCompletion(fixtureInput, execution.operationRef);
    f.deps.executeEffect = vi.fn<ProtectedHostedOperatorDependencies["executeEffect"]>(
      async (input) => {
        if (input.checkpointAccountPreparation === undefined) {
          throw new Error("Missing account checkpoint");
        }
        await input.checkpointAccountPreparation(preparation);
        return {
          effectId: input.effect.id,
          observedAt: "2026-10-14T12:00:00.000Z",
          resourceVersion: "actual-account-readback",
        };
      },
    );
    f.deps.verifyNormalActorAccounts = vi.fn(async () =>
      initialNormalActorState(program, execution.operationRef),
    );
    f.approve();
    const incomplete = await f.client.request(execution);
    expect(incomplete.code).toBe("reconciliation_required");
    expect(f.row?.record.status).toBe("pending");
    expect(f.deps.verify).not.toHaveBeenCalled();
  });
});

const requireFixture = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("missing fixture value");
  }
  return value;
};

const captureSuccessorFixture = () => {
  const current = participantServiceFixture();
  const completion = participantAccountCompletion(current, "11111111-1111-4111-8111-111111111111");
  const original = completion.preparation;
  const appPlan = hostedOperatorPlanSchema.parse({
    ...plan,
    stage: "app",
    access: [],
    normalActorProgram: original.program,
    normalActorPreparation: {
      accountOperationRef: original.accountOperationRef,
      programDigest: original.programDigest,
      accountPlanDigest: original.accountPlanDigest,
      accountApprovalId: original.accountApprovalId,
      accountApprovedByCallId: original.accountApprovedByCallId,
    },
  });
  current.f.row = {
    revision: 10,
    record: hostedRuntimeJournalRecordSchema.parse({
      version: 1,
      kind: "app-runtime",
      request: target,
      status: "prepared",
      step: "bound",
      approvedByCallId: "app-call",
      accountPreparation: original,
      proof,
      privateState: {
        encryptedToken: "original-resources",
        keyVersion: "fixture",
        tokenIv: "iv",
        tokenTag: "tag",
      },
      operator: {
        mode: "protected-operator-v1",
        operationRef: "22222222-2222-4222-8222-222222222222",
        plan: appPlan,
        planDigest: operatorPlanDigest(appPlan),
        approvalId: "durable-human-decision",
        fenceGeneration: 1,
        receipts: appPlan.effects.map((effect) => ({
          effectId: effect.id,
          observedAt: "2026-10-14T12:00:00.000Z",
          resourceVersion: "observed",
          ...(effect.kind === "access" ? { fenceGeneration: 1 } : {}),
        })),
      },
    }),
  };
  const qa = Array.from({ length: 7 }, (_, index) => ({
    actorKey: `qa-${index + 1}`,
    email: `qa${index + 1}@example.test`,
    name: `QA ${index + 1}`,
    account: "create-email-password",
  }));
  const nextProgram = normalActorProgramSchema.parse({
    ...original.program,
    actors: [...original.program.actors, ...qa],
    organizations: [
      { organizationId: "qa-one", name: "QA One", slug: "qa-one", ownerActorKey: "qa-1" },
      { organizationId: "qa-two", name: "QA Two", slug: "qa-two", ownerActorKey: "qa-4" },
    ],
    memberships: qa.map((actor, index) => ({
      actorKey: actor.actorKey,
      organizationId: index < 3 ? "qa-one" : "qa-two",
      role: [0, 3].includes(index) ? "owner" : "member",
    })),
    appAccess: qa.map((actor, index) => ({
      actorKey: actor.actorKey,
      organizationId: index < 3 ? "qa-one" : "qa-two",
      roles: ["member"],
    })),
  });
  const successor = createParticipantSuccessorPlan(current.f.row.record, nextProgram, Date.now());
  if (successor === undefined) {
    throw new Error("missing capture successor");
  }
  current.f.deps.plan = vi.fn(async () => successor);
  current.f.approve();
  return { ...current, successor, nextProgram };
};

describe("capture-only participant program successor", () => {
  it("proposes a separate approval while preserving completed capture and app evidence", async () => {
    const { f, successor, nextProgram } = captureSuccessorFixture();
    const before = structuredClone(requireFixture(f.row));
    const result = await f.client.request({
      action: "plan",
      operation: "prepare",
      selection,
      normalActorProgram: nextProgram,
    });
    expect(result.status).toBe("planned");
    expect(result.operationRef).not.toBe(before.record.operator?.operationRef);
    expect(f.row?.record.accountPreparation).toEqual(before.record.accountPreparation);
    expect(f.row?.record.privateState).toEqual(before.record.privateState);
    expect(f.row?.record.participantPreparationHistory).toEqual([
      {
        preparation: before.record.accountPreparation,
        operator: before.record.operator,
        approvedByCallId: before.record.approvedByCallId,
        proof: before.record.proof,
      },
    ]);
    expect(f.deps.ensureNormalActorCapture).not.toHaveBeenCalled();
    expect(f.deps.executeEffect).not.toHaveBeenCalled();
    expect(successor.access).toEqual([]);
    expect(successor.normalActorProgram?.actors).toHaveLength(8);
    expect(successor.normalActorProgram?.organizations).toHaveLength(2);
  });

  it.each([
    "original approval",
    "app approval",
    "owner",
    "lease",
    "pending effect",
    "pending attempt",
    "missing receipt",
    "resource",
    "original actor",
    "original membership",
  ] as const)("refuses successor planning with changed %s", async (changed) => {
    const { f, successor, nextProgram } = captureSuccessorFixture();
    if (changed === "owner") {
      f.revoke();
    }
    if (changed === "lease") {
      requireFixture(f.row).record.leaseId = "33333333-3333-4333-8333-333333333333";
    }
    if (changed === "pending effect") {
      requireFixture(requireFixture(f.row).record.operator).pendingEffectId = "bind";
    }
    if (changed === "pending attempt") {
      requireFixture(requireFixture(f.row).record.operator).pendingEffectAttempt = {
        id: "33333333-3333-4333-8333-333333333333",
      };
    }
    if (changed === "missing receipt") {
      requireFixture(requireFixture(f.row).record.operator).receipts = [];
    }
    if (changed === "resource") {
      f.deps.plan = vi.fn(async () =>
        hostedOperatorPlanSchema.parse({
          ...successor,
          appDatabase: { ...successor.appDatabase, database: "foreign" },
        }),
      );
    }
    if (changed === "original actor") {
      f.deps.plan = vi.fn(async () =>
        hostedOperatorPlanSchema.parse({
          ...successor,
          normalActorProgram: {
            ...nextProgram,
            actors: nextProgram.actors.map((actor) =>
              actor.actorKey === "owner" ? { ...actor, email: "foreign@example.test" } : actor,
            ),
          },
        }),
      );
    }
    if (changed === "original membership") {
      f.deps.plan = vi.fn(async () =>
        hostedOperatorPlanSchema.parse({
          ...successor,
          normalActorProgram: {
            ...nextProgram,
            memberships: [
              ...nextProgram.memberships,
              { actorKey: "owner", organizationId: "qa-one", role: "member" },
            ],
          },
        }),
      );
    }
    if (changed === "original approval" || changed === "app approval") {
      const prior = f.deps.readApproval;
      const deniedCall = changed === "original approval" ? "actual-eve-call" : "app-call";
      f.deps.readApproval = async (input) =>
        input.callId === deniedCall ? null : await prior(input);
    }
    const before = structuredClone(f.row);
    await expect(
      f.client.request({
        action: "plan",
        operation: "prepare",
        selection,
        normalActorProgram: nextProgram,
      }),
    ).resolves.toMatchObject({ status: "blocked" });
    expect(f.row).toEqual(before);
    expect(f.deps.ensureNormalActorCapture).not.toHaveBeenCalled();
  });

  it("plans the resolved app under the completed successor account approval and preserves original history", async () => {
    const { f, nextProgram, successor } = captureSuccessorFixture();
    const pending = await f.client.request({
      action: "plan",
      operation: "prepare",
      selection,
      normalActorProgram: nextProgram,
    });
    const record = requireFixture(f.row).record;
    const original = requireFixture(record.accountPreparation);
    const operation = z.uuid().parse(pending.operationRef);
    const preparation = {
      ...original,
      program: nextProgram,
      programDigest: normalActorProgramDigest(nextProgram),
      accountOperationRef: operation,
      accountPlan: successor,
      accountPlanDigest: operatorPlanDigest(successor),
      accountApprovalId: "durable-human-decision",
      accountApprovedByCallId: "successor-account-call",
      predecessor: successor.normalActorPredecessor,
    };
    record.accountPreparation = preparation;
    record.approvedByCallId = preparation.accountApprovedByCallId;
    record.status = "participants-prepared";
    requireFixture(record.operator).approvalId = preparation.accountApprovalId;
    requireFixture(record.operator).receipts = [
      {
        effectId: "normal-accounts",
        observedAt: "2026-10-20T00:00:00.000Z",
        resourceVersion: "verified-successor-accounts",
      },
    ];
    const appPlan = hostedOperatorPlanSchema.parse({
      ...plan,
      stage: "app",
      access: [],
      normalActorProgram: nextProgram,
      normalActorPreparation: {
        accountOperationRef: operation,
        accountPlanDigest: preparation.accountPlanDigest,
        programDigest: preparation.programDigest,
        accountApprovalId: preparation.accountApprovalId,
        accountApprovedByCallId: preparation.accountApprovedByCallId,
      },
    });
    f.deps.plan = vi.fn(async () => appPlan);
    const history = structuredClone(record.participantPreparationHistory);
    const proposed = await f.client.request({
      action: "plan",
      operation: "prepare",
      selection,
      normalActorProgram: nextProgram,
    });
    expect(proposed.status).toBe("planned");
    expect(proposed.operationRef).not.toBe(operation);
    expect(f.row?.record.accountPreparation).toEqual(preparation);
    expect(f.row?.record.operator?.plan.normalActorPreparation?.accountOperationRef).toBe(
      operation,
    );
    expect(f.row?.record.operator?.plan.normalActorPredecessor).toBeUndefined();
    expect(f.row?.record.participantPreparationHistory).toEqual(history);
    expect(f.deps.executeEffect).not.toHaveBeenCalled();
  });

  it.each(["unapproved", "cancelled"])(
    "does not switch account state for an %s proposal",
    async (outcome) => {
      const { f, nextProgram } = captureSuccessorFixture();
      const result = await f.client.request({
        action: "plan",
        operation: "prepare",
        selection,
        normalActorProgram: nextProgram,
      });
      const before = structuredClone(requireFixture(f.row).record.accountPreparation);
      f.deps.readApproval = async (input) =>
        outcome === "unapproved"
          ? null
          : {
              approved: false,
              action: input.action,
              callId: input.callId,
              planDigest: input.planDigest,
              approvalId: "cancelled-successor",
            };
      const executed = await f.client.request({
        action: "execute",
        callId: "successor-call",
        operationRef: z.uuid().parse(result.operationRef),
        planDigest: z.string().parse(result.planDigest),
        selection,
      });
      expect(executed.status).toBe("blocked");
      expect(executed.code).toBe("authorization_required");
      expect(f.row?.record.accountPreparation).toEqual(before);
      expect(f.deps.ensureNormalActorCapture).not.toHaveBeenCalled();
      expect(f.deps.executeEffect).not.toHaveBeenCalled();
    },
  );
});
