/* oxlint-disable typescript/no-non-null-assertion, typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Focused fixtures provide only consumed native coordinates; real stores and producer paths validate authority separately. */
/* oxlint-disable eslint/require-await, eslint/no-await-in-loop, unicorn/no-await-expression-member -- Native lifecycle observations and durable store transitions are deliberately ordered; fixture ports preserve their asynchronous interface. */
/* oxlint-disable anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- Only transport port is a fixture; durable owner reservations and claims use the real canonical store. */
import { describe, it, expect, vi } from "vitest";
import {
  InMemoryHostedEveStore,
  toDurableHostedSessionRecord,
  hostedOperationRecordSchema,
  isDeliveredInternalContinuation,
} from "./hosted-store";
import { hostedEveOperationScopes } from "./hosted-auth";
import { continueHostedPreapprovalAuthoring } from "./preapproval-authoring-controller";
import { authoringScopeDigest, readInternalAuthoringMarker } from "../agent/preapproval-authoring";
import type { HostedEveTransport } from "./hosted-service";

const principal = {
  audience: "https://builder.test/mcp",
  issuer: "https://builder.test/auth",
  ownerUserId: "owner",
  scopes: Object.values(hostedEveOperationScopes),
  workspaceId: "workspace",
};
const result = { cursor: 1, events: [], sessionId: "public", status: "waiting" as const };
const scope = {
  acceptedByCallId: "accept",
  appId: "app",
  appSpecDigest: "a".repeat(64),
  artifactPath: "app.md",
  artifactRevision: "rev",
  authoritySessionId: "logical",
  planningStateDigest: "d".repeat(64),
  sourceReceiptDigest: "b".repeat(64),
  workspaceDigest: "c".repeat(64),
  workspaceId: "sandbox",
};
const decision = {
  adapterSessionId: "logical",
  decision: "runnable" as const,
  kind: "preapproval-authoring-decision-v1" as const,
  scope,
  scopeDigest: authoringScopeDigest(scope),
  turnId: "turn1",
  turnSequence: 1,
  version: 1 as const,
};
const fixture = async () => {
  const store = new InMemoryHostedEveStore();
  const start = {
    clientRequestId: "start",
    createdAtEpochMs: 1,
    kind: "start" as const,
    operationId: "start",
    principal,
    requestDigest: `sha256:${"f".repeat(64)}`,
    state: "reserved" as const,
    updatedAtEpochMs: 1,
    version: 1 as const,
  };
  await store.reserveOperation(principal, start);
  await store.settleSucceeded({
    nowEpochMs: 1,
    operationId: "start",
    principal,
    requestDigest: start.requestDigest,
    result,
    session: {
      adapterSessionId: "logical",
      createdAtEpochMs: 1,
      principal,
      sessionId: "public",
      status: "waiting",
      updatedAtEpochMs: 1,
      version: 1,
    },
  });
  await store.recordPreapprovalAuthoringDecision({ decision, principal, sessionId: "public" });
  const sendAccepted = vi.fn<NonNullable<HostedEveTransport["sendAccepted"]>>().mockResolvedValue();
  const observe = vi.fn(async () => ({ pendingRequests: [], status: "waiting" }));
  return {
    assertCurrentOwner: vi.fn<() => Promise<void>>().mockResolvedValue(),
    now: () => 2,
    observe,
    principal,
    result,
    sendAccepted,
    sessionId: "public",
    store,
    transport: { observe, sendAccepted } as unknown as HostedEveTransport,
  };
};
describe("canonical preapproval authoring", () => {
  it("reserves distinct drafting purpose before sending once, without a Build grant", async () => {
    const f = await fixture();
    f.sendAccepted.mockImplementation(async (request) => {
      const op = await f.store.getPrivateOperation(principal, request.operationId);
      expect(op?.state).toBe("reserved");
      expect(op?.internalAuthoringContinuation?.decision.scopeDigest).toBe(decision.scopeDigest);
      expect(op?.internalBuildContinuation).toBeUndefined();
    });
    expect((await continueHostedPreapprovalAuthoring(f)).status).toBe("working");
    await continueHostedPreapprovalAuthoring(f);
    expect(f.sendAccepted).toHaveBeenCalledOnce();
  });
  it("never resends unknown acceptance; exact native claim can reconcile it", async () => {
    const f = await fixture();
    let operationId = "";
    let message = "";
    f.sendAccepted.mockImplementation(async (request) => {
      ({ operationId } = request);
      ({ message } = request);
      throw new Error("lost ack");
    });
    expect((await continueHostedPreapprovalAuthoring(f)).error?.code).toBe(
      "preapproval_authoring_continuation_unknown",
    );
    await continueHostedPreapprovalAuthoring(f);
    expect(f.sendAccepted).toHaveBeenCalledOnce();
    const marker = readInternalAuthoringMarker(message)!;
    const input = {
      logicalSessionId: "logical",
      messageSequence: 0,
      nonce: marker.nonce,
      operationId,
      principal,
      scopeDigest: decision.scopeDigest,
      sessionId: "public",
      turnId: "turn2",
      turnSequence: 2,
    };
    expect(
      await f.store.claimInternalAuthoringMessage({ ...input, scopeDigest: "e".repeat(64) }),
    ).toBe(false);
    expect(await f.store.claimInternalAuthoringMessage(input)).toBe(true);
    await continueHostedPreapprovalAuthoring(f);
    expect((await f.store.getPrivateOperation(principal, operationId))?.state).toBe("succeeded");
    expect(f.sendAccepted).toHaveBeenCalledOnce();
  });
  it("rejects changed proposal/cancel/source after async transport observation", async () => {
    const f = await fixture();
    f.observe.mockImplementation(async () => {
      await f.store.recordPreapprovalAuthoringDecision({
        decision: { ...decision, decision: "planned" },
        principal,
        sessionId: "public",
      });
      return { pendingRequests: [], status: "waiting" };
    });
    const observed = await continueHostedPreapprovalAuthoring(f);
    expect(observed.status).toBe("waiting");
    expect(f.sendAccepted).not.toHaveBeenCalled();
  });
  it("halts at actual pending input or a new plan", async () => {
    const f = await fixture();
    f.observe.mockResolvedValue({
      pendingRequests: [{ requestId: "fresh-build" }] as never[],
      status: "waiting",
    });
    expect((await continueHostedPreapprovalAuthoring(f)).status).toBe("waiting");
    expect(f.sendAccepted).not.toHaveBeenCalled();
  });
  it("reports unchanged authenticated drafting as blocked, not completed or endlessly runnable", async () => {
    const f = await fixture();
    await f.store.recordPreapprovalAuthoringDecision({
      decision: { ...decision, decision: "blocked", reason: "authoring_no_progress" },
      principal,
      sessionId: "public",
    });
    const response = await continueHostedPreapprovalAuthoring(f);
    expect(response.status).toBe("waiting");
    expect(response.error?.code).toBe("preapproval_authoring_no_progress");
    expect(f.sendAccepted).not.toHaveBeenCalled();
    expect(
      toDurableHostedSessionRecord((await f.store.getSession(principal, "public"))!)
        .privateAuthoringDecision?.scope,
    ).toEqual(scope);
  });
  it("cannot confuse authoring marker with another purpose or settle rejected/succeeded as unknown", async () => {
    const common = {
      clientRequestId: "draft",
      createdAtEpochMs: 1,
      internalAuthoringContinuation: {
        decision,
        deliveredMessageSequence: 0,
        deliveredTurnId: "turn2",
        nonce: "a".repeat(64),
      },
      kind: "send",
      operationId: "draft",
      principal,
      requestDigest: `sha256:${"f".repeat(64)}`,
      sessionId: "public",
      updatedAtEpochMs: 1,
      version: 1,
    };
    expect(
      hostedOperationRecordSchema.safeParse({
        ...common,
        internalBuildContinuation: {},
        state: "reserved",
      }).success,
    ).toBe(false);
    for (const terminal of [
      { safeErrorCode: "denied", state: "rejected" },
      { result, state: "succeeded" },
    ]) {
      expect(
        isDeliveredInternalContinuation(
          hostedOperationRecordSchema.parse({ ...common, ...terminal }),
        ),
      ).toBe(false);
    }
    expect(
      isDeliveredInternalContinuation(
        hostedOperationRecordSchema.parse({
          ...common,
          safeErrorCode: "lost_ack",
          state: "submission_unknown",
        }),
      ),
    ).toBe(true);
  });
});
