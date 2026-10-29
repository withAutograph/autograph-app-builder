import { createHostedOperatorReadApproval } from "./hosted-operator-owner";
import { durableHostedSessionRecordSchema } from "../eve/hosted-store";
import { privateHostedApprovalReceiptSchema } from "../eve/private-hosted-approval";
import { z } from "zod";
import { createHash } from "node:crypto";
/* oxlint-disable eslint/require-await, unicorn/no-useless-undefined -- Controlled authority and CAS ports retain the asynchronous production boundary. */
import { describe, expect, it, vi } from "vitest";
import {
  hostedOperatorPlanSchema,
  operatorPlanDigest,
  normalActorPreparationSchema,
  HostedOperatorError,
  operatorOwnerContextSchema,
} from "./hosted-operator-contract";
import {
  initialNormalActorState,
  normalActorProgramSchema,
  normalActorProgramDigest,
} from "./hosted-operator-normal-actor-program";
import {
  createNormalActorJournal,
  normalActorAccountPreparationSchema,
  normalActorCaptureCookieSchema,
} from "./hosted-operator-normal-actor-journal";
import { createNormalActorJournalAuthority } from "./hosted-operator-normal-actor-authority";
import {
  encryptNormalActorState,
  decryptNormalActorState,
} from "./hosted-operator-normal-actor-state";
import {
  createParticipantSuccessorPlan,
  isAdditiveCaptureParticipantProgram,
} from "./hosted-operator-participant-successor";
import { createHostedOperatorNormalActorOperations } from "./hosted-operator-normal-actor-operations";
import type { NormalActorOperationsDependencies } from "./hosted-operator-normal-actor-operations";
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import type { HostedOperatorWorkerEffectContext } from "./hosted-operator-service";
import type { HostedRuntimeJournalRow } from "./hosted-runtime-journal";

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

const requireFixture = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("missing fixture value");
  }
  return value;
};

