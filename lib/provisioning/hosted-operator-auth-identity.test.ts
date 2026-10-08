/* oxlint-disable eslint/no-await-in-loop, unicorn/no-await-expression-member, sonarjs/no-undefined-assignment -- Negative fixture responses are consumed one at a time; the explicit omitted nonce exercises captured-proof reuse. */
import { createHash, generateKeyPairSync } from "node:crypto";
import { SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import {
  createRealmIdentityBrowserUrl,
  readVerifiedRealmAccess,
  realmIdentityNonceSha256,
  verifyRealmIdentityLinkProof,
} from "./hosted-operator-auth-identity";

const keys = generateKeyPairSync("ed25519");
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
const nonce = "a".repeat(64);
const fixture = async () => {
  const now = new Date();
  const issuedAt = Math.floor(now.getTime() / 1000);
  const pending = {
    audience: "https://operator.example",
    authResourceId: "auth-owned",
    bootstrapPlanDigest: "b".repeat(64),
    browserOrigin: "https://public-auth.example",
    endpointOrigin: "https://gateway.example",
    expiresAt: new Date(now.getTime() + 600_000).toISOString(),
    issuer: "https://public.example",
    nonceSha256: realmIdentityNonceSha256(nonce),
    organizationId: null,
    ownerSessionId: "original-public-session",
  };
  const claims = {
    aud: pending.audience,
    authResourceId: pending.authResourceId,
    bootstrapPlanDigest: pending.bootstrapPlanDigest,
    exp: issuedAt + 240,
    iat: issuedAt,
    iss: pending.issuer,
    nonceSha256: pending.nonceSha256,
    organizationId: null,
    ownerSessionId: pending.ownerSessionId,
    purpose: "realm-operator-link-v1",
    resource,
    sessionId: "actual-normal-realm-session",
    sub: "actual-normal-realm-actor",
  };
  const proof = await new SignJWT(claims)
    .setProtectedHeader({
      alg: "EdDSA",
      kid: "actual-native-key",
      typ: "autograph-realm-operator-link+jwt",
    })
    .sign(keys.privateKey);
  return {
    claims,
    getKey: async () => await Promise.resolve(keys.publicKey),
    nonce,
    now,
    pending,
    proof,
    resource,
  };
};
describe("private Realm identity bridge", () => {
  it("validates exact pending nonce, physical resource, owner session and separate signed purpose", async () => {
    const f = await fixture();
    expect(await verifyRealmIdentityLinkProof(f)).toMatchObject({
      organizationId: null,
      sub: f.claims.sub,
    });
    await expect(verifyRealmIdentityLinkProof({ ...f, nonce: "c".repeat(64) })).rejects.toThrow();
    await expect(
      verifyRealmIdentityLinkProof({ ...f, resource: { ...resource, database: "other_auth" } }),
    ).rejects.toThrow();
    await expect(
      verifyRealmIdentityLinkProof({
        ...f,
        pending: { ...f.pending, ownerSessionId: "another-session" },
      }),
    ).rejects.toThrow();
    await expect(
      verifyRealmIdentityLinkProof({
        ...f,
        pending: { ...f.pending, consumedAt: new Date().toISOString() },
      }),
    ).rejects.toThrow();
  });
  it("rechecks native current identity through closed POST without cookie and checks authority again", async () => {
    const f = await fixture();
    const assertCurrent = vi.fn(async () => {
      await Promise.resolve();
    });
    const readback = vi.fn(async (request: Request) => {
      expect(request.url).toBe(
        "https://gateway.example/api/auth/platform/operator-identity/readback",
      );
      expect(request.method).toBe("POST");
      expect(request.redirect).toBe("error");
      expect(request.headers.has("cookie")).toBe(false);
      expect(await request.text()).toContain("proof=");
      return Response.json({
        identity: {
          actorId: f.claims.sub,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          organizationId: null,
          sessionId: f.claims.sessionId,
          version: 1,
        },
        resource,
      });
    });
    expect(
      (await readVerifiedRealmAccess({ ...f, assertCurrent, readback })).identity.actorId,
    ).toBe(f.claims.sub);
    expect(assertCurrent).toHaveBeenCalledTimes(2);
    await expect(
      readVerifiedRealmAccess({
        ...f,
        assertCurrent,
        pending: {
          ...f.pending,
          consumedAt: new Date().toISOString(),
          proofRef: "private-proof",
          proofSha256: "c".repeat(64),
        },
        readback,
      }),
    ).rejects.toThrow();
    const captured = {
      ...f.pending,
      consumedAt: new Date().toISOString(),
      proofRef: "private-proof",
      proofSha256: createHash("sha256").update(f.proof).digest("hex"),
    };
    expect(
      (
        await readVerifiedRealmAccess({
          ...f,
          assertCurrent,
          nonce: undefined,
          pending: captured,
          readback,
        })
      ).identity.actorId,
    ).toBe(f.claims.sub);
  });
  it("fails closed on revoked native session or mismatching readback, without fabricating identity", async () => {
    const f = await fixture();
    const assertCurrent = vi.fn(async () => {
      await Promise.resolve();
    });
    for (const response of [
      Response.json({ code: "auth_identity_required" }, { status: 401 }),
      Response.json({
        identity: {
          actorId: "other-actor",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          organizationId: null,
          sessionId: f.claims.sessionId,
          version: 1,
        },
        resource,
      }),
    ]) {
      await expect(
        readVerifiedRealmAccess({
          ...f,
          assertCurrent,
          readback: async () => await Promise.resolve(response),
        }),
      ).rejects.toThrow();
    }
    await expect(
      readVerifiedRealmAccess({
        ...f,
        assertCurrent: async () => {
          await Promise.reject(new Error("owner revoked"));
        },
        readback: async () => await Promise.resolve(Response.json({})),
      }),
    ).rejects.toThrow("owner revoked");
  });
});

it("uses only the live canonical nonce and approved normal Auth browser origin for the link", async () => {
  const f = await fixture();
  const url = new URL(createRealmIdentityBrowserUrl({ link: f.pending, nonce }));
  expect(url.origin).toBe(f.pending.browserOrigin);
  expect(url.pathname).toBe("/api/auth/platform/operator-link");
  expect(url.searchParams.get("ownerSessionId")).toBe(f.pending.ownerSessionId);
  expect(url.searchParams.get("organizationId")).toBeNull();
  expect(url.toString()).not.toContain(f.pending.endpointOrigin);
  expect(() => createRealmIdentityBrowserUrl({ link: f.pending, nonce: "c".repeat(64) })).toThrow();
  expect(() =>
    createRealmIdentityBrowserUrl({
      link: { ...f.pending, consumedAt: new Date().toISOString() },
      nonce,
    }),
  ).toThrow();
});

it("uses the immutable consumed receipt for an expired transport proof while fresh Realm readback governs authority", async () => {
  const f = await fixture();
  const issued = Math.floor(Date.now() / 1000) - 600;
  const proof = await new SignJWT({ ...f.claims, exp: issued + 240, iat: issued })
    .setProtectedHeader({
      alg: "EdDSA",
      kid: "actual-native-key",
      typ: "autograph-realm-operator-link+jwt",
    })
    .sign(keys.privateKey);
  const capturedAt = new Date((issued + 1) * 1000).toISOString();
  const pending = {
    ...f.pending,
    consumedAt: capturedAt,
    proofRef: "owned-private-proof",
    proofSha256: createHash("sha256").update(proof).digest("hex"),
  };
  const current = vi.fn(async () => {
    await Promise.resolve();
  });
  const readback = vi.fn(async (request: Request) => {
    const body = new URLSearchParams(await request.text());
    expect(JSON.parse(body.get("attestation") ?? "null")).toEqual({
      capturedAt,
      proofSha256: pending.proofSha256,
      purpose: "realm-captured-link-readback-v1",
      realmSessionId: f.claims.sessionId,
      version: 1,
    });
    return Response.json({
      identity: {
        actorId: f.claims.sub,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        organizationId: null,
        sessionId: f.claims.sessionId,
        version: 1,
      },
      resource,
    });
  });
  await expect(
    readVerifiedRealmAccess({ ...f, assertCurrent: current, pending, proof, readback }),
  ).resolves.toMatchObject({ identity: { actorId: f.claims.sub } });
  await expect(
    readVerifiedRealmAccess({ ...f, assertCurrent: current, proof, readback }),
  ).rejects.toThrow();
  await expect(
    readVerifiedRealmAccess({
      ...f,
      assertCurrent: current,
      pending: { ...pending, consumedAt: new Date((issued - 1) * 1000).toISOString() },
      proof,
      readback,
    }),
  ).rejects.toThrow();
  await expect(
    readVerifiedRealmAccess({
      ...f,
      assertCurrent: current,
      pending,
      proof,
      readback: async () => await Promise.resolve(new Response(null, { status: 401 })),
    }),
  ).rejects.toThrow();
});
