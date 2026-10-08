/* oxlint-disable eslint/sort-keys, unicorn/no-await-expression-member, typescript/no-unsafe-type-assertion, anti-slop/no-runtime-typeof -- This fixture imports only the explicit local source API and preserves its source-shaped contracts; sequential native assertions check every dynamic API and readonly result. */
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { betterAuth as betterAuthFactory } from "better-auth";
import type { RealmIdentityCallbackPorts } from "../../../../lib/provisioning/hosted-operator-realm-callback";

interface Identity {
  version: 1;
  actorId: string;
  sessionId: string;
  organizationId: string | null;
  expiresAt: string;
}
interface Database {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
  end: () => Promise<void>;
}
type PhysicalResource = Awaited<
  ReturnType<RealmIdentityCallbackPorts["staging"]>
>["bootstrapResource"];
interface IdentityModule {
  readNormalSignedRealmIdentity: (input: {
    headers: Headers;
    organizationId: string | null;
    cookieName: string;
    secret: string;
    database: { query: (sql: string, values: readonly unknown[]) => Promise<{ rows: unknown[] }> };
  }) => Promise<Identity | null>;
  readNormalRealmIdentityBySession: (input: {
    database: { query: (sql: string, values: readonly unknown[]) => Promise<{ rows: unknown[] }> };
    actorId: string;
    realmSessionId: string;
    organizationId: string | null;
  }) => Promise<Identity | null>;
}
interface LinkModule {
  issueRealmOperatorLinkProof: (input: {
    identity: Identity;
    resource: PhysicalResource;
    challenge: {
      nonce: string;
      ownerSessionId: string;
      bootstrapPlanDigest: string;
      authResourceId: string;
      organizationId: string | null;
    };
    config: {
      browserOrigin: string;
      builderCallbackOrigin: string;
      builderCallbackPath: "/api/hosted-operator/realm-identity";
      operatorOrigin: string;
    };
    issuer: string;
    keyId: string;
    privateKey: string;
  }) => string;
  verifyRealmOperatorLinkProof: (input: {
    proof: string;
    issuer: string;
    audience: string;
    keyId: string;
    privateKey: string;
  }) => { sub: string; sessionId: string; organizationId: string | null };
}

