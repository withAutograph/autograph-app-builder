/* oxlint-disable eslint/require-await, eslint/no-await-in-loop, unicorn/no-await-expression-member -- Fixture ports model async native I/O; replay negatives are exercised in order. */
import { createHash, generateKeyPairSync } from "node:crypto";
import { SignJWT } from "jose";
import { z } from "zod";
import type { RealmIdentityCallbackPorts } from "./hosted-operator-realm-callback";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRealmIdentityCallbackHandler,
  createRealmIdentityHandoffSenderVerifier,
} from "./hosted-operator-realm-callback";
import { InMemoryHostedEveStore, toDurableHostedSessionRecord } from "../eve/hosted-store";
import { hostedEveOperationScopes } from "../eve/hosted-auth";
import { createHostedOperatorOwnerContextResolver } from "./hosted-operator-owner-context";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { realmIdentityNonceSha256 } from "./hosted-operator-auth-identity";
import type { HostedOperatorContext } from "./hosted-operator-service";
import type {
  OperatorArtifactContext,
  OperatorArtifactStore,
} from "./hosted-operator-artifact-store";
import { HostedOperatorError } from "./hosted-operator-contract";
import { encryptVercelToken } from "../integrations/vercel-installation";

afterEach(() => {
  vi.restoreAllMocks();
});

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
const artifactKey = (owner: OperatorArtifactContext, reference: string) =>
  JSON.stringify([owner.authority, owner.target.appId, owner.target.sessionId, reference]);
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
    .setProtectedHeader({ alg: "EdDSA", kid: "native", typ: "platform-realm-operator-link+jwt" })
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
  const artifacts = new Map<string, string>();
  const store: OperatorArtifactStore = {
    put: vi.fn<OperatorArtifactStore["put"]>(async (owner, chunk) => {
      artifacts.set(artifactKey(owner, chunk.artifactRef), chunk.content);
    }),
    read: vi.fn<OperatorArtifactStore["read"]>(async (owner, reference) =>
      artifacts.get(artifactKey(owner, reference)),
    ),
  };
  const ports = {
    assertCurrent: vi.fn(async () => {}),
    authenticate: vi.fn<RealmIdentityCallbackPorts["authenticate"]>(async () => context),
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
    afterLinked: vi.fn(
      async (
        _context: HostedOperatorContext,
        _observed: { nonceSha256: string; proofRef: string; proofSha256: string },
      ) => {},
    ),
    identityHandoff: {
      verifySender: vi.fn(async (request: Request) => {
        if (request.headers.get("authorization") !== "Bearer trusted.gateway.token") {
          throw new Error("foreign sender");
        }
      }),
      context: vi.fn(async () => context),
      artifacts: store,
    },
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
  const nativePost = async (changes: { body?: object; headers?: Record<string, string> } = {}) =>
    await handler(
      new Request("https://builder.example/api/hosted-operator/realm-identity", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer trusted.gateway.token",
          ...changes.headers,
        },
        body: JSON.stringify({
          version: 1,
          purpose: "realm-owner-identity-stage-v1",
          origin: link.browserOrigin,
          nonce,
          proof,
          ...changes.body,
        }),
      }),
    );
  return {
    artifacts,
    context,
    handler,
    link,
    nativePost,
    nonce,
    ownerSessionId,
    ports,
    post,
    proof,
  };
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
    expect((await f.handler(request)).status).toBe(303);
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

