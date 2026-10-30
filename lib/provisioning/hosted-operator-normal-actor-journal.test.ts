/* oxlint-disable eslint/require-await, unicorn/no-useless-undefined, typescript/consistent-return -- In-memory CAS is asynchronous and returns undefined for a real lost conditional write. */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import {
  initialNormalActorState,
  normalActorProgramDigest,
  normalActorProgramSchema,
} from "./hosted-operator-normal-actor-program";
import {
  createNormalActorJournal,
  normalActorCaptureCookieDigest,
} from "./hosted-operator-normal-actor-journal";
import { hostedOperatorRealmLinkConfigSha256 } from "./hosted-operator-realm-link-config";
import {
  retainedOperatorAuthFromJournal,
  hostedRuntimeJournalRecordSchema,
} from "./hosted-runtime-journal";
import type { HostedRuntimeJournalRow } from "./hosted-runtime-journal";
import { createNormalActorJournalAuthority } from "./hosted-operator-normal-actor-authority";
import { confirmNormalActorCapture } from "./hosted-operator-normal-actor-confirmation";

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
  origin: "https://apps.example.test",
  actors: [
    { actorKey: "owner", email: "owner@example.test", name: "Owner", account: "capture-existing" },
  ],
  organizations: [],
  memberships: [],
  appAccess: [],
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
const preparationInput = {
  program,
  programDigest: normalActorProgramDigest(program),
  accountOperationRef,
  accountPlan: plan,
  accountPlanDigest: operatorPlanDigest(plan),
  accountApprovalId: "initial-approval",
  accountApprovedByCallId: "initial-call",
};
const normalCookie = {
  name: "__Secure-session",
  value: "actual%2Fencoded%3Dcookie",
  domain: "apps.example.test",
  path: "/",
  expires: -1 as const,
  httpOnly: true as const,
  secure: true as const,
  sameSite: "Lax" as const,
  hostOnly: true,
};
const fixture = (selectedPreparation = preparationInput) => {
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
        plan: selectedPreparation.accountPlan,
        planDigest: selectedPreparation.accountPlanDigest,
        approvalId: "initial-approval",
        receipts: [],
      },
      privateState: {
        encryptedToken: "resource-private-state",
        keyVersion: "v1",
        tokenIv: "resource-iv",
        tokenTag: "resource-tag",
      },
    }),
  };
  let approved = true;
  let owned = true;
  let conflict = false;
  let writes = 0;
  let approvals = 0;
  const journal = createNormalActorJournal({
    keyring: { tokenKey: Buffer.alloc(32, 7), tokenKeyVersion: "v1" },
    now: () => Date.now(),
    assertAuthorized: async (input) => {
      if (
        !owned ||
        input.authority.ownerUserId !== authority.ownerUserId ||
        input.target.sessionId !== target.sessionId
      ) {
        throw new Error("owner_revoked");
      }
    },
    assertAccountApproval: async (_context, preparation) => {
      approvals += 1;
      if (
        !approved ||
        preparation.accountApprovalId !== "initial-approval" ||
        preparation.accountPlanDigest !== selectedPreparation.accountPlanDigest ||
        preparation.accountOperationRef !== accountOperationRef
      ) {
        throw new Error("approval_revoked");
      }
    },
    assertMutationAuthority: async (_context, current) => {
      if (current.record.leaseId !== row.record.leaseId || current.revision !== row.revision) {
        throw new Error("lease_changed");
      }
    },
    store: {
      read: async () => structuredClone(row),
      compareAndSet: async (input): Promise<HostedRuntimeJournalRow | undefined> => {
        if (conflict) {
          conflict = false;
          row = { ...row, revision: row.revision + 1 };
          return;
        }
        if (input.expectedRevision !== row.revision) {
          return undefined;
        }
        writes += 1;
        row = {
          record: hostedRuntimeJournalRecordSchema.parse(input.record),
          revision: row.revision + 1,
        };
        return structuredClone(row);
      },
    },
  });
  return {
    journal,
    get row() {
      return row;
    },
    set row(value) {
      row = value;
    },
    get writes() {
      return writes;
    },
    get approvals() {
      return approvals;
    },
    revokeApproval() {
      approved = false;
    },
    revokeOwner() {
      owned = false;
    },
    conflictOnce() {
      conflict = true;
    },
  };
};

