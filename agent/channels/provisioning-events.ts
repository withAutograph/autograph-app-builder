import { defineChannel, POST } from "eve/channels";
import type { AttachSessionFn } from "eve/channels";
import type { SessionAuthContext } from "eve/context";
import { z } from "zod";

import {
  createRealmContinuationServiceAuth,
  realmContinuationServiceIdentityForWorkload,
  readSealedRealmContinuationAuthority,
} from "@/lib/hosted/realm-continuation-authority";
import type { RealmContinuationAuthority } from "@/lib/hosted/realm-continuation-authority";
import { readVercelTokenKeyringEnvironment } from "@/lib/integrations/vercel-installation";
import {
  openHostedOperatorCompositionResources,
  readHostedOperatorSourceConfiguration,
} from "@/lib/provisioning/hosted-operator-source-configuration";
import { createOperatorWorkloadVerifier } from "@/lib/provisioning/hosted-operator-workload";

/**
 * Private service event delivery for a consumed Realm identity proof. The
 * opaque authority is accepted only by the injected verifier; it is never
 * copied into session content, a URL, or a diagnostic.
 */
const requestSchema = z.strictObject({
  authority: z.string().min(1).max(16_384),
  dispatchId: z.string().regex(/^[a-f0-9]{64}$/u),
  version: z.literal(1),
});

const notSubmitted = "not-submitted";
const receiptSchema = z.strictObject({
  adapterSessionId: z.string().min(1),
  dispatchId: z.string().regex(/^[a-f0-9]{64}$/u),
  status: z.enum(["accepted", "unknown", notSubmitted]),
  version: z.literal(1),
});
const maximumRequestBytes = 20_000;

export type RealmContinuationEventClaim = RealmContinuationAuthority;
export interface RealmContinuationWaitTarget {
  readonly requestId: string;
}
export interface RealmContinuationPendingBaseline {
  readonly nextNativeIndex: number;
  readonly pendingRequestIds: readonly string[];
}
type SessionStreamEvent =
  Awaited<ReturnType<ReturnType<AttachSessionFn>["getEventStream"]>> extends ReadableStream<
    infer TEvent
  >
    ? TEvent
    : never;

/** Narrow adapter ports keep authority and database composition outside the HTTP boundary. */
export interface ProvisioningEventRouteDependencies {
  readIdentityWait?: (claim: RealmContinuationEventClaim) => Promise<
    | {
        token: string;
        eventId: string;
        observed: boolean;
      }
    | undefined
  >;
  resumeIdentityWait?: (token: string, event: { eventId: string }) => Promise<void>;
  authorize: (
    request: Request,
    opaqueAuthority: string,
  ) => Promise<{
    claim: RealmContinuationEventClaim;
    auth: SessionAuthContext;
  }>;
  claimDelivery: (
    claim: RealmContinuationEventClaim,
    dispatchId: string,
    streamStartIndex: number,
    targetRequestId: string,
  ) => Promise<boolean>;
  readDeliveryClaim: (claim: RealmContinuationEventClaim, dispatchId: string) => Promise<boolean>;
  readDeliveryStartIndex: (
    claim: RealmContinuationEventClaim,
    dispatchId: string,
  ) => Promise<number | undefined>;
  readDeliveryTargetRequestId: (
    claim: RealmContinuationEventClaim,
    dispatchId: string,
  ) => Promise<string | undefined>;
  /** Canonically verifies the original pending structured request is the obsolete Auth wait. */
  findObsoleteAuthWait: (
    claim: RealmContinuationEventClaim,
    pendingRequests: readonly unknown[],
  ) => Promise<RealmContinuationWaitTarget | null>;
  readDeliveryReceipt: (
    claim: RealmContinuationEventClaim,
    dispatchId: string,
  ) => Promise<"accepted" | "unknown" | typeof notSubmitted>;
  acceptDelivery: (claim: RealmContinuationEventClaim, dispatchId: string) => Promise<void>;
  respond: (
    sessionId: string,
    response: { readonly requestId: string; readonly text: string },
    auth: SessionAuthContext,
    attachSession: AttachSessionFn,
  ) => Promise<
    | { readonly status: "accepted"; readonly sessionId: string }
    | { readonly status: "session_not_active" }
  >;
  wasAccepted: (
    sessionId: string,
    dispatchId: string,
    reason: RealmContinuationEventClaim["reason"],
    targetRequestId: string | undefined,
    streamStartIndex: number,
    attachSession: AttachSessionFn,
  ) => Promise<boolean>;
  streamTailIndex: (sessionId: string, attachSession: AttachSessionFn) => Promise<number>;
  readPendingRequests: (
    claim: RealmContinuationEventClaim,
    attachSession: AttachSessionFn,
  ) => Promise<readonly unknown[]>;
}

