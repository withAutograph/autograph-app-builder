/* oxlint-disable eslint/no-await-in-loop, eslint/complexity, sonarjs/expression-complexity -- The closed two-phase credential boundary validates every native sender, program, proof and actual-account binding. */
import { createHash } from "node:crypto";
import type { JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { readVerifiedRealmAccess, realmIdentityNonceSha256 } from "./hosted-operator-auth-identity";
import type {
  PendingRealmIdentityLink,
  realmPhysicalResourceSchema,
} from "./hosted-operator-auth-identity";
import {
  normalActorCaptureCookieDigest,
  normalActorCaptureCookieSchema,
} from "./hosted-operator-normal-actor-journal";
import type {
  NormalActorCaptureCookie,
  NormalActorJournal,
} from "./hosted-operator-normal-actor-journal";
import type {
  NormalActorProgram,
  NormalActorSessionRef,
} from "./hosted-operator-normal-actor-program";
import type { NormalAuthSession } from "./hosted-operator-normal-auth-client";
import type { HostedOperatorContext } from "./hosted-operator-service";

export const NORMAL_ACTOR_CAPTURE_PATH = "/api/hosted-operator/realm-browser-session";
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const envelope = z.strictObject({
  version: z.literal(1),
  purpose: z.literal("realm-normal-browser-session-v1"),
  ownerSessionId: z.string().min(1).max(200),
  operationRef: z.uuid(),
  participantProgramDigest: digest,
  reviewedNonce: digest,
  proof: z.string().min(1).max(16_384),
  origin: z.url(),
});
export const normalActorCaptureRequestSchema = z.discriminatedUnion("phase", [
  envelope.extend({ phase: z.literal("authorize") }),
  envelope.extend({ phase: z.literal("capture"), normalCookie: normalActorCaptureCookieSchema }),
]);
export interface NormalActorCaptureSender {
  issuer: string;
  audience: string;
  ownerId: string;
  projectId: string;
  environment: "preview";
  subject: string;
}
export interface NormalActorCapturePorts {
  builderOrigin: string;
  sender: NormalActorCaptureSender;
  /** Root binds Vercel's native signature verifier to this exact configured Auth sender. */
  verifySender: (
    token: string,
    sender: NormalActorCaptureSender,
  ) => Promise<{
    iss: string;
    aud: string;
    owner_id: string;
    project_id: string;
    environment: string;
    sub: string;
  }>;
  pending: (input: { ownerSessionId: string; nonceSha256: string }) => Promise<{
    context: HostedOperatorContext;
    actorKey: string;
    organizationId?: string;
    link: PendingRealmIdentityLink;
    resource: z.infer<typeof realmPhysicalResourceSchema>;
    getKey: JWTVerifyGetKey;
    readback: (request: Request) => Promise<Response>;
    assertCurrent: () => Promise<void>;
  }>;
  journal: NormalActorJournal;
  /** Actual same-cookie normal Auth GetSession; the adapter compares its result with signed identity and approved email. */
  verifyCapturedActor: (input: {
    context: HostedOperatorContext;
    actorKey: string;
    program: NormalActorProgram;
    session: NormalActorSessionRef;
    normalCookie: NormalActorCaptureCookie;
  }) => Promise<NormalAuthSession | null>;
  now: () => number;
}
const readBody = async (request: Request) => {
  if (request.body === null) {
    throw new Error("realm_browser_session_capture_unavailable");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) {
      break;
    }
    bytes += part.value.byteLength;
    if (bytes > 32_768) {
      await reader.cancel();
      throw new Error("realm_browser_session_capture_unavailable");
    }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks).toString("utf-8");
};
const ack = (body: { authorized: true } | { captured: true }, status = 200) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });

/** Two-phase private Auth sender protocol; never consumes the normal-owner callback nonce. */
export const createNormalActorCaptureHandler =
  (ports: NormalActorCapturePorts) =>
  async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (
        url.origin !== ports.builderOrigin ||
        url.pathname !== NORMAL_ACTOR_CAPTURE_PATH ||
        url.search !== "" ||
        request.method !== "POST" ||
        request.headers.get("content-type")?.startsWith("application/json") !== true
      ) {
        throw new Error("realm_browser_session_capture_unavailable");
      }
      const bearer = request.headers
        .get("authorization")
        ?.match(/^Bearer (?<token>[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u)
        ?.groups?.token;
      if (bearer === undefined || bearer.length > 16_384) {
        throw new Error("realm_browser_session_capture_unavailable");
      }
      const sender = await ports.verifySender(bearer, ports.sender);
      if (
        sender.iss !== ports.sender.issuer ||
        sender.aud !== ports.sender.audience ||
        sender.owner_id !== ports.sender.ownerId ||
        sender.project_id !== ports.sender.projectId ||
        sender.environment !== ports.sender.environment ||
        sender.sub !== ports.sender.subject
      ) {
        throw new Error("realm_browser_session_capture_unavailable");
      }
      const input = normalActorCaptureRequestSchema.parse(JSON.parse(await readBody(request)));
      const nonceSha256 = realmIdentityNonceSha256(input.reviewedNonce);
      const pending = await ports.pending({ ownerSessionId: input.ownerSessionId, nonceSha256 });
      const { link, context } = pending;
      if (
        link.consumedAt !== undefined ||
        link.ownerSessionId !== input.ownerSessionId ||
        context.target.sessionId !== input.ownerSessionId ||
        link.browserOrigin !== input.origin ||
        link.browserSession?.operationRef !== input.operationRef ||
        link.browserSession.participantProgramDigest !== input.participantProgramDigest ||
        Date.parse(link.expiresAt) <= ports.now()
      ) {
        throw new Error("realm_browser_session_capture_unavailable");
      }
      const retained = await ports.journal.read(context);
      if (
        retained === undefined ||
        retained.preparation.accountOperationRef !== input.operationRef ||
        retained.preparation.programDigest !== input.participantProgramDigest ||
        retained.preparation.program.origin !== input.origin
      ) {
        throw new Error("realm_browser_session_capture_unavailable");
      }
      const actor = retained.preparation.program.actors.find(
        (entry) => entry.actorKey === pending.actorKey && entry.account === "capture-existing",
      );
      if (actor === undefined) {
        throw new Error("realm_browser_session_capture_unavailable");
      }
      const verified = await readVerifiedRealmAccess({
        pending: link,
        resource: pending.resource,
        getKey: pending.getKey,
        readback: pending.readback,
        assertCurrent: pending.assertCurrent,
        proof: input.proof,
        nonce: input.reviewedNonce,
      });
      const proofSha256 = createHash("sha256").update(input.proof).digest("hex");
      if (verified.claims.browserSession === undefined) {
        throw new Error("realm_browser_session_capture_unavailable");
      }
      if (input.phase === "authorize") {
        await ports.journal.authorizeCapture(context, {
          actorKey: pending.actorKey,
          organizationId: pending.organizationId,
          nonceSha256,
          proofSha256,
          expiresAt: new Date(
            Math.min(
              Date.parse(link.expiresAt),
              verified.claims.exp * 1000,
              Date.parse(verified.identity.expiresAt),
            ),
          ).toISOString(),
        });
        return ack({ authorized: true });
      }
      const cookie = input.normalCookie;
      const { hostname } = new URL(input.origin);
      const domain = cookie.domain.replace(/^\./u, "");
      if (
        normalActorCaptureCookieDigest(cookie) !==
          verified.claims.browserSession.normalCookieSha256 ||
        (cookie.hostOnly
          ? cookie.domain !== hostname
          : hostname !== domain && !hostname.endsWith(`.${domain}`))
      ) {
        throw new Error("realm_browser_session_capture_unavailable");
      }
      const latest = await ports.journal.read(context);
      const stage = latest?.preparation.captures.find(
        (entry) =>
          entry.nonceSha256 === nonceSha256 &&
          entry.proofSha256 === proofSha256 &&
          entry.actorKey === pending.actorKey,
      );
      if (stage === undefined) {
        throw new Error("realm_browser_session_capture_unavailable");
      }
      const session = {
        reference: stage.reference,
        actorId: verified.identity.actorId,
        realmSessionId: verified.identity.sessionId,
        origin: input.origin,
        expiresAt: verified.identity.expiresAt,
      };
      const actual = await ports.verifyCapturedActor({
        context,
        actorKey: pending.actorKey,
        program: retained.preparation.program,
        session,
        normalCookie: cookie,
      });
      if (
        actual === null ||
        actual.actorId !== session.actorId ||
        actual.sessionId !== session.realmSessionId ||
        actual.email.toLowerCase() !== actor.email.toLowerCase() ||
        Date.parse(actual.expiresAt) <= ports.now()
      ) {
        throw new Error("realm_browser_session_capture_unavailable");
      }
      await pending.assertCurrent();
      await ports.journal.capture(context, {
        version: 1,
        actorKey: pending.actorKey,
        nonceSha256,
        organizationId: pending.organizationId,
        proofSha256,
        proof: input.proof,
        session,
        normalCookie: cookie,
      });
      return ack({ captured: true });
    } catch {
      return Response.json(
        { error: "realm_browser_session_capture_unavailable" },
        { status: 403, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } },
      );
    }
  };