describe("native private Realm identity handoff", () => {
  it("emits no private staging failure diagnostic on success", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await fixture();
    expect((await f.nativePost()).status).toBe(200);
    expect(log).not.toHaveBeenCalled();
  });
  it.each([
    ["canonical_pending", "auth_schema_not_ready"],
    ["context", "authorization_required"],
    ["current_authority", "operation_in_progress"],
    ["artifact", "operator_unavailable"],
  ] as const)("reports only the closed %s failure and public code", async (stage, code) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await fixture();
    const failure = new HostedOperatorError(code);
    if (stage === "canonical_pending") {
      f.ports.staging.mockRejectedValue(failure);
    }
    if (stage === "context") {
      f.ports.identityHandoff.context.mockRejectedValue(failure);
    }
    if (stage === "current_authority") {
      f.ports.assertCurrent.mockRejectedValue(failure);
    }
    if (stage === "artifact") {
      vi.mocked(f.ports.identityHandoff.artifacts.put).mockRejectedValue(failure);
    }
    const response = await f.nativePost();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "auth_identity_required" });
    expect(log).toHaveBeenCalledExactlyOnceWith("realm_identity_callback_failure", {
      stage,
      errorClass: "operator_error",
      code,
    });
  });
  it("allowlists JOSE codes while discarding private error details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await fixture();
    f.ports.fetch.mockRejectedValue(
      Object.assign(new Error(`private ${f.proof}`), {
        code: "ERR_JWKS_TIMEOUT",
        cause: { cookie: "private-cookie", nonce: f.nonce },
      }),
    );
    expect((await f.nativePost()).status).toBe(401);
    expect(log).toHaveBeenCalledExactlyOnceWith("realm_identity_callback_failure", {
      stage: "proof_verification",
      errorClass: "jose_error",
      code: "ERR_JWKS_TIMEOUT",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(f.proof);
    expect(JSON.stringify(log.mock.calls)).not.toContain(f.nonce);
    expect(JSON.stringify(log.mock.calls)).not.toContain(f.ownerSessionId);
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-cookie");
  });
  it.each<{
    status: number;
    headers: Record<string, string>;
    expected: { httpStatus: number; contentType: string; vercelError?: string };
  }>([
    {
      status: 403,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-vercel-error": "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH",
      },
      expected: {
        httpStatus: 403,
        contentType: "html",
        vercelError: "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH",
      },
    },
    {
      status: 403,
      headers: {
        "content-type": "private-content-type; private-parameter=private-value",
        "x-vercel-error": "private-provider-error",
      },
      expected: { httpStatus: 403, contentType: "other", vercelError: "other" },
    },
    {
      status: 200,
      headers: { "content-type": "application/json; private-parameter=private-value" },
      expected: { httpStatus: 200, contentType: "json" },
    },
    {
      status: 404,
      headers: { "x-vercel-error": "DEPLOYMENT_NOT_FOUND" },
      expected: { httpStatus: 404, contentType: "missing", vercelError: "DEPLOYMENT_NOT_FOUND" },
    },
  ])("reports only closed JWKS response metadata on failure: $expected", async (input) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await fixture();
    const denied = new Response(null, { status: input.status, headers: input.headers });
    f.ports.fetch.mockResolvedValue(denied);
    const response = await f.nativePost();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "auth_identity_required" });
    expect(log).toHaveBeenCalledExactlyOnceWith("realm_identity_callback_failure", {
      stage: "proof_verification",
      errorClass: "jose_error",
      code: "ERR_JOSE_GENERIC",
      jwks: input.expected,
    });
    expect(f.ports.fetch).toHaveBeenCalledOnce();
    expect(f.ports.identityHandoff.artifacts.put).not.toHaveBeenCalled();
    expect(f.ports.consume).not.toHaveBeenCalled();
    const retained = JSON.stringify(log.mock.calls);
    for (const secret of [
      "private-content-type",
      "private-parameter",
      "private-value",
      "private-provider-error",
      f.proof,
      f.nonce,
      f.ownerSessionId,
      f.link.endpointOrigin,
    ]) {
      expect(retained).not.toContain(secret);
    }
  });
  it("omits malicious messages and nonallowlisted codes without invoking getters", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await fixture();
    const error = Object.assign(new Error("private-message"), { code: "private-code" });
    f.ports.staging.mockRejectedValueOnce(error);
    expect((await f.nativePost()).status).toBe(401);
    const readCode = vi.fn(() => {
      throw new Error("private-getter");
    });
    f.ports.staging.mockRejectedValueOnce(
      Object.defineProperty(new Error("private-message"), "code", { get: readCode }),
    );
    expect((await f.nativePost()).status).toBe(401);
    expect(readCode).not.toHaveBeenCalled();
    expect(log.mock.calls).toEqual([
      ["realm_identity_callback_failure", { stage: "canonical_pending", errorClass: "unknown" }],
      ["realm_identity_callback_failure", { stage: "canonical_pending", errorClass: "unknown" }],
    ]);
  });
  it("preserves the denial when the diagnostic sink throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("sink unavailable");
    });
    const f = await fixture();
    f.ports.staging.mockRejectedValue(new HostedOperatorError("authorization_required"));
    const response = await f.nativePost();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "auth_identity_required" });
  });

  it("stages a verified proof privately and completes through an opaque normal-owner GET once", async () => {
    const f = await fixture();
    const response = await f.nativePost();
    expect(response.status).toBe(200);
    const body = z
      .object({ version: z.literal(1), continuationUrl: z.url() })
      .parse(await response.json());
    const url = new URL(body.continuationUrl);
    expect(url.origin).toBe(f.ports.builderOrigin);
    expect(url.pathname).toBe("/api/hosted-operator/realm-identity");
    expect([...url.searchParams.keys()]).toEqual(["handoff"]);
    expect(body.continuationUrl).not.toContain(f.proof);
    expect(body.continuationUrl).not.toContain(f.nonce);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(JSON.stringify([...f.artifacts])).not.toContain(f.proof);
    expect(f.ports.publish).not.toHaveBeenCalled();
    const result = await f.handler(new Request(body.continuationUrl));
    expect(result.status).toBe(303);
    expect(result.headers.get("location")).toBe(`${f.ports.builderOrigin}/auth/account-connected`);
    expect(f.ports.authenticate).toHaveBeenCalledWith(expect.any(Request), {
      nonceSha256: f.link.nonceSha256,
      ownerSessionId: f.ownerSessionId,
    });
    expect(f.ports.consume).toHaveBeenCalledWith({
      context: f.context,
      nonceSha256: f.link.nonceSha256,
      proofRef: "private-immutable-proof",
      proofSha256: createHash("sha256").update(f.proof).digest("hex"),
    });
    expect(f.ports.afterLinked).toHaveBeenCalledOnce();
    expect((await f.handler(new Request(body.continuationUrl))).status).toBe(401);
    expect(f.ports.publish).toHaveBeenCalledOnce();
  });

  it("shows account connection completion after committed linking even when the wake dispatcher fails", async () => {
    const f = await fixture();
    const response = await f.nativePost();
    const body = z.object({ continuationUrl: z.url() }).parse(await response.json());
    f.ports.afterLinked.mockRejectedValue(new Error("dispatch unavailable"));
    const result = await f.handler(new Request(body.continuationUrl));
    expect(result.status).toBe(303);
    expect(result.headers.get("location")).toBe(`${f.ports.builderOrigin}/auth/account-connected`);
    expect(f.ports.consume).toHaveBeenCalledOnce();
    expect((await f.handler(new Request(body.continuationUrl))).status).toBe(401);
  });

  it.each(["sender", "origin", "nonce", "proof"] as const)(
    "rejects an invalid private %s before storing or consuming proof",
    async (kind) => {
      const f = await fixture();
      const response = await f.nativePost(
        kind === "sender"
          ? { headers: { authorization: "Bearer foreign.gateway.token" } }
          : { body: { [kind]: kind === "nonce" ? "c".repeat(64) : "invalid" } },
      );
      expect(response.status).toBe(401);
      expect(f.artifacts.size).toBe(0);
      expect(f.ports.consume).not.toHaveBeenCalled();
      expect(f.ports.afterLinked).not.toHaveBeenCalled();
    },
  );

  it.each([
    "ticket",
    "expired-ticket",
    "owner",
    "foreign-owner-scope",
    "changed-nonce",
    "artifact",
    "known-nonce",
  ] as const)("rejects %s on completion without publishing", async (kind) => {
    const f = await fixture();
    const response = await f.nativePost();
    const body = z.object({ continuationUrl: z.url() }).parse(await response.json());
    const url = new URL(body.continuationUrl);
    if (kind === "ticket") {
      url.searchParams.set("handoff", `${url.searchParams.get("handoff") ?? ""}tampered`);
    } else if (kind === "expired-ticket") {
      const ticket = {
        version: 1,
        ownerSessionId: f.ownerSessionId,
        nonceSha256: f.link.nonceSha256,
        claimSecret: "c".repeat(64),
        expiresAt: Date.now() - 1,
      };
      const envelope = {
        ...encryptVercelToken({
          key: f.ports.keyring.tokenKey,
          token: JSON.stringify(ticket),
          associatedData: `realm-owner-identity-handoff-v1:${f.ports.builderOrigin}:/api/hosted-operator/realm-identity`,
        }),
        keyVersion: f.ports.keyring.tokenKeyVersion,
      };
      url.searchParams.set("handoff", Buffer.from(JSON.stringify(envelope)).toString("base64url"));
    } else if (kind === "owner") {
      f.ports.authenticate.mockRejectedValue(new Error("wrong owner"));
    } else if (kind === "foreign-owner-scope") {
      f.ports.authenticate.mockResolvedValue({
        ...f.context,
        authority: { ...f.context.authority, ownerUserId: "other" },
      });
    } else if (kind === "changed-nonce") {
      f.link.nonceSha256 = "c".repeat(64);
    } else if (kind === "artifact") {
      for (const key of f.artifacts.keys()) {
        f.artifacts.set(key, "tampered");
      }
    } else {
      url.search = new URLSearchParams({ session: f.ownerSessionId, nonce: f.nonce }).toString();
    }
    expect((await f.handler(new Request(url))).status).toBe(401);
    expect(f.ports.publish).not.toHaveBeenCalled();
    expect(f.ports.consume).not.toHaveBeenCalled();
    expect(f.ports.afterLinked).not.toHaveBeenCalled();
  });

  it("retains the opaque return path when the original owner needs to sign in", async () => {
    const f = await fixture();
    const response = await f.nativePost();
    const body = z.object({ continuationUrl: z.url() }).parse(await response.json());
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Missing normal Builder session is an explicit authentication outcome.
    f.ports.authenticate.mockResolvedValueOnce(undefined);
    const result = await f.handler(new Request(body.continuationUrl));
    expect(result.status).toBe(303);
    const signIn = new URL(result.headers.get("location") ?? "https://missing.invalid");
    expect(signIn.pathname).toBe("/auth/sign-in");
    expect(signIn.searchParams.get("redirectTo")).toBe(
      new URL(body.continuationUrl).pathname + new URL(body.continuationUrl).search,
    );
    expect(f.ports.identityHandoff.artifacts.read).not.toHaveBeenCalled();
    expect(f.ports.consume).not.toHaveBeenCalled();
    expect((await f.handler(new Request(body.continuationUrl))).status).toBe(303);
  });
});

