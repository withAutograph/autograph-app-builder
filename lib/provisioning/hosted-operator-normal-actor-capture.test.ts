/* oxlint-disable eslint/require-await, unicorn/no-useless-undefined, typescript/consistent-return -- In-memory CAS is asynchronous and returns undefined for a real lost conditional write. */
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import {
  normalActorProgramDigest,
  normalActorProgramSchema,
} from "./hosted-operator-normal-actor-program";
import {
  createNormalActorJournal,
  normalActorCaptureCookieDigest,
} from "./hosted-operator-normal-actor-journal";
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import type { HostedRuntimeJournalRow } from "./hosted-runtime-journal";

import { generateKeyPair, SignJWT } from "jose";
import {
  createNormalActorCaptureHandler,
  NORMAL_ACTOR_CAPTURE_PATH,
} from "./hosted-operator-normal-actor-capture";
import type { NormalActorCapturePorts } from "./hosted-operator-normal-actor-capture";
import { realmIdentityNonceSha256 } from "./hosted-operator-auth-identity";

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

const captureFixture = async () => {
  const value = fixture();
  await value.journal.retain(context, preparationInput);
  const keys = await generateKeyPair("EdDSA");
  const nonce = "e".repeat(64);
  const seconds = Math.floor(Date.now() / 1000);
  const resource = {
    version: 1 as const,
    database: "auth",
    environment: "preview" as const,
    hostname: "ep-owned.neon.tech",
    migratorRole: "auth_owner",
    runtimeRole: "auth_runtime",
    port: 5432,
    schema: "public" as const,
    neon: { branchId: "br_fixture", projectId: "neon-owned" },
  };
  const proof = await new SignJWT({
    authResourceId: "auth-resource",
    bootstrapPlanDigest: preparationInput.accountPlanDigest,
    nonceSha256: realmIdentityNonceSha256(nonce),
    ownerSessionId: target.sessionId,
    purpose: "realm-operator-link-v1",
    resource,
    organizationId: null,
    sessionId: "actual-session",
    browserSession: {
      operationRef: accountOperationRef,
      participantProgramDigest: preparationInput.programDigest,
      normalCookieSha256: normalActorCaptureCookieDigest(normalCookie),
    },
  })
    .setProtectedHeader({ alg: "EdDSA", typ: "platform-realm-operator-link+jwt" })
    .setIssuer("https://gateway.example.test")
    .setAudience("https://builder.example.test")
    .setSubject("actual-actor")
    .setIssuedAt(seconds)
    .setExpirationTime(seconds + 180)
    .sign(keys.privateKey);
  let readbacks = 0;
  let actualEmail = program.actors[0]?.email ?? "missing";
  let senderProject = "prj_auth";
  let pendingConsumed = false;
  const ports: NormalActorCapturePorts = {
    builderOrigin: "https://builder.example.test",
    sender: {
      issuer: "https://oidc.vercel.example",
      audience: "audience",
      ownerId: "team",
      projectId: "prj_auth",
      environment: "preview",
      subject: "auth-subject",
    },
    verifySender: async () => ({
      iss: "https://oidc.vercel.example",
      aud: "audience",
      owner_id: "team",
      project_id: senderProject,
      environment: "preview",
      sub: "auth-subject",
    }),
    pending: async () => ({
      context,
      actorKey: "owner",
      resource,
      getKey: async () => keys.publicKey,
      assertCurrent: async () => {
        if (pendingConsumed) {
          throw new Error("consumed");
        }
      },
      link: {
        audience: "https://builder.example.test",
        authResourceId: "auth-resource",
        bootstrapPlanDigest: preparationInput.accountPlanDigest,
        browserOrigin: program.origin,
        endpointOrigin: "https://gateway.example.test",
        expiresAt: new Date((seconds + 240) * 1000).toISOString(),
        issuer: "https://gateway.example.test",
        nonceSha256: realmIdentityNonceSha256(nonce),
        organizationId: null,
        ownerSessionId: target.sessionId,
        browserSession: {
          operationRef: accountOperationRef,
          participantProgramDigest: preparationInput.programDigest,
        },
      },
      readback: async () => {
        readbacks += 1;
        return Response.json({
          resource,
          identity: {
            version: 1,
            actorId: "actual-actor",
            organizationId: null,
            sessionId: "actual-session",
            expiresAt: "2030-01-01T00:00:00.000Z",
          },
        });
      },
    }),
    journal: value.journal,
    verifyCapturedActor: async (input) => {
      expect(input.normalCookie.value).toBe(normalCookie.value);
      return {
        actorId: "actual-actor",
        sessionId: "actual-session",
        email: actualEmail,
        expiresAt: "2030-01-01T00:00:00.000Z",
      };
    },
    now: () => Date.now(),
  };
  const handler = createNormalActorCaptureHandler(ports);
  const body = {
    version: 1,
    purpose: "realm-normal-browser-session-v1",
    ownerSessionId: target.sessionId,
    operationRef: accountOperationRef,
    participantProgramDigest: preparationInput.programDigest,
    reviewedNonce: nonce,
    proof,
    origin: program.origin,
  };
  const request = (
    phase: "authorize" | "capture",
    extra: Record<string, z.infer<ReturnType<typeof z.json>>> = {},
  ) =>
    new Request(`https://builder.example.test${NORMAL_ACTOR_CAPTURE_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer signed.oidc.token", "content-type": "application/json" },
      body: JSON.stringify({
        ...body,
        phase,
        ...(phase === "capture" ? { normalCookie } : {}),
        ...extra,
      }),
    });
  return {
    value,
    handler,
    request,
    get readbacks() {
      return readbacks;
    },
    swapEmail() {
      actualEmail = "other@example.test";
    },
    swapSender() {
      senderProject = "wrong-auth-project";
    },
    consume() {
      pendingConsumed = true;
    },
  };
};

describe("normal Auth two-phase private capture", () => {
  it("verifies signed proof and actual readback twice and preserves raw cookie metadata only in encrypted staging", async () => {
    const value = await captureFixture();
    const authorized = await value.handler(value.request("authorize"));
    expect(await authorized.json()).toEqual({ authorized: true });
    const capturedResponse = await value.handler(value.request("capture"));
    expect(await capturedResponse.json()).toEqual({ captured: true });
    expect(value.readbacks).toBe(2);
    const reference = value.value.row.record.accountPreparation?.captures[0]?.reference;
    const captured = await value.value.journal.readCapture(context, reference ?? "missing");
    expect(captured?.normalCookie).toEqual(normalCookie);
    expect(captured?.session.actorId).toBe("actual-actor");
    expect(value.value.row.record.operator?.identityLink?.consumedAt).toBeUndefined();
    expect(JSON.stringify(value.value.row)).not.toContain(normalCookie.value);
  });
  it("preserves the server-issued Domain attribute and session-only expiry unchanged", async () => {
    const value = await captureFixture();
    await value.handler(value.request("authorize"));
    const domainCookie = { ...normalCookie, domain: ".example.test", hostOnly: false };
    const result = await value.handler(value.request("capture", { normalCookie: domainCookie }));
    expect(result.status).toBe(200);
    const reference = value.value.row.record.accountPreparation?.captures[0]?.reference;
    const captured = await value.value.journal.readCapture(context, reference ?? "missing");
    expect(captured?.normalCookie).toEqual(domainCookie);
  });
  it("requires phase authorization and actual approved-email identity before saving credentials", async () => {
    const value = await captureFixture();
    const withoutAuthorization = await value.handler(value.request("capture"));
    expect(withoutAuthorization.status).toBe(403);
    await value.handler(value.request("authorize"));
    value.swapEmail();
    const wrongAccount = await value.handler(value.request("capture"));
    expect(wrongAccount.status).toBe(403);
    expect(value.value.row.record.accountPreparation?.captures[0]?.sealed).toBeUndefined();
  });
  it.each(["sender", "nonce", "operation", "cookie", "proof", "consumed"])(
    "rejects %s mismatch with no raw diagnostic or credential ACK",
    async (kind) => {
      const value = await captureFixture();
      await value.handler(value.request("authorize"));
      if (kind === "sender") {
        value.swapSender();
      }
      if (kind === "consumed") {
        value.consume();
      }
      const extras = {
        nonce: { reviewedNonce: "d".repeat(64) },
        operation: { operationRef: "33333333-3333-4333-8333-333333333333" },
        cookie: { normalCookie: { ...normalCookie, value: "different%2Fcredential" } },
        proof: { proof: "forged.private.proof" },
      };
      const extra = Object.entries(extras).find(([key]) => key === kind)?.[1] ?? {};
      const response = await value.handler(value.request("capture", extra));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "realm_browser_session_capture_unavailable" });
      expect(value.value.row.record.accountPreparation?.captures[0]?.sealed).toBeUndefined();
    },
  );
  it("rejects oversized bodies before parsing credential bytes", async () => {
    const value = await captureFixture();
    const response = await value.handler(
      value.request("authorize", { extra: "private".repeat(10_000) }),
    );
    expect(response.status).toBe(403);
    expect(value.readbacks).toBe(0);
  });
});
