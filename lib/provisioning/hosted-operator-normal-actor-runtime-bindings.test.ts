/* oxlint-disable eslint/require-await, unicorn/no-useless-undefined -- Fixture authority and CAS preserve the asynchronous real journal interfaces. */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  hostedOperatorPlanSchema,
  operatorPlanDigest,
  HostedOperatorError,
} from "./hosted-operator-contract";
import {
  initialNormalActorState,
  normalActorProgramSchema,
  normalActorProgramDigest,
  normalBrowserStorageStateSchema,
  proposeResolvedNormalActorAccess,
} from "./hosted-operator-normal-actor-program";
import type {
  NormalBrowserStorageState,
  NormalActorSessionRef,
} from "./hosted-operator-normal-actor-program";
import { createNormalActorJournal } from "./hosted-operator-normal-actor-journal";
import type { NormalActorJournalPorts } from "./hosted-operator-normal-actor-journal";
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import type { HostedRuntimeJournalRow } from "./hosted-runtime-journal";
import { createNormalActorRuntimeBindings } from "./hosted-operator-normal-actor-runtime-bindings";

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
    {
      actorKey: "no-access",
      email: "no-access@example.com",
      name: "No access",
      account: "create-email-password",
    },
    {
      actorKey: "unassigned",
      email: "unassigned@example.com",
      name: "Unassigned",
      account: "create-email-password",
    },
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
    { actorKey: "no-access", organizationId: "org-one", role: "member" },
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
const faults = [
  "revoked",
  "wrong-session",
  "wrong-actor",
  "wrong-email",
  "wrong-organization",
  "wrong-role",
  "expired",
] as const;
type Fault = (typeof faults)[number];
interface RuntimeSession {
  session: NormalActorSessionRef;
  actorKey: string;
  organizationId: string | null;
}
const normalSessionResponse = (saved: RuntimeSession, email: string, fault: Fault | undefined) =>
  Response.json({
    session: {
      id: fault === "wrong-session" ? "wrong-session" : saved.session.realmSessionId,
      userId: fault === "wrong-actor" ? "wrong-actor" : saved.session.actorId,
      expiresAt: fault === "expired" ? "2020-01-01T00:00:00.000Z" : saved.session.expiresAt,
      activeOrganizationId: fault === "wrong-organization" ? "org-two" : saved.organizationId,
    },
    user: {
      id: fault === "wrong-actor" ? "wrong-actor" : saved.session.actorId,
      email: fault === "wrong-email" ? "different@example.com" : email,
    },
  });
