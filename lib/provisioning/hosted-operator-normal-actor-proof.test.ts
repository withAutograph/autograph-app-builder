/* oxlint-disable eslint/require-await, unicorn/no-useless-undefined -- Fixture CAS and key ports preserve their asynchronous production interfaces. */
import { createHash } from "node:crypto";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { generateKeyPair, SignJWT, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import {
  normalActorProgramSchema,
  normalActorProgramDigest,
} from "./hosted-operator-normal-actor-program";
import { createNormalActorJournal } from "./hosted-operator-normal-actor-journal";
import type { NormalActorJournalPorts } from "./hosted-operator-normal-actor-journal";
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import type { HostedRuntimeJournalRow } from "./hosted-runtime-journal";
import { prepareNormalActorAccounts } from "./hosted-operator-normal-actors";
import { createHostedOperatorNormalAuthClient } from "./hosted-operator-normal-auth-client";
import { createHostedOperatorNormalActorProofCollector } from "./hosted-operator-normal-actor-proof";
import type { OperatorArtifactStore } from "./hosted-operator-artifact-store";

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
const fixture = async () => {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA");
  const auth = betterAuth({
    secret: "normal-owner-proof-local-fixture-long-secret",
    baseURL: program.origin,
    emailAndPassword: { enabled: true },
    plugins: [organization()],
    logger: { disabled: true },
  });
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
        approvalId: "initial-approval",
        receipts: [],
      },
    }),
  };
  let approved = true;
  let wrongCallback = false;
  let wrongActor = false;
  const requests: Request[] = [];
  const cookies = new Map<string, string>();
  const artifacts = new Map<string, string>();
  const resource = {
    version: 1 as const,
    database: plan.authDatabase.database,
    environment: "preview" as const,
    hostname: plan.neon.endpoint,
    migratorRole: plan.authDatabase.migratorRole,
    runtimeRole: plan.authDatabase.runtimeRole,
    neon: { projectId: plan.neon.projectId, branchId: plan.neon.branchId },
    port: 5432,
    schema: "public" as const,
  };
  const assertAuthorized = async () => {
    if (!approved) {
      throw new Error("fixture_approval_revoked");
    }
  };
  const journalPorts: NormalActorJournalPorts = {
    keyring: { tokenKey: Buffer.alloc(32, 7), tokenKeyVersion: "v1" },
    now: () => Date.now(),
    assertAuthorized,
    assertAccountApproval: async (_input, preparation) => {
      await assertAuthorized();
      expect(preparation.accountOperationRef).toBe(accountOperationRef);
      expect(preparation.accountApprovalId).toBe("initial-approval");
    },
    assertMutationAuthority: async (_input, current) => {
      await assertAuthorized();
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
  const normalFetch: typeof fetch = async (url, init) => {
    const request = new Request(url, init);
    requests.push(request.clone());
    if (new URL(request.url).pathname !== "/api/auth/platform/operator-link") {
      return await auth.handler(request);
    }
    expect(request.method).toBe("POST");
    expect(request.headers.get("origin")).toBe(program.origin);
    const values = new URLSearchParams(await request.text());
    expect(values.has("operationRef")).toBe(false);
    expect(values.has("participantProgramDigest")).toBe(false);
    const actual = await auth.api.getSession({ headers: request.headers });
    if (actual === null) {
      return new Response(null, { status: 401 });
    }
    cookies.set(actual.session.id, request.headers.get("cookie") ?? "");
    const proof = await new SignJWT({
      purpose: "realm-operator-link-v1",
      sessionId: actual.session.id,
      organizationId: null,
      ownerSessionId: values.get("ownerSessionId"),
      authResourceId: values.get("authResourceId"),
      bootstrapPlanDigest: values.get("bootstrapPlanDigest"),
      nonceSha256: createHash("sha256")
        .update(values.get("nonce") ?? "")
        .digest("hex"),
      resource,
    })
      .setProtectedHeader({
        alg: "EdDSA",
        kid: "fixture-key",
        typ: "platform-realm-operator-link+jwt",
      })
      .setIssuer(program.origin)
      .setAudience("https://operator.example.com")
      .setSubject(wrongActor ? "different-real-actor" : actual.user.id)
      .setIssuedAt()
      .setExpirationTime("4m")
      .sign(privateKey);
    const action = wrongCallback
      ? "https://unapproved.example.com/api/hosted-operator/realm-identity"
      : "https://builder.example.com/api/hosted-operator/realm-identity";
    return new Response(
      `<!doctype html><title>Account confirmed</title><form method="post" action="${action}"><input type="hidden" name="nonce" value="${values.get("nonce")}"><input type="hidden" name="proof" value="${proof}"><button type="submit">Return to App Builder</button></form>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  };
  const journal = createNormalActorJournal(journalPorts);
  await journal.retain(context, {
    program,
    programDigest: normalActorProgramDigest(program),
    accountOperationRef,
    accountPlan: plan,
    accountPlanDigest: operatorPlanDigest(plan),
    accountApprovalId: "initial-approval",
    accountApprovedByCallId: "initial-call",
  });
  await prepareNormalActorAccounts({
    program,
    operationRef: accountOperationRef,
    ports: {
      assertCurrent: assertAuthorized,
      checkpoint: async (state) => {
        await journal.checkpoint(context, state);
      },
      readCapturedActor: async () => null,
      readOrganizationSession: async () => null,
      clientFactory: (input) =>
        createHostedOperatorNormalAuthClient({ ...input, fetch: normalFetch }),
    },
  });
  const artifactStore: OperatorArtifactStore = {
    put: async (_context, chunk) => {
      await assertAuthorized();
      const previous = artifacts.get(chunk.artifactRef);
      if (previous !== undefined && previous !== chunk.content) {
        throw new Error("fixture_immutable_artifact");
      }
      artifacts.set(chunk.artifactRef, chunk.content);
    },
    read: async (_context, ref) => {
      await assertAuthorized();
      return artifacts.get(ref);
    },
  };
  const collect = createHostedOperatorNormalActorProofCollector({
    journalPorts,
    assertPlanningAuthorized: assertAuthorized,
    normalRealmFetch: async (input) => {
      expect(input.origin).toBe(program.origin);
      return normalFetch;
    },
    ownedArtifacts: async () => ({
      context: { authority, target: { appId: target.appId, sessionId: target.sessionId } },
      store: artifactStore,
    }),
    resolveRealmBinding: async () => ({
      authResourceId: plan.authDatabase.resourceId,
      bootstrapPlanDigest: "d".repeat(64),
      issuer: program.origin,
      audience: "https://operator.example.com",
      endpointOrigin:
        plan.deploymentBoundary?.verification.gatewayOrigin ?? "https://gateway.example.test",
      builderCallbackOrigin: "https://builder.example.com",
      resource,
      getKey: async () => publicKey,
      transportSource: {
        issuer: "https://oidc.vercel.com",
        audience: "https://operator.example.com",
        ownerId: "team",
        projectId: "prj_operator",
        environment: "preview",
      },
      readback: async (request) => {
        expect(new URL(request.url).origin).toBe(
          plan.deploymentBoundary?.verification.gatewayOrigin,
        );
        expect(new URL(request.url).pathname).toBe("/api/auth/platform/operator-identity/readback");
        const values = new URLSearchParams(await request.text());
        const proof = values.get("proof");
        if (proof === null) {
          return new Response(null, { status: 401 });
        }
        const { payload } = await jwtVerify(proof, publicKey, {
          issuer: program.origin,
          audience: "https://operator.example.com",
          ...(values.has("attestation")
            ? {
                currentDate: new Date(
                  z
                    .object({ capturedAt: z.iso.datetime() })
                    .parse(JSON.parse(values.get("attestation") ?? "{}")).capturedAt,
                ),
              }
            : {}),
        });
        const cookie = cookies.get(String(payload.sessionId));
        const actual = await auth.api.getSession({
          headers: new Headers({ cookie: cookie ?? "" }),
        });
        if (actual === null) {
          return new Response(null, { status: 401 });
        }
        return Response.json({
          identity: {
            version: 1,
            actorId: actual.user.id,
            sessionId: actual.session.id,
            organizationId: null,
            expiresAt: actual.session.expiresAt.toISOString(),
          },
          resource,
        });
      },
    }),
  });
  const input = async (organizationId: string) => {
    const prepared = await journal.read(context);
    if (prepared === undefined) {
      throw new Error("fixture_missing_preparation");
    }
    const owner = prepared.state.organizationSessions?.find(
      (entry) => entry.actorKey === "owner" && entry.organizationId === organizationId,
    )?.session;
    if (owner === undefined) {
      throw new Error("fixture_missing_owner");
    }
    return { ...context, plan, ...prepared, organizationId, owner };
  };
  return {
    collect,
    input,
    journal,
    requests,
    artifacts,
    get row() {
      return row;
    },
    revoke() {
      approved = false;
    },
    badCallback() {
      wrongCallback = true;
    },
    badActor() {
      wrongActor = true;
    },
  };
};

describe("normal organization owner proof collector", () => {
  it("collects signed actual per-organization session proofs and reuses the same private artifacts on retry", async () => {
    const f = await fixture();
    const one = await f.collect(await f.input("org-one"));
    const two = await f.collect(await f.input("org-two"));
    expect(one.identityCapture.realmSessionId).not.toBe(two.identityCapture.realmSessionId);
    expect(one.identityProof.reference).not.toBe(two.identityProof.reference);
    expect(f.row.record.accountPreparation?.organizationProofs).toHaveLength(2);
    const retained = f.row.record.accountPreparation?.organizationProofs?.[0];
    expect(retained?.link.sealedNonce).toBeDefined();
    expect(retained?.link.organizationId).toBeNull();
    expect(retained?.owner.realmSessionId).toBe(one.identityCapture.realmSessionId);
    expect(await f.collect(await f.input("org-one"))).toEqual(one);
    expect(
      f.requests.filter(
        (request) => new URL(request.url).pathname === "/api/auth/platform/operator-link",
      ),
    ).toHaveLength(2);
    expect(f.requests.every((request) => new URL(request.url).origin === program.origin)).toBe(
      true,
    );
    expect(f.artifacts.size).toBe(2);
  });
  it("rejects an unapproved callback destination without retaining a proof", async () => {
    const f = await fixture();
    f.badCallback();
    await expect(f.collect(await f.input("org-one"))).rejects.toMatchObject({
      code: "auth_identity_required",
    });
    expect(f.artifacts.size).toBe(0);
    expect(
      f.row.record.accountPreparation?.organizationProofs?.[0]?.link.consumedAt,
    ).toBeUndefined();
  });
  it("rejects a signed claim that differs from the actual retained owner session", async () => {
    const f = await fixture();
    f.badActor();
    await expect(f.collect(await f.input("org-one"))).rejects.toMatchObject({
      code: "auth_identity_required",
    });
    expect(f.artifacts.size).toBe(0);
  });
  it("rechecks first account authority on a consumed retry before any new request", async () => {
    const f = await fixture();
    const input = await f.input("org-one");
    await f.collect(input);
    const before = f.requests.length;
    f.revoke();
    await expect(f.collect(input)).rejects.toMatchObject({ code: "auth_identity_required" });
    expect(f.requests).toHaveLength(before);
  });
});
