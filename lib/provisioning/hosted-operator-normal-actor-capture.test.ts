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
const fixture = () => {
  let row: HostedRuntimeJournalRow = {
    record: hostedRuntimeJournalRecordSchema.parse({
      approvedByCallId: "initial-call",
      kind: "app-runtime",
      leaseId: "44444444-4444-4444-8444-444444444444",
      operator: {
        approvalId: "initial-approval",
        mode: "protected-operator-v1",
        operationRef: accountOperationRef,
        plan,
        planDigest: operatorPlanDigest(plan),
        receipts: [],
      },
      privateState: {
        encryptedToken: "resource-private-state",
        keyVersion: "v1",
        tokenIv: "resource-iv",
        tokenTag: "resource-tag",
      },
      request: target,
      status: "pending",
      step: "reserved",
      version: 1,
    }),
    revision: 1,
  };
  let approved = true;
  let owned = true;
  let conflict = false;
  let writes = 0;
  let approvals = 0;
  const journal = createNormalActorJournal({
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
    assertAuthorized: async (input) => {
      if (
        !owned ||
        input.authority.ownerUserId !== authority.ownerUserId ||
        input.target.sessionId !== target.sessionId
      ) {
        throw new Error("owner_revoked");
      }
    },
    assertMutationAuthority: async (_context, current) => {
      if (current.record.leaseId !== row.record.leaseId || current.revision !== row.revision) {
        throw new Error("lease_changed");
      }
    },
    keyring: { tokenKey: Buffer.alloc(32, 7), tokenKeyVersion: "v1" },
    now: () => Date.now(),
    store: {
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
      read: async () => structuredClone(row),
    },
  });
  return {
    get approvals() {
      return approvals;
    },
    conflictOnce() {
      conflict = true;
    },
    journal,
    revokeApproval() {
      approved = false;
    },
    revokeOwner() {
      owned = false;
    },
    get row() {
      return row;
    },
    set row(value) {
      row = value;
    },
    get writes() {
      return writes;
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
    database: "auth",
    environment: "preview" as const,
    hostname: "ep-owned.neon.tech",
    migratorRole: "auth_owner",
    neon: { branchId: "br_fixture", projectId: "neon-owned" },
    port: 5432,
    runtimeRole: "auth_runtime",
    schema: "public" as const,
    version: 1 as const,
  };
  const proof = await new SignJWT({
    authResourceId: "auth-resource",
    bootstrapPlanDigest: preparationInput.accountPlanDigest,
    browserSession: {
      normalCookieSha256: normalActorCaptureCookieDigest(normalCookie),
      operationRef: accountOperationRef,
      participantProgramDigest: preparationInput.programDigest,
    },
    nonceSha256: realmIdentityNonceSha256(nonce),
    organizationId: null,
    ownerSessionId: target.sessionId,
    purpose: "realm-operator-link-v1",
    resource,
    sessionId: "actual-session",
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
    journal: value.journal,
    now: () => Date.now(),
    pending: async () => ({
      actorKey: "owner",
      assertCurrent: async () => {
        if (pendingConsumed) {
          throw new Error("consumed");
        }
      },
      context,
      getKey: async () => keys.publicKey,
      link: {
        audience: "https://builder.example.test",
        authResourceId: "auth-resource",
        bootstrapPlanDigest: preparationInput.accountPlanDigest,
        browserOrigin: program.origin,
        browserSession: {
          operationRef: accountOperationRef,
          participantProgramDigest: preparationInput.programDigest,
        },
        endpointOrigin: "https://gateway.example.test",
        expiresAt: new Date((seconds + 240) * 1000).toISOString(),
        issuer: "https://gateway.example.test",
        nonceSha256: realmIdentityNonceSha256(nonce),
        organizationId: null,
        ownerSessionId: target.sessionId,
      },
      readback: async () => {
        readbacks += 1;
        return Response.json({
          identity: {
            actorId: "actual-actor",
            expiresAt: "2030-01-01T00:00:00.000Z",
            organizationId: null,
            sessionId: "actual-session",
            version: 1,
          },
          resource,
        });
      },
      resource,
    }),
    sender: {
      audience: "audience",
      environment: "preview",
      issuer: "https://oidc.vercel.example",
      ownerId: "team",
      projectId: "prj_auth",
      subject: "auth-subject",
    },
    verifyCapturedActor: async (input) => {
      expect(input.normalCookie.value).toBe(normalCookie.value);
      return {
        actorId: "actual-actor",
        email: actualEmail,
        expiresAt: "2030-01-01T00:00:00.000Z",
        sessionId: "actual-session",
      };
    },
    verifySender: async () => ({
      aud: "audience",
      environment: "preview",
      iss: "https://oidc.vercel.example",
      owner_id: "team",
      project_id: senderProject,
      sub: "auth-subject",
    }),
  };
  const handler = createNormalActorCaptureHandler(ports);
  const body = {
    operationRef: accountOperationRef,
    origin: program.origin,
    ownerSessionId: target.sessionId,
    participantProgramDigest: preparationInput.programDigest,
    proof,
    purpose: "realm-normal-browser-session-v1",
    reviewedNonce: nonce,
    version: 1,
  };
  const request = (
    phase: "authorize" | "capture",
    extra: Record<string, z.infer<ReturnType<typeof z.json>>> = {},
  ) => {
    const requestBody: typeof body & { phase: typeof phase; normalCookie?: typeof normalCookie } = {
      ...body,
      phase,
    };
    if (phase === "capture") requestBody.normalCookie = normalCookie;
    return new Request(`https://builder.example.test${NORMAL_ACTOR_CAPTURE_PATH}`, {
      body: JSON.stringify({ ...requestBody, ...extra }),
      headers: { authorization: "Bearer signed.oidc.token", "content-type": "application/json" },
      method: "POST",
    });
  };
  return {
    consume() {
      pendingConsumed = true;
    },
    handler,
    get readbacks() {
      return readbacks;
    },
    request,
    swapEmail() {
      actualEmail = "other@example.test";
    },
    swapSender() {
      senderProject = "wrong-auth-project";
    },
    value,
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
        cookie: { normalCookie: { ...normalCookie, value: "different%2Fcredential" } },
        nonce: { reviewedNonce: "d".repeat(64) },
        operation: { operationRef: "33333333-3333-4333-8333-333333333333" },
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