const fixture = async () => {
  const keyring = { tokenKey: Buffer.alloc(32, 7), tokenKeyVersion: "v1" };
  const state = initialNormalActorState(program, accountOperationRef);
  state.actors[0] = {
    actorKey: "owner",
    signup: "complete",
    session: {
      reference: "33333333-3333-4333-8333-333333333333",
      actorId: "real-owner",
      realmSessionId: "real-session",
      origin: program.origin,
      expiresAt: "2030-01-01T00:00:00.000Z",
    },
    storageState: {
      cookies: [
        {
          name: "__Secure-session",
          value: "actual-retained-cookie",
          domain: "apps.example.com",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ],
      origins: [],
    },
  };
  const preparation = normalActorAccountPreparationSchema.parse({
    program,
    programDigest: normalActorProgramDigest(program),
    accountOperationRef,
    accountPlan: plan,
    accountPlanDigest: operatorPlanDigest(plan),
    accountApprovalId: "original-approval",
    accountApprovedByCallId: "original-call",
    sealedState: encryptNormalActorState({
      ...context,
      ownerSessionId: target.sessionId,
      operationRef: accountOperationRef,
      program,
      config: keyring,
      state,
    }),
    captures: [],
    accountsCompletedAt: "2026-10-20T00:00:00.000Z",
  });
  let row: HostedRuntimeJournalRow = {
    revision: 1,
    record: hostedRuntimeJournalRecordSchema.parse({
      kind: "app-runtime",
      version: 1,
      request: target,
      approvedByCallId: "original-call",
      status: "participants-prepared",
      step: "reserved",
      accountPreparation: preparation,
      privateState: {
        encryptedToken: "resource-secret",
        keyVersion: "v1",
        tokenIv: "iv",
        tokenTag: "tag",
      },
      operator: {
        mode: "protected-operator-v1",
        operationRef: accountOperationRef,
        plan,
        planDigest: operatorPlanDigest(plan),
        approvalId: "original-approval",
        receipts: [],
      },
    }),
  };
  let owned = true;
  const approvals = new Map([
    ["original-call", { digest: operatorPlanDigest(plan), id: "original-approval" }],
  ]);
  const owner = async () => {
    if (!owned) {
      throw new HostedOperatorError("authorization_required");
    }
  };
  const ports = createNormalActorJournalAuthority({
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
    keyring,
    now: Date.now,
    assertCanonicalOwner: owner,
    assertApprovedOwner: owner,
    readApproval: async (input) => {
      const approved = approvals.get(input.callId);
      return approved?.digest === input.planDigest
        ? {
            approved: true,
            action: input.action,
            approvalId: approved.id,
            callId: input.callId,
            planDigest: input.planDigest,
          }
        : null;
    },
  });
  const journal = createNormalActorJournal(ports);
  const reference = await journal.authorizeCapture(context, {
    actorKey: "owner",
    nonceSha256: "1".repeat(64),
    proofSha256: createHash("sha256").update("verified-capture").digest("hex"),
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
  const originalSession = requireFixture(state.actors[0].session);
  originalSession.reference = reference;
  await journal.capture(context, {
    version: 1,
    actorKey: "owner",
    nonceSha256: "1".repeat(64),
    proofSha256: createHash("sha256").update("verified-capture").digest("hex"),
    proof: "verified-capture",
    session: originalSession,
    normalCookie: normalActorCaptureCookieSchema.parse({
      ...requireFixture(state.actors[0].storageState).cookies[0],
      hostOnly: true,
    }),
  });
  await journal.checkpoint(context, state);
  const original = structuredClone(requireFixture(row.record.accountPreparation));
  const appPlan = hostedOperatorPlanSchema.parse({
    ...plan,
    stage: "app",
    effects: ["resources", "install", "access", "bindings"].map((kind) => ({
      id: kind,
      kind,
      description: "Observe approved phase",
    })),
    normalActorPreparation: normalActorPreparationSchema.strip().parse(original),
  });
  approvals.set("app-call", { digest: operatorPlanDigest(appPlan), id: "app-approval" });
  row.record.proof = {
    actors: 0,
    tenants: 1,
    artifactHash: "c".repeat(64),
    authenticatedBehavior: "unassessed",
    manifestSha256: appPlan.release.sha256,
    releaseId: appPlan.release.id,
  };
  row.record.status = "prepared";
  row.record.step = "bound";
  row.record.approvedByCallId = "app-call";
  row.record.operator = {
    mode: "protected-operator-v1",
    operationRef: "44444444-4444-4444-8444-444444444444",
    plan: appPlan,
    planDigest: operatorPlanDigest(appPlan),
    approvalId: "app-approval",
    fenceGeneration: 1,
    receipts: appPlan.effects.map((effect) => ({
      effectId: effect.id,
      ...(effect.kind === "access" ? { fenceGeneration: 1 } : {}),
      observedAt: "2026-10-20T00:00:00.000Z",
      resourceVersion: "observed",
    })),
  };
  const nextProgram = normalActorProgramSchema.parse({
    ...program,
    actors: [
      ...program.actors,
      { actorKey: "qa", email: "qa@example.test", name: "QA", account: "create-email-password" },
    ],
  });
  const nextPlan = createParticipantSuccessorPlan(row.record, nextProgram, Date.now());
  if (nextPlan === undefined) {
    throw new Error("missing successor");
  }
  const predecessor = {
    preparation: original,
    approvedByCallId: row.record.approvedByCallId,
    operator: structuredClone(row.record.operator),
    proof: row.record.proof,
  };
  row.record.participantPreparationHistory = [predecessor];
  row.record.status = "pending";
  row.record.step = "reserved";
  const operationRef = "55555555-5555-4555-8555-555555555555";
  row.record.operator = {
    mode: "protected-operator-v1",
    operationRef,
    plan: nextPlan,
    planDigest: operatorPlanDigest(nextPlan),
    receipts: [],
  };
  row.record.approvedByCallId = "operator:unapproved-plan";
  const input = {
    ...context,
    plan: nextPlan,
    operationRef,
    planDigest: operatorPlanDigest(nextPlan),
    callId: "successor-call",
    approvalId: "successor-approval",
  };
  const assertCurrent = async () => {
    await owner();
    const approved = approvals.get(input.callId);
    if (
      ![
        row.record.operator?.operationRef === input.operationRef,
        row.record.operator?.planDigest === input.planDigest,
        row.record.operator?.approvalId === approved?.id,
        approved?.digest === input.planDigest,
        row.record.approvedByCallId === input.callId,
      ].every(Boolean)
    ) {
      throw new HostedOperatorError("authorization_required");
    }
  };
  const fetchSession = vi.fn<typeof fetch>(async (url, init) => {
    const request = new Request(url, init);
    expect(request.method).toBe("GET");
    expect(new URL(request.url).pathname).toBe("/api/auth/get-session");
    expect(new URL(request.url).searchParams.get("disableRefresh")).toBe("true");
    expect(request.headers.get("cookie")).toContain("actual-retained-cookie");
    return Response.json({
      user: { id: "real-owner", email: "owner@example.test" },
      session: {
        id: "real-session",
        userId: "real-owner",
        expiresAt: "2030-01-01T00:00:00.000Z",
        activeOrganizationId: null,
      },
    });
  });
  const unused = async (): Promise<never> => {
    throw new Error("unexpected account or organization effect");
  };
  const dependencies: NormalActorOperationsDependencies = {
    journalPorts: ports,
    assertPlanningAuthorized: owner,
    assertCurrentPlan: assertCurrent,
    normalRealmFetch: async () => fetchSession,
    prepareActorCapture: unused,
    collectOrganizationOwnerProof: unused,
    executeOrganization: unused,
    inspectOrganization: unused,
  };
  return {
    journal,
    ports,
    original,
    predecessor,
    state,
    input,
    approvals,
    fetchSession,
    operations: createHostedOperatorNormalActorOperations(dependencies),
    approve() {
      approvals.set(input.callId, { digest: input.planDigest, id: input.approvalId });
      row.record.approvedByCallId = input.callId;
      requireFixture(row.record.operator).approvalId = input.approvalId;
    },
    revokeOwner() {
      owned = false;
    },
    get row() {
      return row;
    },
    reference,
  };
};

describe("approved additive capture participant state", () => {
  it("reseals verified session state while preserving original ciphertext, capture AAD and app evidence", async () => {
    const f = await fixture();
    const before = structuredClone(f.row.record);
    f.approve();
    await expect(f.operations.ensureNormalActorCapture(f.input)).resolves.toBe("ready");
    const prepared = await f.journal.read(context);
    expect(prepared?.state.actors[0]).toEqual(f.state.actors[0]);
    expect(prepared?.state.actors[1]).toEqual({ actorKey: "qa", signup: "pending" });
    expect(prepared?.preparation.accountsCompletedAt).toBeUndefined();
    expect(prepared?.preparation.sealedState).not.toEqual(f.original.sealedState);
    expect(prepared?.preparation.captures).toEqual([]);
    expect(f.row.record.participantPreparationHistory).toEqual(
      before.participantPreparationHistory,
    );
    expect(f.row.record.privateState).toEqual(before.privateState);
    expect(await f.journal.readCapture(context, f.reference)).toMatchObject({
      proof: "verified-capture",
      normalCookie: { value: "actual-retained-cookie" },
    });
    expect(() =>
      decryptNormalActorState({
        authority,
        ownerSessionId: target.sessionId,
        operationRef: f.input.operationRef,
        program: requireFixture(f.input.plan.normalActorProgram),
        config: f.ports.keyring,
        sealed: f.original.sealedState,
      }),
    ).toThrow();
    expect(f.fetchSession).toHaveBeenCalled();
  });

  it("runs the existing account worker for new QA without recapturing or signing up the original actor", async () => {
    const f = await fixture();
    f.approve();
    await f.operations.ensureNormalActorCapture(f.input);
    const originalFetch = f.fetchSession.getMockImplementation();
    if (originalFetch === undefined) {
      throw new Error("missing fixture fetch");
    }
    const signups: string[] = [];
    f.fetchSession.mockImplementation(async (url, init) => {
      const request = new Request(url, init);
      if (new URL(request.url).pathname === "/api/auth/sign-up/email") {
        const body = z.object({ email: z.email() }).parse(await request.json());
        signups.push(body.email);
        return Response.json(
          { user: { id: "qa-actor", email: "qa@example.test" } },
          {
            headers: {
              "set-cookie": "__Secure-session=qa-cookie; Path=/; Secure; HttpOnly; SameSite=Lax",
            },
          },
        );
      }
      if (request.headers.get("cookie")?.includes("qa-cookie") === true) {
        return Response.json({
          user: { id: "qa-actor", email: "qa@example.test" },
          session: {
            id: "qa-session",
            userId: "qa-actor",
            expiresAt: "2030-01-01T00:00:00.000Z",
            activeOrganizationId: null,
          },
        });
      }
      return await originalFetch(url, init);
    });
    f.row.record.leaseId = "66666666-6666-4666-8666-666666666666";
    f.row.record.leaseExpiresAt = "2030-01-01T00:00:00.000Z";
    requireFixture(f.row.record.operator).fenceGeneration = 2;
    requireFixture(f.row.record.operator).pendingEffectId = "normal-accounts";
    const unused = async (): Promise<never> => {
      throw new Error("unexpected resource worker effect");
    };
    const effect: HostedOperatorWorkerEffectContext = {
      ...f.input,
      effect: requireFixture(f.input.plan.effects[0]),
      leaseId: f.row.record.leaseId,
      fenceGeneration: 2,
      workerAttemptId: "account-worker",
      workerCheckpoints: [],
      assertCurrent: async () => {
        await f.ports.assertMutationAuthority(effect, f.row);
      },
      checkpoint: unused,
      bindWorkerContext: unused,
      checkpointAccountPreparation: async (preparation) => {
        expect(preparation.accountOperationRef).toBe(f.input.operationRef);
      },
    };
    const completed = await f.operations.prepareNormalActorAccounts(effect);
    expect(completed.actors.every((actor) => actor.signup === "complete")).toBe(true);
    expect(signups).toEqual(["qa@example.test"]);
    const retained = await f.journal.read(context);
    expect(retained?.state.actors[0]?.session?.reference).toBe(f.reference);
    expect(f.row.record.participantPreparationHistory?.[0]?.preparation).toEqual(f.original);
  });

  it.each([
    "unapproved",
    "cancelled",
    "original approval",
    "app approval",
    "owner",
    "lease",
    "pending effect",
    "pending attempt",
    "stale session",
    "foreign session",
    "approval revoked during check",
    "plan changed during check",
  ] as const)("preserves original state when %s refuses initialization", async (changed) => {
    const f = await fixture();
    if (changed !== "unapproved") {
      f.approve();
    }
    if (changed === "cancelled") {
      f.approvals.delete("successor-call");
    }
    if (changed === "original approval") {
      f.approvals.delete("original-call");
    }
    if (changed === "app approval") {
      f.approvals.delete("app-call");
    }
    if (changed === "owner") {
      f.revokeOwner();
    }
    if (changed === "lease") {
      f.row.record.leaseId = "66666666-6666-4666-8666-666666666666";
    }
    if (changed === "pending effect") {
      requireFixture(f.row.record.operator).pendingEffectId = "normal-accounts";
    }
    if (changed === "pending attempt") {
      requireFixture(f.row.record.operator).pendingEffectAttempt = {
        id: "66666666-6666-4666-8666-666666666666",
      };
    }
    if (changed === "stale session") {
      f.fetchSession.mockResolvedValue(Response.json(null));
    }
    if (changed === "foreign session") {
      f.fetchSession.mockResolvedValue(
        Response.json({
          user: { id: "foreign", email: "owner@example.test" },
          session: {
            id: "foreign-session",
            userId: "foreign",
            expiresAt: "2030-01-01T00:00:00.000Z",
          },
        }),
      );
    }
    if (changed === "approval revoked during check" || changed === "plan changed during check") {
      f.fetchSession.mockImplementation(async () => {
        if (changed === "approval revoked during check") {
          f.approvals.delete("successor-call");
        } else {
          requireFixture(f.row.record.operator).planDigest = "f".repeat(64);
        }
        return Response.json({
          user: { id: "real-owner", email: "owner@example.test" },
          session: {
            id: "real-session",
            userId: "real-owner",
            expiresAt: "2030-01-01T00:00:00.000Z",
          },
        });
      });
    }
    const before = structuredClone(f.row.record.accountPreparation);
    const history = structuredClone(f.row.record.participantPreparationHistory);
    await expect(f.operations.ensureNormalActorCapture(f.input)).rejects.toBeDefined();
    expect(f.row.record.accountPreparation).toEqual(before);
    expect(f.row.record.participantPreparationHistory).toEqual(history);
  });

  it("rejects changing a carried capture before checkpointing its successor state", async () => {
    const f = await fixture();
    f.approve();
    await f.operations.ensureNormalActorCapture(f.input);
    const prepared = await f.journal.read(context);
    if (prepared === undefined) {
      throw new Error("missing successor state");
    }
    requireFixture(prepared.state.actors[0]?.session).realmSessionId = "foreign-session";
    const before = structuredClone(f.row.record);
    await expect(f.journal.checkpoint(context, prepared.state)).rejects.toThrow(
      "normal_actor_journal_authority_mismatch",
    );
    expect(f.row.record).toEqual(before);
  });

  it("keeps predecessor approval authority after successor initialization", async () => {
    const f = await fixture();
    f.approve();
    await f.operations.ensureNormalActorCapture(f.input);
    f.approvals.delete("original-call");
    await expect(f.journal.read(context)).rejects.toMatchObject({ code: "authorization_required" });
  });

  it.each([
    "valid",
    "cancelled",
    "foreign responder",
    "changed lineage",
    "changed resource",
  ] as const)(
    "reads original approvals through the deployed canonical reader only for %s successor provenance",
    async (changed) => {
      const f = await fixture();
      f.approve();
      await f.operations.ensureNormalActorCapture(f.input);
      const ownerContext = operatorOwnerContextSchema.parse({
        kind: "direct",
        authority,
        principal: { ...authority, scopes: ["autograph:send"] },
        sessionId: target.sessionId,
        adapterSessionId: "adapter",
        adapterGeneration: 1,
      });
      const receipts = [
        {
          callId: f.original.accountApprovedByCallId,
          id: f.original.accountApprovalId,
          plan: f.original.accountPlan,
          operationRef: f.original.accountOperationRef,
        },
        {
          callId: f.predecessor.approvedByCallId,
          id: f.predecessor.operator.approvalId,
          plan: f.predecessor.operator.plan,
          operationRef: f.predecessor.operator.operationRef,
        },
      ].map((entry, sequence) =>
        privateHostedApprovalReceiptSchema.parse({
          callId: entry.callId,
          requestId: entry.id,
          format: "autograph-hosted-approval-v1",
          outcome: "approved",
          responderPrincipalId: authority.ownerUserId,
          sequence,
          turnId: "",
          toolName: "prepare-app-hosted-runtime",
          toolInput: {
            appId: target.appId,
            branch: target.branch,
            projectId: target.projectId,
            environment: target.environment,
            operationRef: entry.operationRef,
            plan: entry.plan,
            planDigest: operatorPlanDigest(entry.plan),
          },
        }),
      );
      const first = requireFixture(receipts[0]);
      if (changed === "cancelled") {
        first.outcome = "cancelled";
      }
      if (changed === "foreign responder") {
        first.responderPrincipalId = "foreign-owner";
      }
      if (changed === "changed lineage") {
        requireFixture(
          f.row.record.operator?.plan.normalActorPredecessor,
        ).preparation.accountPlanDigest = "f".repeat(64);
      }
      if (changed === "changed resource") {
        requireFixture(f.row.record.operator).plan.appDatabase.database = "foreign_database";
      }
      const session = durableHostedSessionRecordSchema.parse({
        version: 2,
        sessionId: target.sessionId,
        appId: target.appId,
        principal: ownerContext.principal,
        adapterGeneration: 1,
        adapterSessionId: "adapter",
        originAdapterSessionId: "adapter",
        createdAtEpochMs: 100,
        updatedAtEpochMs: 100,
        lastProgressAtEpochMs: 100,
        resumability: "live",
        stage: "ready",
        status: "waiting",
        title: "Controlled actor authority",
        privateApprovalReceipts: receipts,
      });
      const readApproval = createHostedOperatorReadApproval({
        journal: f.ports.store,
        eve: { getSession: async () => session, recordPrivateApprovalReceipts: async () => {} },
        observe: async () => {
          throw new HostedOperatorError("authorization_required");
        },
      });
      const input = {
        ...context,
        ownerContext,
        action: "prepare" as const,
        callId: f.original.accountApprovedByCallId,
        planDigest: f.original.accountPlanDigest,
      };
      if (changed === "valid") {
        await expect(readApproval(input)).resolves.toMatchObject({
          approved: true,
          approvalId: f.original.accountApprovalId,
        });
        await expect(
          readApproval({
            ...input,
            callId: f.predecessor.approvedByCallId,
            planDigest: f.predecessor.operator.planDigest,
          }),
        ).resolves.toMatchObject({ approved: true, approvalId: f.predecessor.operator.approvalId });
      } else {
        await expect(readApproval(input)).rejects.toMatchObject({ code: "authorization_required" });
      }
    },
  );

  it("refuses signup enrollment policy intent at the account-only successor boundary", async () => {
    const f = await fixture();
    const record = {
      ...f.row.record,
      ...f.predecessor,
      accountPreparation: f.original,
      status: "prepared" as const,
      step: "bound" as const,
    };
    expect(() =>
      createParticipantSuccessorPlan(record, f.input.plan.normalActorProgram, Date.now(), {
        version: 1,
        organizationId: "qa-org",
        eligibility: "public",
        appPath: "/qa",
        membershipRole: "member",
        appRoles: ["member"],
      }),
    ).toThrow();
  });

  it("rejects relabeling the original actor as a QA organization participant", () => {
    const next = normalActorProgramSchema.parse({
      ...program,
      actors: [
        ...program.actors,
        { actorKey: "qa", email: "qa@example.test", name: "QA", account: "create-email-password" },
      ],
      organizations: [
        { organizationId: "qa-org", name: "QA", slug: "qa-org", ownerActorKey: "owner" },
      ],
      memberships: [{ actorKey: "owner", organizationId: "qa-org", role: "owner" }],
    });
    expect(isAdditiveCaptureParticipantProgram(program, next)).toBe(false);
  });
});
