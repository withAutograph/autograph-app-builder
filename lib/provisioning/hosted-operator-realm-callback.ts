/* oxlint-disable eslint/no-await-in-loop -- Bounded callback body is read sequentially; the reader cancels immediately at the byte limit. */
import { createHash } from "node:crypto";
import { createRemoteJWKSet, customFetch } from "jose";
import { z } from "zod";
import {
  encryptVercelToken,
  decryptVersionedVercelToken,
} from "../integrations/vercel-installation";
import type { VercelTokenKeyringConfig } from "../integrations/vercel-installation";
import type { openHostedOperatorCompositionResources } from "./hosted-operator-source-configuration";
import type { HostedOperatorContext } from "./hosted-operator-service";
import {
  readVerifiedRealmAccess,
  realmIdentityNonceSha256,
  verifyRealmIdentityLinkProof,
} from "./hosted-operator-auth-identity";
import type {
  PendingRealmIdentityLink,
  realmPhysicalResourceSchema,
} from "./hosted-operator-auth-identity";

const PATH = "/api/hosted-operator/realm-identity";
const COOKIE = "__Secure-autograph-realm-identity-stage";
const bodySchema = z.strictObject({
  nonce: z.string().regex(/^[a-f0-9]{64}$/u),
  ownerSessionId: z.string().min(1).max(200),
  proof: z.string().min(1).max(16_384),
});
const stageSchema = bodySchema.extend({ expiresAt: z.number().int(), version: z.literal(1) });
const envelopeSchema = z.strictObject({
  encryptedToken: z.string(),
  keyVersion: z.string(),
  tokenIv: z.string(),
  tokenTag: z.string(),
});
const noStore = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
interface Staging {
  link: PendingRealmIdentityLink;
  bootstrapResource: z.infer<typeof realmPhysicalResourceSchema>;
  jwksUrl: string;
}
export interface RealmIdentityCallbackPorts {
  builderOrigin: string;
  keyring: VercelTokenKeyringConfig;
  fetch: typeof fetch;
  staging: (input: { ownerSessionId: string; nonceSha256: string }) => Promise<Staging>;
  authenticate: (
    request: Request,
    input: { ownerSessionId: string; nonceSha256: string },
  ) => Promise<HostedOperatorContext | undefined>;
  assertCurrent: (context: HostedOperatorContext) => Promise<void>;
  publish: (
    context: HostedOperatorContext,
    proof: string,
  ) => Promise<{ proofRef: string; proofSha256: string }>;
  consume: (input: {
    context: HostedOperatorContext;
    nonceSha256: string;
    proofRef: string;
    proofSha256: string;
  }) => Promise<void>;
}
const aad = (origin: string, sessionId: string) =>
  `autograph-realm-identity-browser-stage-v1:${origin}:${PATH}:${sessionId}`;
const cookieName = (sessionId: string) =>
  `${COOKIE}-${createHash("sha256").update(sessionId).digest("hex").slice(0, 24)}`;
const cookieHeader = (value: string, seconds: number, sessionId: string) =>
  `${cookieName(sessionId)}=${value}; Path=${PATH}; Max-Age=${seconds}; Secure; HttpOnly; SameSite=Lax`;