const organizationProofFixture = async () => {
  const selectedProgram = normalActorProgramSchema.parse({
    ...program,
    organizations: [
      { organizationId: "org-one", ownerActorKey: "owner", name: "One", slug: "one" },
    ],
    memberships: [{ actorKey: "owner", organizationId: "org-one", role: "owner" }],
  });
  const selectedPlan = hostedOperatorPlanSchema.parse({
    ...plan,
    normalActorProgram: selectedProgram,
  });
  const selectedPreparation = {
    ...preparationInput,
    program: selectedProgram,
    programDigest: normalActorProgramDigest(selectedProgram),
    accountPlan: selectedPlan,
    accountPlanDigest: operatorPlanDigest(selectedPlan),
  };
  const value = fixture(selectedPreparation);
  await value.journal.retain(context, selectedPreparation);
  const owner = {
    reference: "22222222-2222-4222-8222-222222222222",
    actorId: "actual-owner",
    realmSessionId: "actual-org-session",
    origin: program.origin,
    expiresAt: "2030-01-01T00:00:00.000Z",
  };
  const state = initialNormalActorState(selectedProgram, accountOperationRef);
  state.actors = [
    {
      actorKey: "owner",
      signup: "complete",
      session: owner,
      storageState: { cookies: [], origins: [] },
    },
  ];
  state.organizationSessions = [
    {
      actorKey: "owner",
      organizationId: "org-one",
      selection: "pending",
      session: owner,
      storageState: { cookies: [], origins: [] },
    },
  ];
  await value.journal.checkpoint(context, state);
  const binding = {
    audience: "https://operator.example.test",
    authResourceId: plan.authDatabase.resourceId,
    bootstrapPlanDigest: selectedPreparation.accountPlanDigest,
    browserOrigin: program.origin,
    endpointOrigin: program.origin,
    issuer: program.origin,
    transportSource: {
      audience: "https://operator.example.test",
      issuer: "https://oidc.vercel.com",
      ownerId: "team",
      projectId: "prj_operator",
      environment: "preview" as const,
    },
  };
  const input = { organizationId: "org-one", ownerActorKey: "owner", owner, binding };
  return { value, input, selectedPreparation };
};

const currentBootstrapFixture = async () => {
  const prepared = await organizationProofFixture();
  const { value, input, selectedPreparation } = prepared;
  const old = await value.journal.prepareOrganizationProof(context, input);
  const bootstrapPlan = hostedOperatorPlanSchema.parse({
    ...selectedPreparation.accountPlan,
    stage: "auth-bootstrap",
    authSchema: {
      artifactRef: "auth-artifact",
      installer: { reference: "auth-worker", sha256: "d".repeat(64) },
      planDigest: "e".repeat(64),
      targetDigest: "f".repeat(64),
    },
    bootstrap: { endpointId: "ep-owned", maintenanceDatabase: "neondb", role: "neondb_owner" },
    resourcesInstaller: { reference: "resources-worker", sha256: "c".repeat(64) },
    gatewayBindings: {
      authBrowserOrigin: program.origin,
      builderCallbackOrigin: "https://builder.example.test",
      operatorOrigin: input.binding.audience,
      catalogAppIds: [target.appId],
      sourceWorkload: { ...input.binding.transportSource, subject: "builder-workload" },
    },
    gatewayDelivery: {
      projectId: "prj_gateway",
      branch: target.branch,
      repoId: "gateway-repo",
      gitSha: "c".repeat(40),
    },
    effects: [
      { id: "auth-resources", kind: "resources", description: "Auth", resourceId: "auth-resource" },
      { id: "app-resources", kind: "resources", description: "App", resourceId: "app-resource" },
      { id: "auth-schema", kind: "install", description: "Auth schema" },
      { id: "gateway-bindings", kind: "gateway-bindings", description: "Gateway configuration" },
      { id: "gateway-delivery", kind: "gateway-delivery", description: "Gateway delivery" },
    ],
  });
  const operationRef = "33333333-3333-4333-8333-333333333333";
  const observedAt = new Date().toISOString();
  const candidate = {
    projectId: "prj_gateway",
    branch: target.branch,
    repoId: "gateway-repo",
    operationRef,
    origin: "https://refreshed-gateway.example.test",
    deploymentId: "refreshed-gateway",
    readyState: "READY" as const,
  };
  value.row = {
    revision: value.row.revision + 1,
    record: hostedRuntimeJournalRecordSchema.parse({
      ...value.row.record,
      leaseId: undefined,
      approvedByCallId: "bootstrap-call",
      operator: {
        mode: "protected-operator-v1",
        operationRef,
        plan: bootstrapPlan,
        planDigest: operatorPlanDigest(bootstrapPlan),
        approvalId: "bootstrap-approval",
        authPreparation: {
          assetSha256: "d".repeat(64),
          catalogFingerprint: "e".repeat(64),
          database: bootstrapPlan.authDatabase.database,
          runtimeRole: bootstrapPlan.authDatabase.runtimeRole,
          targetDigest: bootstrapPlan.authSchema?.targetDigest,
          observedAt,
        },
        receipts: bootstrapPlan.effects.map((effect) => ({
          effectId: effect.id,
          observedAt,
          resourceVersion: "actual-readback",
        })),
        gatewayEnvironment: [
          {
            key: "PLATFORM_REALM_OPERATOR_LINK_CONFIG",
            id: "owned-row",
            projectId: "prj_gateway",
            branch: target.branch,
            operationRef,
            comment: `App Builder protected operator ${operationRef}`,
            valueSha256: hostedOperatorRealmLinkConfigSha256(bootstrapPlan),
          },
        ],
        gatewayDeliveryCandidates: [candidate],
        deliveredGatewayDeploymentId: candidate.deploymentId,
      },
    }),
  };
  const auth = retainedOperatorAuthFromJournal(value.row.record);
  if (auth === undefined) {
    throw new Error("fixture bootstrap incomplete");
  }
  const bootstrap = { auth, candidate };
  const nextInput = {
    ...input,
    binding: { ...input.binding, endpointOrigin: candidate.origin },
    bootstrap,
    assertBootstrapCurrent: async () => {},
  };
  return { ...prepared, old, bootstrap, nextInput };
};