const nativeSender = {
  issuer: "https://oidc.vercel.com/team",
  audience: "https://vercel.com/team",
  ownerId: "team",
  projectId: "gateway",
  environment: "preview" as const,
  subject: "gateway-preview",
};
const senderPayload = {
  iss: nativeSender.issuer,
  aud: nativeSender.audience,
  owner_id: nativeSender.ownerId,
  project_id: nativeSender.projectId,
  environment: nativeSender.environment,
  sub: nativeSender.subject,
};
describe("exact native Gateway sender", () => {
  it("passes all configured native verification constraints", async () => {
    const verify = vi.fn(async () => ({ payload: senderPayload }));
    await createRealmIdentityHandoffSenderVerifier(
      nativeSender,
      verify,
    )(
      new Request("https://builder.example", {
        headers: { authorization: "Bearer signed.native.token" },
      }),
    );
    expect(verify).toHaveBeenCalledWith("signed.native.token", {
      audience: nativeSender.audience,
      issuer: nativeSender.issuer,
      ownerId: nativeSender.ownerId,
      projectId: nativeSender.projectId,
      environment: nativeSender.environment,
      subject: nativeSender.subject,
    });
  });
  it.each(["iss", "aud", "owner_id", "project_id", "environment", "sub"] as const)(
    "rejects a foreign native %s",
    async (field) => {
      const verify = vi.fn(async () => ({ payload: { ...senderPayload, [field]: "foreign" } }));
      await expect(
        createRealmIdentityHandoffSenderVerifier(
          nativeSender,
          verify,
        )(
          new Request("https://builder.example", {
            headers: { authorization: "Bearer signed.native.token" },
          }),
        ),
      ).rejects.toThrow();
    },
  );
});
