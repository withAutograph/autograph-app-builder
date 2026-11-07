import { createNormalActorRuntimeBindings } from "./hosted-operator-normal-actor-runtime-bindings";
import { createParticipantSuccessorPlan } from "./hosted-operator-participant-successor";
import { createNormalActorJournalAuthority } from "./hosted-operator-normal-actor-authority";
/* oxlint-disable eslint/require-await, unicorn/no-useless-undefined -- Local CAS fixture preserves the asynchronous production port contract. */
import { createHash, randomUUID } from "node:crypto";
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
  normalActorPreparationSchema,
} from "./hosted-operator-contract";
import {
  initialNormalActorState,
  normalActorProgramSchema,
  proposeResolvedNormalActorAccess,
} from "./hosted-operator-normal-actor-program";
import {
  createNormalActorJournal,
  normalActorCaptureCookieSchema,
} from "./hosted-operator-normal-actor-journal";
import type { NormalActorJournalPorts } from "./hosted-operator-normal-actor-journal";
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import type { HostedRuntimeJournalRow } from "./hosted-runtime-journal";
import type { HostedOperatorWorkerEffectContext } from "./hosted-operator-service";
import { createHostedOperatorNormalActorOperations } from "./hosted-operator-normal-actor-operations";
import type { NormalActorOperationsDependencies } from "./hosted-operator-normal-actor-operations";

const requireFixture = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("missing fixture value");
  }
  return value;
};

