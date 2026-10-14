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
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
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
const fixture = () => {
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
        plan,
        planDigest: operatorPlanDigest(plan),
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
        preparation.accountPlanDigest !== preparationInput.accountPlanDigest ||
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

describe("retained actual normal actor journal", () => {
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
