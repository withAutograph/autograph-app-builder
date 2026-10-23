/* oxlint-disable eslint/no-await-in-loop -- Bounded callback body is read sequentially; the reader cancels immediately at the byte limit. */
import { verifyVercelOidcToken } from "@vercel/oidc";
import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, customFetch } from "jose";
import { z } from "zod";
import { HostedOperatorError, operatorPublicResultSchema } from "./hosted-operator-contract";
import {
  encryptVercelToken,
  decryptVersionedVercelToken,
} from "../integrations/vercel-installation";
import type { VercelTokenKeyringConfig } from "../integrations/vercel-installation";
import type { openHostedOperatorCompositionResources } from "./hosted-operator-source-configuration";
import type { HostedOperatorContext } from "./hosted-operator-service";
import type { OperatorArtifactStore } from "./hosted-operator-artifact-store";
import type { NormalActorCaptureSender } from "./hosted-operator-normal-actor-capture";
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
const privateStageRequestSchema = z.strictObject({
  version: z.literal(1),
  purpose: z.literal("realm-owner-identity-stage-v1"),
  origin: z.url(),
  nonce: bodySchema.shape.nonce,
  proof: bodySchema.shape.proof,
});
const privateStageSchema = stageSchema.extend({ claimHash: bodySchema.shape.nonce });
const routingTicketSchema = z.strictObject({
  version: z.literal(1),
  ownerSessionId: bodySchema.shape.ownerSessionId,
  nonceSha256: bodySchema.shape.nonce,
  claimSecret: bodySchema.shape.nonce,
  expiresAt: z.number().int(),
});
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
  identityHandoff?: {
    verifySender: (request: Request) => Promise<void>;
    context: (selector: {
      ownerSessionId: string;
      nonceSha256: string;
    }) => Promise<HostedOperatorContext>;
    artifacts: OperatorArtifactStore;
  };
  afterLinked?: (
    context: HostedOperatorContext,
    observed: { nonceSha256: string; proofRef: string; proofSha256: string },
  ) => Promise<void>;
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
const readBody = async (request: Request, maximumBytes = 16_384): Promise<string> => {
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
    if (size > maximumBytes) {
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
const seal = (ports: RealmIdentityCallbackPorts, associatedData: string, value: string) => ({
  ...encryptVercelToken({ associatedData, key: ports.keyring.tokenKey, token: value }),
  keyVersion: ports.keyring.tokenKeyVersion,
});
const unseal = (
  ports: RealmIdentityCallbackPorts,
  associatedData: string,
  value: z.infer<typeof envelopeSchema>,
) =>
  decryptVersionedVercelToken({
    ...value,
    associatedData,
    config: ports.keyring,
  });
const ticketAad = (origin: string) => `realm-owner-identity-handoff-v1:${origin}:${PATH}`;
const privateStageAad = (origin: string, sessionId: string, claimHash: string) =>
  `realm-owner-identity-stage-v1:${origin}:${PATH}:${sessionId}:${claimHash}`;
const stageReference = (context: HostedOperatorContext, claimHash: string) =>
  `_protected-operator/artifacts/realm-identity-stage/${context.target.appId}/${claimHash}`;
const senderClaimsSchema = z.object({
  iss: z.string(),
  aud: z.string(),
  owner_id: z.string(),
  project_id: z.string(),
  environment: z.string(),
  sub: z.string(),
});

/** Accept only the configured native Gateway workload; a browser Origin header grants no staging authority. */
export const createRealmIdentityHandoffSenderVerifier =
  (
    sender: NormalActorCaptureSender,
    verify: (
      token: string,
      options: Parameters<typeof verifyVercelOidcToken>[1],
    ) => Promise<{ payload: unknown }> = verifyVercelOidcToken,
  ) =>
  async (request: Request): Promise<void> => {
    const bearer = request.headers
      .get("authorization")
      ?.match(/^Bearer (?<token>[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u)?.groups?.token;
    if (bearer === undefined || bearer.length > 16_384 || sender.environment !== "preview") {
      throw new Error("realm_handoff_sender");
    }
    const verified = await verify(bearer, {
      audience: sender.audience,
      issuer: sender.issuer,
      ownerId: sender.ownerId,
      projectId: sender.projectId,
      environment: sender.environment,
      subject: sender.subject,
    });
    const claims = senderClaimsSchema.parse(verified.payload);
    const matches = [
      claims.iss === sender.issuer,
      claims.aud === sender.audience,
      claims.owner_id === sender.ownerId,
      claims.project_id === sender.projectId,
      claims.environment === sender.environment,
      claims.sub === sender.subject,
    ].every(Boolean);
    if (!matches) {
      throw new Error("realm_handoff_sender");
    }
  };

const privateStageName = z.enum([
  "sender",
  "body",
  "canonical_pending",
  "origin",
  "proof_verification",
  "context",
  "current_authority",
  "artifact",
  "seal",
  "response",
]);
const privateStageJoseCode = z.enum([
  "ERR_JOSE_ALG_NOT_ALLOWED",
  "ERR_JOSE_NOT_SUPPORTED",
  "ERR_JOSE_GENERIC",
  "ERR_JOSE_INVALID",
  "ERR_JWT_EXPIRED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWT_INVALID",
  "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWKS_INVALID",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
  "ERR_JWKS_TIMEOUT",
]);
interface JwksResponseObservation {
  httpStatus: number;
  contentType: "json" | "html" | "other" | "missing";
  vercelError?: "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH" | "DEPLOYMENT_NOT_FOUND" | "other";
}
const observeJwksResponse = (response: Response): JwksResponseObservation => {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  let contentType: JwksResponseObservation["contentType"] = "other";
  if (!mediaType) {
    contentType = "missing";
  } else if (mediaType === "application/json" || mediaType.endsWith("+json")) {
    contentType = "json";
  } else if (mediaType === "text/html" || mediaType === "application/xhtml+xml") {
    contentType = "html";
  }
  const providerError = response.headers.get("x-vercel-error");
  const observation: JwksResponseObservation = { httpStatus: response.status, contentType };
  if (providerError) {
    observation.vercelError =
      providerError === "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH" ||
      providerError === "DEPLOYMENT_NOT_FOUND"
        ? providerError
        : "other";
  }
  return observation;
};
interface PrivateStageFailure {
  stage: z.infer<typeof privateStageName>;
  errorClass: "operator_error" | "jose_error" | "unknown";
  code?: string;
  jwks?: JwksResponseObservation;
}
const reportPrivateStageFailure = (
  stage: z.infer<typeof privateStageName>,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Caught exceptions are reduced to exact allowlisted codes; never messages, causes, or request values.
  error: unknown,
  jwks?: JwksResponseObservation,
) => {
  const failure: PrivateStageFailure = {
    stage,
    errorClass: "unknown",
    ...(stage === "proof_verification" && jwks !== undefined ? { jwks } : {}),
  };
  try {
    // Read only an own data descriptor; a hostile code getter is never invoked.
    const code: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value;
    if (error instanceof HostedOperatorError) {
      const parsed = operatorPublicResultSchema.shape.code.unwrap().safeParse(code);
      if (parsed.success) {
        failure.errorClass = "operator_error";
        failure.code = parsed.data;
      }
    } else {
      const parsed = privateStageJoseCode.safeParse(code);
      if (parsed.success) {
        failure.errorClass = "jose_error";
        failure.code = parsed.data;
      }
    }
  } catch {
    /* Exception introspection cannot replace the original callback failure. */
  }
  try {
    console.error("realm_identity_callback_failure", failure);
  } catch {
    /* Diagnostics cannot change the original callback response. */
  }
};

const privateStage = async (ports: RealmIdentityCallbackPorts, request: Request) => {
  let stage: z.infer<typeof privateStageName> = "sender";
  let jwks: JwksResponseObservation | undefined;
  try {
    const handoff = ports.identityHandoff;
    if (handoff === undefined) {
      throw new Error("realm_handoff_unavailable");
    }
    await handoff.verifySender(request);
    stage = "body";
    const candidate = privateStageRequestSchema.parse(JSON.parse(await readBody(request, 32_768)));
    const input = routing(candidate.nonce, candidate.proof);
    stage = "canonical_pending";
    const staging = await ports.staging({
      nonceSha256: realmIdentityNonceSha256(input.nonce),
      ownerSessionId: input.ownerSessionId,
    });
    stage = "origin";
    if (candidate.origin !== staging.link.browserOrigin) {
      throw new Error("realm_callback_origin");
    }
    stage = "proof_verification";
    const getKey = createRemoteJWKSet(new URL(staging.jwksUrl), {
      [customFetch]: async (url, init) => {
        const response = await ports.fetch(url, init);
        try {
          jwks = observeJwksResponse(response);
        } catch {
          /* Metadata observation must preserve the original response and verification. */
        }
        return response;
      },
    });
    const claims = await verifyRealmIdentityLinkProof({
      ...input,
      getKey,
      pending: staging.link,
      resource: staging.bootstrapResource,
    });
    stage = "context";
    const context = await handoff.context({
      ownerSessionId: input.ownerSessionId,
      nonceSha256: staging.link.nonceSha256,
    });
    if (context.target.sessionId !== input.ownerSessionId) {
      throw new Error("realm_callback_scope");
    }
    stage = "current_authority";
    await ports.assertCurrent(context);
    const expiresAt = Math.min(
      Date.now() + 240_000,
      claims.exp * 1000,
      Date.parse(staging.link.expiresAt),
    );
    const claimSecret = randomBytes(32).toString("hex");
    const claimHash = createHash("sha256").update(claimSecret).digest("hex");
    stage = "seal";
    const encrypted = seal(
      ports,
      privateStageAad(ports.builderOrigin, input.ownerSessionId, claimHash),
      JSON.stringify({ ...input, expiresAt, claimHash, version: 1 }),
    );
    stage = "artifact";
    await handoff.artifacts.put(
      { authority: context.authority, target: context.target },
      {
        artifactRef: stageReference(context, claimHash),
        chunkIndex: 0,
        content: JSON.stringify(encrypted),
      },
    );
    stage = "current_authority";
    await ports.assertCurrent(context);
    stage = "seal";
    const ticket = seal(
      ports,
      ticketAad(ports.builderOrigin),
      JSON.stringify({
        ownerSessionId: input.ownerSessionId,
        nonceSha256: staging.link.nonceSha256,
        claimSecret,
        expiresAt,
        version: 1,
      }),
    );
    const value = Buffer.from(JSON.stringify(ticket)).toString("base64url");
    stage = "response";
    return Response.json(
      {
        version: 1,
        continuationUrl: `${ports.builderOrigin}${PATH}?handoff=${encodeURIComponent(value)}`,
      },
      { headers: noStore },
    );
  } catch (error) {
    reportPrivateStageFailure(stage, error, jwks);
    throw error;
  }
};

const stageBrowserPost = async (ports: RealmIdentityCallbackPorts, request: Request) => {
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
  const sessionId = input.ownerSessionId;
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
};
const readRoutingTicket = (ports: RealmIdentityCallbackPorts, opaque: string) => {
  const encoded = z
    .string()
    .min(1)
    .max(3800)
    .regex(/^[A-Za-z0-9_-]+$/u)
    .parse(opaque);
  const envelope = envelopeSchema.parse(
    JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8")),
  );
  const ticket = routingTicketSchema.parse(
    JSON.parse(unseal(ports, ticketAad(ports.builderOrigin), envelope)),
  );
  if (ticket.expiresAt <= Date.now()) {
    throw new Error("realm_stage_expired");
  }
  return ticket;
};
const readPrivateStage = async (
  ports: RealmIdentityCallbackPorts,
  context: HostedOperatorContext,
  ticket: z.infer<typeof routingTicketSchema>,
) => {
  const handoff = ports.identityHandoff;
  if (handoff === undefined) {
    throw new Error("realm_handoff_unavailable");
  }
  const claimHash = createHash("sha256").update(ticket.claimSecret).digest("hex");
  const content = await handoff.artifacts.read(
    { authority: context.authority, target: context.target },
    stageReference(context, claimHash),
    0,
  );
  if (content === undefined) {
    throw new Error("realm_stage_required");
  }
  const envelope = envelopeSchema.parse(JSON.parse(content));
  const captured = privateStageSchema.parse(
    JSON.parse(
      unseal(
        ports,
        privateStageAad(ports.builderOrigin, ticket.ownerSessionId, claimHash),
        envelope,
      ),
    ),
  );
  const matches = [
    captured.ownerSessionId === ticket.ownerSessionId,
    captured.claimHash === claimHash,
    captured.expiresAt === ticket.expiresAt,
    captured.expiresAt > Date.now(),
    realmIdentityNonceSha256(captured.nonce) === ticket.nonceSha256,
  ].every(Boolean);
  if (!matches) {
    throw new Error("realm_stage_expired");
  }
  return captured;
};

const completeBrowserGet = async (
  ports: RealmIdentityCallbackPorts,
  request: Request,
  url: URL,
) => {
  let sessionId = url.searchParams.get("session") ?? "";
  const opaque = url.searchParams.get("handoff");
  const ticket = opaque === null ? undefined : readRoutingTicket(ports, opaque);
  sessionId = ticket?.ownerSessionId ?? sessionId;
  let stage = ticket === undefined ? fromCookie(request, ports, sessionId) : undefined;
  const selector = {
    nonceSha256: ticket?.nonceSha256 ?? realmIdentityNonceSha256(z.string().parse(stage?.nonce)),
    ownerSessionId: sessionId,
  };
  // Validate the pending nonce before reading a staged artifact, including after a previous successful consumption.
  await ports.staging(selector);
  const context = await ports.authenticate(request, selector);
  if (context === undefined) {
    const returnPath =
      opaque === null
        ? `${PATH}?session=${encodeURIComponent(sessionId)}`
        : `${PATH}?handoff=${encodeURIComponent(opaque)}`;
    return new Response(null, {
      headers: {
        ...noStore,
        location: `${ports.builderOrigin}/auth/sign-in?redirectTo=${encodeURIComponent(returnPath)}`,
      },
      status: 303,
    });
  }
  if (context.target.sessionId !== sessionId) {
    throw new Error("realm_callback_scope");
  }
  if (ticket !== undefined) {
    stage = await readPrivateStage(ports, context, ticket);
  }
  if (stage === undefined) {
    throw new Error("realm_stage_required");
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
  try {
    await ports.afterLinked?.(context, { nonceSha256: selector.nonceSha256, ...published });
  } catch {
    // Identity is already linked. The supplied dispatcher owns durable retry;
    // a dispatch failure must not be reported as failed authentication.
  }
  return new Response(null, {
    headers: {
      ...noStore,
      location: `${ports.builderOrigin}/auth/account-connected`,
      "set-cookie": cookieHeader("", 0, sessionId),
    },
    status: 303,
  });
};

/** Native private POST only stages proof. Completion always requires the normal original-owner browser session. */
export const createRealmIdentityCallbackHandler =
  (ports: RealmIdentityCallbackPorts) =>
  async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("session") ?? "";
    try {
      const validOrigin = url.origin === ports.builderOrigin && url.pathname === PATH;
      const queryKeys = [...url.searchParams.keys()];
      const validQuery =
        request.method === "POST"
          ? url.search === ""
          : queryKeys.length === 1 && (queryKeys[0] === "session" || queryKeys[0] === "handoff");
      if (!validOrigin || !validQuery) {
        throw new Error("realm_callback_scope");
      }
      if (request.method === "POST") {
        if (request.headers.get("content-type")?.split(";", 1)[0] === "application/json") {
          return await privateStage(ports, request);
        }
        return await stageBrowserPost(ports, request);
      }
      if (request.method !== "GET") {
        throw new Error("realm_callback_method");
      }
      return await completeBrowserGet(ports, request, url);
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
      let selectedNonceSha256: string | undefined;
      const sender = configuration.gateway.workload;
      if (
        sender.environment !== "preview" ||
        sender.projectId !== configuration.gateway.projectId ||
        sender.ownerId !== configuration.teamId
      ) {
        throw new Error("realm_callback_configuration");
      }
      const stageArtifacts = createPostgresOperatorArtifactStore({
        assertCurrentOwner: async (artifactContext) => {
          const context = await controlPlane.resolveRealmIdentityCallbackContext({
            authority: hostedTenantAuthoritySchema.parse(artifactContext.authority),
            ownerSessionId: artifactContext.target.sessionId,
            // The exact pending nonce is selected by the verified routing ticket or private POST below.
            nonceSha256: selectedNonceSha256 ?? "",
          });
          if (context.target.appId !== artifactContext.target.appId) {
            throw new Error("realm_callback_scope");
          }
          await controlPlane.assertPlanningAuthorized(context);
        },
        database: openHostedPostgresDatabase(runtime.databaseUrl),
      });
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
        afterLinked: async (context) => {
          await controlPlane.reconcileOwnerRealmContinuation(context);
        },
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
        identityHandoff: {
          verifySender: createRealmIdentityHandoffSenderVerifier({
            ...sender,
            environment: "preview",
          }),
          context: async (selector) =>
            await controlPlane.resolveRealmIdentityCallbackContext(selector),
          artifacts: stageArtifacts,
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
          selectedNonceSha256 = input.nonceSha256;
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