const eventText = (dispatchId: string, reason: RealmContinuationEventClaim["reason"]) =>
  reason.kind === "consumed-proof"
    ? `Verified server event: the linked Realm identity proof is now available. Resume the existing approved operation by rereading its canonical state. This event is not a user reply. Dispatch ${dispatchId}.`
    : `Verified server event: the prior technical Auth wait expired. Resume the same approved operation and reread its canonical state before continuing. This event is not a user reply. Dispatch ${dispatchId}.`;

const receipt = (
  dispatchId: string,
  adapterSessionId: string,
  status: z.infer<typeof receiptSchema>["status"],
) => receiptSchema.parse({ adapterSessionId, dispatchId, status, version: 1 });

const parseRequest = async (request: Request): Promise<z.infer<typeof requestSchema> | null> => {
  if (
    request.method !== "POST" ||
    request.headers.get("content-type")?.split(";", 1)[0] !== "application/json"
  ) {
    return null;
  }
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) > maximumRequestBytes)
  ) {
    return null;
  }
  if (request.body === null) {
    return null;
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- Request body chunks must be read in stream order.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      byteLength += value.byteLength;
      if (byteLength > maximumRequestBytes) {
        // oxlint-disable-next-line no-await-in-loop -- Stop the oversized request stream immediately.
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const parsed = requestSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const workflowTarget = (dispatchId: string) => `workflow:${dispatchId}`;

/** Create route handlers with verified authority, durable receiver-claim, and native session ports. */
export const createProvisioningEventHandlers = (
  dependencies: ProvisioningEventRouteDependencies,
) => {
  const wasApplied = async (
    claim: RealmContinuationEventClaim,
    dispatchId: string,
    attachSession: AttachSessionFn,
  ) => {
    const target = await dependencies.readDeliveryTargetRequestId(claim, dispatchId);
    if (target === workflowTarget(dispatchId)) {
      const wait = await dependencies.readIdentityWait?.(claim);
      return wait?.eventId === dispatchId && wait.observed;
    }
    return await dependencies.wasAccepted(
      claim.adapterSessionId,
      dispatchId,
      claim.reason,
      target,
      (await dependencies.readDeliveryStartIndex(claim, dispatchId)) ?? -1,
      attachSession,
    );
  };
  const readExistingReceipt = async (
    claim: RealmContinuationEventClaim,
    dispatchId: string,
    attachSession: AttachSessionFn,
  ): Promise<Response | undefined> => {
    try {
      const previousReceipt = await dependencies.readDeliveryReceipt(claim, dispatchId);
      if (previousReceipt === "accepted") {
        const targetRequestId = await dependencies.readDeliveryTargetRequestId(claim, dispatchId);
        return Response.json(
          receipt(
            dispatchId,
            claim.adapterSessionId,
            targetRequestId === undefined ? "unknown" : "accepted",
          ),
          { status: 200, headers: { "cache-control": "no-store" } },
        );
      }
      if (previousReceipt === "unknown") {
        const accepted = await wasApplied(claim, dispatchId, attachSession);
        if (accepted) {
          await dependencies.acceptDelivery(claim, dispatchId);
          return Response.json(receipt(dispatchId, claim.adapterSessionId, "accepted"), {
            status: 200,
            headers: { "cache-control": "no-store" },
          });
        }
        return Response.json(receipt(dispatchId, claim.adapterSessionId, "unknown"), {
          status: 200,
          headers: { "cache-control": "no-store" },
        });
      }
    } catch {
      return Response.json(receipt(dispatchId, claim.adapterSessionId, "unknown"), {
        status: 200,
        headers: { "cache-control": "no-store" },
      });
    }
    return undefined;
  };
  const resumeAuthoredWait = async (
    claim: RealmContinuationEventClaim,
    dispatchId: string,
    attachSession: AttachSessionFn,
  ): Promise<Response | undefined> => {
    try {
      const wait = await dependencies.readIdentityWait?.(claim);
      if (wait !== undefined) {
        if (wait.eventId !== dispatchId || dependencies.resumeIdentityWait === undefined) {
          return Response.json({ error: "identity_wait_mismatch" }, { status: 409 });
        }
        const claimed = await dependencies.claimDelivery(
          claim,
          dispatchId,
          await dependencies.streamTailIndex(claim.adapterSessionId, attachSession),
          workflowTarget(dispatchId),
        );
        if (claimed) {
          // The capability was registered by the approved authored Workflow. No
          // generic message, pending question, or human answer is involved.
          await dependencies.resumeIdentityWait(wait.token, { eventId: dispatchId });
        }
        const applied = await wasApplied(claim, dispatchId, attachSession);
        if (applied) {
          await dependencies.acceptDelivery(claim, dispatchId);
        }
        return Response.json(
          receipt(dispatchId, claim.adapterSessionId, applied ? "accepted" : "unknown"),
          { status: 200, headers: { "cache-control": "no-store" } },
        );
      }
    } catch {
      return Response.json(receipt(dispatchId, claim.adapterSessionId, "unknown"), {
        status: 200,
        headers: { "cache-control": "no-store" },
      });
    }
    return undefined;
  };
  const dispatch = async (request: Request, attachSession: AttachSessionFn) => {
    const input = await parseRequest(request);
    if (input === null) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    let authorized: Awaited<ReturnType<ProvisioningEventRouteDependencies["authorize"]>>;
    try {
      authorized = await dependencies.authorize(request, input.authority);
    } catch {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const existingReceipt = await readExistingReceipt(
      authorized.claim,
      input.dispatchId,
      attachSession,
    );
    if (existingReceipt !== undefined) {
      return existingReceipt;
    }

    const authoredResponse = await resumeAuthoredWait(
      authorized.claim,
      input.dispatchId,
      attachSession,
    );
    if (authoredResponse !== undefined) {
      return authoredResponse;
    }

    let target: RealmContinuationWaitTarget | null;
    try {
      const pendingRequests = await dependencies.readPendingRequests(
        authorized.claim,
        attachSession,
      );
      target = await dependencies.findObsoleteAuthWait(authorized.claim, pendingRequests);
      if (target === null) {
        return Response.json({ error: "pending_input_mismatch" }, { status: 409 });
      }
    } catch {
      return Response.json({ error: "pending_input_unavailable" }, { status: 503 });
    }

    try {
      const streamStartIndex = await dependencies.streamTailIndex(
        authorized.claim.adapterSessionId,
        attachSession,
      );
      const claimed = await dependencies.claimDelivery(
        authorized.claim,
        input.dispatchId,
        streamStartIndex,
        target.requestId,
      );
      if (!claimed) {
        const alreadyClaimed = await dependencies.readDeliveryClaim(
          authorized.claim,
          input.dispatchId,
        );
        const startIndex = await dependencies.readDeliveryStartIndex(
          authorized.claim,
          input.dispatchId,
        );
        if (
          alreadyClaimed &&
          startIndex !== undefined &&
          (await dependencies.wasAccepted(
            authorized.claim.adapterSessionId,
            input.dispatchId,
            authorized.claim.reason,
            await dependencies.readDeliveryTargetRequestId(authorized.claim, input.dispatchId),
            startIndex,
            attachSession,
          ))
        ) {
          await dependencies.acceptDelivery(authorized.claim, input.dispatchId);
          return Response.json(
            receipt(input.dispatchId, authorized.claim.adapterSessionId, "accepted"),
            { status: 200, headers: { "cache-control": "no-store" } },
          );
        }
        return Response.json(
          receipt(
            input.dispatchId,
            authorized.claim.adapterSessionId,
            alreadyClaimed ? "unknown" : notSubmitted,
          ),
          { status: 200, headers: { "cache-control": "no-store" } },
        );
      }
    } catch {
      return Response.json(
        receipt(input.dispatchId, authorized.claim.adapterSessionId, "unknown"),
        { status: 200, headers: { "cache-control": "no-store" } },
      );
    }

    try {
      const result = await dependencies.respond(
        authorized.claim.adapterSessionId,
        { requestId: target.requestId, text: eventText(input.dispatchId, authorized.claim.reason) },
        authorized.auth,
        attachSession,
      );
      const applied =
        result.status === "accepted" &&
        (await dependencies.wasAccepted(
          authorized.claim.adapterSessionId,
          input.dispatchId,
          authorized.claim.reason,
          target.requestId,
          (await dependencies.readDeliveryStartIndex(authorized.claim, input.dispatchId)) ?? -1,
          attachSession,
        ));
      if (applied) {
        await dependencies.acceptDelivery(authorized.claim, input.dispatchId);
      }
      return Response.json(
        receipt(
          input.dispatchId,
          authorized.claim.adapterSessionId,
          applied ? "accepted" : "unknown",
        ),
        { status: 200, headers: { "cache-control": "no-store" } },
      );
    } catch {
      // Session.respond has no public idempotency key. Once the receiver claim is
      // durable, an interrupted response is ambiguous and must never be retried as
      // a second logical event.
      return Response.json(
        receipt(input.dispatchId, authorized.claim.adapterSessionId, "unknown"),
        { status: 200, headers: { "cache-control": "no-store" } },
      );
    }
  };

  const reconcile = async (request: Request, attachSession: AttachSessionFn) => {
    const input = await parseRequest(request);
    if (input === null) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    try {
      const authorized = await dependencies.authorize(request, input.authority);
      const persistedReceipt = await dependencies.readDeliveryReceipt(
        authorized.claim,
        input.dispatchId,
      );
      if (persistedReceipt === "accepted") {
        const targetRequestId = await dependencies.readDeliveryTargetRequestId(
          authorized.claim,
          input.dispatchId,
        );
        return Response.json(
          receipt(
            input.dispatchId,
            authorized.claim.adapterSessionId,
            targetRequestId === undefined ? "unknown" : "accepted",
          ),
          { status: 200, headers: { "cache-control": "no-store" } },
        );
      }
      const accepted = await wasApplied(authorized.claim, input.dispatchId, attachSession);
      if (accepted) {
        await dependencies.acceptDelivery(authorized.claim, input.dispatchId);
        return Response.json(
          receipt(input.dispatchId, authorized.claim.adapterSessionId, "accepted"),
          { status: 200, headers: { "cache-control": "no-store" } },
        );
      }
      if (persistedReceipt === "unknown") {
        return Response.json(
          receipt(input.dispatchId, authorized.claim.adapterSessionId, "unknown"),
          { status: 200, headers: { "cache-control": "no-store" } },
        );
      }
      const claimed = await dependencies.readDeliveryClaim(authorized.claim, input.dispatchId);
      return Response.json(
        receipt(
          input.dispatchId,
          authorized.claim.adapterSessionId,
          claimed ? "unknown" : notSubmitted,
        ),
        { status: 200, headers: { "cache-control": "no-store" } },
      );
    } catch {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
  };

  return { dispatch, reconcile };
};

export const createProvisioningEventsChannel = (
  dependencies: ProvisioningEventRouteDependencies,
) => {
  const handlers = createProvisioningEventHandlers(dependencies);
  // Eve's Vercel route transform preserves /eve/v1, so registrations include that prefix.
  return defineChannel({
    routes: [
      POST("/eve/v1/internal/hosted-operator/realm-continuation", (request, { attachSession }) =>
        handlers.dispatch(request, attachSession),
      ),
      POST(
        "/eve/v1/internal/hosted-operator/realm-continuation/reconcile",
        (request, { attachSession }) => handlers.reconcile(request, attachSession),
      ),
    ],
  });
};

const readCapturedEvents = async (
  session: ReturnType<AttachSessionFn>,
  startIndex: number,
  capturedCount: number,
): Promise<SessionStreamEvent[]> => {
  if (capturedCount === 0) {
    return [];
  }
  const stream = await session.getEventStream({ startIndex });
  const reader = stream.getReader();
  const events: SessionStreamEvent[] = [];
  try {
    while (events.length < capturedCount) {
      // oxlint-disable-next-line no-await-in-loop -- Durable events must be consumed in index order.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      events.push(value);
    }
  } finally {
    await reader.cancel();
  }
  if (events.length !== capturedCount) {
    throw new Error("Native session observation is incomplete.");
  }
  return events;
};

const readMissingRequestDetails = async (
  session: ReturnType<AttachSessionFn>,
  missing: Set<string>,
  rawRequests: Map<string, unknown>,
  initialWindowEnd: number,
): Promise<void> => {
  let windowEnd = initialWindowEnd;
  let windowSize = 16;
  while (missing.size > 0 && windowEnd >= 0) {
    const startIndex = Math.max(0, windowEnd - windowSize + 1);
    // oxlint-disable-next-line no-await-in-loop -- Find only raw requests still pending in the captured canonical observation.
    const events = await readCapturedEvents(session, startIndex, windowEnd - startIndex + 1);
    for (const event of events.toReversed()) {
      if (event.type !== "input.requested") {
        continue;
      }
      for (const request of event.data.requests) {
        if (missing.delete(request.requestId)) {
          rawRequests.set(request.requestId, request);
        }
      }
    }
    windowEnd = startIndex - 1;
    windowSize = Math.min(windowSize * 2, 512);
  }
  if (missing.size > 0) {
    throw new Error("Native pending input details are unavailable.");
  }
};

/** Replays the canonical baseline, retaining older unresolved input across later turns. */
export const readPendingRealmContinuationRequests = async (
  session: ReturnType<AttachSessionFn>,
  baseline: RealmContinuationPendingBaseline,
): Promise<readonly unknown[]> => {
  const tailIndex = await session.getStreamTailIndex();
  if (
    !Number.isSafeInteger(baseline.nextNativeIndex) ||
    baseline.nextNativeIndex < 0 ||
    baseline.nextNativeIndex > tailIndex + 1
  ) {
    throw new Error("Native session observation baseline is unavailable.");
  }
  const pending = new Set(baseline.pendingRequestIds);
  const rawRequests = new Map<string, unknown>();
  const delta = await readCapturedEvents(
    session,
    baseline.nextNativeIndex,
    tailIndex - baseline.nextNativeIndex + 1,
  );
  for (const event of delta) {
    if (event.type === "input.requested") {
      for (const request of event.data.requests) {
        pending.add(request.requestId);
        rawRequests.set(request.requestId, request);
      }
    } else if (event.type === "input.resolved") {
      for (const resolution of event.data.resolutions) {
        pending.delete(resolution.requestId);
      }
    }
  }
  const missing = new Set([...pending].filter((id) => !rawRequests.has(id)));
  await readMissingRequestDetails(session, missing, rawRequests, baseline.nextNativeIndex - 1);
  return [...pending].map((id) => rawRequests.get(id));
};

/** A structured technical response never supplies a message or an approval option. */
export const respondToRealmContinuationWait: ProvisioningEventRouteDependencies["respond"] = async (
  sessionId,
  response,
  auth,
  attachSession,
) => await attachSession(sessionId).respond([response], { auth });

/** Submission alone is insufficient: require the owner's exact question resolution. */
export const wasRealmContinuationResponseApplied: ProvisioningEventRouteDependencies["wasAccepted"] =
  async (sessionId, dispatchId, reason, targetRequestId, streamStartIndex, attachSession) => {
    if (streamStartIndex < 0 || targetRequestId === undefined) {
      return false;
    }
    const session = attachSession(sessionId);
    const tailIndex = await session.getStreamTailIndex();
    if (tailIndex < streamStartIndex) {
      return false;
    }
    const events = await readCapturedEvents(
      session,
      streamStartIndex,
      tailIndex - streamStartIndex + 1,
    );
    return events.some((event) => {
      if (event.type !== "input.resolved") {
        return false;
      }
      return event.data.resolutions.some((resolution) =>
        [
          resolution.kind === "question",
          resolution.outcome === "answered",
          resolution.requestId === targetRequestId,
          resolution.response?.requestId === targetRequestId,
          resolution.response?.optionId === undefined,
          resolution.response?.text === eventText(dispatchId, reason),
        ].every(Boolean),
      );
    });
  };

/** Server-owned adapter: verifies caller OIDC before opening Builder control-plane state. */
const productionDependencies = (): ProvisioningEventRouteDependencies => ({
  async readIdentityWait(claim) {
    const { controlPlane } = await openHostedOperatorCompositionResources(process.env);
    try {
      return await controlPlane.readRealmIdentityWaitDelivery(claim);
    } finally {
      await controlPlane.close();
    }
  },
  async resumeIdentityWait(token, event) {
    const { resumeHook } = await import("workflow/api");
    await resumeHook(token, event);
  },
  async authorize(request, opaqueAuthority) {
    const configuration = readHostedOperatorSourceConfiguration(process.env);
    await createOperatorWorkloadVerifier(configuration.workloadPolicy)(request);
    const keyring = readVercelTokenKeyringEnvironment(process.env);
    const service = realmContinuationServiceIdentityForWorkload(configuration.workloadPolicy);
    const claim = readSealedRealmContinuationAuthority(opaqueAuthority, {
      config: keyring,
      service,
    });
    const serviceAuth = createRealmContinuationServiceAuth({
      claim: opaqueAuthority,
      config: keyring,
      initiator: claim.initiator,
      service,
    });
    return {
      // The native response carries the service responder; the tool keeps its approved run snapshot.
      auth: serviceAuth.current,
      claim,
    };
  },
  async claimDelivery(claim, dispatchId, streamStartIndex, targetRequestId) {
    const { controlPlane } = await openHostedOperatorCompositionResources(process.env);
    try {
      return await controlPlane.claimRealmContinuationDelivery(
        claim,
        dispatchId,
        streamStartIndex,
        targetRequestId,
      );
    } finally {
      await controlPlane.close();
    }
  },
  async readDeliveryClaim(claim, dispatchId) {
    const { controlPlane } = await openHostedOperatorCompositionResources(process.env);
    try {
      return await controlPlane.readRealmContinuationDeliveryClaim(claim, dispatchId);
    } finally {
      await controlPlane.close();
    }
  },
  async readDeliveryStartIndex(claim, dispatchId) {
    const { controlPlane } = await openHostedOperatorCompositionResources(process.env);
    try {
      return await controlPlane.readRealmContinuationDeliveryStartIndex(claim, dispatchId);
    } finally {
      await controlPlane.close();
    }
  },
  async readDeliveryTargetRequestId(claim, dispatchId) {
    const { controlPlane } = await openHostedOperatorCompositionResources(process.env);
    try {
      return await controlPlane.readRealmContinuationDeliveryTargetRequestId(claim, dispatchId);
    } finally {
      await controlPlane.close();
    }
  },
  async findObsoleteAuthWait(claim, pendingRequests) {
    const { controlPlane } = await openHostedOperatorCompositionResources(process.env);
    try {
      let target: RealmContinuationWaitTarget | null = null;
      for (const request of pendingRequests) {
        const parsed = z.object({ requestId: z.string().min(1) }).safeParse(request);
        if (!parsed.success) {
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop -- Each candidate must match the canonical approved technical wait.
        if (await controlPlane.isObsoleteRealmAuthWait(claim, request)) {
          if (target !== null) {
            return null;
          }
          target = { requestId: parsed.data.requestId };
        }
      }
      return target;
    } finally {
      await controlPlane.close();
    }
  },
  async readDeliveryReceipt(claim, dispatchId) {
    const { controlPlane } = await openHostedOperatorCompositionResources(process.env);
    try {
      return await controlPlane.readRealmContinuationDeliveryReceipt(claim, dispatchId);
    } finally {
      await controlPlane.close();
    }
  },
  async acceptDelivery(claim, dispatchId) {
    const { controlPlane } = await openHostedOperatorCompositionResources(process.env);
    try {
      await controlPlane.acceptRealmContinuationDelivery(claim, dispatchId);
    } finally {
      await controlPlane.close();
    }
  },
  respond: respondToRealmContinuationWait,
  wasAccepted: wasRealmContinuationResponseApplied,
  async streamTailIndex(sessionId, attachSession) {
    return await attachSession(sessionId).getStreamTailIndex();
  },
  async readPendingRequests(claim, attachSession) {
    const { controlPlane } = await openHostedOperatorCompositionResources(process.env);
    let baseline: RealmContinuationPendingBaseline;
    try {
      baseline = await controlPlane.readRealmContinuationPendingBaseline(claim);
    } finally {
      await controlPlane.close();
    }
    return await readPendingRealmContinuationRequests(
      attachSession(claim.adapterSessionId),
      baseline,
    );
  },
});

export default createProvisioningEventsChannel(productionDependencies());