/** Source-only cookie/proof and fresh readonly native session lookup. Preview physical metadata is modeled by the caller; no hosted resource is claimed. */
export const openOwnedRealmSource = async (input: {
  sourceRoot: string;
  ownerConnection: string;
  runtimeConnection: string;
  staging: Awaited<ReturnType<RealmIdentityCallbackPorts["staging"]>>;
  nonce: string;
  builderOrigin: string;
}) => {
  const sourceRequire = createRequire(path.join(input.sourceRoot, "package.json"));
  // SAFETY: Runtime modules come exclusively from the explicitly selected Arrusted source and its existing dependencies.
  const { Pool } = sourceRequire("pg") as {
    Pool: new (options: { connectionString: string }) => Database;
  };
  // SAFETY: Use the selected source package entry and installed BetterAuth types; native signup verifies its behavior.
  const { betterAuth } = (await import(
    pathToFileURL(sourceRequire.resolve("better-auth")).href
  )) as { betterAuth: typeof betterAuthFactory };
  // SAFETY: The selected source exports this fixed readonly identity API; the acceptance checks native current and foreign actors.
  const identityModule = (await import(
    pathToFileURL(path.join(input.sourceRoot, "packages/auth/operator-identity.ts")).href
  )) as IdentityModule;
  // SAFETY: The selected source owns proof signing and verification; callback signature and nonce negatives exercise this API.
  const links = (await import(
    pathToFileURL(path.join(input.sourceRoot, "packages/auth/operator-identity-link.ts")).href
  )) as LinkModule;
  assert.equal(
    typeof identityModule.readNormalRealmIdentityBySession,
    "function",
    "Actual Arrusted readonly session source helper is required",
  );
  const owner = new Pool({ connectionString: input.ownerConnection });
  const runtime = new Pool({ connectionString: input.runtimeConnection });
  try {
    await owner.query(
      await readFile(path.join(input.sourceRoot, "packages/auth/schema.sql"), "utf-8"),
    );
    await owner.query("create table public.app_actor_assignment (id text primary key)");
    const privileges = (
      await readFile(path.join(input.sourceRoot, "packages/auth/runtime-privileges.sql"), "utf-8")
    )
      .replaceAll("__RUNTIME_ROLE_LITERAL__", "'realm_runtime'")
      .replaceAll("__RUNTIME_ROLE__", '"realm_runtime"');
    await owner.query(privileges);
    const { browserOrigin } = input.staging.link;
    const auth = betterAuth({
      baseURL: browserOrigin,
      database: runtime,
      emailAndPassword: { enabled: true },
      secret: randomBytes(32).toString("hex"),
      trustedOrigins: [browserOrigin],
    });
    const signup = await auth.handler(
      new Request(`${browserOrigin}/api/auth/sign-up/email`, {
        body: JSON.stringify({
          name: "Owned Realm fixture",
          email: "realm-owner@example.test",
          password: randomBytes(32).toString("hex"),
        }),
        headers: { "content-type": "application/json", origin: browserOrigin },
        method: "POST",
      }),
    );
    assert.equal(signup.status, 200, "normal source BetterAuth signup in owned PG");
    const cookie = signup.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie !== undefined && cookie !== "");
    const headers = new Headers({
      cookie,
      host: new URL(browserOrigin).host,
      origin: browserOrigin,
    });
    const normal = await auth.api.getSession({
      headers,
      query: { disableCookieCache: true, disableRefresh: true },
    });
    assert.ok(normal);
    const authContext = await auth.$context;
    const database = {
      query: async (query: string, values: readonly unknown[]) =>
        await runtime.query(query, [...values]),
    };
    const identity = await identityModule.readNormalSignedRealmIdentity({
      cookieName: authContext.authCookies.sessionToken.name,
      database,
      headers,
      organizationId: null,
      secret: authContext.secret,
    });
    assert.ok(identity);
    assert.equal(identity.actorId, normal.user.id);
    assert.equal(identity.sessionId, normal.session.id);
    assert.equal(normal.user.emailVerified, false);
    assert.equal(
      await identityModule.readNormalSignedRealmIdentity({
        cookieName: authContext.authCookies.sessionToken.name,
        database,
        headers: new Headers({ cookie: `${cookie}tampered` }),
        organizationId: null,
        secret: authContext.secret,
      }),
      null,
    );
    const preservedSessions = (
      await owner.query('select id,token,"expiresAt" from public.session order by id')
    ).rows;
    const keys = generateKeyPairSync("ed25519");
    const privateKey = keys.privateKey.export({ format: "pem", type: "pkcs8" });
    const keyId = "owned-realm-key";
    const proof = links.issueRealmOperatorLinkProof({
      challenge: {
        authResourceId: input.staging.link.authResourceId,
        bootstrapPlanDigest: input.staging.link.bootstrapPlanDigest,
        nonce: input.nonce,
        organizationId: null,
        ownerSessionId: input.staging.link.ownerSessionId,
      },
      config: {
        browserOrigin,
        builderCallbackOrigin: input.builderOrigin,
        builderCallbackPath: "/api/hosted-operator/realm-identity",
        operatorOrigin: input.staging.link.audience,
      },
      identity,
      issuer: input.staging.link.issuer,
      keyId,
      privateKey,
      resource: input.staging.bootstrapResource,
    });
    const foreignProof = links.issueRealmOperatorLinkProof({
      challenge: {
        authResourceId: input.staging.link.authResourceId,
        bootstrapPlanDigest: input.staging.link.bootstrapPlanDigest,
        nonce: input.nonce,
        organizationId: null,
        ownerSessionId: "foreign-owner-session",
      },
      config: {
        browserOrigin,
        builderCallbackOrigin: input.builderOrigin,
        builderCallbackPath: "/api/hosted-operator/realm-identity",
        operatorOrigin: input.staging.link.audience,
      },
      identity,
      issuer: input.staging.link.issuer,
      keyId,
      privateKey,
      resource: input.staging.bootstrapResource,
    });
    assert.equal(
      await identityModule.readNormalRealmIdentityBySession({
        actorId: "foreign-actor",
        database,
        organizationId: null,
        realmSessionId: identity.sessionId,
      }),
      null,
    );
    let sessionReads = 0;
    const fetch: typeof globalThis.fetch = async (request, init) => {
      const incoming = request instanceof Request ? request : new Request(request, init);
      const url = new URL(incoming.url);
      assert.equal(url.origin, input.staging.link.endpointOrigin);
      assert.equal(incoming.headers.get("cookie"), null, "Realm cookie remains at Auth");
      if (url.pathname === "/_platform/jwks.json") {
        assert.equal(incoming.method, "GET");
        return Response.json({
          keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: keyId }],
        });
      }
      assert.equal(url.pathname, "/api/auth/platform/operator-identity/readback");
      assert.equal(incoming.method, "POST");
      const submitted = new URLSearchParams(await incoming.text()).get("proof");
      assert.ok(submitted !== null && submitted !== "");
      const claims = links.verifyRealmOperatorLinkProof({
        audience: input.staging.link.audience,
        issuer: input.staging.link.issuer,
        keyId,
        privateKey,
        proof: submitted,
      });
      const current = await identityModule.readNormalRealmIdentityBySession({
        actorId: claims.sub,
        database,
        organizationId: claims.organizationId,
        realmSessionId: claims.sessionId,
      });
      sessionReads += 1;
      return current === null
        ? Response.json({ code: "auth_required" }, { status: 401 })
        : Response.json({ identity: current, resource: input.staging.bootstrapResource });
    };
    return {
      async assertPreserved() {
        assert.ok(sessionReads > 0, "Callback uses actual readonly source session readback");
        assert.deepEqual(
          (await owner.query('select id,token,"expiresAt" from public.session order by id')).rows,
          preservedSessions,
        );
        assert.equal(
          z
            .object({ count: z.number() })
            .parse((await owner.query('select count(*)::int as count from public."user"')).rows[0])
            .count,
          1,
        );
        assert.equal(
          z
            .object({ count: z.number() })
            .parse(
              (await owner.query("select count(*)::int as count from public.organization")).rows[0],
            ).count,
          0,
        );
        assert.equal(
          z
            .object({ count: z.number() })
            .parse((await owner.query("select count(*)::int as count from public.member")).rows[0])
            .count,
          0,
        );
      },
      async close() {
        await runtime.end();
        await owner.end();
      },
      fetch,
      foreignProof,
      identity,
      proof,
      async setSessionCurrent(current: boolean) {
        await owner.query('update public.session set "expiresAt"=$1 where id=$2', [
          current ? new Date(identity.expiresAt) : new Date(Date.now() - 60_000),
          identity.sessionId,
        ]);
      },
    };
  } catch (error) {
    await runtime.end();
    await owner.end();
    throw error;
  }
};
