/* oxlint-disable typescript/no-non-null-assertion -- Fixture always constructs these required private envelopes and links; tests mutate them to exercise rejection. */
/* oxlint-disable eslint/require-await, unicorn/no-useless-undefined, typescript/consistent-return -- In-memory CAS is asynchronous and returns undefined for a real lost conditional write. */
import { createHash } from "node:crypto";
import { canReserveIdentityLink } from "./hosted-operator-pending-account-capture";
import { describe, expect, it } from "vitest";
import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import {
  initialNormalActorState,
  normalActorProgramDigest,
  normalActorProgramSchema,
} from "./hosted-operator-normal-actor-program";
import { normalActorCaptureCookieDigest } from "./hosted-operator-normal-actor-journal";

import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";
import { confirmNormalActorCapture } from "./hosted-operator-normal-actor-confirmation";
import {
  encryptNormalActorState,
  decryptNormalActorState,
} from "./hosted-operator-normal-actor-state";
import type { NormalActorCapturedPayload } from "./hosted-operator-normal-actor-journal";

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
    { account: "capture-existing", actorKey: "owner", email: "owner@example.test", name: "Owner" },
  ],
  appAccess: [],
  appId: target.appId,
  memberships: [],
  organizations: [],
  origin: "https://apps.example.test",
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
const preparationInput = {
  accountApprovalId: "initial-approval",
  accountApprovedByCallId: "initial-call",
  accountOperationRef,
  accountPlan: plan,
  accountPlanDigest: operatorPlanDigest(plan),
  program,
  programDigest: normalActorProgramDigest(program),
};
const normalCookie = {
  domain: "apps.example.test",
  expires: -1 as const,
  hostOnly: true,
  httpOnly: true as const,
  name: "__Secure-session",
  path: "/",
  sameSite: "Lax" as const,
  secure: true as const,
  value: "actual%2Fencoded%3Dcookie",
};

const keyring = { tokenKey: Buffer.alloc(32, 7), tokenKeyVersion: "v1" };
const now = Date.parse("2026-10-14T16:30:00.000Z");
const scope = {
  authority,
  config: keyring,
  operationRef: accountOperationRef,
  ownerSessionId: target.sessionId,
  program,
};
const proof = "actual-private-proof-fixture";
const proofSha256 = createHash("sha256").update(proof).digest("hex");
const nonceSha256 = "c".repeat(64);
const proofRef = `_protected-operator/artifacts/realm-identity-proof/${target.appId}/${proofSha256}`;
const session = {
  actorId: "actual-owner",
  expiresAt: "2030-01-01T00:00:00.000Z",
  origin: program.origin,
  realmSessionId: "actual-session",
  reference: "22222222-2222-4222-8222-222222222222",
};
const fixture = () => {
  const payload: NormalActorCapturedPayload = {
    actorKey: "owner",
    nonceSha256,
    normalCookie,
    proof,
    proofSha256,
    session,
    version: 1,
  };
  const sealedState = encryptNormalActorState({
    ...scope,
    state: initialNormalActorState(program, accountOperationRef),
  });
  const record: HostedRuntimeJournalRecord = {
    accountPreparation: {
      ...preparationInput,
      captures: [
        {
          actorKey: "owner",
          expiresAt: session.expiresAt,
          nonceSha256,
          normalCookieSha256: normalActorCaptureCookieDigest(normalCookie),
          proofSha256,
          reference: session.reference,
          sealed: sealedState,
        },
      ],
      sealedState,
    },
    approvedByCallId: "initial-call",
    kind: "app-runtime",
    operator: {
      identityLink: {
        audience: program.origin,
        authResourceId: "auth-resource",
        bootstrapPlanDigest: preparationInput.accountPlanDigest,
        browserOrigin: program.origin,
        browserSession: {
          operationRef: accountOperationRef,
          participantProgramDigest: preparationInput.programDigest,
        },
        endpointOrigin: "https://gateway.example.test",
        expiresAt: session.expiresAt,
        issuer: program.origin,
        nonceSha256,
        organizationId: null,
        ownerSessionId: target.sessionId,
        sealedNonce: {
          encryptedToken: "private",
          keyVersion: "v1",
          tokenIv: "iv",
          tokenTag: "tag",
        },
      },
      mode: "protected-operator-v1",
      operationRef: accountOperationRef,
      plan,
      planDigest: operatorPlanDigest(plan),
      receipts: [],
    },
    request: target,
    status: "pending",
    step: "reserved",
    version: 1,
  };
  return { context, keyring, nonceSha256, now, payload, proofRef, proofSha256, record };
};
const readState = (record: HostedRuntimeJournalRecord) =>
  decryptNormalActorState({ ...scope, sealed: record.accountPreparation!.sealedState });