describe("retained actual normal actor journal", () => {
  it("rejects participant preparation when captured-account provenance is omitted or changed", async () => {
    const pointer = {
      preparation: {
        accountOperationRef,
        programDigest: preparationInput.programDigest,
        accountPlanDigest: preparationInput.accountPlanDigest,
        accountApprovalId: preparationInput.accountApprovalId,
        accountApprovedByCallId: preparationInput.accountApprovedByCallId,
      },
      bootstrapOperationRef: "33333333-3333-4333-8333-333333333333",
      bootstrapPlanDigest: "a".repeat(64),
      bootstrapApprovalId: "bootstrap-approval",
      bootstrapApprovedByCallId: "bootstrap-call",
    };
    const successorPlan = hostedOperatorPlanSchema.parse({
      ...plan,
      normalActorCapturePredecessor: pointer,
    });
    const successor = {
      ...preparationInput,
      accountPlan: successorPlan,
      accountPlanDigest: operatorPlanDigest(successorPlan),
    };
    const value = fixture();
    await expect(value.journal.retain(context, successor)).rejects.toThrow(
      "normal_actor_journal_authority_mismatch",
    );
    await expect(
      value.journal.retain(context, {
        ...successor,
        capturePredecessor: { ...pointer, bootstrapApprovalId: "other-approval" },
      }),
    ).rejects.toThrow("normal_actor_journal_authority_mismatch");
    expect(value.writes).toBe(0);
  });

  it("checks the actual lease and fence without renewing or mutating the CAS snapshot", async () => {
    const value = fixture();
    const now = Date.now();
    value.row = {
      ...value.row,
      record: hostedRuntimeJournalRecordSchema.parse({
        ...value.row.record,
        leaseExpiresAt: new Date(now + 60_000).toISOString(),
        operator: { ...value.row.record.operator, fenceGeneration: 1 },
      }),
    };
    const guard = createNormalActorJournalAuthority({
      store: { read: async () => structuredClone(value.row), compareAndSet: async () => undefined },
      keyring: { tokenKey: Buffer.alloc(32, 7), tokenKeyVersion: "v1" },
      now: () => now,
      assertCanonicalOwner: async () => undefined,
      assertApprovedOwner: async () => undefined,
      readApproval: async () => ({
        approvalId: "initial-approval",
        callId: "initial-call",
        planDigest: operatorPlanDigest(plan),
        action: "prepare",
        approved: true,
      }),
    });
    const effect = {
      ...context,
      effect: plan.effects[0],
      operationRef: accountOperationRef,
      plan,
      fenceGeneration: 1,
      leaseId: value.row.record.leaseId,
    };
    const snapshot = structuredClone(value.row);
    await guard.assertMutationAuthority(effect, snapshot);
    expect(value.row).toEqual(snapshot);
    const changedLease = { ...effect, leaseId: "55555555-5555-4555-8555-555555555555" };
    const changedFence = { ...effect, fenceGeneration: 2 };
    await expect(guard.assertMutationAuthority(changedLease, snapshot)).rejects.toThrow();
    await expect(guard.assertMutationAuthority(changedFence, snapshot)).rejects.toThrow();
    await expect(guard.assertMutationAuthority(context, snapshot)).rejects.toThrow();
    expect(value.writes).toBe(0);
  });

  it("permits only capture writes for the exact idle approved pending account attempt", async () => {
    const value = fixture();
    await value.journal.retain(context, preparationInput);
    delete value.row.record.leaseId;
    if (value.row.record.operator === undefined) {
      throw new Error("missing operator");
    }
    value.row.record.operator.pendingEffectId = "normal-accounts";
    value.row.record.operator.pendingEffectAttempt = {
      id: "00000000-0000-4000-8000-000000000004",
    };
    const guard = createNormalActorJournalAuthority({
      store: { read: async () => structuredClone(value.row), compareAndSet: async () => undefined },
      keyring: { tokenKey: Buffer.alloc(32, 7), tokenKeyVersion: "v1" },
      now: Date.now,
      assertCanonicalOwner: async () => undefined,
      assertApprovedOwner: async () => undefined,
      readApproval: async () => null,
    });
    await expect(
      guard.assertMutationAuthority(context, structuredClone(value.row), "capture"),
    ).resolves.toBeUndefined();
    await expect(
      guard.assertMutationAuthority(context, structuredClone(value.row)),
    ).rejects.toThrow();
    const before = structuredClone(value.row);
    if (value.row.record.operator === undefined) {
      throw new Error("missing operator");
    }
    value.row.record.operator.approvalId = "different";
    await expect(
      guard.assertMutationAuthority(context, structuredClone(value.row), "capture"),
    ).rejects.toThrow();
    value.row = structuredClone(before);
    if (value.row.record.operator === undefined) {
      throw new Error("missing operator");
    }
    value.row.record.operator.pendingEffectId = "other";
    await expect(
      guard.assertMutationAuthority(context, structuredClone(value.row), "capture"),
    ).rejects.toThrow();
    value.row = structuredClone(before);
    value.row.record.leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    await expect(
      guard.assertMutationAuthority(context, structuredClone(value.row), "capture"),
    ).rejects.toThrow();
  });

  it("waits for every approved organization session before recording account completion", async () => {
    const selectedProgram = normalActorProgramSchema.parse({
      ...program,
      organizations: [
        { organizationId: "org-one", ownerActorKey: "owner", name: "One", slug: "one" },
      ],
      memberships: [{ actorKey: "owner", organizationId: "org-one", role: "owner" }],
    });
    const selectedPlan = hostedOperatorPlanSchema.parse({
      ...plan,
      normalActorProgram: selectedProgram,
    });
    const selectedPreparation = {
      ...preparationInput,
      program: selectedProgram,
      programDigest: normalActorProgramDigest(selectedProgram),
      accountPlan: selectedPlan,
      accountPlanDigest: operatorPlanDigest(selectedPlan),
    };
    const value = fixture(selectedPreparation);
    await value.journal.retain(context, selectedPreparation);
    const state = initialNormalActorState(selectedProgram, accountOperationRef);
    const session = {
      reference: "22222222-2222-4222-8222-222222222222",
      actorId: "actual-actor",
      realmSessionId: "base-session",
      origin: program.origin,
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
    const storageState = { cookies: [], origins: [] };
    state.actors = [{ actorKey: "owner", signup: "complete", session, storageState }];
    const baseOnly = await value.journal.checkpoint(context, state);
    expect(baseOnly.accountsCompletedAt).toBeUndefined();
    state.organizationSessions = [
      {
        actorKey: "owner",
        organizationId: "org-one",
        selection: "pending",
        session: {
          ...session,
          reference: "55555555-5555-4555-8555-555555555555",
          realmSessionId: "org-session",
        },
        storageState,
      },
    ];
    const allSessions = await value.journal.checkpoint(context, state);
    expect(allSessions.accountsCompletedAt).toBeDefined();
  });

  it("registers a pending human capture only against the actual canonical first-approval link", async () => {
    const selectedPlan = hostedOperatorPlanSchema.parse({
      ...plan,
      gatewayBindings: {
        authBrowserOrigin: program.origin,
        builderCallbackOrigin: "https://builder.example.test",
        operatorOrigin: "https://operator.example.test",
        catalogAppIds: [target.appId],
        sourceWorkload: {
          issuer: "https://oidc.vercel.com",
          audience: "https://gateway.example.test",
          ownerId: "team",
          projectId: "prj_gateway",
          environment: "preview",
          subject: "gateway",
        },
      },
    });
    const selectedPreparation = {
      ...preparationInput,
      accountPlan: selectedPlan,
      accountPlanDigest: operatorPlanDigest(selectedPlan),
    };
    const value = fixture(selectedPreparation);
    await value.journal.retain(context, selectedPreparation);
    const nonceSha256 = "c".repeat(64);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const link = {
      audience: "https://operator.example.test",
      authResourceId: plan.authDatabase.resourceId,
      bootstrapPlanDigest: selectedPreparation.accountPlanDigest,
      browserOrigin: program.origin,
      endpointOrigin: "https://gateway.example.test",
      issuer: program.origin,
      nonceSha256,
      ownerSessionId: target.sessionId,
      organizationId: null,
      expiresAt,
      browserSession: {
        operationRef: accountOperationRef,
        participantProgramDigest: preparationInput.programDigest,
      },
    };
    value.row = {
      revision: value.row.revision + 1,
      record: hostedRuntimeJournalRecordSchema.parse({
        ...value.row.record,
        leaseId: undefined,
        operator: { ...value.row.record.operator, identityLink: link },
      }),
    };
    const input = { actorKey: "owner", nonceSha256, expiresAt };
    expect(await value.journal.registerPendingCapture(context, input)).toEqual(input);
    expect(await value.journal.readPendingCapture(context, nonceSha256)).toEqual(input);
    await expect(
      value.journal.registerPendingCapture(context, { ...input, actorKey: "different-owner" }),
    ).rejects.toThrow("normal_actor_capture_pending_mismatch");
    await expect(
      value.journal.registerPendingCapture(context, {
        ...input,
        organizationId: "unapproved-organization",
      }),
    ).rejects.toThrow("normal_actor_capture_pending_mismatch");
    await expect(
      value.journal.registerPendingCapture(context, { ...input, nonceSha256: "d".repeat(64) }),
    ).rejects.toThrow("normal_actor_capture_pending_mismatch");
    // Continue the same capture with the production journal guard while an account attempt is pending.
    if (value.row.record.operator === undefined) {
      throw new Error("missing operator");
    }
    value.row.record.operator.pendingEffectId = "normal-accounts";
    value.row.record.operator.pendingEffectAttempt = { id: "00000000-0000-4000-8000-000000000004" };
    const store = {
      read: async () => structuredClone(value.row),
      compareAndSet: async (request: {
        expectedRevision: number;
        record: typeof value.row.record;
      }) => {
        if (request.expectedRevision !== value.row.revision) {
          return undefined;
        }
        value.row = { revision: value.row.revision + 1, record: request.record };
        return structuredClone(value.row);
      },
    };
    const keyring = { tokenKey: Buffer.alloc(32, 7), tokenKeyVersion: "v1" };
    const guarded = createNormalActorJournal(
      createNormalActorJournalAuthority({
        store,
        keyring,
        now: Date.now,
        assertCanonicalOwner: async () => undefined,
        assertApprovedOwner: async () => undefined,
        readApproval: async (request) => ({
          ...request,
          approvalId: "initial-approval",
          approved: true,
        }),
      }),
    );
    await guarded.registerPendingCapture(context, input);
    const proof = "controlled-proof";
    const proofSha256 = createHash("sha256").update(proof).digest("hex");
    const reference = await guarded.authorizeCapture(context, { ...input, proofSha256 });
    const session = {
      reference,
      actorId: "same-owner",
      realmSessionId: "new-session",
      origin: program.origin,
      expiresAt,
    };
    const payload = {
      version: 1 as const,
      actorKey: "owner",
      nonceSha256,
      proofSha256,
      proof,
      session,
      normalCookie,
    };
    await guarded.capture(context, payload);
    const result = confirmNormalActorCapture({
      context,
      record: value.row.record,
      nonceSha256,
      proofSha256,
      payload,
      keyring,
      now: Date.now(),
      proofRef: `_protected-operator/artifacts/realm-identity-proof/${target.appId}/${proofSha256}`,
    });
    expect(result.operator?.pendingEffectAttempt).toEqual(
      value.row.record.operator?.pendingEffectAttempt,
    );
    expect(result.operator?.identityLink?.consumedAt).toBeDefined();
    value.row = {
      revision: value.row.revision + 1,
      record: hostedRuntimeJournalRecordSchema.parse({
        ...value.row.record,
        operator: {
          ...value.row.record.operator,
          identityLink: {
            ...link,
            consumedAt: new Date().toISOString(),
            proofRef: "confirmed-proof",
            proofSha256: "e".repeat(64),
          },
        },
      }),
    };
    expect(await value.journal.readPendingCapture(context, nonceSha256)).toBeUndefined();
  });

  it("supersedes an old endpoint proof only with the completed approved bootstrap and preserves accounts", async () => {
    const { value, old, nextInput } = await currentBootstrapFixture();
    const before = structuredClone(value.row.record.accountPreparation);
    const next = await value.journal.prepareOrganizationProof(context, nextInput);
    expect(next.nonce).not.toBe(old.nonce);
    expect(next.record.bootstrap).toEqual(nextInput.bootstrap);
    expect(value.row.record.accountPreparation?.supersededOrganizationProofs).toEqual([old.record]);
    expect(value.row.record.accountPreparation).toEqual({
      ...before,
      organizationProofs: [next.record],
      supersededOrganizationProofs: [old.record],
    });
    const writes = value.writes;
    expect(await value.journal.prepareOrganizationProof(context, nextInput)).toEqual(next);
    expect(value.writes).toBe(writes);
    const proofSha256 = "e".repeat(64);
    await expect(
      value.journal.completeOrganizationProof(context, {
        organizationId: nextInput.organizationId,
        nonceSha256: old.record.link.nonceSha256,
        proofSha256,
        proofRef: `_protected-operator/artifacts/realm-identity-proof/${target.appId}/${proofSha256}`,
        actorId: nextInput.owner.actorId,
        realmSessionId: nextInput.owner.realmSessionId,
        capturedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow("normal_actor_organization_proof_mismatch");
  });

  it.each([
    "wrong-endpoint",
    "wrong-snapshot",
    "wrong-program",
    "wrong-resource",
    "wrong-tuple",
    "missing-guard",
    "missing-bootstrap",
    "revoked-account-approval",
    "revoked-owner",
    "pending-binding",
    "revoked-guard",
    "pending-effect",
    "live-lease",
  ])("preserves the old proof when successor authority is invalid: %s", async (change) => {
    const { value, nextInput } = await currentBootstrapFixture();
    const operator = value.row.record.operator;
    const gatewayRow = operator?.gatewayEnvironment?.[0];
    const actor = nextInput.bootstrap.auth.plan.normalActorProgram?.actors[0];
    if (operator === undefined || gatewayRow === undefined || actor === undefined) {
      throw new Error("fixture bootstrap scope missing");
    }
    switch (change) {
      case "wrong-endpoint": {
        nextInput.binding.endpointOrigin = "https://unapproved.example.test";
        break;
      }
      case "wrong-snapshot": {
        nextInput.bootstrap.auth.approvalId = "different-approval";
        break;
      }
      case "wrong-program": {
        actor.name = "Different participant";
        break;
      }
      case "wrong-resource": {
        nextInput.binding.authResourceId = "different-auth";
        break;
      }
      case "wrong-tuple": {
        nextInput.binding.transportSource.projectId = "different-operator";
        break;
      }
      case "revoked-guard": {
        nextInput.assertBootstrapCurrent = async () => {
          throw new Error("bootstrap_revoked");
        };
        break;
      }
      case "revoked-account-approval": {
        value.revokeApproval();
        break;
      }
      case "revoked-owner": {
        value.revokeOwner();
        break;
      }
      case "pending-binding": {
        gatewayRow.pendingOperationRef = "33333333-3333-4333-8333-333333333333";
        gatewayRow.pendingValueSha256 = "a".repeat(64);
        break;
      }
      case "pending-effect": {
        operator.pendingEffectId = "gateway-delivery";
        break;
      }
      case "live-lease": {
        value.row.record.leaseId = "44444444-4444-4444-8444-444444444444";
        value.row.record.leaseExpiresAt = "2030-01-01T00:00:00.000Z";
        break;
      }
      default: {
        break;
      }
    }
    const before = structuredClone(value.row);
    const writes = value.writes;
    let selected: Parameters<typeof value.journal.prepareOrganizationProof>[1] = nextInput;
    if (change === "missing-guard") {
      selected = { ...nextInput, assertBootstrapCurrent: undefined };
    }
    if (change === "missing-bootstrap") {
      selected = { ...nextInput, bootstrap: undefined };
    }
    await expect(value.journal.prepareOrganizationProof(context, selected)).rejects.toThrow();
    expect(value.row).toEqual(before);
    expect(value.writes).toBe(writes);
  });

  it("renews an expired nonce for the same endpoint without creating successor history", async () => {
    const { value, input } = await organizationProofFixture();
    const old = await value.journal.prepareOrganizationProof(context, input);
    const retained = value.row.record.accountPreparation?.organizationProofs?.[0];
    if (retained === undefined) {
      throw new Error("fixture proof missing");
    }
    retained.link.expiresAt = "2020-01-01T00:00:00.000Z";
    const renewed = await value.journal.prepareOrganizationProof(context, input);
    expect(renewed.nonce).not.toBe(old.nonce);
    expect(value.row.record.accountPreparation?.supersededOrganizationProofs).toBeUndefined();
  });

  it("rechecks bootstrap approval after a lost CAS before replacing the old proof", async () => {
    const { value, nextInput } = await currentBootstrapFixture();
    const before = structuredClone(value.row.record.accountPreparation);
    const originalRevision = value.row.revision;
    value.conflictOnce();
    nextInput.assertBootstrapCurrent = async () => {
      if (value.row.revision !== originalRevision) {
        throw new Error("bootstrap_revoked");
      }
    };
    await expect(value.journal.prepareOrganizationProof(context, nextInput)).rejects.toThrow(
      "bootstrap_revoked",
    );
    expect(value.row.record.accountPreparation).toEqual(before);
  });

  it("binds organization proof nonce to the actual candidate and retains consumed proof metadata immutably", async () => {
    const { value, input } = await organizationProofFixture();
    const { owner, binding } = input;
    const pending = await value.journal.prepareOrganizationProof(context, input);
    expect(pending.nonce).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(value.row.record.accountPreparation)).not.toContain(pending.nonce);
    expect(await value.journal.prepareOrganizationProof(context, input)).toEqual(pending);
    await expect(
      value.journal.prepareOrganizationProof(context, {
        ...input,
        owner: { ...owner, realmSessionId: "different-session" },
      }),
    ).rejects.toThrow("normal_actor_organization_proof_mismatch");
    const proofSha256 = "e".repeat(64);
    const completion = {
      organizationId: "org-one",
      nonceSha256: pending.record.link.nonceSha256,
      proofSha256,
      proofRef: `_protected-operator/artifacts/realm-identity-proof/${target.appId}/${proofSha256}`,
      actorId: owner.actorId,
      realmSessionId: owner.realmSessionId,
      capturedAt: new Date().toISOString(),
    };
    const consumed = await value.journal.completeOrganizationProof(context, completion);
    expect(consumed.link.proofSha256).toBe(proofSha256);
    await expect(
      value.journal.completeOrganizationProof(context, {
        ...completion,
        proofSha256: "f".repeat(64),
        proofRef: `_protected-operator/artifacts/realm-identity-proof/${target.appId}/${"f".repeat(64)}`,
      }),
    ).rejects.toThrow("normal_actor_organization_proof_mismatch");
    const retried = await value.journal.prepareOrganizationProof(context, input);
    expect(retried.record).toEqual(consumed);
    await expect(
      value.journal.prepareOrganizationProof(context, {
        ...input,
        binding: {
          ...binding,
          transportSource: { ...binding.transportSource, projectId: "different-project" },
        },
      }),
    ).rejects.toThrow("normal_actor_organization_proof_mismatch");
  });

  it("keeps the original account approval and encryption scope across app replanning and CAS retry", async () => {
    const value = fixture();
    value.conflictOnce();
    await value.journal.retain(context, preparationInput);
    const resource = structuredClone(value.row.record.privateState);
    value.row = {
      ...value.row,
      revision: value.row.revision + 1,
      record: hostedRuntimeJournalRecordSchema.parse({
        ...value.row.record,
        approvedByCallId: "next-app-call",
        operator: {
          ...value.row.record.operator,
          operationRef: "33333333-3333-4333-8333-333333333333",
          approvalId: "next-app-approval",
        },
      }),
    };
    const read = await value.journal.read(context);
    expect(read?.state.operationRef).toBe(accountOperationRef);
    expect(read?.preparation.accountApprovedByCallId).toBe("initial-call");
    expect(value.row.record.privateState).toEqual(resource);
    expect(value.approvals).toBeGreaterThan(2);
  });
  it("requires fresh canonical owner and original approval before reads and writes", async () => {
    const value = fixture();
    await value.journal.retain(context, preparationInput);
    value.revokeApproval();
    await expect(value.journal.read(context)).rejects.toThrow("approval_revoked");
    await expect(
      value.journal.checkpoint(context, initialNormalActorState(program, accountOperationRef)),
    ).rejects.toThrow("approval_revoked");
    const owner = fixture();
    await owner.journal.retain(context, preparationInput);
    owner.revokeOwner();
    await expect(owner.journal.read(context)).rejects.toThrow("owner_revoked");
  });
  it("encrypts actual complete session state separately and preserves the completion time", async () => {
    const value = fixture();
    await value.journal.retain(context, preparationInput);
    const state = initialNormalActorState(program, accountOperationRef);
    state.actors = [
      {
        actorKey: "owner",
        signup: "complete",
        session: {
          reference: "22222222-2222-4222-8222-222222222222",
          actorId: "actual-actor",
          realmSessionId: "actual-realm-session",
          origin: program.origin,
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
        storageState: {
          cookies: [
            {
              name: normalCookie.name,
              value: normalCookie.value,
              domain: normalCookie.domain,
              path: normalCookie.path,
              expires: -1,
              httpOnly: true,
              secure: true,
              sameSite: "Lax",
            },
          ],
          origins: [],
        },
      },
    ];
    const first = await value.journal.checkpoint(context, state);
    const second = await value.journal.checkpoint(context, state);
    expect(second.accountsCompletedAt).toBe(first.accountsCompletedAt);
    expect(await value.journal.read(context)).toMatchObject({ state });
    expect(JSON.stringify(value.row)).not.toContain(normalCookie.value);
    expect(value.row.record.privateState?.encryptedToken).toBe("resource-private-state");
  });
  it("stores no dummy credential in authorization, then seals raw encoded cookie and host-only metadata idempotently", async () => {
    const value = fixture();
    await value.journal.retain(context, preparationInput);
    const proof = "actual.signed.proof";
    const proofSha256 = createHash("sha256").update(proof).digest("hex");
    const request = {
      actorKey: "owner",
      nonceSha256: "f".repeat(64),
      proofSha256,
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
    const reference = await value.journal.authorizeCapture(context, request);
    expect(value.row.record.accountPreparation?.captures[0]?.sealed).toBeUndefined();
    const payload = {
      version: 1 as const,
      actorKey: "owner",
      nonceSha256: request.nonceSha256,
      proofSha256,
      proof,
      session: {
        reference: reference ?? "missing",
        actorId: "actual-actor",
        realmSessionId: "actual-session",
        origin: program.origin,
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
      normalCookie,
    };
    await value.journal.capture(context, payload);
    const encrypted = JSON.stringify(value.row.record.accountPreparation?.captures);
    const { writes } = value;
    await value.journal.capture(context, payload);
    await value.journal.authorizeCapture(context, {
      ...request,
      expiresAt: "2031-01-01T00:00:00.000Z",
    });
    expect(value.writes).toBe(writes);
    expect(JSON.stringify(value.row.record.accountPreparation?.captures)).toBe(encrypted);
    expect(await value.journal.readCapture(context, reference ?? "missing")).toEqual(payload);
    expect(encrypted).not.toContain(normalCookie.value);
    expect(encrypted).not.toContain(proof);
    expect(normalActorCaptureCookieDigest(normalCookie)).toBe(
      createHash("sha256").update(`${normalCookie.name}=${normalCookie.value}`).digest("hex"),
    );
    await expect(
      value.journal.capture(context, {
        ...payload,
        normalCookie: { ...normalCookie, value: "swapped" },
      }),
    ).rejects.toThrow("normal_actor_capture_unavailable");
  });
});