const readBody = async (request: Request): Promise<string> => {
  if (request.body === null) {
    throw new Error("realm_body_required");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    size += next.value.byteLength;
    if (size > 16_384) {
      await reader.cancel();
      throw new Error("realm_body_too_large");
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks).toString("utf-8");
};
const routing = (nonce: string, proof: string) => {
  const [, payload] = proof.split(".");
  if (!payload) {
    throw new Error("realm_proof_invalid");
  }
  const hint = z
    .object({ ownerSessionId: z.string().min(1).max(200) })
    .parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")));
  // Unverified routing hint is never authorization: the exact pending nonce selects verifier config below.
  return bodySchema.parse({ nonce, ownerSessionId: hint.ownerSessionId, proof });
};
const fromCookie = (request: Request, ports: RealmIdentityCallbackPorts, sessionId: string) => {
  const name = cookieName(sessionId);
  const value = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  if (value === undefined || value === "" || value.length > 3800) {
    throw new Error("realm_stage_required");
  }
  const envelope = envelopeSchema.parse(
    JSON.parse(Buffer.from(value, "base64url").toString("utf-8")),
  );
  const stage = stageSchema.parse(
    JSON.parse(
      decryptVersionedVercelToken({
        ...envelope,
        associatedData: aad(ports.builderOrigin, sessionId),
        config: ports.keyring,
      }),
    ),
  );
  if (stage.ownerSessionId !== sessionId || stage.expiresAt <= Date.now()) {
    throw new Error("realm_stage_expired");
  }
  return stage;
};
/** The POST never grants identity. Normal-owner GET rechecks current Realm and canonical nonce before publication/CAS. */
export const createRealmIdentityCallbackHandler =
  (ports: RealmIdentityCallbackPorts) =>
  async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    let sessionId = url.searchParams.get("session") ?? "";
    try {
      const validOrigin = url.origin === ports.builderOrigin && url.pathname === PATH;
      const validQuery =
        request.method === "POST"
          ? url.search === ""
          : url.searchParams.getAll("session").length === 1 &&
            [...url.searchParams.keys()].every((key) => key === "session");
      if (!validOrigin || !validQuery) {
        throw new Error("realm_callback_scope");
      }
      if (request.method === "POST") {
        const values = new URLSearchParams(await readBody(request));
        const input = routing(values.get("nonce") ?? "", values.get("proof") ?? "");
        const staging = await ports.staging({
          nonceSha256: realmIdentityNonceSha256(input.nonce),
          ownerSessionId: input.ownerSessionId,
        });
        if (request.headers.get("origin") !== staging.link.browserOrigin) {
          throw new Error("realm_callback_origin");
        }
        const getKey = createRemoteJWKSet(new URL(staging.jwksUrl), { [customFetch]: ports.fetch });
        const claims = await verifyRealmIdentityLinkProof({
          ...input,
          getKey,
          pending: staging.link,
          resource: staging.bootstrapResource,
        });
        sessionId = input.ownerSessionId;
        const seconds = Math.min(240, claims.exp - Math.floor(Date.now() / 1000));
        const encrypted = encryptVercelToken({
          associatedData: aad(ports.builderOrigin, sessionId),
          key: ports.keyring.tokenKey,
          token: JSON.stringify({ ...input, expiresAt: Date.now() + seconds * 1000, version: 1 }),
        });
        const value = Buffer.from(
          JSON.stringify({ ...encrypted, keyVersion: ports.keyring.tokenKeyVersion }),
        ).toString("base64url");
        if (value.length > 3800) {
          throw new Error("realm_stage_too_large");
        }
        return new Response(null, {
          headers: {
            ...noStore,
            location: `${ports.builderOrigin}${PATH}?session=${encodeURIComponent(sessionId)}`,
            "set-cookie": cookieHeader(value, seconds, sessionId),
          },
          status: 303,
        });
      }
      if (request.method !== "GET") {
        throw new Error("realm_callback_method");
      }
      const stage = fromCookie(request, ports, sessionId);
      const selector = {
        nonceSha256: realmIdentityNonceSha256(stage.nonce),
        ownerSessionId: stage.ownerSessionId,
      };
      const context = await ports.authenticate(request, selector);
      if (context === undefined) {
        const returnPath = `${PATH}?session=${encodeURIComponent(sessionId)}`;
        return new Response(null, {
          headers: {
            ...noStore,
            location: `${ports.builderOrigin}/auth/sign-in?redirectTo=${encodeURIComponent(returnPath)}`,
          },
          status: 303,
        });
      }
      const staging = await ports.staging(selector);
      const getKey = createRemoteJWKSet(new URL(staging.jwksUrl), { [customFetch]: ports.fetch });
      await readVerifiedRealmAccess({
        ...stage,
        assertCurrent: async () => {
          await ports.assertCurrent(context);
        },
        getKey,
        pending: staging.link,
        readback: async (query) => await ports.fetch(query),
        resource: staging.bootstrapResource,
      });
      const published = await ports.publish(context, stage.proof);
      if (published.proofSha256 !== createHash("sha256").update(stage.proof).digest("hex")) {
        throw new Error("realm_proof_publication_mismatch");
      }
      await ports.consume({ context, nonceSha256: selector.nonceSha256, ...published });
      return new Response(
        "Account linked. Return to your app build for its separately approved access plan.",
        { headers: { ...noStore, "set-cookie": cookieHeader("", 0, sessionId) } },
      );
    } catch {
      return Response.json(
        { code: "auth_identity_required" },
        { headers: { ...noStore, "set-cookie": cookieHeader("", 0, sessionId) }, status: 401 },
      );
    }
  };

