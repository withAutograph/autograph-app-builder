import { createNormalActorJournalAuthority } from "./hosted-operator-normal-actor-authority";
/* oxlint-disable eslint/require-await, unicorn/no-useless-undefined -- Local CAS fixture preserves the asynchronous production port contract. */
import { randomUUID } from "node:crypto";
import {
  createHostedOperatorNormalAuthClient,
  NormalAuthClientError,
} from "./hosted-operator-normal-auth-client";
import { betterAuth } from "better-auth";
import { organization as organizationPlugin } from "better-auth/plugins";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  HostedOperatorError,
  hostedOperatorPlanSchema,
  operatorPlanDigest,
} from "./hosted-operator-contract";
import {
  normalActorProgramSchema,
  proposeResolvedNormalActorAccess,
} from "./hosted-operator-normal-actor-program";
import { createNormalActorJournal } from "./hosted-operator-normal-actor-journal";
import type { NormalActorJournalPorts } from "./hosted-operator-normal-actor-journal";
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import type { HostedRuntimeJournalRow } from "./hosted-runtime-journal";
import type { HostedOperatorWorkerEffectContext } from "./hosted-operator-service";
import { createHostedOperatorNormalActorOperations } from "./hosted-operator-normal-actor-operations";
import type { NormalActorOperationsDependencies } from "./hosted-operator-normal-actor-operations";