const fixture = async (fault?: Fault) => {
  let row: HostedRuntimeJournalRow = {
    revision: 1,
    record: hostedRuntimeJournalRecordSchema.parse({
      kind: "app-runtime",
      version: 1,
      request: target,
      approvedByCallId: "initial-call",
      status: "pending",
      step: "reserved",
      operator: {
        mode: "protected-operator-v1",
        operationRef: accountOperationRef,
        plan,
        planDigest: operatorPlanDigest(plan),
        approvalId: "first-account-approval",
        receipts: [],
      },
    }),
  };
  let firstApproval = true;
  let currentPlan = true;
  let finalDenied = false;
  let currentChecks = 0;
  const assertOwner = async () => {
    if (!currentPlan) {
      throw new HostedOperatorError("authorization_required");
    }
  };
  const journalPorts: NormalActorJournalPorts = {
    keyring: { tokenKey: Buffer.alloc(32, 7), tokenKeyVersion: "v1" },
    now: () => Date.now(),
    assertAuthorized: assertOwner,
    assertAccountApproval: async (_context, preparation) => {
      if (!firstApproval) {
        throw new HostedOperatorError("authorization_required");
      }
      expect(preparation.accountOperationRef).toBe(accountOperationRef);
      expect(preparation.accountApprovalId).toBe("first-account-approval");
      expect(preparation.accountPlanDigest).toBe(operatorPlanDigest(plan));
    },
    assertMutationAuthority: async (_context, current) => {
      expect(current.revision).toBe(row.revision);
      expect(current.record.leaseId).toBeUndefined();
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
  const journal = createNormalActorJournal(journalPorts);
  await journal.retain(context, {
    program,
    programDigest: normalActorProgramDigest(program),
    accountOperationRef,
    accountPlan: plan,
    accountPlanDigest: operatorPlanDigest(plan),
    accountApprovalId: "first-account-approval",
    accountApprovedByCallId: "initial-call",
  });
  const storage = (cookie: string): NormalBrowserStorageState => ({
    cookies: [
      {
        name: "__Secure-runtime-session",
        value: cookie,
        domain: new URL(program.origin).hostname,
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ],
    origins: [],
  });
  const state = initialNormalActorState(program, accountOperationRef);
  state.actors = program.actors.map((actor, index) => ({
    actorKey: actor.actorKey,
    signup: "complete",
    credentials: { password: randomBytes(32).toString("base64url") },
    session: {
      reference: `33333333-3333-4333-8333-${String(index + 1).padStart(12, "0")}`,
      actorId: `id-${actor.actorKey}`,
      realmSessionId: `base-${actor.actorKey}`,
      origin: program.origin,
      expiresAt: "2030-01-01T00:00:00.000Z",
      activeOrganizationId: null,
    },
    storageState: storage(`private-base-${actor.actorKey}`),
  }));
  state.organizations = state.organizations.map((entry) => ({ ...entry, status: "complete" }));
  state.memberships = state.memberships.map((entry) => ({ ...entry, status: "complete" }));
  state.organizationSessions = program.memberships.map((membership, index) => ({
    actorKey: membership.actorKey,
    organizationId: membership.organizationId,
    selection: "selected",
    session: {
      reference: `44444444-4444-4444-8444-${String(index + 1).padStart(12, "0")}`,
      actorId: `id-${membership.actorKey}`,
      realmSessionId: `scoped-${index}`,
      origin: program.origin,
      expiresAt: "2030-01-01T00:00:00.000Z",
      activeOrganizationId: membership.organizationId,
    },
    storageState: storage(`private-scoped-${index}`),
  }));
  await journal.checkpoint(context, state);
  const retained = await journal.read(context);
  if (retained === undefined) {
    throw new Error("fixture_missing_preparation");
  }
  const specs = program.organizations.map((entry) => ({
    kind: "create-owned-organization",
    organizationId: entry.organizationId,
    name: entry.name,
    slug: entry.slug,
    actorId: "id-owner",
    bootstrapPlanDigest: "d".repeat(64),
    identityNonceSha256: "e".repeat(64),
    identityCapture: {
      capturedAt: new Date().toISOString(),
      realmSessionId: `signed-${entry.organizationId}`,
    },
    identityProof: { reference: `private-${entry.organizationId}-proof`, sha256: "f".repeat(64) },
    identityVerification: {
      issuer: program.origin,
      audience: "https://operator.example.com",
      jwksUrl: "https://gateway.example.test/_platform/jwks.json",
      transportSource: {
        issuer: "https://oidc.vercel.com",
        audience: "https://operator.example.com",
        ownerId: "team",
        projectId: "prj_operator",
        environment: "preview",
      },
    },
  }));
  const fullPlan = hostedOperatorPlanSchema.parse({
    ...plan,
    stage: "app",
    normalActorPreparation: {
      programDigest: retained.preparation.programDigest,
      accountOperationRef,
      accountPlanDigest: retained.preparation.accountPlanDigest,
      accountApprovalId: retained.preparation.accountApprovalId,
      accountApprovedByCallId: retained.preparation.accountApprovedByCallId,
    },
    access: proposeResolvedNormalActorAccess(program, state),
    authMembership: { kind: "create-owned-organizations", organizations: specs },
    effects: [
      { kind: "resources", id: "resources", description: "Fixture resources" },
      { kind: "install", id: "install", description: "Fixture app" },
      { kind: "auth-membership", id: "auth-membership:org-one", description: "One" },
      { kind: "auth-membership", id: "auth-membership:org-two", description: "Two" },
      { kind: "access", id: "access", description: "Fixture roles" },
      { kind: "bindings", id: "bindings", description: "Fixture runtime" },
    ],
  });
  row = {
    revision: row.revision + 1,
    record: hostedRuntimeJournalRecordSchema.parse({
      ...row.record,
      approvedByCallId: "current-call",
      operator: {
        mode: "protected-operator-v1",
        operationRef: "22222222-2222-4222-8222-222222222222",
        plan: fullPlan,
        planDigest: operatorPlanDigest(fullPlan),
        approvalId: "current-approval",
        receipts: [],
      },
    }),
  };
  const requests: Request[] = [];
  const sessions = new Map<
    string,
    { session: NormalActorSessionRef; actorKey: string; organizationId: string | null }
  >();
  for (const actor of state.actors) {
    if (actor.session !== undefined && actor.storageState !== undefined) {
      const [cookie] = actor.storageState.cookies;
      if (cookie !== undefined) {
        sessions.set(cookie.value, {
          session: actor.session,
          actorKey: actor.actorKey,
          organizationId: null,
        });
      }
    }
  }
  for (const actor of state.organizationSessions) {
    const [cookie] = actor.storageState.cookies;
    if (cookie !== undefined) {
      sessions.set(cookie.value, {
        session: actor.session,
        actorKey: actor.actorKey,
        organizationId: actor.organizationId,
      });
    }
  }
  const fetch: typeof globalThis.fetch = async (targetUrl, init) => {
    const request = new Request(targetUrl, init);
    requests.push(request);
    expect(request.method).toBe("GET");
    expect(new URL(request.url).origin).toBe(program.origin);
    const cookie = request.headers.get("cookie")?.split("=").slice(1).join("=");
    const saved = cookie === undefined ? undefined : sessions.get(cookie);
    if (saved === undefined) {
      return new Response(null, { status: 401 });
    }
    const actor = program.actors.find((entry) => entry.actorKey === saved.actorKey);
    if (actor === undefined) {
      throw new Error("fixture_missing_actor");
    }
    const fail = saved.actorKey === "owner" && saved.organizationId === "org-one";
    if (new URL(request.url).pathname === "/api/auth/get-session") {
      if (fail && fault === "revoked") {
        return Response.json(null);
      }
      return normalSessionResponse(saved, actor.email, fail ? fault : undefined);
    }
    const url = new URL(request.url);
    expect(url.pathname).toBe("/api/auth/organization/list-members");
    expect(url.searchParams.get("organizationId")).toBe(saved.organizationId);
    expect(url.searchParams.get("filterField")).toBe("userId");
    expect(url.searchParams.get("filterValue")).toBe(saved.session.actorId);
    const membership = program.memberships.find(
      (entry) => entry.actorKey === saved.actorKey && entry.organizationId === saved.organizationId,
    );
    if (membership === undefined) {
      throw new Error("fixture_missing_membership");
    }
    return Response.json({
      total: 1,
      members: [
        {
          id: `member-${saved.actorKey}-${saved.organizationId}`,
          userId: saved.session.actorId,
          organizationId: saved.organizationId,
          role: fail && fault === "wrong-role" ? "admin" : membership.role,
          user: { id: saved.session.actorId, email: actor.email },
        },
      ],
    });
  };
  const runtime = createNormalActorRuntimeBindings({
    journalPorts,
    assertCurrentPlan: async (input) => {
      currentChecks += 1;
      await assertOwner();
      expect(input.operationRef).toBe("22222222-2222-4222-8222-222222222222");
      if (finalDenied && currentChecks === 2) {
        throw new HostedOperatorError("authorization_required");
      }
    },
    normalRealmFetch: async (input) => {
      expect(input.origin).toBe(program.origin);
      return fetch;
    },
  });
  const input = {
    ...context,
    plan: fullPlan,
    operationRef: "22222222-2222-4222-8222-222222222222",
  };
  return {
    runtime,
    input,
    state,
    journal,
    requests,
    get row() {
      return row;
    },
    get currentChecks() {
      return currentChecks;
    },
    revokeFirst() {
      firstApproval = false;
    },
    revokeCurrent() {
      currentPlan = false;
    },
    denyFinal() {
      finalDenied = true;
    },
  };
};

const denied = async (operation: Promise<unknown>, code: string) => {
  let result = "returned-private-state";
  try {
    await operation;
  } catch (error) {
    result = error instanceof HostedOperatorError ? error.code : "unexpected-authority-failure";
  }
  expect(result).toBe(code);
};
describe("fresh authenticated normal actor runtime bindings", () => {
  it("decrypts only original account state and reads each projected jar and organization membership once", async () => {
    const f = await fixture();
    const projection = await f.runtime(f.input);
    if (projection === undefined) {
      throw new Error("fixture_missing_projection");
    }
    expect(projection.identities.actors).toHaveLength(6);
    expect(
      f.requests.filter((request) => new URL(request.url).pathname === "/api/auth/get-session"),
    ).toHaveLength(6);
    expect(
      f.requests.filter(
        (request) => new URL(request.url).pathname === "/api/auth/organization/list-members",
      ),
    ).toHaveLength(5);
    expect(
      new Set(
        f.requests
          .filter((request) => new URL(request.url).pathname === "/api/auth/get-session")
          .map((request) => request.headers.get("cookie")),
      ).size,
    ).toBe(6);
    expect(
      projection.identities.actors.find((actor) => actor.actorKey === "no-access")?.roles,
    ).toEqual([]);
    expect(
      projection.identities.actors.find((actor) => actor.actorKey === "unassigned")?.organizationId,
    ).toBeNull();
    for (const identity of projection.identities.actors) {
      const content = projection.files[identity.storageState];
      if (content === undefined) {
        throw new Error("fixture_missing_storage");
      }
      expect(normalBrowserStorageStateSchema.parse(JSON.parse(content)).cookies).toHaveLength(1);
    }
    expect(f.currentChecks).toBe(2);
    const [actor] = f.state.actors;
    expect(JSON.stringify(f.row.record.accountPreparation)).not.toContain(
      actor?.credentials?.password ?? "fixture-missing-password",
    );
    const retained = await f.journal.read(context);
    expect(retained?.preparation.accountOperationRef).toBe(accountOperationRef);
  });
  it.each(faults)("denies live %s without returning runtime credentials", async (fault) => {
    const f = await fixture(fault);
    await denied(f.runtime(f.input), "auth_identity_required");
  });
  it("denies revoked first and current approvals before any normal HTTP request", async () => {
    const first = await fixture();
    first.revokeFirst();
    await denied(first.runtime(first.input), "authorization_required");
    expect(first.requests).toHaveLength(0);
    const current = await fixture();
    current.revokeCurrent();
    await denied(current.runtime(current.input), "authorization_required");
    expect(current.requests).toHaveLength(0);
  });
  it("denies changed original frozen approval references before reading a jar", async () => {
    const f = await fixture();
    const frozen = f.input.plan.normalActorPreparation;
    if (frozen === undefined) {
      throw new Error("fixture_missing_original_scope");
    }
    const changes = [
      { accountOperationRef: "55555555-5555-4555-8555-555555555555" },
      { accountPlanDigest: "a".repeat(64) },
      { accountApprovalId: "different-first-approval" },
      { accountApprovedByCallId: "different-first-call" },
      { programDigest: "a".repeat(64) },
    ];
    await Promise.all(
      changes.map(async (change) => {
        await denied(
          f.runtime({
            ...f.input,
            plan: { ...f.input.plan, normalActorPreparation: { ...frozen, ...change } },
          }),
          "resource_mismatch",
        );
      }),
    );
    expect(f.requests).toHaveLength(0);
  });
  it("denies a final current-plan revocation after complete live reads", async () => {
    const f = await fixture();
    f.denyFinal();
    await denied(f.runtime(f.input), "authorization_required");
    expect(f.requests).toHaveLength(11);
    expect(f.currentChecks).toBe(2);
  });
  it("returns legacy undefined without journal or HTTP authorization effects", async () => {
    const f = await fixture();
    const legacy = hostedOperatorPlanSchema.parse({
      ...plan,
      stage: "app",
      normalActorProgram: undefined,
      effects: [
        { kind: "resources", id: "resources", description: "Fixture resources" },
        { kind: "install", id: "install", description: "Fixture app" },
        { kind: "access", id: "access", description: "Fixture access" },
        { kind: "bindings", id: "bindings", description: "Fixture binding" },
      ],
    });
    expect(await f.runtime({ ...f.input, plan: legacy })).toBeUndefined();
    expect(f.requests).toHaveLength(0);
    expect(f.currentChecks).toBe(0);
  });
});