describe("human confirmation of private actual actor capture", () => {
  it("reconnects the same approved actor while preserving an interrupted account attempt", () => {
    const input = fixture();
    const operator = input.record.operator!;
    const preparation = input.record.accountPreparation!;
    input.record.approvedByCallId = preparation.accountApprovedByCallId;
    operator.approvalId = preparation.accountApprovalId;
    const effect = operator.plan.effects.find((entry) => entry.kind === "normal-accounts");
    if (!effect) {
      throw new Error("missing account effect");
    }
    operator.pendingEffectId = effect.id;
    operator.pendingEffectAttempt = { id: "00000000-0000-4000-8000-000000000009" };
    const reservation = {
      operationRef: operator.operationRef,
      participantCapture: true,
      planDigest: operator.planDigest,
    };
    expect(canReserveIdentityLink(input.record, reservation)).toBe(true);
    expect(
      canReserveIdentityLink(input.record, { ...reservation, participantCapture: false }),
    ).toBe(false);
    expect(canReserveIdentityLink(input.record, { ...reservation, operationRef: "other" })).toBe(
      false,
    );
    expect(canReserveIdentityLink(input.record, { ...reservation, planDigest: "other" })).toBe(
      false,
    );
    const result = confirmNormalActorCapture(input);
    expect(result.operator?.pendingEffectId).toBe(effect.id);
    expect(result.operator?.pendingEffectAttempt).toEqual(operator.pendingEffectAttempt);
    expect(readState(result).actors[0].session?.actorId).toBe(session.actorId);
    expect(result.operator?.identityLink?.consumedAt).toBeDefined();
    const wrongApproval = fixture();
    wrongApproval.record = structuredClone(input.record);
    wrongApproval.record.operator!.approvalId = "other-approval";
    expect(() => confirmNormalActorCapture(wrongApproval)).toThrow();
    const leased = fixture();
    leased.record = structuredClone(input.record);
    leased.record.leaseId = "00000000-0000-4000-8000-000000000010";
    expect(canReserveIdentityLink(leased.record, reservation)).toBe(false);
    expect(() => confirmNormalActorCapture(leased)).toThrow();
  });
  it("atomically consumes nonce and activates exact encoded actual cookie bytes", () => {
    const input = fixture();
    const result = confirmNormalActorCapture(input);
    expect(result.operator!.identityLink).toMatchObject({
      consumedAt: new Date(now).toISOString(),
      proofRef,
      proofSha256,
    });
    expect(result.operator!.identityLink!.sealedNonce).toBeUndefined();
    expect(readState(result).actors[0]).toMatchObject({
      session,
      signup: "complete",
      storageState: {
        cookies: [
          {
            domain: normalCookie.domain,
            expires: -1,
            name: normalCookie.name,
            value: normalCookie.value,
          },
        ],
        origins: [],
      },
    });
    expect(input.record.operator!.identityLink!.consumedAt).toBeUndefined();
    expect(readState(input.record).actors[0].session).toBeUndefined();
  });
  it("returns exact unchanged record for same consumed proof replay", () => {
    const input = fixture();
    const confirmed = confirmNormalActorCapture(input);
    expect(
      confirmNormalActorCapture({ ...input, now: Date.parse("2035-01-01"), record: confirmed }),
    ).toBe(confirmed);
  });
  it.each([
    "nonce",
    "proof",
    "ref",
    "cookie",
    "origin",
    "actor",
    "program",
    "operation",
    "owner",
    "lease",
    "pending",
    "expired",
    "unsealed",
    "scope",
  ])("rejects %s mismatch with sanitized error", (caseName) => {
    const input = fixture();
    switch (caseName) {
      case "nonce": {
        input.nonceSha256 = "d".repeat(64);
        break;
      }
      case "proof": {
        input.payload.proof = "switched-proof";
        break;
      }
      case "ref": {
        input.proofRef = "different-ref";
        break;
      }
      case "cookie": {
        input.payload.normalCookie = { ...normalCookie, value: "other-cookie" };
        break;
      }
      case "origin": {
        input.payload.session = { ...session, origin: "https://other.example.test" };
        break;
      }
      case "actor": {
        input.payload.actorKey = "other";
        break;
      }
      case "program": {
        input.record.accountPreparation!.programDigest = "d".repeat(64);
        break;
      }
      case "operation": {
        input.record.operator!.identityLink!.browserSession!.operationRef =
          "33333333-3333-4333-8333-333333333333";
        break;
      }
      case "owner": {
        input.record.operator!.identityLink!.ownerSessionId = "other-owner";
        break;
      }
      case "lease": {
        input.record.leaseId = "33333333-3333-4333-8333-333333333333";
        break;
      }
      case "pending": {
        input.record.operator!.pendingEffectId = "normal-accounts";
        break;
      }
      case "expired": {
        input.now = Date.parse("2035-01-01");
        break;
      }
      case "unsealed": {
        delete input.record.accountPreparation!.captures[0].sealed;
        break;
      }
      case "scope": {
        input.context = { ...context, authority: { ...authority, ownerUserId: "other-user" } };
        break;
      }
      default: {
        throw new Error("Unknown fixture case");
      }
    }
    expect(() => confirmNormalActorCapture(input)).toThrow("normal_actor_confirmation_unavailable");
  });
  it("rejects switched cookies on callback replay", () => {
    const input = fixture();
    const record = confirmNormalActorCapture(input);
    expect(() =>
      confirmNormalActorCapture({
        ...input,
        payload: { ...input.payload, normalCookie: { ...normalCookie, value: "switched-cookie" } },
        record,
      }),
    ).toThrow("normal_actor_confirmation_unavailable");
  });
  it("protects the previously authenticated actual actor ID", () => {
    const input = fixture();
    const state = initialNormalActorState(program, accountOperationRef);
    state.actors[0] = {
      actorKey: "owner",
      session: { ...session, actorId: "other-actual-owner" },
      signup: "complete",
      storageState: { cookies: [], origins: [] },
    };
    input.record.accountPreparation!.sealedState = encryptNormalActorState({ ...scope, state });
    expect(() => confirmNormalActorCapture(input)).toThrow("normal_actor_confirmation_unavailable");
  });
  it("activates a supplemental actual organization session as pending without replacing the base actor", () => {
    const input = fixture();
    const organizationId = "actual-org";
    const scopedProgram = normalActorProgramSchema.parse({
      ...program,
      memberships: [{ actorKey: "owner", organizationId, role: "owner" }],
      organizations: [
        { name: "Actual organization", organizationId, ownerActorKey: "owner", slug: "actual-org" },
      ],
    });
    const scopedPlan = hostedOperatorPlanSchema.parse({
      ...plan,
      normalActorProgram: scopedProgram,
    });
    const programDigest = normalActorProgramDigest(scopedProgram);
    const planDigest = operatorPlanDigest(scopedPlan);
    const scopedScope = { ...scope, program: scopedProgram };
    const state = initialNormalActorState(scopedProgram, accountOperationRef);
    state.actors[0] = {
      actorKey: "owner",
      session: {
        ...session,
        realmSessionId: "actual-base-session",
        reference: "55555555-5555-4555-8555-555555555555",
      },
      signup: "complete",
      storageState: { cookies: [], origins: [] },
    };
    const base = structuredClone(state.actors[0]);
    const preparation = input.record.accountPreparation!;
    preparation.program = scopedProgram;
    preparation.programDigest = programDigest;
    preparation.accountPlan = scopedPlan;
    preparation.accountPlanDigest = planDigest;
    preparation.sealedState = encryptNormalActorState({ ...scopedScope, state });
    preparation.captures[0].organizationId = organizationId;
    input.payload.organizationId = organizationId;
    const link = input.record.operator!.identityLink!;
    link.browserSession!.participantProgramDigest = programDigest;
    link.bootstrapPlanDigest = planDigest;
    link.organizationId = null;
    const result = confirmNormalActorCapture(input);
    const actual = decryptNormalActorState({
      ...scopedScope,
      sealed: result.accountPreparation!.sealedState,
    });
    expect(actual.actors[0]).toEqual(base);
    expect(actual.organizationSessions).toMatchObject([
      { actorKey: "owner", organizationId, selection: "pending", session },
    ]);
    expect(actual.organizationSessions![0].storageState.cookies[0].value).toBe(normalCookie.value);
  });
  it("rejects a participant proof claiming organization membership before provisioning", () => {
    const input = fixture();
    input.record.operator!.identityLink!.organizationId = "future-organization";
    expect(() => confirmNormalActorCapture(input)).toThrow("normal_actor_confirmation_unavailable");
  });
  it("preserves server parent-domain scope and raw encoded bytes", () => {
    const input = fixture();
    input.payload.normalCookie = { ...normalCookie, domain: ".example.test", hostOnly: false };
    input.record.accountPreparation!.captures[0].normalCookieSha256 =
      normalActorCaptureCookieDigest(input.payload.normalCookie);
    const [cookie] = readState(confirmNormalActorCapture(input)).actors[0].storageState!.cookies;
    expect(cookie.domain).toBe(".example.test");
    expect(cookie.value).toBe(normalCookie.value);
  });
});