const accountOperationRef = "11111111-1111-4111-8111-111111111111";
const authority = {
  audience: "https://builder.example.test/mcp",
  issuer: "https://builder.example.test/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const target = {
  appId: "normal-app",
  branch: "preview",
  environment: "preview" as const,
  installationId: "installation",
  projectId: "prj_app",
  scopeId: "team",
  scopeType: "team" as const,
  sessionId: "owner-session",
};
const context = { authority, target };
const program = normalActorProgramSchema.parse({
  actors: [
    {
      account: "create-email-password",
      actorKey: "owner",
      email: "owner@example.com",
      name: "Owner",
    },
    { account: "create-email-password", actorKey: "peer", email: "peer@example.com", name: "Peer" },
  ],
  appAccess: [
    { actorKey: "owner", organizationId: "org-one", roles: ["owner"] },
    { actorKey: "peer", organizationId: "org-two", roles: ["member"] },
  ],
  appId: target.appId,
  memberships: [
    { actorKey: "owner", organizationId: "org-one", role: "owner" },
    { actorKey: "peer", organizationId: "org-one", role: "member" },
    { actorKey: "owner", organizationId: "org-two", role: "owner" },
    { actorKey: "peer", organizationId: "org-two", role: "member" },
  ],
  organizations: [
    { name: "One", organizationId: "org-one", ownerActorKey: "owner", slug: "one" },
    { name: "Two", organizationId: "org-two", ownerActorKey: "owner", slug: "two" },
  ],
  origin: "https://apps.example.com",
  version: 1,
});
const plan = hostedOperatorPlanSchema.parse({
  access: [],
  action: "prepare",
  appDatabase: {
    database: "normal",
    migratorRole: "normal_owner",
    resourceId: "app-resource",
    runtimeRole: "normal_runtime",
  },
  authDatabase: {
    database: "auth",
    migratorRole: "auth_owner",
    resourceId: "auth-resource",
    runtimeRole: "auth_runtime",
  },
  contextId: "accepted-spec",
  cost: { class: "shared-recovery-group", description: "Approved normal accounts", owner: "owner" },
  deploymentBoundary: {
    app: {
      branch: target.branch,
      deploymentId: "dpl_app",
      environment: "preview",
      projectId: target.projectId,
    },
    authority,
    gateway: {
      branch: target.branch,
      deploymentId: "dpl_gateway",
      environment: "preview",
      projectId: "prj_gateway",
    },
    operator: { deploymentId: "dpl_operator", environment: "preview", projectId: "prj_operator" },
    teamId: "team",
    verification: {
      gatewayOrigin: "https://gateway.example.test",
      jwksUrl: "https://gateway.example.test/_platform/jwks.json",
      publicOrigin: program.origin,
    },
  },
  effects: [
    {
      description: "Capture approved actual accounts",
      id: "normal-accounts",
      kind: "normal-accounts",
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
  normalActorProgram: program,
  publicGateway: { branch: target.branch, origin: program.origin, projectId: "prj_gateway" },
  release: { artifactRef: "owned-release", id: "release", sha256: "b".repeat(64) },
  retention: { expiresAt: "2030-01-01T00:00:00.000Z", policy: "Retain Auth" },
  selection: {
    appId: target.appId,
    branch: target.branch,
    environment: target.environment,
    projectId: target.projectId,
    sessionId: target.sessionId,
  },
  stage: "auth-participants",
  version: 1,
});
const fixture = (captureExisting = false, selectedProgram = program) => {
  let actualProgram = captureExisting
    ? normalActorProgramSchema.parse({
        ...program,
        actors: program.actors.map((actor) => ({ ...actor, account: "capture-existing" })),
      })
    : selectedProgram;
  const actualPlan = hostedOperatorPlanSchema.parse({ ...plan, normalActorProgram: actualProgram });
  let row: HostedRuntimeJournalRow = {
    record: hostedRuntimeJournalRecordSchema.parse({
      approvedByCallId: "initial-call",
      kind: "app-runtime",
      leaseId: "44444444-4444-4444-8444-444444444444",
      operator: {
        approvalId: "initial-approval",
        mode: "protected-operator-v1",
        operationRef: accountOperationRef,
        plan: actualPlan,
        planDigest: operatorPlanDigest(actualPlan),
        receipts: [],
      },
      request: target,
      status: "pending",
      step: "reserved",
      version: 1,
    }),
    revision: 1,
  };
  let authorized = true;
  const requests: Request[] = [];
  const captures: { actorKey: string; organizationId?: string }[] = [];
  let organizationIndex = 0;
  const auth = betterAuth({
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
    baseURL: actualProgram.origin,
    emailAndPassword: { enabled: true },
    logger: { disabled: true },
    plugins: [organizationPlugin({ requireEmailVerificationOnInvitation: false })],
    secret: "normal-operations-local-fixture-long-secret",
  });
  const journalPorts: NormalActorJournalPorts = {
    assertAccountApproval: async (_input, preparation) => {
      expect(preparation.accountOperationRef).toBe(accountOperationRef);
      expect(preparation.accountApprovalId).toBe("initial-approval");
      expect(preparation.accountPlanDigest).toBe(operatorPlanDigest(actualPlan));
    },
    assertAuthorized: async (input) => {
      if (!authorized || input.authority.ownerUserId !== authority.ownerUserId) {
        throw new Error("owner_revoked");
      }
    },
    assertMutationAuthority: async (_input, current) => {
      expect(current.revision).toBe(row.revision);
      expect(current.record.leaseId).toBe(row.record.leaseId);
    },
    keyring: { tokenKey: Buffer.alloc(32, 7), tokenKeyVersion: "v1" },
    now: () => Date.now(),
    store: {
      compareAndSet: async (input) => {
        if (input.expectedRevision !== row.revision) {
          return undefined;
        }
        row = {
          record: hostedRuntimeJournalRecordSchema.parse(input.record),
          revision: row.revision + 1,
        };
        return structuredClone(row);
      },
      read: async () => structuredClone(row),
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
        actorId: input.owner.actorId,
        bootstrapPlanDigest: input.preparation.accountPlanDigest,
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
            environment: "preview",
            issuer: actualProgram.origin,
            ownerId: authority.ownerUserId,
            projectId: target.projectId,
          },
        },
        kind: "create-owned-organization",
        name: organization.name,
        organizationId: organization.organizationId,
        slug: organization.slug,
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
        body: JSON.stringify({ name: organization.name, slug: organization.slug }),
        headers: {
          "content-type": "application/json",
          cookie: candidate.storageState.cookies
            .map((cookie) => `${cookie.name}=${cookie.value}`)
            .join("; "),
          origin: actualProgram.origin,
        },
        method: "POST",
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
        fetch: localFetch,
        origin: actualProgram.origin,
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
    approvalId: "initial-approval",
    callId: "initial-call",
    operationRef: accountOperationRef,
    plan: actualPlan,
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
  const { leaseId } = row.record;
  if (leaseId === undefined) {
    throw new Error("fixture_missing_lease");
  }
  const effect: HostedOperatorWorkerEffectContext & { leaseId: string } = {
    ...context,
    assertCurrent,
    bindWorkerContext: async () => {
      throw new Error("unused_worker_binding");
    },
    checkpoint: async () => {
      throw new Error("unused_resource_checkpoint");
    },
    checkpointAccountPreparation,
    effect: selectedEffect,
    fenceGeneration: 1,
    leaseId,
    operationRef: accountOperationRef,
    plan: actualPlan,
    workerAttemptId: "fixture-attempt",
    workerCheckpoints: [],
  };
  return {
    auth,
    captures,
    checkpointAccountPreparation,
    dependencies,
    effect,
    journal: createNormalActorJournal(journalPorts),
    journalPorts,
    localFetch,
    operations,
    preflight,
    requests,
    revoke() {
      authorized = false;
    },
    get row() {
      return row;
    },
    set row(value: HostedRuntimeJournalRow) {
      row = value;
    },
    selectProgram(next: typeof program) {
      actualProgram = next;
      organizationIndex = 0;
    },
  };
};

describe("normal actor operations", () => {
  it("carries one original capture through mutable scope, stopped seven-account preparation, two organizations and scoped runtime handoff", async () => {
    const originalProgram = normalActorProgramSchema.parse({
      ...program,
      actors: [{ ...program.actors[0], account: "capture-existing" }],
      appAccess: [],
      memberships: [],
      organizations: [],
    });
    const f = fixture(false, originalProgram);
    let now = Date.now();
    const approvals = new Map<string, { id: string; digest: string }>();
    const currentOperator = () => {
      const { operator } = f.row.record;
      if (operator === undefined) {
        throw new Error("missing fixture operator");
      }
      return operator;
    };
    const authorizeCurrent: NormalActorOperationsDependencies["assertCurrentPlan"] = async (
      input,
    ) => {
      await f.journalPorts.assertAuthorized(input);
      const operator = currentOperator();
      const approval = approvals.get(f.row.record.approvedByCallId);
      if (
        [
          operator.operationRef === input.operationRef,
          operator.planDigest === operatorPlanDigest(input.plan),
          operator.approvalId === approval?.id,
          operator.planDigest === approval?.digest,
          Date.parse(input.plan.retention.expiresAt) > now,
        ].some((matches) => !matches)
      ) {
        throw new HostedOperatorError("authorization_required");
      }
    };
    Object.assign(
      f.journalPorts,
      createNormalActorJournalAuthority({
        ...f.journalPorts,
        assertApprovedOwner: async (input) => {
          await authorizeCurrent({ ...input, operationRef: currentOperator().operationRef });
        },
        assertCanonicalOwner: f.journalPorts.assertAuthorized,
        now: () => now,
        readApproval: async (input) => {
          const approval = approvals.get(input.callId);
          return approval?.digest === input.planDigest
            ? { ...input, approvalId: approval.id, approved: true }
            : null;
        },
      }),
    );
    f.dependencies.assertCurrentPlan = authorizeCurrent;
    const installPlan = (selected: typeof plan, operationRef: string, callId: string) => {
      const approvalId = `${callId}-approval`;
      approvals.set(callId, { digest: operatorPlanDigest(selected), id: approvalId });
      f.row.record.approvedByCallId = callId;
      f.row.record.operator = {
        approvalId,
        fenceGeneration: 1,
        mode: "protected-operator-v1",
        operationRef,
        plan: selected,
        planDigest: operatorPlanDigest(selected),
        receipts: [],
      };
      f.row.record.status = "pending";
      f.row.record.step = "reserved";
      delete f.row.record.leaseId;
      delete f.row.record.leaseExpiresAt;
      return {
        ...context,
        approvalId,
        callId,
        operationRef,
        plan: selected,
        planDigest: operatorPlanDigest(selected),
      };
    };
    const settle = () => {
      const operator = currentOperator();
      delete f.row.record.leaseId;
      delete f.row.record.leaseExpiresAt;
      delete operator.pendingEffectId;
      delete operator.pendingEffectAttempt;
      operator.receipts = operator.plan.effects.map((effect) => ({
        effectId: effect.id,
        observedAt: new Date(now).toISOString(),
        resourceVersion: "controlled fixture receipt",
        ...(effect.kind === "access" ? { fenceGeneration: operator.fenceGeneration } : {}),
      }));
      f.row.record.status = operator.plan.stage === "app" ? "prepared" : "participants-prepared";
      f.row.record.step = operator.plan.stage === "app" ? "bound" : "reserved";
    };
    const worker = (
      selected: typeof plan,
      effect: (typeof plan.effects)[number],
    ): HostedOperatorWorkerEffectContext & { leaseId: string } => {
      const operator = currentOperator();
      f.row.record.leaseId = randomUUID();
      f.row.record.leaseExpiresAt = "2030-01-01T00:00:00.000Z";
      operator.pendingEffectId = effect.id;
      const result: HostedOperatorWorkerEffectContext & { leaseId: string } = {
        ...f.effect,
        assertCurrent: async () => {
          await f.journalPorts.assertMutationAuthority(result, f.row);
        },
        checkpointAccountPreparation: async (preparation) => {
          expect(preparation.sealedState).toEqual(f.row.record.accountPreparation?.sealedState);
        },
        effect,
        leaseId: f.row.record.leaseId,
        operationRef: operator.operationRef,
        plan: selected,
      };
      return result;
    };
    const originalInput = installPlan(
      hostedOperatorPlanSchema.parse({
        ...f.preflight.plan,
        retention: { ...plan.retention, expiresAt: new Date(now + 1000).toISOString() },
      }),
      accountOperationRef,
      "capture-call",
    );
    await expect(f.operations.ensureNormalActorCapture(originalInput)).rejects.toThrow(
      "fixture_capture_required",
    );
    const capturedClient = createHostedOperatorNormalAuthClient({
      assertApprovedEffect: async () => {
        await authorizeCurrent({
          ...context,
          operationRef: currentOperator().operationRef,
          plan: currentOperator().plan,
        });
      },
      fetch: async (url, init) => await f.auth.handler(new Request(url, init)),
      origin: program.origin,
    });
    await capturedClient.signUp({
      email: requireFixture(originalProgram.actors[0]).email,
      name: "Owner",
      password: randomUUID(),
    });
    const session = await capturedClient.getSession();
    if (session === null) {
      throw new Error("missing captured fixture session");
    }
    const captureState = initialNormalActorState(originalProgram, accountOperationRef);
    const proof = "controlled owner-confirmed capture";
    const proofSha256 = createHash("sha256").update(proof).digest("hex");
    const reference = await f.journal.authorizeCapture(context, {
      actorKey: "owner",
      expiresAt: session.expiresAt,
      nonceSha256: "1".repeat(64),
      proofSha256,
    });
    captureState.actors[0] = {
      actorKey: "owner",
      session: {
        actorId: session.actorId,
        expiresAt: session.expiresAt,
        origin: program.origin,
        realmSessionId: session.sessionId,
        reference,
      },
      signup: "complete",
      storageState: capturedClient.exportStorageState(),
    };
    await f.journal.capture(context, {
      actorKey: "owner",
      nonceSha256: "1".repeat(64),
      normalCookie: normalActorCaptureCookieSchema.parse({
        ...requireFixture(captureState.actors[0].storageState).cookies[0],
        expires: -1,
        hostOnly: true,
      }),
      proof,
      proofSha256,
      session: requireFixture(captureState.actors[0].session),
      version: 1,
    });
    await f.journal.checkpoint(context, captureState);
    const originalPreparation = structuredClone(requireFixture(f.row.record.accountPreparation));
    const originalApp = hostedOperatorPlanSchema.parse({
      ...originalInput.plan,
      effects: ["resources", "install", "access", "bindings"].map((kind) => ({
        description: "Controlled resource boundary",
        id: kind,
        kind,
      })),
      normalActorPreparation: normalActorPreparationSchema.strip().parse(originalPreparation),
      retention: { ...plan.retention, expiresAt: new Date(now + 3000).toISOString() },
      stage: "app",
    });
    const appInput = installPlan(originalApp, "22222222-2222-4222-8222-222222222222", "app-call");
    f.row.record.privateState = {
      encryptedToken: "fixture",
      keyVersion: "v1",
      tokenIv: "iv",
      tokenTag: "tag",
    };
    f.row.record.proof = {
      actors: 0,
      artifactHash: "c".repeat(64),
      authenticatedBehavior: "unassessed",
      manifestSha256: originalApp.release.sha256,
      releaseId: originalApp.release.id,
      tenants: 1,
    };
    settle();
    const drift = await f.auth.handler(
      new Request(`${program.origin}/api/auth/organization/create`, {
        body: JSON.stringify({ name: "Existing personal scope", slug: "personal-existing" }),
        headers: {
          "content-type": "application/json",
          cookie: capturedClient
            .exportStorageState()
            .cookies.map((cookie) => `${cookie.name}=${cookie.value}`)
            .join("; "),
          origin: program.origin,
        },
        method: "POST",
      }),
    );
    expect(drift.status).toBe(200);
    const existingOrg = z.object({ id: z.string() }).parse(await drift.json());
    await capturedClient.setActiveOrganization({ organizationId: existingOrg.id });
    const changedSession = await capturedClient.getSession();
    expect(changedSession?.activeOrganizationId).toBe(existingOrg.id);
    const runtime = createNormalActorRuntimeBindings(f.dependencies);
    const opaque = await runtime(appInput);
    expect(opaque?.identities.actors[0]).toMatchObject({
      actorKey: "owner",
      organizationId: null,
      roles: [],
    });
    if (opaque === undefined) {
      throw new Error("missing personal runtime projection");
    }
    expect(
      JSON.parse(
        requireFixture(opaque.files[requireFixture(opaque.identities.actors[0]).storageState]),
      ),
    ).toEqual(captureState.actors[0].storageState);
    const qaActors = Array.from({ length: 7 }, (_, index) => ({
      account: "create-email-password",
      actorKey: `qa-${index + 1}`,
      email: `qa-${index + 1}@example.com`,
      name: `QA ${index + 1}`,
    }));
    const combined = normalActorProgramSchema.parse({
      ...originalProgram,
      actors: [...originalProgram.actors, ...qaActors],
      appAccess: qaActors.map((actor, index) => ({
        actorKey: actor.actorKey,
        organizationId: index < 4 ? "qa-one" : "qa-two",
        roles: ["member"],
      })),
      memberships: qaActors.map((actor, index) => ({
        actorKey: actor.actorKey,
        organizationId: index < 4 ? "qa-one" : "qa-two",
        role: index === 0 || index === 4 ? "owner" : "member",
      })),
      organizations: [
        { name: "QA One", organizationId: "qa-one", ownerActorKey: "qa-1", slug: "qa-one" },
        { name: "QA Two", organizationId: "qa-two", ownerActorKey: "qa-5", slug: "qa-two" },
      ],
    });
    // The completed capture's execution window is history; current app/session authority remains valid.
    now += 2000;
    const successor = createParticipantSuccessorPlan(f.row.record, combined, now);
    if (successor === undefined) {
      throw new Error("missing additive fixture plan");
    }
    const archive = {
      approvedByCallId: f.row.record.approvedByCallId,
      operator: structuredClone(currentOperator()),
      preparation: originalPreparation,
      proof: structuredClone(f.row.record.proof),
    };
    f.row.record.participantPreparationHistory = [archive];
    f.selectProgram(combined);
    const next = installPlan(successor, "33333333-3333-4333-8333-333333333333", "qa-call");
    await f.operations.ensureNormalActorCapture(next);
    const actualFetch = f.dependencies.normalRealmFetch;
    let stopped = false;
    let interrupt = true;
    const signupEmails: string[] = [];
    f.dependencies.normalRealmFetch = async (input) => {
      const fetch = await actualFetch(input);
      return async (url, init) => {
        const request = new Request(url, init);
        if (new URL(request.url).pathname === "/api/auth/sign-up/email") {
          signupEmails.push(
            z.object({ email: z.string() }).parse(await request.clone().json()).email,
          );
        }
        const response = await fetch(request);
        if (interrupt && new URL(request.url).pathname === "/api/auth/sign-up/email") {
          interrupt = false;
          stopped = true;
        }
        return response;
      };
    };
    const first = worker(successor, requireFixture(successor.effects[0]));
    const assertFirst = first.assertCurrent;
    first.assertCurrent = async () => {
      if (stopped) {
        throw new Error("fixture stopped");
      }
      await assertFirst();
    };
    await expect(f.operations.prepareNormalActorAccounts(first)).rejects.toBeDefined();
    const interrupted = await f.journal.read(context);
    expect(interrupted?.state.actors.find((actor) => actor.actorKey === "qa-1")?.signup).toBe(
      "attempted",
    );
    // Stop releases only the local fence, preserving the unfinished effect.
    delete f.row.record.leaseId;
    delete f.row.record.leaseExpiresAt;
    expect(currentOperator().receipts).toEqual([]);
    stopped = false;
    const resumed = worker(successor, requireFixture(successor.effects[0]));
    await f.operations.prepareNormalActorAccounts(resumed);
    const saved = await f.journal.read(context);
    if (saved === undefined) {
      throw new Error("missing resumed account state");
    }
    await f.operations.verifyNormalActorAccounts({
      ...resumed,
      accountPreparation: saved.preparation,
      checkpointAccountPreparation: requireFixture(resumed.checkpointAccountPreparation),
    });
    expect(signupEmails).toHaveLength(7);
    expect(new Set(signupEmails).size).toBe(7);
    expect(saved.state.actors[0]).toEqual(captureState.actors[0]);
    expect(f.captures).toEqual([{ actorKey: "owner", organizationId: undefined }]);
    settle();
    expect(createParticipantSuccessorPlan(f.row.record, combined, now)).toBeUndefined();
    const prepared = await f.journal.read(context);
    if (prepared === undefined) {
      throw new Error("missing completed successor");
    }
    const organizations = await f.operations.readNormalActorOrganizationProofs({
      ...context,
      plan: successor,
      ...prepared,
    });
    const { normalActorPredecessor, ...appBase } = successor;
    void normalActorPredecessor;
    const full = hostedOperatorPlanSchema.parse({
      ...appBase,
      access: proposeResolvedNormalActorAccess(combined, prepared.state),
      authMembership: { kind: "create-owned-organizations", organizations },
      effects: [
        { description: "Fixture resources", id: "resources", kind: "resources" },
        { description: "Fixture install", id: "install", kind: "install" },
        ...combined.organizations.map((org) => ({
          description: "Approved QA organization",
          id: `auth-membership:${org.organizationId}`,
          kind: "auth-membership",
        })),
        { description: "Approved QA grants", id: "access", kind: "access" },
        { description: "Fixture bindings", id: "bindings", kind: "bindings" },
      ],
      normalActorPreparation: normalActorPreparationSchema.strip().parse(prepared.preparation),
      retention: plan.retention,
      stage: "app",
    });
    const fullInput = installPlan(full, "44444444-4444-4444-8444-444444444444", "qa-app-call");
    for (const effect of full.effects.filter((entry) => entry.kind === "auth-membership")) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each selected organization owns a distinct journal fence.
      await f.operations.prepareNormalActorMemberships(worker(full, effect));
    }
    await f.operations.verifyNormalActorMemberships(
      worker(full, requireFixture(full.effects.find((entry) => entry.kind === "auth-membership"))),
    );
    settle();
    // The completed predecessor app also expires; the newly approved current plan remains valid.
    now += 2000;
    const projection = await runtime(fullInput);
    expect(projection?.identities.actors).toHaveLength(8);
    expect(
      projection?.identities.actors.filter((actor) => actor.organizationId !== null),
    ).toHaveLength(7);
    expect(projection?.identities.actors.find((actor) => actor.actorKey === "owner")).toMatchObject(
      { organizationId: null, roles: [] },
    );
    expect(full.access).toHaveLength(7);
    const history = structuredClone(f.row.record.participantPreparationHistory);
    expect(history?.[0]).toEqual(archive);
    const afterHandoff = await f.journal.read(context);
    expect(afterHandoff?.state.actors[0]).toEqual(captureState.actors[0]);
    now = Date.parse(full.retention.expiresAt);
    await expect(runtime(fullInput)).rejects.toMatchObject({ code: "authorization_required" });
    now = Date.now() + 4000;
    for (const callId of ["capture-call", "app-call", "qa-call", "qa-app-call"]) {
      const approval = requireFixture(approvals.get(callId));
      approvals.delete(callId);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Revoke and restore each independent canonical authority in sequence.
      await expect(runtime(fullInput)).rejects.toMatchObject({ code: "authorization_required" });
      approvals.set(callId, approval);
    }
    const validTime = now;
    now = Date.parse(session.expiresAt) + 1;
    await expect(runtime(fullInput)).rejects.toMatchObject({ code: "auth_identity_required" });
    now = validTime;
    const beforeScopeDrift = await f.journal.read(context);
    const scoped = beforeScopeDrift?.state.organizationSessions?.find(
      (entry) => entry.actorKey === "qa-1",
    );
    if (scoped === undefined) {
      throw new Error("missing scoped QA fixture");
    }
    const deselected = await f.auth.handler(
      new Request(`${program.origin}/api/auth/organization/create`, {
        body: JSON.stringify({ name: "Different live QA selection", slug: "outside-approved-qa" }),
        headers: {
          "content-type": "application/json",
          cookie: scoped.storageState.cookies
            .map((cookie) => `${cookie.name}=${cookie.value}`)
            .join("; "),
          origin: program.origin,
        },
        method: "POST",
      }),
    );
    expect(deselected.status).toBe(200);
    await expect(runtime(fullInput)).rejects.toMatchObject({ code: "auth_identity_required" });
    expect(f.row.record.participantPreparationHistory).toEqual(history);
  }, 30_000);

  it.each([
    "valid",
    "invalid",
    "expired",
    "cancelled",
    "foreign-lease",
    "stale-fence",
    "expired-lease",
  ] as const)(
    "checkpoints owner-confirmed capture completion only after %s session verification",
    async (outcome) => {
      const capturedProgram = normalActorProgramSchema.parse({
        ...program,
        actors: [{ ...program.actors[0], account: "capture-existing" }],
        appAccess: [],
        memberships: [],
        organizations: [],
      });
      const f = fixture(false, capturedProgram);
      await expect(f.operations.ensureNormalActorCapture(f.preflight)).rejects.toThrow(
        "fixture_capture_required",
      );
      const client = createHostedOperatorNormalAuthClient({
        assertApprovedEffect: f.effect.assertCurrent,
        fetch: async (url, init) => await f.auth.handler(new Request(url, init)),
        origin: capturedProgram.origin,
      });
      await client.signUp({
        email: "owner@example.com",
        name: "Owner",
        password: randomUUID(),
      });
      const session = await client.getSession();
      if (session === null) {
        throw new Error("fixture_missing_session");
      }
      const state = initialNormalActorState(capturedProgram, accountOperationRef);
      state.actors = [
        {
          actorKey: "owner",
          session: {
            actorId: outcome === "invalid" ? "other-actor" : session.actorId,
            expiresAt: session.expiresAt,
            origin: capturedProgram.origin,
            realmSessionId: session.sessionId,
            reference: randomUUID(),
          },
          signup: "complete",
          storageState: client.exportStorageState(),
        },
      ];
      await f.journal.checkpoint(context, state);
      // Owner confirmation stores the complete captured state before its effect reconciliation.
      const preparation = f.row.record.accountPreparation;
      if (preparation === undefined) {
        throw new Error("fixture_missing_preparation");
      }
      delete preparation.accountsCompletedAt;
      if (outcome === "expired") {
        f.journalPorts.now = () => Date.parse(session.expiresAt) + 1;
      }
      const { leaseId } = f.row.record;
      if (leaseId === undefined || f.row.record.operator === undefined) {
        throw new Error("fixture_missing_lease");
      }
      f.effect.leaseId = outcome === "foreign-lease" ? randomUUID() : leaseId;
      f.row.record.leaseExpiresAt =
        outcome === "expired-lease" ? "2020-01-01T00:00:00.000Z" : "2030-01-01T00:00:00.000Z";
      f.row.record.operator.fenceGeneration =
        outcome === "stale-fence" ? f.effect.fenceGeneration + 1 : f.effect.fenceGeneration;
      const authorityPorts = createNormalActorJournalAuthority({
        assertApprovedOwner: f.journalPorts.assertAuthorized,
        assertCanonicalOwner: f.journalPorts.assertAuthorized,
        keyring: f.journalPorts.keyring,
        now: f.journalPorts.now,
        readApproval: async (input) => ({
          action: input.action,
          approvalId: "initial-approval",
          approved: true,
          callId: input.callId,
          planDigest: input.planDigest,
        }),
        store: f.journalPorts.store,
      });
      Object.assign(f.journalPorts, authorityPorts);
      const before = structuredClone(f.row);
      // A final verifier with only idle-owner context must not mutate an active lease.
      await expect(authorityPorts.assertMutationAuthority(context, before)).rejects.toMatchObject({
        code: "operation_in_progress",
      });
      const requestCount = f.requests.length;
      const verify = f.operations.verifyNormalActorAccounts({
        ...f.effect,
        accountPreparation: preparation,
        assertCurrent: async () => {
          await f.effect.assertCurrent();
          if (outcome === "cancelled") {
            throw new Error("cancelled");
          }
        },
        checkpointAccountPreparation: f.checkpointAccountPreparation,
        plan: f.preflight.plan,
      });
      if (outcome === "valid") {
        await verify;
        expect(f.row.record.accountPreparation?.accountsCompletedAt).toBeDefined();
        const saved = await f.journal.read(context);
        expect(saved?.state).toEqual(state);
        expect(f.row.record.accountPreparation?.accountPlan).toEqual(preparation.accountPlan);
      } else {
        await expect(verify).rejects.toThrow();
        expect(f.row).toEqual(before);
      }
      expect(f.requests.slice(requestCount).every((request) => request.method === "GET")).toBe(
        true,
      );
    },
  );
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
      ...f.effect,
      accountPreparation: saved.preparation,
      assertCurrent: f.effect.assertCurrent,
      checkpointAccountPreparation: f.checkpointAccountPreparation,
      plan: f.preflight.plan,
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
      access: proposeResolvedNormalActorAccess(program, saved.state),
      authMembership: { kind: "create-owned-organizations", organizations },
      effects: [
        { description: "Fixture resources", id: "resources", kind: "resources" },
        { description: "Fixture installation", id: "install", kind: "install" },
        { description: "One", id: "auth-membership:org-one", kind: "auth-membership" },
        { description: "Two", id: "auth-membership:org-two", kind: "auth-membership" },
        { description: "Fixture access", id: "access", kind: "access" },
        { description: "Fixture bindings", id: "bindings", kind: "bindings" },
      ],
      normalActorPreparation: {
        accountApprovalId: saved.preparation.accountApprovalId,
        accountApprovedByCallId: saved.preparation.accountApprovedByCallId,
        accountOperationRef,
        accountPlanDigest: saved.preparation.accountPlanDigest,
        programDigest: saved.preparation.programDigest,
      },
      stage: "app",
    });
    const first = fullPlan.effects.find((entry) => entry.id === "auth-membership:org-one");
    const second = fullPlan.effects.find((entry) => entry.id === "auth-membership:org-two");
    if (!first || !second) {
      throw new Error("fixture_missing_effect");
    }
    const appOperationRef = "22222222-2222-4222-8222-222222222222";
    const firstState = await f.operations.prepareNormalActorMemberships({
      ...f.effect,
      effect: first,
      operationRef: appOperationRef,
      plan: fullPlan,
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
      effect: second,
      operationRef: appOperationRef,
      plan: fullPlan,
    });
    const before = f.requests.length;
    const verified = await f.operations.verifyNormalActorMemberships({
      ...f.effect,
      effect: second,
      operationRef: appOperationRef,
      plan: fullPlan,
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
      assertApprovedEffect: f.effect.assertCurrent,
      fetch: f.localFetch,
      origin: program.origin,
      storageState: ownerContext.storageState,
    });
    await normal.setActiveOrganization({ organizationId: "org-two" });
    const beforeStaleVerify = f.requests.length;
    await expect(
      f.operations.verifyNormalActorMemberships({
        ...f.effect,
        effect: second,
        operationRef: appOperationRef,
        plan: fullPlan,
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
        effect: { ...first, id: "auth-membership" },
        plan: fullPlan,
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
        ...f.effect,
        accountPreparation: saved.preparation,
        assertCurrent: f.effect.assertCurrent,
        checkpointAccountPreparation: f.checkpointAccountPreparation,
        plan: f.preflight.plan,
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
  it.each(["expired", "different-actor"] as const)(
    "requests an ordinary reconnect for an %s captured session without weakening identity checks",
    async (outcome) => {
      const capturedProgram = normalActorProgramSchema.parse({
        ...program,
        actors: [{ ...program.actors[0], account: "capture-existing" }],
        appAccess: [],
        memberships: [],
        organizations: [],
      });
      const f = fixture(false, capturedProgram);
      await expect(f.operations.ensureNormalActorCapture(f.preflight)).rejects.toThrow(
        "fixture_capture_required",
      );
      const client = createHostedOperatorNormalAuthClient({
        assertApprovedEffect: f.effect.assertCurrent,
        fetch: async (url, init) => await f.auth.handler(new Request(url, init)),
        origin: capturedProgram.origin,
      });
      await client.signUp({ email: "owner@example.com", name: "Owner", password: randomUUID() });
      const session = await client.getSession();
      if (session === null) {
        throw new Error("fixture_missing_session");
      }
      const state = initialNormalActorState(capturedProgram, accountOperationRef);
      state.actors = [
        {
          actorKey: "owner",
          session: {
            actorId: outcome === "different-actor" ? "foreign" : session.actorId,
            expiresAt: session.expiresAt,
            origin: capturedProgram.origin,
            realmSessionId: session.sessionId,
            reference: randomUUID(),
          },
          signup: "complete",
          storageState: client.exportStorageState(),
        },
      ];
      await f.journal.checkpoint(context, state);
      if (outcome === "expired") {
        f.journalPorts.now = () => Date.parse(session.expiresAt) + 1;
      }
      const beforeRequests = f.requests.length;
      const beforeCaptures = f.captures.length;
      if (outcome === "expired") {
        await expect(f.operations.ensureNormalActorCapture(f.preflight)).rejects.toThrow(
          "fixture_capture_required",
        );
        expect(f.captures.slice(beforeCaptures)).toEqual([
          { actorKey: "owner", organizationId: undefined },
        ]);
        expect(f.requests).toHaveLength(beforeRequests);
      } else {
        await expect(f.operations.ensureNormalActorCapture(f.preflight)).rejects.toMatchObject({
          code: "auth_identity_required",
        });
        expect(f.captures).toHaveLength(beforeCaptures);
      }
    },
  );
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
      account: "create-email-password" as const,
      actorKey: `actor-${index}`,
      email: `actor${index}@example.com`,
      name: `Actor ${index}`,
    }));
    const selectedProgram = normalActorProgramSchema.parse({
      ...program,
      actors,
      appAccess: [],
      memberships: program.organizations.flatMap((organization) =>
        actors.map((actor, index) => ({
          actorKey: actor.actorKey,
          organizationId: organization.organizationId,
          role: index === 0 ? "owner" : "member",
        })),
      ),
      organizations: program.organizations.map((organization) => ({
        ...organization,
        ownerActorKey: "actor-0",
      })),
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
        assertApprovedOwner: async (ownedContext) => {
          fullJournal += 1;
          await canonical(ownedContext);
        },
        assertCanonicalOwner: canonical,
        keyring: f.journalPorts.keyring,
        now: Date.now,
        readApproval: async (input) => ({
          action: input.action,
          approvalId: "initial-approval",
          approved: true,
          callId: input.callId,
          planDigest: input.planDigest,
        }),
        store: f.journalPorts.store,
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
            record: {
              ...f.row.record,
              leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
            revision: f.row.revision + 1,
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
        checkpoints,
        fullJournal,
        fullService,
        observations,
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