/** Production route composition opens only existing source-owned readers; no caller policy or Realm cookie port. */
export const createRealmIdentityCallbackDeploymentHandler =
  (environment: Readonly<Record<string, string | undefined>> = process.env) =>
  async (request: Request): Promise<Response> => {
    let resources: Awaited<ReturnType<typeof openHostedOperatorCompositionResources>> | undefined;
    try {
      const [
        { openHostedOperatorCompositionResources },
        { createHostedOperatorRealmHttpTransport },
        { ensurePreviewOAuthDeploymentSessionOrganization },
        { readPreviewOAuthRuntimeConfig },
        { hostedTenantAuthoritySchema },
        { readVercelTokenKeyringEnvironment },
        { createPostgresOperatorArtifactStore },
        { openHostedPostgresDatabase },
      ] = await Promise.all([
        import("./hosted-operator-source-configuration"),
        import("./hosted-operator-realm-http-transport"),
        import("../auth/preview-oauth-deployment"),
        import("../auth/preview-oauth-runtime"),
        import("../db/hosted-admin"),
        import("../integrations/vercel-installation"),
        import("./hosted-operator-artifact-store"),
        import("../mcp/hosted-route"),
      ]);
      resources = await openHostedOperatorCompositionResources(environment);
      const { configuration, controlPlane } = resources;
      const runtime = readPreviewOAuthRuntimeConfig({ ...environment });
      if (new URL(runtime.issuer).origin !== configuration.builderCallbackOrigin) {
        throw new Error("realm_callback_configuration");
      }
      let selectedEndpointOrigin: string | undefined;
      return await createRealmIdentityCallbackHandler({
        assertCurrent: controlPlane.assertPlanningAuthorized,
        authenticate: async (incoming, selector) => {
          const session = await ensurePreviewOAuthDeploymentSessionOrganization({
            environment: { ...environment },
            headers: incoming.headers,
          });
          const authority =
            session === undefined
              ? undefined
              : hostedTenantAuthoritySchema.parse({
                  audience: runtime.resource,
                  issuer: runtime.issuer,
                  ownerUserId: session.user.id,
                  workspaceId: session.organization.workspaceId,
                });
          return authority === undefined
            ? undefined
            : await controlPlane.resolveRealmIdentityCallbackContext({ authority, ...selector });
        },
        builderOrigin: configuration.builderCallbackOrigin,
        consume: async (input) => {
          await controlPlane.consumeOwnerRealmIdentityCallback(input);
        },
        fetch: async (input, init) => {
          if (selectedEndpointOrigin === undefined) {
            throw new Error("realm_callback_configuration");
          }
          return await createHostedOperatorRealmHttpTransport(
            configuration,
            "builder",
            undefined,
            selectedEndpointOrigin,
          )(input, init);
        },
        keyring: readVercelTokenKeyringEnvironment({ ...environment }),
        publish: async (context, proof) => {
          await controlPlane.assertPlanningAuthorized(context);
          const proofSha256 = createHash("sha256").update(proof).digest("hex");
          const proofRef = `_protected-operator/artifacts/realm-identity-proof/${context.target.appId}/${proofSha256}`;
          const artifacts = createPostgresOperatorArtifactStore({
            assertCurrentOwner: async () => {
              await controlPlane.assertPlanningAuthorized(context);
            },
            database: openHostedPostgresDatabase(runtime.databaseUrl),
          });
          await artifacts.put(
            {
              authority: context.authority,
              target: { appId: context.target.appId, sessionId: context.target.sessionId },
            },
            {
              artifactRef: proofRef,
              chunkIndex: 0,
              content: Buffer.from(proof).toString("base64"),
            },
          );
          await controlPlane.assertPlanningAuthorized(context);
          return { proofRef, proofSha256 };
        },
        staging: async (input) => {
          const pending = await controlPlane.readPendingRealmIdentityLinkForStaging(input);
          selectedEndpointOrigin = pending.link.endpointOrigin;
          return pending;
        },
      })(request);
    } catch {
      return Response.json(
        { code: "auth_identity_required" },
        {
          headers: {
            ...noStore,
            "set-cookie": cookieHeader(
              "",
              0,
              new URL(request.url).searchParams.get("session") ?? "",
            ),
          },
          status: 401,
        },
      );
    } finally {
      await resources?.controlPlane.close();
    }
  };