const accountOperationRef = "11111111-1111-4111-8111-111111111111";
const authority = {
  issuer: "https://builder.example.test/api/auth",
  audience: "https://builder.example.test/mcp",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const target = {
  appId: "normal-app",
  branch: "preview",
  environment: "preview" as const,
  projectId: "prj_app",
  sessionId: "owner-session",
  installationId: "installation",
  scopeId: "team",
  scopeType: "team" as const,
};
const context = { authority, target };
const program = normalActorProgramSchema.parse({
  version: 1,
  appId: target.appId,
  origin: "https://apps.example.com",
  actors: [
    {
      actorKey: "owner",
      email: "owner@example.com",
      name: "Owner",
      account: "create-email-password",
    },
    { actorKey: "peer", email: "peer@example.com", name: "Peer", account: "create-email-password" },
  ],
  organizations: [
    { organizationId: "org-one", ownerActorKey: "owner", name: "One", slug: "one" },
    { organizationId: "org-two", ownerActorKey: "owner", name: "Two", slug: "two" },
  ],
  memberships: [
    { actorKey: "owner", organizationId: "org-one", role: "owner" },
    { actorKey: "peer", organizationId: "org-one", role: "member" },
    { actorKey: "owner", organizationId: "org-two", role: "owner" },
    { actorKey: "peer", organizationId: "org-two", role: "member" },
  ],
  appAccess: [
    { actorKey: "owner", organizationId: "org-one", roles: ["owner"] },
    { actorKey: "peer", organizationId: "org-two", roles: ["member"] },
  ],
});
const plan = hostedOperatorPlanSchema.parse({
  version: 1,
  stage: "auth-participants",
  action: "prepare",
  access: [],
  normalActorProgram: program,
  selection: {
    appId: target.appId,
    branch: target.branch,
    environment: target.environment,
    projectId: target.projectId,
    sessionId: target.sessionId,
  },
  appDatabase: {
    resourceId: "app-resource",
    database: "normal",
    migratorRole: "normal_owner",
    runtimeRole: "normal_runtime",
  },
  authDatabase: {
    resourceId: "auth-resource",
    database: "auth",
    migratorRole: "auth_owner",
    runtimeRole: "auth_runtime",
  },
  contextId: "accepted-spec",
  cost: { class: "shared-recovery-group", description: "Approved normal accounts", owner: "owner" },
  effects: [
    {
      id: "normal-accounts",
      kind: "normal-accounts",
      description: "Capture approved actual accounts",
    },
  ],
  installer: { reference: "owned-worker", sha256: "a".repeat(64) },
  neon: {
    branchId: "br_fixture",
    connectionRef: "owned-connection",
    endpoint: "ep-owned.neon.tech",
    projectId: "neon-owned",
    source: "synthetic-only",
  },
  release: { artifactRef: "owned-release", id: "release", sha256: "b".repeat(64) },
  retention: { expiresAt: "2030-01-01T00:00:00.000Z", policy: "Retain Auth" },
  publicGateway: { branch: target.branch, origin: program.origin, projectId: "prj_gateway" },
  deploymentBoundary: {
    authority,
    teamId: "team",
    app: {
      branch: target.branch,
      deploymentId: "dpl_app",
      environment: "preview",
      projectId: target.projectId,
    },
    gateway: {
      branch: target.branch,
      deploymentId: "dpl_gateway",
      environment: "preview",
      projectId: "prj_gateway",
    },
    operator: { deploymentId: "dpl_operator", environment: "preview", projectId: "prj_operator" },
    verification: {
      gatewayOrigin: "https://gateway.example.test",
      jwksUrl: "https://gateway.example.test/_platform/jwks.json",
      publicOrigin: program.origin,
    },
  },
});
const fixture = (captureExisting = false, selectedProgram = program) => {
  const actualProgram = captureExisting
    ? normalActorProgramSchema.parse({
        ...program,
        actors: program.actors.map((actor) => ({ ...actor, account: "capture-existing" })),
      })
    : selectedProgram;
  const actualPlan = hostedOperatorPlanSchema.parse({ ...plan, normalActorProgram: actualProgram });
  let row: HostedRuntimeJournalRow = {
    revision: 1,
    record: hostedRuntimeJournalRecordSchema.parse({
      kind: "app-runtime",
      version: 1,
      request: target,
      approvedByCallId: "initial-call",
      status: "pending",
      step: "reserved",
      leaseId: "44444444-4444-4444-8444-444444444444",
      operator: {
        mode: "protected-operator-v1",
        operationRef: accountOperationRef,
        plan: actualPlan,
        planDigest: operatorPlanDigest(actualPlan),
        approvalId: "initial-approval",
        receipts: [],
      },
    }),
  };
  let authorized = true;
  const requests: Request[] = [];
  const captures: { actorKey: string; organizationId?: string }[] = [];
  let organizationIndex = 0;
  const auth = betterAuth({
    secret: "normal-operations-local-fixture-long-secret",
    baseURL: actualProgram.origin,
    emailAndPassword: { enabled: true },
    plugins: [organizationPlugin({ requireEmailVerificationOnInvitation: false })],
    advanced: {
      database: {
        generateId: ({ model }) => {
          if (model !== "organization") {
            return randomUUID();
          }
          const selected = actualProgram.organizations[organizationIndex];
          organizationIndex += 1;
          return selected?.organizationId ?? randomUUID();
        },
      },
    },
    logger: { disabled: true },
  });
  const journalPorts: NormalActorJournalPorts = {
    keyring: { tokenKey: Buffer.alloc(32, 7), tokenKeyVersion: "v1" },
    now: () => Date.now(),
    assertAuthorized: async (input) => {
      if (!authorized || input.authority.ownerUserId !== authority.ownerUserId) {
        throw new Error("owner_revoked");
      }
    },
    assertAccountApproval: async (_input, preparation) => {
      expect(preparation.accountOperationRef).toBe(accountOperationRef);
      expect(preparation.accountApprovalId).toBe("initial-approval");
      expect(preparation.accountPlanDigest).toBe(operatorPlanDigest(actualPlan));
    },
    assertMutationAuthority: async (_input, current) => {
      expect(current.revision).toBe(row.revision);
      expect(current.record.leaseId).toBe(row.record.leaseId);
    },
    store: {
      read: async () => structuredClone(row),
      compareAndSet: async (input) => {
        if (input.expectedRevision !== row.revision) {
          return undefined;
        }
        row = {
          revision: row.revision + 1,
          record: hostedRuntimeJournalRecordSchema.parse(input.record),
        };
        return structuredClone(row);
      },
    },
  };
  const assertCurrent = async () => {
    await journalPorts.assertAuthorized(context);
  };
  const localFetch: typeof fetch = async (url, init) => {
    const request = new Request(url, init);
    requests.push(request.clone());
    if (request.url.endsWith("/sign-up/email")) {
      expect(row.record.accountPreparation).toBeDefined();
      const saved = await createNormalActorJournal(journalPorts).read(context);
      expect(
        saved?.state.actors.some(
          (actor) => actor.signup === "attempted" && actor.credentials?.password !== undefined,
        ),
      ).toBe(true);
    }
    return await auth.handler(request);
  };
  const dependencies: NormalActorOperationsDependencies = {
    journalPorts,
    assertPlanningAuthorized: assertCurrent,
    assertCurrentPlan: async (input) => {
      await assertCurrent();
      expect(input.plan.selection.appId).toBe(target.appId);
    },
    normalRealmFetch: async (input) => {
      expect(input.origin).toBe(actualProgram.origin);
      return localFetch;
    },
    prepareActorCapture: async (input) => {
      captures.push({ actorKey: input.actorKey, organizationId: input.organizationId });
      throw new Error("fixture_capture_required");
    },
    // Proof and selected worker ports are local dependency fixtures, not hosted provider or signed proof evidence.
    collectOrganizationOwnerProof: async (input) => {
      const organization = input.preparation.program.organizations.find(
        (entry) => entry.organizationId === input.organizationId,
      );
      if (!organization) {
        throw new Error("fixture_missing_organization");
      }
      return {
        kind: "create-owned-organization",
        organizationId: organization.organizationId,
        name: organization.name,
        slug: organization.slug,
        actorId: input.owner.actorId,
        bootstrapPlanDigest: operatorPlanDigest(actualPlan),
        identityCapture: {
          capturedAt: new Date().toISOString(),
          realmSessionId: input.owner.realmSessionId,
        },
        identityNonceSha256: "a".repeat(64),
        identityProof: {
          reference: `fixture-proof-${organization.organizationId}`,
          sha256: "b".repeat(64),
        },
        identityVerification: {
          audience: actualProgram.origin,
          issuer: actualProgram.origin,
          jwksUrl: `${actualProgram.origin}/jwks`,
          transportSource: {
            audience: actualProgram.origin,
            issuer: actualProgram.origin,
            environment: "preview",
            ownerId: authority.ownerUserId,
            projectId: target.projectId,
          },
        },
      };
    },
    executeOrganization: async (input) => {
      const saved = await createNormalActorJournal(journalPorts).read(context);
      const candidate = saved?.state.organizationSessions?.find(
        (entry) => entry.session.realmSessionId === input.owner.realmSessionId,
      );
      const organization = actualProgram.organizations.find(
        (entry) => entry.organizationId === input.organizationId,
      );
      if (!candidate || !organization) {
        throw new Error("fixture_missing_owner");
      }
      const response = await localFetch(`${actualProgram.origin}/api/auth/organization/create`, {
        method: "POST",
        headers: {
          origin: actualProgram.origin,
          "content-type": "application/json",
          cookie: candidate.storageState.cookies
            .map((cookie) => `${cookie.name}=${cookie.value}`)
            .join("; "),
        },
        body: JSON.stringify({ name: organization.name, slug: organization.slug }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: input.organizationId });
    },
    inspectOrganization: async (input) => {
      const saved = await createNormalActorJournal(journalPorts).read(context);
      const candidate = saved?.state.organizationSessions?.find(
        (entry) => entry.session.realmSessionId === input.owner.realmSessionId,
      );
      if (!candidate) {
        throw new Error("fixture_missing_owner");
      }
      const list = await localFetch(`${actualProgram.origin}/api/auth/organization/list`, {
        headers: {
          cookie: candidate.storageState.cookies
            .map((cookie) => `${cookie.name}=${cookie.value}`)
            .join("; "),
        },
      });
      expect(list.status).toBe(200);
      const listed = z.array(z.object({ id: z.string() })).parse(await list.json());
      if (!listed.some((entry) => entry.id === input.organizationId)) {
        return "absent";
      }
      const client = createHostedOperatorNormalAuthClient({
        origin: actualProgram.origin,
        fetch: localFetch,
        storageState: candidate.storageState,
      });
      try {
        const actual = await client.listMembers({
          organizationId: input.organizationId,
          userId: input.owner.actorId,
        });
        return actual.members.some(
          (member) => member.userId === input.owner.actorId && member.role === "owner",
        )
          ? "applied"
          : "absent";
      } catch (error) {
        if (error instanceof NormalAuthClientError && error.authCode === "ORGANIZATION_NOT_FOUND") {
          return "absent";
        }
        throw error;
      }
    },
  };
  const operations = createHostedOperatorNormalActorOperations(dependencies);
  const preflight = {
    ...context,
    plan: actualPlan,
    operationRef: accountOperationRef,
    callId: "initial-call",
    approvalId: "initial-approval",
    planDigest: operatorPlanDigest(actualPlan),
  };
  const [selectedEffect] = actualPlan.effects;
  if (selectedEffect === undefined) {
    throw new Error("fixture_missing_effect");
  }
  const checkpointAccountPreparation: NonNullable<
    HostedOperatorWorkerEffectContext["checkpointAccountPreparation"]
  > = async (preparation) => {
    expect(preparation.accountOperationRef).toBe(accountOperationRef);
    expect(row.record.accountPreparation?.sealedState).toEqual(preparation.sealedState);
  };
  const effect: HostedOperatorWorkerEffectContext = {
    ...context,
    plan: actualPlan,
    operationRef: accountOperationRef,
    effect: selectedEffect,
    fenceGeneration: 1,
    workerCheckpoints: [],
    workerAttemptId: "fixture-attempt",
    assertCurrent,
    checkpoint: async () => {
      throw new Error("unused_resource_checkpoint");
    },
    bindWorkerContext: async () => {
      throw new Error("unused_worker_binding");
    },
    checkpointAccountPreparation,
  };
  return {
    operations,
    journalPorts,
    preflight,
    effect,
    requests,
    localFetch,
    captures,
    checkpointAccountPreparation,
    journal: createNormalActorJournal(journalPorts),
    get row() {
      return row;
    },
    set row(value: HostedRuntimeJournalRow) {
      row = value;
    },
    revoke() {
      authorized = false;
    },
  };
};

describe("normal actor operations", () => {
  it("persists original encrypted authority before ordinary signup and prepares independent pending organization sessions", async () => {
    const f = fixture();
    expect(await f.operations.ensureNormalActorCapture(f.preflight)).toBe("ready");
    const state = await f.operations.prepareNormalActorAccounts(f.effect);
    expect(state.actors.every((actor) => actor.signup === "complete")).toBe(true);
    expect(state.organizationSessions).toHaveLength(4);
    expect(state.organizationSessions?.every((entry) => entry.selection === "pending")).toBe(true);
    expect(
      new Set(state.organizationSessions?.map((entry) => entry.session.realmSessionId)).size,
    ).toBe(4);
    const saved = await f.journal.read(context);
    expect(saved?.preparation.accountOperationRef).toBe(accountOperationRef);
    expect(JSON.stringify(f.row.record)).not.toContain(state.actors[0]?.credentials?.password);
    expect(JSON.stringify(f.row.record)).not.toContain(
      state.actors[0]?.storageState?.cookies[0]?.value,
    );
    const before = f.requests.length;
    if (!saved) {
      throw new Error("fixture_missing_preparation");
    }
    await f.operations.verifyNormalActorAccounts({
      ...context,
      plan: f.preflight.plan,
      assertCurrent: f.effect.assertCurrent,
      accountPreparation: saved.preparation,
      checkpointAccountPreparation: f.checkpointAccountPreparation,
    });
    expect(f.requests.slice(before).every((request) => request.method === "GET")).toBe(true);
  });
  it("executes only the selected organization, then verifies every real membership and active context without mutations", async () => {
    const f = fixture();
    await f.operations.ensureNormalActorCapture(f.preflight);
    await f.operations.prepareNormalActorAccounts(f.effect);
    const saved = await f.journal.read(context);
    if (!saved) {
      throw new Error("fixture_missing_preparation");
    }
    const organizations = await f.operations.readNormalActorOrganizationProofs({
      ...context,
      plan: f.preflight.plan,
      ...saved,
    });
    expect(organizations.map((entry) => entry.identityCapture.realmSessionId)).toEqual(
      saved.state.organizationSessions
        ?.filter((entry) => entry.actorKey === "owner")
        .map((entry) => entry.session.realmSessionId),
    );
    const fullPlan = hostedOperatorPlanSchema.parse({
      ...f.preflight.plan,
      stage: "app",
      normalActorPreparation: {
        accountOperationRef,
        programDigest: saved.preparation.programDigest,
        accountPlanDigest: saved.preparation.accountPlanDigest,
        accountApprovalId: saved.preparation.accountApprovalId,
        accountApprovedByCallId: saved.preparation.accountApprovedByCallId,
      },
      authMembership: { kind: "create-owned-organizations", organizations },
      access: proposeResolvedNormalActorAccess(program, saved.state),
      effects: [
        { id: "resources", kind: "resources", description: "Fixture resources" },
        { id: "install", kind: "install", description: "Fixture installation" },
        { id: "auth-membership:org-one", kind: "auth-membership", description: "One" },
        { id: "auth-membership:org-two", kind: "auth-membership", description: "Two" },
        { id: "access", kind: "access", description: "Fixture access" },
        { id: "bindings", kind: "bindings", description: "Fixture bindings" },
      ],
    });
    const first = fullPlan.effects.find((entry) => entry.id === "auth-membership:org-one");
    const second = fullPlan.effects.find((entry) => entry.id === "auth-membership:org-two");
    if (!first || !second) {
      throw new Error("fixture_missing_effect");
    }
    const appOperationRef = "22222222-2222-4222-8222-222222222222";
    const firstState = await f.operations.prepareNormalActorMemberships({
      ...f.effect,
      plan: fullPlan,
      operationRef: appOperationRef,
      effect: first,
    });
    expect(
      firstState.memberships
        .filter((entry) => entry.organizationId === "org-one")
        .every((entry) => entry.status === "complete"),
    ).toBe(true);
    expect(
      firstState.memberships
        .filter((entry) => entry.organizationId === "org-two")
        .every((entry) => entry.status === "pending"),
    ).toBe(true);
    await f.operations.prepareNormalActorMemberships({
      ...f.effect,
      plan: fullPlan,
      operationRef: appOperationRef,
      effect: second,
    });
    const before = f.requests.length;
    const verified = await f.operations.verifyNormalActorMemberships({
      ...f.effect,
      plan: fullPlan,
      operationRef: appOperationRef,
      effect: second,
    });
    expect(
      verified.organizationSessions?.every(
        (entry) =>
          entry.selection === "selected" &&
          entry.session.activeOrganizationId === entry.organizationId,
      ),
    ).toBe(true);
    expect(f.requests.slice(before).every((request) => request.method === "GET")).toBe(true);
    const ownerContext = verified.organizationSessions?.find(
      (entry) => entry.actorKey === "owner" && entry.organizationId === "org-one",
    );
    if (ownerContext === undefined) {
      throw new Error("fixture_missing_context");
    }
    const normal = createHostedOperatorNormalAuthClient({
      origin: program.origin,
      fetch: f.localFetch,
      storageState: ownerContext.storageState,
      assertApprovedEffect: f.effect.assertCurrent,
    });
    await normal.setActiveOrganization({ organizationId: "org-two" });
    const beforeStaleVerify = f.requests.length;
    await expect(
      f.operations.verifyNormalActorMemberships({
        ...f.effect,
        plan: fullPlan,
        operationRef: appOperationRef,
        effect: second,
      }),
    ).rejects.toMatchObject({ code: "auth_identity_required" });
    expect(f.requests.slice(beforeStaleVerify).every((request) => request.method === "GET")).toBe(
      true,
    );
    const retained = await f.journal.read(context);
    expect(retained?.preparation.accountOperationRef).toBe(accountOperationRef);
    await expect(
      f.operations.prepareNormalActorMemberships({
        ...f.effect,
        plan: fullPlan,
        effect: { ...first, id: "auth-membership" },
      }),
    ).rejects.toMatchObject({ code: "resource_mismatch" });
  });

  it("does not treat a base account session as all required organization candidates", async () => {
    const f = fixture();
    await f.operations.ensureNormalActorCapture(f.preflight);
    await f.operations.prepareNormalActorAccounts(f.effect);
    const saved = await f.journal.read(context);
    if (!saved) {
      throw new Error("fixture_missing_preparation");
    }
    saved.state.organizationSessions = [];
    await f.journal.checkpoint(context, saved.state);
    const before = f.requests.length;
    await expect(
      f.operations.verifyNormalActorAccounts({
        ...context,
        plan: f.preflight.plan,
        assertCurrent: f.effect.assertCurrent,
        accountPreparation: saved.preparation,
        checkpointAccountPreparation: f.checkpointAccountPreparation,
      }),
    ).rejects.toMatchObject({ code: "auth_identity_required" });
    expect(f.requests.slice(before).every((request) => request.method === "GET")).toBe(true);
  });
  it("retains first real account approval before requiring owner capture without making account requests", async () => {
    const f = fixture(true);
    await expect(f.operations.ensureNormalActorCapture(f.preflight)).rejects.toThrow(
      "fixture_capture_required",
    );
    expect(f.row.record.accountPreparation?.accountApprovalId).toBe("initial-approval");
    expect(f.captures).toEqual([{ actorKey: "owner", organizationId: undefined }]);
    expect(f.requests).toHaveLength(0);
  });
  it("rechecks actual owner authority before a retained private read", async () => {
    const f = fixture();
    await f.operations.ensureNormalActorCapture(f.preflight);
    f.revoke();
    await expect(f.operations.readNormalActorPreparation(context)).rejects.toThrow("owner_revoked");
  });
});

describe("safe save-wrapper observation outside journal CAS", () => {
  it("reduces only four full save-wrapper checks with the same real journal and outward Auth calls", async () => {
    const actors = Array.from({ length: 8 }, (_, index) => ({
      actorKey: `actor-${index}`,
      email: `actor${index}@example.com`,
      name: `Actor ${index}`,
      account: "create-email-password" as const,
    }));
    const selectedProgram = normalActorProgramSchema.parse({
      ...program,
      actors,
      organizations: program.organizations.map((organization) => ({
        ...organization,
        ownerActorKey: "actor-0",
      })),
      memberships: program.organizations.flatMap((organization) =>
        actors.map((actor, index) => ({
          actorKey: actor.actorKey,
          organizationId: organization.organizationId,
          role: index === 0 ? "owner" : "member",
        })),
      ),
      appAccess: [],
    });
    const run = async (observe: boolean) => {
      const f = fixture(false, selectedProgram);
      await f.operations.ensureNormalActorCapture(f.preflight);
      const { leaseId } = f.row.record;
      if (leaseId === undefined || f.row.record.operator === undefined) {
        throw new Error("Missing owned fixture lease");
      }
      f.effect.leaseId = leaseId;
      f.row.record.leaseExpiresAt = "2030-01-01T00:00:00.000Z";
      f.row.record.operator.fenceGeneration = f.effect.fenceGeneration;
      let fullService = 0;
      let fullJournal = 0;
      let observations = 0;
      let checkpoints = 0;
      const canonical = f.journalPorts.assertAuthorized;
      const current = f.effect.assertCurrent;
      const checkpoint = f.effect.checkpointAccountPreparation;
      const ports = createNormalActorJournalAuthority({
        store: f.journalPorts.store,
        keyring: f.journalPorts.keyring,
        now: Date.now,
        assertCanonicalOwner: canonical,
        assertApprovedOwner: async (ownedContext) => {
          fullJournal += 1;
          await canonical(ownedContext);
        },
        readApproval: async (input) => ({
          action: input.action,
          approvalId: "initial-approval",
          approved: true,
          callId: input.callId,
          planDigest: input.planDigest,
        }),
      });
      Object.assign(f.journalPorts, ports);
      f.effect.assertCurrent = async () => {
        fullService += 1;
        await current();
      };
      if (observe) {
        f.effect.assertCurrentObservation = async () => {
          observations += 1;
          await current();
          if (
            f.row.record.leaseId !== leaseId ||
            Date.parse(f.row.record.leaseExpiresAt ?? "") <= Date.now()
          ) {
            throw new HostedOperatorError("operation_in_progress");
          }
          // Model the real service guard's lease renewal/revision write outside journal CAS.
          f.row = {
            ...f.row,
            revision: f.row.revision + 1,
            record: {
              ...f.row.record,
              leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          };
        };
      }
      f.effect.checkpointAccountPreparation = async (preparation) => {
        checkpoints += 1;
        // The real service's fifth full checkpoint guard remains unchanged.
        await f.effect.assertCurrent();
        if (checkpoint === undefined) {
          throw new Error("Missing service checkpoint");
        }
        await checkpoint(preparation);
      };
      const state = await f.operations.prepareNormalActorAccounts(f.effect);
      expect(state.actors.every((actor) => actor.signup === "complete")).toBe(true);
      return {
        fullService,
        fullJournal,
        observations,
        checkpoints,
        paths: f.requests.map((request) => new URL(request.url).pathname),
      };
    };
    const fallback = await run(false);
    const observed = await run(true);
    expect(observed.checkpoints).toBe(fallback.checkpoints);
    expect(observed.paths).toEqual(fallback.paths);
    expect(observed.fullJournal).toBe(fallback.fullJournal);
    expect(observed.fullJournal).toBe(observed.checkpoints * 2);
    expect(observed.observations).toBe(observed.checkpoints * 4);
    expect(fallback.fullService - observed.fullService).toBe(observed.observations);
    expect(observed.fullService).toBeGreaterThan(observed.checkpoints);
  });
  it.each(["authorization_required", "operation_in_progress"] as const)(
    "rejects %s observation before writing account state",
    async (code) => {
      const f = fixture();
      await f.operations.ensureNormalActorCapture(f.preflight);
      const initial = f.row;
      f.effect.assertCurrentObservation = async () => {
        throw new HostedOperatorError(code);
      };
      await expect(f.operations.prepareNormalActorAccounts(f.effect)).rejects.toThrow(code);
      expect(f.row).toEqual(initial);
      expect(f.requests).toEqual([]);
    },
  );
});
