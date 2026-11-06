import type { InputRequest, InputResponse } from "eve/client";
import type { AttachSessionFn } from "eve/channels";
import type { SessionAuthContext } from "eve/context";
import type { HostedRuntimeJournalRecord } from "../../lib/provisioning/hosted-runtime-journal";
import { describe, expect, it, vi } from "vitest";
import {
  createProvisioningEventHandlers,
  createProvisioningEventsChannel,
  readPendingRealmContinuationRequests,
  respondToRealmContinuationWait,
  wasRealmContinuationResponseApplied,
} from "./provisioning-events";
import type {
  ProvisioningEventRouteDependencies,
  RealmContinuationEventClaim,
} from "./provisioning-events";

const attachSession = vi.fn<AttachSessionFn>();
const dispatchId = "a".repeat(64);
const authority = "private-verified-authority";
const claim: RealmContinuationEventClaim = {
  adapterSessionId: "adapter-session-1",
  appId: "app-1",
  approvedPlanDigest: "b".repeat(64),
  authority: {
    audience: "https://builder.example.test/mcp",
    issuer: "https://builder.example.test/api/auth",
    ownerUserId: "owner-1",
    workspaceId: "workspace-1",
  },
  initiator: {
    attributes: {
      "mcp:audience": "https://builder.example.test/mcp",
      "mcp:scopes": ["autograph:session"],
      "mcp:workspace-id": "workspace-1",
    },
    authenticator: "mcp-oauth-jwks",
    issuer: "https://builder.example.test/api/auth",
    principalId: "owner-1",
    principalType: "user",
    subject: "owner-1",
  },
  nonceSha256: "c".repeat(64),
  operationRef: "00000000-0000-4000-8000-000000000001",
  ownerSessionId: "public-session-1",
  purpose: "autograph-realm-continuation-authority-v1",
  reason: { kind: "consumed-proof", proofRef: "private-proof", proofSha256: "d".repeat(64) },
  service: {
    authenticator: "autograph-realm-continuation",
    forwardedBy: "service-1",
    issuer: "https://oidc.vercel.com/team",
    principalId: "service-1",
    subject: "service-1",
  },
};
const auth: SessionAuthContext = {
  attributes: {},
  authenticator: "native-workload",
  issuer: "https://builder.example.test",
  principalId: "verified-workload",
  principalType: "app",
  subject: "verified-workload",
};
const request = () =>
  new Request("https://builder.example.test/eve/v1/internal/hosted-operator/realm-continuation", {
    body: JSON.stringify({ authority, dispatchId, version: 1 }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
const fixture = () => {
  const delivered = new Set<string>();
  const accepted = new Set<string>();
  const dependencies = {
    acceptDelivery: vi
      .fn<ProvisioningEventRouteDependencies["acceptDelivery"]>()
      .mockImplementation(async (_claim, id) => {
        accepted.add(id);
        return Promise.resolve();
      }),
    authorize: vi
      .fn<ProvisioningEventRouteDependencies["authorize"]>()
      .mockResolvedValue({ claim, auth }),
    claimDelivery: vi
      .fn<ProvisioningEventRouteDependencies["claimDelivery"]>()
      .mockImplementation(async (_claim, id, _streamStartIndex) => {
        if (delivered.has(id)) {
          return Promise.resolve(false);
        }
        delivered.add(id);
        return Promise.resolve(true);
      }),
    findObsoleteAuthWait: vi
      .fn<ProvisioningEventRouteDependencies["findObsoleteAuthWait"]>()
      .mockResolvedValue({ requestId: "legacy-auth-wait" }),
    readDeliveryClaim: vi
      .fn<ProvisioningEventRouteDependencies["readDeliveryClaim"]>()
      .mockImplementation(async (_claim, id) => Promise.resolve(delivered.has(id))),
    readDeliveryReceipt: vi
      .fn<ProvisioningEventRouteDependencies["readDeliveryReceipt"]>()
      .mockImplementation(async (_claim, id) => {
        if (accepted.has(id)) {
          return Promise.resolve("accepted");
        }
        return Promise.resolve(delivered.has(id) ? "unknown" : "not-submitted");
      }),
    readDeliveryStartIndex: vi
      .fn<ProvisioningEventRouteDependencies["readDeliveryStartIndex"]>()
      .mockResolvedValue(0),
    readDeliveryTargetRequestId: vi
      .fn<ProvisioningEventRouteDependencies["readDeliveryTargetRequestId"]>()
      .mockResolvedValue("legacy-auth-wait"),
    readPendingRequests: vi
      .fn<ProvisioningEventRouteDependencies["readPendingRequests"]>()
      .mockResolvedValue([{ requestId: "legacy-auth-wait" }]),
    respond: vi
      .fn<ProvisioningEventRouteDependencies["respond"]>()
      .mockResolvedValue({ status: "accepted", sessionId: claim.adapterSessionId }),
    streamTailIndex: vi
      .fn<ProvisioningEventRouteDependencies["streamTailIndex"]>()
      .mockResolvedValue(7),
    wasAccepted: vi
      .fn<ProvisioningEventRouteDependencies["wasAccepted"]>()
      .mockResolvedValue(false),
  } satisfies ProvisioningEventRouteDependencies;
  return { dependencies, handlers: createProvisioningEventHandlers(dependencies) };
};

describe("authored identity hook delivery", () => {
  it("resumes the registered Workflow without input and waits for its canonical acknowledgment", async () => {
    const { dependencies } = fixture();
    const readIdentityWait = vi
      .fn<NonNullable<ProvisioningEventRouteDependencies["readIdentityWait"]>>()
      .mockResolvedValue({ eventId: dispatchId, observed: false, token: "private-hook" });
    const resumeIdentityWait = vi
      .fn<NonNullable<ProvisioningEventRouteDependencies["resumeIdentityWait"]>>()
      .mockResolvedValue();
    dependencies.readDeliveryTargetRequestId.mockResolvedValue(`workflow:${dispatchId}`);
    const handlers = createProvisioningEventHandlers({
      ...dependencies,
      readIdentityWait,
      resumeIdentityWait,
    });
    const eventResponse1 = await handlers.dispatch(request(), attachSession);
    expect(await eventResponse1.json()).toMatchObject({
      status: "unknown",
    });
    expect(resumeIdentityWait).toHaveBeenCalledExactlyOnceWith("private-hook", {
      eventId: dispatchId,
    });
    expect(dependencies.readPendingRequests).not.toHaveBeenCalled();
    expect(dependencies.respond).not.toHaveBeenCalled();
    expect(dependencies.acceptDelivery).not.toHaveBeenCalled();
    await handlers.dispatch(request(), attachSession);
    expect(resumeIdentityWait).toHaveBeenCalledTimes(1);
    readIdentityWait.mockResolvedValue({
      eventId: dispatchId,
      observed: true,
      token: "private-hook",
    });
    const reconciled = await handlers.reconcile(request(), attachSession);
    expect(await reconciled.json()).toMatchObject({ status: "accepted" });
    expect(dependencies.acceptDelivery).toHaveBeenCalledTimes(1);
  });

  it("does not retry an ambiguous hook write or fall back to answering a question", async () => {
    const { dependencies } = fixture();
    const readIdentityWait = vi
      .fn<NonNullable<ProvisioningEventRouteDependencies["readIdentityWait"]>>()
      .mockResolvedValue({ eventId: dispatchId, observed: false, token: "private-hook" });
    const resumeIdentityWait = vi
      .fn<NonNullable<ProvisioningEventRouteDependencies["resumeIdentityWait"]>>()
      .mockRejectedValue(new Error("hook delivery outcome unknown"));
    dependencies.readDeliveryTargetRequestId.mockResolvedValue(`workflow:${dispatchId}`);
    const handlers = createProvisioningEventHandlers({
      ...dependencies,
      readIdentityWait,
      resumeIdentityWait,
    });
    await handlers.dispatch(request(), attachSession);
    await handlers.dispatch(request(), attachSession);
    await handlers.reconcile(request(), attachSession);
    expect(resumeIdentityWait).toHaveBeenCalledTimes(1);
    expect(dependencies.respond).not.toHaveBeenCalled();
    expect(dependencies.acceptDelivery).not.toHaveBeenCalled();
  });

  it("rejects a hook for another canonical event before any write", async () => {
    const { dependencies } = fixture();
    const resumeIdentityWait =
      vi.fn<NonNullable<ProvisioningEventRouteDependencies["resumeIdentityWait"]>>();
    const handlers = createProvisioningEventHandlers({
      ...dependencies,
      readIdentityWait: vi
        .fn<NonNullable<ProvisioningEventRouteDependencies["readIdentityWait"]>>()
        .mockResolvedValue({ eventId: "f".repeat(64), observed: false, token: "private-hook" }),
      resumeIdentityWait,
    });
    const response = await handlers.dispatch(request(), attachSession);
    expect(response.status).toBe(409);
    expect(dependencies.claimDelivery).not.toHaveBeenCalled();
    expect(resumeIdentityWait).not.toHaveBeenCalled();
    expect(dependencies.respond).not.toHaveBeenCalled();
  });
});

describe("private Realm continuation event handlers", () => {
  it.each([
    new Request("https://builder.example.test/internal/hosted-operator/realm-continuation"),
    new Request("https://builder.example.test/internal/hosted-operator/realm-continuation", {
      body: "{}",
      method: "POST",
    }),
    new Request("https://builder.example.test/internal/hosted-operator/realm-continuation", {
      body: "not-json",
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    new Request("https://builder.example.test/internal/hosted-operator/realm-continuation", {
      body: JSON.stringify({ authority, dispatchId: "invalid", version: 1 }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    new Request("https://builder.example.test/internal/hosted-operator/realm-continuation", {
      body: JSON.stringify({ authority: "x".repeat(16_385), dispatchId, version: 1 }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  ])("rejects malformed input before authorization", async (invalid) => {
    const { dependencies, handlers } = fixture();
    const response = await handlers.dispatch(invalid, attachSession);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(dependencies.authorize).not.toHaveBeenCalled();
    expect(dependencies.claimDelivery).not.toHaveBeenCalled();
    expect(dependencies.respond).not.toHaveBeenCalled();
  });

  it("sends one verified server event after claiming delivery and keeps authority out of session content", async () => {
    const { dependencies, handlers } = fixture();
    const incoming = request();
    const response = await handlers.dispatch(incoming, attachSession);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      adapterSessionId: claim.adapterSessionId,
      dispatchId,
      status: "unknown",
      version: 1,
    });
    expect(dependencies.authorize).toHaveBeenCalledWith(incoming, authority);
    expect(dependencies.claimDelivery).toHaveBeenCalledExactlyOnceWith(
      claim,
      dispatchId,
      7,
      "legacy-auth-wait",
    );
    expect(dependencies.respond).toHaveBeenCalledExactlyOnceWith(
      claim.adapterSessionId,
      expect.objectContaining({ requestId: "legacy-auth-wait" }),
      auth,
      attachSession,
    );
    const [[, event]] = dependencies.respond.mock.calls;
    const message = JSON.stringify(event);
    expect(message).toContain(dispatchId);
    expect(message).toContain("Verified server event");
    expect(message).toContain("not a user reply");
    expect(message).not.toContain(authority);
    expect(dependencies.acceptDelivery).not.toHaveBeenCalled();
  });

  it("retains an ambiguous send as unknown and never dispatches again on reconcile or duplicate delivery", async () => {
    const { dependencies, handlers } = fixture();
    dependencies.respond.mockRejectedValue(new Error("connection interrupted after dispatch"));
    const first = await handlers.dispatch(request(), attachSession);
    expect(await first.json()).toMatchObject({ dispatchId, status: "unknown" });
    const readback = await handlers.reconcile(request(), attachSession);
    expect(await readback.json()).toMatchObject({ dispatchId, status: "unknown" });
    const duplicate = await handlers.dispatch(request(), attachSession);
    expect(await duplicate.json()).toMatchObject({ dispatchId, status: "unknown" });
    expect(dependencies.respond).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    "uses durable readback after a duplicate claim (claimed=%s)",
    async (claimed) => {
      const { dependencies, handlers } = fixture();
      dependencies.claimDelivery.mockResolvedValue(false);
      dependencies.readDeliveryClaim.mockResolvedValue(claimed);
      const response = await handlers.dispatch(request(), attachSession);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        dispatchId,
        status: claimed ? "unknown" : "not-submitted",
      });
      expect(dependencies.readDeliveryClaim).toHaveBeenCalledWith(claim, dispatchId);
      expect(dependencies.respond).not.toHaveBeenCalled();
    },
  );

  it("rejects a changed pending input before claiming or sending", async () => {
    const { dependencies, handlers } = fixture();
    dependencies.findObsoleteAuthWait.mockResolvedValue(null);
    const response = await handlers.dispatch(request(), attachSession);
    expect(response.status).toBe(409);
    expect(dependencies.claimDelivery).not.toHaveBeenCalled();
    expect(dependencies.respond).not.toHaveBeenCalled();
  });

  it("targets only the technical Auth wait when unrelated input is also pending", async () => {
    const { dependencies, handlers } = fixture();
    dependencies.readPendingRequests.mockResolvedValue([
      { requestId: "legacy-auth-wait" },
      { requestId: "product-decision" },
    ]);
    const response = await handlers.dispatch(request(), attachSession);
    expect(response.status).toBe(200);
    expect(dependencies.respond).toHaveBeenCalledExactlyOnceWith(
      claim.adapterSessionId,
      expect.objectContaining({ requestId: "legacy-auth-wait" }),
      auth,
      attachSession,
    );
  });

  it("labels an expired technical wait without claiming identity proof is available", async () => {
    const { dependencies, handlers } = fixture();
    const expiredClaim = {
      ...claim,
      reason: { expiresAt: "2026-10-15T00:00:00.000Z", kind: "expired-technical-wait" as const },
    };
    dependencies.authorize.mockResolvedValue({ auth, claim: expiredClaim });
    const response = await handlers.dispatch(request(), attachSession);
    expect(response.status).toBe(200);
    const [[, event]] = dependencies.respond.mock.calls;
    expect(JSON.stringify(event)).toContain("prior technical Auth wait expired");
    expect(JSON.stringify(event)).not.toContain("proof is now available");
  });

  it("registers both private routes under Eve's preserved service prefix", () => {
    const channel = createProvisioningEventsChannel(fixture().dependencies);
    expect(channel.routes.map(({ method, path }) => [method, path])).toEqual([
      ["POST", "/eve/v1/internal/hosted-operator/realm-continuation"],
      ["POST", "/eve/v1/internal/hosted-operator/realm-continuation/reconcile"],
    ]);
  });

  it("denies unauthorized reconciliation without claiming or sending", async () => {
    const { dependencies, handlers } = fixture();
    dependencies.authorize.mockRejectedValue(new Error("foreign owner"));
    const response = await handlers.reconcile(request(), attachSession);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(dependencies.readDeliveryClaim).not.toHaveBeenCalled();
    expect(dependencies.claimDelivery).not.toHaveBeenCalled();
    expect(dependencies.respond).not.toHaveBeenCalled();
  });

  it("reconciles an unclaimed delivery as not submitted without dispatching", async () => {
    const { dependencies, handlers } = fixture();
    const response = await handlers.reconcile(request(), attachSession);
    expect(await response.json()).toMatchObject({ dispatchId, status: "not-submitted" });
    expect(dependencies.claimDelivery).not.toHaveBeenCalled();
    expect(dependencies.respond).not.toHaveBeenCalled();
  });
});

type NativeSession = ReturnType<AttachSessionFn>;
type NativeEvent =
  Awaited<ReturnType<NativeSession["getEventStream"]>> extends ReadableStream<infer TEvent>
    ? TEvent
    : never;
type NativeResolution = Extract<
  NativeEvent,
  { type: "input.resolved" }
>["data"]["resolutions"][number];
type FixtureNativeEvent =
  | { type: "input.requested"; data: { requests: readonly InputRequest[] } }
  | { type: "input.resolved"; data: { resolutions: readonly NativeResolution[] } }
  | { type: "turn.started"; data: { turnId: string } }
  | { type: "session.waiting" }
  | { type: "message.received"; data: { message: string | undefined } };
const nativeEvent = (event: FixtureNativeEvent): NativeEvent => {
  const meta = { at: "2026-10-15T00:00:00.000Z", id: "event-1" };
  const coordinates = { sequence: 0, stepIndex: 0, turnId: "turn_0" };
  switch (event.type) {
    case "input.requested": {
      return { ...event, data: { ...coordinates, ...event.data }, meta };
    }
    case "input.resolved": {
      return { ...event, data: { ...coordinates, ...event.data }, meta };
    }
    case "turn.started": {
      return { ...event, data: { sequence: 0, ...event.data }, meta };
    }
    case "session.waiting": {
      return {
        ...event,
        data: { continuationToken: claim.adapterSessionId, wait: "next-user-message" },
        meta,
      };
    }
    case "message.received": {
      return {
        ...event,
        data: { message: event.data.message ?? "", sequence: 0, turnId: "turn_0" },
        meta,
      };
    }
    default: {
      throw new Error("Unsupported native fixture event.");
    }
  }
};
const question = (requestId: string): InputRequest => ({
  action: {
    callId: requestId,
    input: {},
    kind: "tool-call",
    toolName: "prepare-app-hosted-runtime",
  },
  kind: "question",
  prompt: "Technical wait",
  requestId,
});
const streamSession = (events: NativeEvent[], live = false) => {
  const getEventStream = vi
    .fn<NativeSession["getEventStream"]>()
    .mockImplementation(async (options) =>
      Promise.resolve(
        new ReadableStream<NativeEvent>({
          start(controller) {
            for (const event of events.slice(options?.startIndex ?? 0)) {
              controller.enqueue(event);
            }
            if (!live) {
              controller.close();
            }
          },
        }),
      ),
    );
  const respond = vi
    .fn<
      (
        responses: readonly InputResponse[],
        options: Parameters<NativeSession["respond"]>[1],
      ) => Promise<{ status: "accepted"; sessionId: string }>
    >()
    .mockResolvedValue({
      sessionId: claim.adapterSessionId,
      status: "accepted",
    });
  const getStreamTailIndex = vi
    .fn<NativeSession["getStreamTailIndex"]>()
    .mockImplementation(async () => Promise.resolve(events.length - 1));
  const session: NativeSession = {
    cancel: vi.fn<NativeSession["cancel"]>().mockResolvedValue({ status: "no_active_turn" }),
    clear: vi.fn<NativeSession["clear"]>().mockResolvedValue({ status: "no_active_session" }),
    compact: vi.fn<NativeSession["compact"]>().mockResolvedValue({ status: "no_active_session" }),
    getEventStream,
    getStreamTailIndex,
    id: claim.adapterSessionId,
    reset: vi.fn<NativeSession["reset"]>().mockResolvedValue({ status: "no_active_session" }),
    respond: async (responses, options) => respond(responses, options),
    send: vi
      .fn<NativeSession["send"]>()
      .mockRejectedValue(new Error("Fixture must not send generic messages.")),
  };
  const attach = vi.fn<AttachSessionFn>().mockReturnValue(session);
  return { attach, getEventStream, getStreamTailIndex, respond, session };
};

describe("exact legacy technical response and owner proof", () => {
  it("uses the public respond shape and preserves unrelated input with honest service attribution", async () => {
    const { dependencies, handlers } = fixture();
    const pending = new Set(["legacy-auth-wait", "product-decision"]);
    const events: NativeEvent[] = [];
    const native = streamSession(events, true);
    native.respond.mockImplementation(async (responses, options) => {
      expect(options.auth).toBe(auth);
      for (const response of responses) {
        pending.delete(response.requestId);
        events.push(
          nativeEvent({
            data: {
              resolutions: [
                { kind: "question", outcome: "answered", requestId: response.requestId, response },
              ],
            },
            type: "input.resolved",
          }),
        );
      }
      return Promise.resolve({ sessionId: claim.adapterSessionId, status: "accepted" });
    });
    dependencies.respond.mockImplementation(respondToRealmContinuationWait);
    dependencies.wasAccepted.mockImplementation(wasRealmContinuationResponseApplied);
    dependencies.readPendingRequests.mockResolvedValue([...pending].map(question));
    const response = await handlers.dispatch(request(), native.attach);
    expect(await response.json()).toMatchObject({ status: "accepted" });
    expect(native.respond).toHaveBeenCalledOnce();
    const [responseCall] = native.respond.mock.calls;
    if (responseCall === undefined) {
      throw new Error("Expected exact technical response.");
    }
    const [responses, options] = responseCall;
    expect(options.auth).toBe(auth);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.requestId).toBe("legacy-auth-wait");
    expect(responses[0]?.text).toContain("not a user reply");
    expect(pending).toEqual(new Set(["product-decision"]));
    expect(dependencies.acceptDelivery).toHaveBeenCalledExactlyOnceWith(claim, dispatchId);
  });

  it("keeps target-gone stale delivery unknown without dismissing another question or posting again", async () => {
    const { dependencies, handlers } = fixture();
    const pending = new Set(["product-decision"]);
    const events: NativeEvent[] = [];
    const native = streamSession(events, true);
    native.respond.mockImplementation(async (responses) => {
      events.push(nativeEvent({ data: { message: responses[0]?.text }, type: "message.received" }));
      return Promise.resolve({ sessionId: claim.adapterSessionId, status: "accepted" });
    });
    dependencies.respond.mockImplementation(respondToRealmContinuationWait);
    dependencies.wasAccepted.mockImplementation(wasRealmContinuationResponseApplied);
    const eventResponse2 = await handlers.dispatch(request(), native.attach);
    expect(await eventResponse2.json()).toMatchObject({
      status: "unknown",
    });
    const eventResponse3 = await handlers.reconcile(request(), native.attach);
    expect(await eventResponse3.json()).toMatchObject({
      status: "unknown",
    });
    const eventResponse4 = await handlers.dispatch(request(), native.attach);
    expect(await eventResponse4.json()).toMatchObject({
      status: "unknown",
    });
    expect(native.respond).toHaveBeenCalledTimes(1);
    expect(pending).toEqual(new Set(["product-decision"]));
    expect(dependencies.acceptDelivery).not.toHaveBeenCalled();
  });

  it("reconciles the saved exact target after its owner resolution arrives", async () => {
    const { dependencies, handlers } = fixture();
    const first = await handlers.dispatch(request(), attachSession);
    expect(await first.json()).toMatchObject({ status: "unknown" });
    const submitted = dependencies.respond.mock.calls[0]?.[1];
    const native = streamSession([
      nativeEvent({
        data: {
          resolutions: [
            {
              kind: "question",
              outcome: "answered",
              requestId: "legacy-auth-wait",
              response: submitted,
            },
          ],
        },
        type: "input.resolved",
      }),
    ]);
    dependencies.wasAccepted.mockImplementation(wasRealmContinuationResponseApplied);
    const result = await handlers.reconcile(request(), native.attach);
    expect(await result.json()).toMatchObject({ status: "accepted" });
    expect(dependencies.respond).toHaveBeenCalledTimes(1);
    expect(dependencies.wasAccepted).toHaveBeenLastCalledWith(
      claim.adapterSessionId,
      dispatchId,
      claim.reason,
      "legacy-auth-wait",
      0,
      native.attach,
    );
  });

  it.each(["message-only", "wrong-request", "wrong-text", "wrong-outcome", "approval-option"])(
    "does not mistake %s for exact owner application",
    async (variant) => {
      const { dependencies, handlers } = fixture();
      await handlers.dispatch(request(), attachSession);
      const [submittedCall] = dependencies.respond.mock.calls;
      if (submittedCall === undefined) {
        throw new Error("Expected submitted technical response.");
      }
      const [, submitted] = submittedCall;
      const response = {
        ...submitted,
        ...(variant === "wrong-text" ? { text: "different" } : {}),
        ...(variant === "approval-option" ? { optionId: "approve" } : {}),
      };
      const events = [
        nativeEvent(
          variant === "message-only"
            ? { data: { message: submitted.text }, type: "message.received" }
            : {
                data: {
                  resolutions: [
                    {
                      kind: "question",
                      outcome: variant === "wrong-outcome" ? "ignored" : "answered",
                      requestId:
                        variant === "wrong-request" ? "product-decision" : submitted.requestId,
                      response,
                    },
                  ],
                },
                type: "input.resolved",
              },
        ),
      ];
      const native = streamSession(events);
      expect(
        await wasRealmContinuationResponseApplied(
          claim.adapterSessionId,
          dispatchId,
          claim.reason,
          submitted.requestId,
          0,
          native.attach,
        ),
      ).toBe(false);
    },
  );

  it("does not infer idle or send a generic message when no technical wait is pending", async () => {
    const { dependencies, handlers } = fixture();
    dependencies.readPendingRequests.mockResolvedValue([]);
    dependencies.findObsoleteAuthWait.mockResolvedValue(null);
    const response = await handlers.dispatch(request(), attachSession);
    expect(response.status).toBe(409);
    expect(dependencies.claimDelivery).not.toHaveBeenCalled();
    expect(dependencies.respond).not.toHaveBeenCalled();
  });

  it("keeps an old claimed delivery without a persisted target unknown", async () => {
    const { dependencies, handlers } = fixture();
    dependencies.readDeliveryReceipt.mockResolvedValue("unknown");
    const legacyClaim: Partial<NonNullable<HostedRuntimeJournalRecord["realmContinuation"]>> = {};
    dependencies.readDeliveryTargetRequestId.mockResolvedValue(legacyClaim.receiverRequestId);
    dependencies.wasAccepted.mockImplementation(wasRealmContinuationResponseApplied);
    const response = await handlers.dispatch(request(), attachSession);
    expect(await response.json()).toMatchObject({ status: "unknown" });
    expect(attachSession).not.toHaveBeenCalled();
    expect(dependencies.respond).not.toHaveBeenCalled();
  });

  it("does not upgrade a legacy submission receipt without a saved target into owner proof", async () => {
    const { dependencies, handlers } = fixture();
    dependencies.readDeliveryReceipt.mockResolvedValue("accepted");
    const legacyClaim: Partial<NonNullable<HostedRuntimeJournalRecord["realmContinuation"]>> = {};
    dependencies.readDeliveryTargetRequestId.mockResolvedValue(legacyClaim.receiverRequestId);
    const eventResponse5 = await handlers.dispatch(request(), attachSession);
    expect(await eventResponse5.json()).toMatchObject({
      status: "unknown",
    });
    const eventResponse6 = await handlers.reconcile(request(), attachSession);
    expect(await eventResponse6.json()).toMatchObject({
      status: "unknown",
    });
    expect(dependencies.respond).not.toHaveBeenCalled();
    expect(dependencies.acceptDelivery).not.toHaveBeenCalled();
  });
});

describe("canonical pending baseline and finite native replay", () => {
  it("retains older unresolved questions across later turns and applies only the captured delta", async () => {
    const older = question("older-auth-wait");
    const newer = question("newer-product-decision");
    const events = [
      nativeEvent({ data: { requests: [older] }, type: "input.requested" }),
      nativeEvent({ data: { turnId: "later" }, type: "turn.started" }),
      nativeEvent({ data: { requests: [newer] }, type: "input.requested" }),
      nativeEvent({ type: "session.waiting" }),
      nativeEvent({
        data: {
          resolutions: [{ kind: "question", outcome: "answered", requestId: newer.requestId }],
        },
        type: "input.resolved",
      }),
      nativeEvent({ data: { turnId: "active" }, type: "turn.started" }),
    ];
    const native = streamSession(events, true);
    const pending = await readPendingRealmContinuationRequests(native.session, {
      nextNativeIndex: 4,
      pendingRequestIds: [older.requestId, newer.requestId],
    });
    expect(pending).toEqual([older]);
    expect(native.getEventStream).toHaveBeenCalledWith({ startIndex: 4 });
    expect(native.getEventStream).toHaveBeenCalledWith({ startIndex: 0 });
  });

  it("adds native input that arrived after the checkpoint baseline", async () => {
    const fresh = question("fresh-question");
    const native = streamSession([
      nativeEvent({ data: { requests: [fresh] }, type: "input.requested" }),
    ]);
    expect(
      await readPendingRealmContinuationRequests(native.session, {
        nextNativeIndex: 0,
        pendingRequestIds: [],
      }),
    ).toEqual([fresh]);
  });

  it("does not open a live stream when the captured tail is empty", async () => {
    const native = streamSession([], true);
    expect(
      await readPendingRealmContinuationRequests(native.session, {
        nextNativeIndex: 0,
        pendingRequestIds: [],
      }),
    ).toEqual([]);
    expect(
      await wasRealmContinuationResponseApplied(
        claim.adapterSessionId,
        dispatchId,
        claim.reason,
        "legacy-auth-wait",
        0,
        native.attach,
      ),
    ).toBe(false);
    expect(native.getEventStream).not.toHaveBeenCalled();
  });

  it("reports an incomplete captured stream instead of inventing an empty pending set", async () => {
    const native = streamSession([]);
    native.getStreamTailIndex.mockResolvedValue(0);
    await expect(
      readPendingRealmContinuationRequests(native.session, {
        nextNativeIndex: 0,
        pendingRequestIds: [],
      }),
    ).rejects.toThrow("observation is incomplete");
  });
});
