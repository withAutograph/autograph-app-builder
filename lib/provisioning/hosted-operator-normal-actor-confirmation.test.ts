/* oxlint-disable typescript/no-non-null-assertion -- Fixture always constructs these required private envelopes and links; tests mutate them to exercise rejection. */
/* oxlint-disable eslint/require-await, unicorn/no-useless-undefined, typescript/consistent-return -- In-memory CAS is asynchronous and returns undefined for a real lost conditional write. */
import { createHash } from "node:crypto";
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

const keyring = { tokenKey: Buffer.alloc(32, 7), tokenKeyVersion: "v1" };
const now = Date.parse("2026-10-14T16:30:00.000Z");
const scope = {
  authority,
  ownerSessionId: target.sessionId,
  operationRef: accountOperationRef,
  program,
  config: keyring,
};
const proof = "actual-private-proof-fixture";
const proofSha256 = createHash("sha256").update(proof).digest("hex");
const nonceSha256 = "c".repeat(64);
const proofRef = `_protected-operator/artifacts/realm-identity-proof/${target.appId}/${proofSha256}`;
const session = {
  reference: "22222222-2222-4222-8222-222222222222",
  actorId: "actual-owner",
  realmSessionId: "actual-session",
  origin: program.origin,
  expiresAt: "2030-01-01T00:00:00.000Z",
};
const fixture = () => {
  const payload: NormalActorCapturedPayload = {
    version: 1,
    actorKey: "owner",
    nonceSha256,
    proofSha256,
    proof,
    session,
    normalCookie,
  };
  const sealedState = encryptNormalActorState({
    ...scope,
    state: initialNormalActorState(program, accountOperationRef),
  });
  const record: HostedRuntimeJournalRecord = {
    version: 1,
    kind: "app-runtime",
    request: target,
    approvedByCallId: "initial-call",
    status: "pending",
    step: "reserved",
    accountPreparation: {
      ...preparationInput,
      sealedState,
      captures: [
        {
          reference: session.reference,
          actorKey: "owner",
          nonceSha256,
          proofSha256,
          expiresAt: session.expiresAt,
          normalCookieSha256: normalActorCaptureCookieDigest(normalCookie),
          sealed: sealedState,
        },
      ],
    },
    operator: {
      mode: "protected-operator-v1",
      operationRef: accountOperationRef,
      plan,
      planDigest: operatorPlanDigest(plan),
      receipts: [],
      identityLink: {
        audience: program.origin,
        issuer: program.origin,
        endpointOrigin: "https://gateway.example.test",
        authResourceId: "auth-resource",
        browserOrigin: program.origin,
        bootstrapPlanDigest: preparationInput.accountPlanDigest,
        ownerSessionId: target.sessionId,
        organizationId: null,
        browserSession: {
          operationRef: accountOperationRef,
          participantProgramDigest: preparationInput.programDigest,
        },
        nonceSha256,
        expiresAt: session.expiresAt,
        sealedNonce: {
          encryptedToken: "private",
          tokenIv: "iv",
          tokenTag: "tag",
          keyVersion: "v1",
        },
      },
    },
  };
  return { context, record, payload, nonceSha256, proofRef, proofSha256, keyring, now };
};
const readState = (record: HostedRuntimeJournalRecord) =>
  decryptNormalActorState({ ...scope, sealed: record.accountPreparation!.sealedState });
describe("human confirmation of private actual actor capture", () => {
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
      signup: "complete",
      session,
      storageState: {
        cookies: [
          {
            name: normalCookie.name,
            value: normalCookie.value,
            domain: normalCookie.domain,
            expires: -1,
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
      confirmNormalActorCapture({ ...input, record: confirmed, now: Date.parse("2035-01-01") }),
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
        record,
        payload: { ...input.payload, normalCookie: { ...normalCookie, value: "switched-cookie" } },
      }),
    ).toThrow("normal_actor_confirmation_unavailable");
  });
  it("protects the previously authenticated actual actor ID", () => {
    const input = fixture();
    const state = initialNormalActorState(program, accountOperationRef);
    state.actors[0] = {
      actorKey: "owner",
      signup: "complete",
      session: { ...session, actorId: "other-actual-owner" },
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
      organizations: [
        { organizationId, slug: "actual-org", name: "Actual organization", ownerActorKey: "owner" },
      ],
      memberships: [{ actorKey: "owner", organizationId, role: "owner" }],
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
      signup: "complete",
      session: {
        ...session,
        reference: "55555555-5555-4555-8555-555555555555",
        realmSessionId: "actual-base-session",
      },
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
    link.organizationId = organizationId;
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
