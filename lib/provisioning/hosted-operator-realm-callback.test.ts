/* oxlint-disable eslint/require-await, eslint/no-await-in-loop, unicorn/no-await-expression-member -- Fixture ports model async native I/O; replay negatives are exercised in order. */
import { createHash, generateKeyPairSync } from "node:crypto";
import { SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { createRealmIdentityCallbackHandler } from "./hosted-operator-realm-callback";
import { InMemoryHostedEveStore, toDurableHostedSessionRecord } from "../eve/hosted-store";
import { hostedEveOperationScopes } from "../eve/hosted-auth";
import { createHostedOperatorOwnerContextResolver } from "./hosted-operator-owner-context";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { realmIdentityNonceSha256 } from "./hosted-operator-auth-identity";
import type { HostedOperatorContext } from "./hosted-operator-service";

const resource = {
  database: "auth_owned",
  environment: "preview" as const,
  hostname: "ep-owned.neon.tech",
  migratorRole: "auth_migrator",
  neon: { branchId: "owned-branch", projectId: "owned-project" },
  port: 5432,
  runtimeRole: "auth_runtime",
  schema: "public" as const,
  version: 1 as const,
};
const fixture = async (ownerSessionId = "original-public-session") => {
  const keys = generateKeyPairSync("ed25519");
  const nonce = "a".repeat(64);
  const issuedAt = Math.floor(Date.now() / 1000);
  const link = {
    audience: "https://operator.example",
    authResourceId: "auth-owned",
    bootstrapPlanDigest: "b".repeat(64),
    browserOrigin: "https://public-auth.example",
    endpointOrigin: "https://immutable-gateway.example",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    issuer: "https://public-auth.example",
    nonceSha256: realmIdentityNonceSha256(nonce),
    organizationId: null,
    ownerSessionId,
  };
  const proof = await new SignJWT({
    aud: link.audience,
    authResourceId: link.authResourceId,
    bootstrapPlanDigest: link.bootstrapPlanDigest,
    exp: issuedAt + 240,
    iat: issuedAt,
    iss: link.issuer,
    nonceSha256: link.nonceSha256,
    organizationId: null,
    ownerSessionId,
    purpose: "realm-operator-link-v1",
    resource,
    sessionId: "normal-realm-session",
    sub: "normal-realm-user",
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "native", typ: "autograph-realm-operator-link+jwt" })
    .sign(keys.privateKey);
  let consumed = false;
  const context: HostedOperatorContext = {
    authority: {
      audience: "https://builder.example/mcp",
      issuer: "https://builder.example/api/auth",
      ownerUserId: "builder-user",
      workspaceId: "owned-workspace",
    },
    target: {
      appId: "owned-app",
      branch: "approved-branch",
      environment: "preview",
      installationId: "owned-installation",
      projectId: "owned-project",
      scopeId: "owned-team",
      scopeType: "team",
      sessionId: ownerSessionId,
    },
  };
  const ports = {
    assertCurrent: vi.fn(async () => {}),
    authenticate: vi.fn(async () => context),
    builderOrigin: "https://builder.example",
    consume: vi.fn(async () => {
      if (consumed) {
        throw new Error("replay");
      }
      consumed = true;
    }),
    fetch: vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/_platform/jwks.json") {
        return Response.json({
          keys: [
            {
              ...keys.publicKey.export({ format: "jwk" }),
              alg: "EdDSA",
              kid: "native",
              use: "sig",
            },
          ],
        });
      }
      return Response.json({
        identity: {
          actorId: "normal-realm-user",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          organizationId: null,
          sessionId: "normal-realm-session",
          version: 1,
        },
        resource,
      });
    }),
    keyring: { tokenKey: Buffer.alloc(32, 5), tokenKeyVersion: "fixture-v1" },
    publish: vi.fn(async (_context: HostedOperatorContext, value: string) => ({
      proofRef: "private-immutable-proof",
      proofSha256: createHash("sha256").update(value).digest("hex"),
    })),
    staging: vi.fn(async () => {
      if (consumed) {
        throw new Error("consumed");
      }
      return {
        bootstrapResource: resource,
        jwksUrl: "https://immutable-gateway.example/_platform/jwks.json",
        link,
      };
    }),
  };
  const handler = createRealmIdentityCallbackHandler(ports);
  const post = async () =>
    await handler(
      new Request("https://builder.example/api/hosted-operator/realm-identity", {
        body: new URLSearchParams({ nonce, proof }),
        headers: { origin: link.issuer },
        method: "POST",
      }),
    );
  return { context, handler, link, nonce, ownerSessionId, ports, post, proof };
};
describe("normal-owner sealed Realm browser callback", () => {
  it("validates proof before sealing, permits Lax owner GET, publishes only after fresh readback and CAS once", async () => {
    const f = await fixture();
    const staged = await f.post();
    expect(staged.status).toBe(303);
    const cookie = staged.headers.get("set-cookie");
    expect(cookie).toContain("Secure; HttpOnly; SameSite=Lax");
    expect(cookie).not.toContain("Domain=");
    expect(cookie).not.toContain(f.proof);
    expect(staged.headers.get("location")).not.toContain(f.nonce);
    expect(f.ports.publish).not.toHaveBeenCalled();
    const request = new Request(staged.headers.get("location") ?? "https://missing.invalid", {
      headers: { cookie: (cookie ?? "").split(";").at(0) ?? "" },
    });
    expect((await f.handler(request)).status).toBe(200);
    expect(f.ports.publish).toHaveBeenCalledWith(f.context, f.proof);
    expect(f.ports.consume).toHaveBeenCalledOnce();
    expect((await f.handler(request)).status).toBe(401);
    expect(f.ports.publish).toHaveBeenCalledOnce();
  });
  it("rejects tampered proof, foreign nonce, wrong owner and sibling staging handles", async () => {
    const f = await fixture();
    const bad = await f.handler(
      new Request("https://builder.example/api/hosted-operator/realm-identity", {
        body: new URLSearchParams({ nonce: "c".repeat(64), proof: f.proof }),
        headers: { origin: f.link.issuer },
        method: "POST",
      }),
    );
    expect(bad.status).toBe(401);
    const staged = await f.post();
    const cookie = (staged.headers.get("set-cookie") ?? "").split(";").at(0) ?? "";
    expect(
      (
        await f.handler(
          new Request(
            "https://builder.example/api/hosted-operator/realm-identity?session=sibling-session",
            { headers: { cookie } },
          ),
        )
      ).status,
    ).toBe(401);
    f.ports.authenticate.mockRejectedValue(new Error("foreign owner"));
    expect(
      (
        await f.handler(
          new Request(staged.headers.get("location") ?? "https://missing.invalid", {
            headers: { cookie },
          }),
        )
      ).status,
    ).toBe(401);
    expect(f.ports.publish).not.toHaveBeenCalled();
    expect(f.ports.consume).not.toHaveBeenCalled();
  });
  it("uses the real owner resolver with exact four-field authority and separate canonical principal", async () => {
    const f = await fixture();
    const authority = hostedTenantAuthoritySchema.parse(f.context.authority);
    const principal = { ...authority, scopes: Object.values(hostedEveOperationScopes) };
    const store = new InMemoryHostedEveStore();
    const operation = {
      clientRequestId: "owned-start",
      createdAtEpochMs: 1,
      kind: "start" as const,
      operationId: "owned-start",
      principal,
      requestDigest: `sha256:${"d".repeat(64)}`,
      state: "reserved" as const,
      updatedAtEpochMs: 1,
      version: 1 as const,
    };
    await store.reserveOperation(principal, operation);
    await store.settleSucceeded({
      nowEpochMs: 1,
      operationId: operation.operationId,
      principal,
      requestDigest: operation.requestDigest,
      result: { cursor: 0, events: [], sessionId: f.ownerSessionId, status: "waiting" },
      session: toDurableHostedSessionRecord({
        adapterSessionId: "real-adapter",
        createdAtEpochMs: 1,
        principal,
        sessionId: f.ownerSessionId,
        status: "waiting",
        updatedAtEpochMs: 1,
        version: 1,
      }),
    });
    const resolver = createHostedOperatorOwnerContextResolver({
      audience: authority.audience,
      // oxlint-disable-next-line unicorn/no-useless-undefined -- The native handoff store represents absence with undefined.
      handoffs: { read: async () => undefined },
      isActiveMember: async () => true,
      issuer: authority.issuer,
      sessions: store,
    });
    const auth = {
      attributes: {
        "mcp:audience": principal.audience,
        "mcp:scopes": principal.scopes,
        "mcp:workspace-id": principal.workspaceId,
      },
      authenticator: "mcp-oauth-jwks",
      issuer: principal.issuer,
      principalId: principal.ownerUserId,
      principalType: "user",
      subject: principal.ownerUserId,
    };
    const owner = await resolver({
      adapterSessionId: "real-adapter",
      authority,
      principal,
      sessionAuth: { current: auth, initiator: auth },
    });
    expect(owner.authority).toEqual(authority);
    expect(owner.principal.scopes).toEqual(principal.scopes);
    expect(() => hostedTenantAuthoritySchema.parse(principal)).toThrow();
  });
});
