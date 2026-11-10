/* oxlint-disable eslint/require-await -- Controlled journal and native wire ports preserve production asynchronous boundaries. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageStreamEvent } from "eve/client";
import { z } from "zod";
import { createSameOriginEveTransport } from "../eve/same-origin-http";
import { readAuthSchemaRolloutApproval } from "../eve/private-auth-schema-rollout-approval";
import {
  authSchemaRolloutApprovalReference,
  authSchemaRolloutDigest,
  authSchemaRolloutPlanResponseSchema,
  authSchemaRolloutReviewResponseSchema,
} from "./production-auth-schema-rollout-contract";
import type {
  AuthSchemaRolloutApplyInput,
  AuthSchemaRolloutApprovalReference,
} from "./production-auth-schema-rollout-contract";
import {
  configuration,
  owner,
  profile,
  proposal,
  rolloutFixture,
} from "./production-auth-schema-rollout.test-fixture";
import { createAuthSchemaRolloutNativeHandler } from "./production-auth-schema-rollout-native";

interface MalformedTestReference extends AuthSchemaRolloutApprovalReference {
  sql?: string;
}

const savedCursor = 7843;
const environment = {
  PRODUCTION_AUTH_SCHEMA_ROLLOUT_CONFIGURATION: JSON.stringify(configuration),
  DATABASE_URL: "postgresql://synthetic:synthetic@localhost/synthetic?sslmode=verify-full",
  BETTER_AUTH_URL: owner.authority.issuer,
  MCP_RESOURCE_URL: owner.authority.audience,
};
const request = (selection: z.infer<ReturnType<typeof z.json>>) =>
  new Request("https://operator.example/v1/auth-schema-rollout", {
    method: "POST",
    headers: { authorization: "Bearer synthetic", "content-type": "application/json" },
    body: JSON.stringify({
      version: 1,
      sessionId: owner.sessionId,
      ownerContext: owner,
      ...z.record(z.string(), z.json()).parse(selection),
    }),
  });
const approvalEvents = (
  input: AuthSchemaRolloutApplyInput,
  callId: string,
): MessageStreamEvent[] => [
  {
    type: "input.requested",
    meta: { at: "2026-11-10T00:00:00Z", id: `request-${callId}` },
    data: {
      sequence: 1,
      stepIndex: 0,
      turnId: "turn",
      requests: [
        {
          kind: "tool-approval",
          requestId: `approval-${callId}`,
          prompt: "Approve the saved sign-in service update?",
          action: {
            kind: "tool-call",
            toolName: "apply-production-auth-schema-rollout",
            callId,
            input,
          },
        },
      ],
    },
  },
  {
    type: "approval.settled",
    meta: { at: "2026-11-10T00:00:01Z", id: `settled-${callId}` },
    data: {
      sequence: 2,
      stepIndex: 0,
      turnId: "turn",
      requestId: `approval-${callId}`,
      responderPrincipalId: owner.authority.ownerUserId,
      outcome: "approved",
    },
  },
  {
    type: "session.waiting",
    meta: { at: "2026-11-10T00:00:02Z", id: `waiting-${callId}` },
    data: { wait: "next-user-message", continuationToken: "retained" },
  },
];
const fixture = async (tailOffset = 0) => {
  const f = rolloutFixture();
  const prepared = z
    .object({
      version: z.literal(1),
      resource: z.json(),
      schemaPlan: z.record(z.string(), z.json()),
    })
    .parse(proposal);
  const effects = Array.from({ length: 7 }, (_, index) => {
    const sql = `ALTER TABLE controlled_${index} ADD COLUMN approved text`;
    return { owner: `effect-${index}`, sql, sha256: authSchemaRolloutDigest(sql) };
  });
  const propose = vi.spyOn(f.ports, "propose").mockResolvedValue({
    ...prepared,
    schemaPlan: { ...prepared.schemaPlan, effects },
  });
  const { plan } = await f.service.plan(owner, profile.id);
  const row = f.rows.get(plan.operationRef);
  if (row === undefined) {
    throw new Error("Expected original plan");
  }
  row.record.approvalObservation = {
    adapterSessionId: owner.adapterSessionId,
    adapterGeneration: owner.adapterGeneration,
    nextNativeIndex: savedCursor,
    capture: {
      ownerUserId: owner.authority.ownerUserId,
      request: {
        action: "auth-schema-rollout",
        planRef: plan.operationRef,
        planDigest: plan.planDigest,
        idempotencyKey: authSchemaRolloutDigest(plan),
      },
      entries: [],
    },
  };
  const history: MessageStreamEvent[] = [];
  const starts: number[] = [];
  const approvalFetch = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(z.string().parse(input));
    const start = z.coerce.number().int().nonnegative().parse(url.searchParams.get("startIndex"));
    starts.push(start);
    return new Response(
      `${history
        .slice(start - savedCursor)
        .map((event) => JSON.stringify(event))
        .join("\n")}\n`,
      {
        headers: {
          "content-type": "application/x-ndjson",
          "x-eve-session-id": owner.adapterSessionId,
          "x-eve-stream-format": "ndjson",
          "x-eve-stream-version": "25",
          "x-eve-stream-tail-index": String(savedCursor + history.length - 1 + tailOffset),
        },
      },
    );
  });
  const reader = createSameOriginEveTransport({
    config: { baseUrl: "https://builder.example" },
    workloadIdentity: { token: async () => "synthetic" },
    fetchImplementation: approvalFetch,
    verifyReadAuthority: async () => true,
  }).observePrivateHistory;
  if (reader === undefined) {
    throw new Error("Expected authorized reader");
  }
  const approval = vi.spyOn(f.ports, "approval").mockImplementation(
    async (expected) =>
      await readAuthSchemaRolloutApproval({
        plan: expected.plan,
        callId: expected.callId,
        owner: expected.owner,
        observation: { state: expected.observation, save: expected.save },
        assertOwner: expected.assertCurrent,
        readHistory: async (startIndex, onEvent) =>
          await reader({
            principal: owner.principal,
            sessionId: owner.sessionId,
            adapterSessionId: owner.adapterSessionId,
            startIndex,
            onEvent,
          }),
      }),
  );
  const compareAndSet = vi.spyOn(f.ports.store, "compareAndSet");
  const reserve = vi.spyOn(f.ports.store, "reserve");
  const withLease = vi.spyOn(f.ports, "withLease");
  const apply = vi.spyOn(f.ports, "apply");
  const inspect = vi.spyOn(f.ports, "inspect");
  propose.mockClear();
  return {
    ...f,
    plan,
    row,
    effects,
    propose,
    history,
    starts,
    approvalFetch,
    approval,
    compareAndSet,
    reserve,
    withLease,
    apply,
    inspect,
  };
};
afterEach(() => vi.restoreAllMocks());

describe("frozen Auth plan approval handoff", () => {
  it("rereads the same plan and reference without credentials, proposals, history, leases or writes", async () => {
    const f = await fixture();
    const before = structuredClone(f.row);
    const readMigration = vi.fn(() => {
      throw new Error("private-credential-canary");
    });
    const close = vi.fn(async () => {});
    const response = await createAuthSchemaRolloutNativeHandler(
      Object.defineProperty({ ...environment }, profile.runtime.migrationConnectionEnvironment, {
        get: readMigration,
      }),
      {
        consent: { resolveOwner: async () => owner, verifyWorkload: async () => {} },
        approvalFetch: f.approvalFetch,
        propose: async () => {
          throw new Error("No proposal during review");
        },
        openJournal: async () => ({ store: f.ports.store, close }),
      },
    )(request({ action: "review", operationRef: f.plan.operationRef }));
    const review = authSchemaRolloutReviewResponseSchema.parse(await response.json());
    expect(review).toEqual({
      version: 1,
      plan: f.plan,
      approvalReference: authSchemaRolloutApprovalReference(f.plan),
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(f.rows.get(f.plan.operationRef)).toEqual(before);
    expect(f.approvalFetch).not.toHaveBeenCalled();
    expect(readMigration).not.toHaveBeenCalled();
    expect(f.propose).not.toHaveBeenCalled();
    expect(f.reserve).not.toHaveBeenCalled();
    expect(f.compareAndSet).not.toHaveBeenCalled();
    expect(f.withLease).not.toHaveBeenCalled();
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.inspect).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("retains legacy plan and status response shapes for existing strict clients", async () => {
    const f = await fixture();
    delete f.row.record.approvalObservation;
    const handler = createAuthSchemaRolloutNativeHandler(environment, {
      consent: { resolveOwner: async () => owner, verifyWorkload: async () => {} },
      propose: async () => await f.ports.propose(profile, async () => {}),
      openJournal: async () => ({ store: f.ports.store, close: async () => {} }),
    });
    const response = await handler(request({ action: "plan", profileId: profile.id }));
    expect(authSchemaRolloutPlanResponseSchema.parse(await response.json())).toEqual({
      version: 1,
      plan: f.plan,
    });
    const status = await handler(request({ action: "status", operationRef: f.plan.operationRef }));
    expect(await status.json()).toEqual({
      version: 1,
      operationRef: f.plan.operationRef,
      state: "planned",
    });
  });

  it("rejects a changed legacy card, then captures a fresh reference after the saved cursor and applies only the original seven effects", async () => {
    const f = await fixture();
    const original = structuredClone(f.row.record);
    f.history.push(
      ...approvalEvents(
        {
          ...f.plan,
          effects: f.plan.effects.map((effect, index) =>
            index < 3 ? effect : { ...effect, sql: `${effect.sql}; SELECT 'drift'` },
          ),
        },
        "bad-call",
      ),
    );
    await expect(
      f.service.execute(owner, f.plan.operationRef, f.plan.planDigest, "bad-call"),
    ).rejects.toMatchObject({ code: "authorization_required" });
    expect(f.starts).toEqual([savedCursor]);
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.rows.get(f.plan.operationRef)?.record.state).toBe("planned");
    const review = await f.service.review(owner, f.plan.operationRef);
    const cursorAfterBad = f.rows.get(f.plan.operationRef)?.record.approvalObservation
      ?.nextNativeIndex;
    expect(cursorAfterBad).toBe(savedCursor + 3);
    f.history.push(...approvalEvents(review.approvalReference, "fresh-reference-call"));
    await expect(
      f.service.execute(
        owner,
        f.plan.operationRef,
        f.plan.planDigest,
        "fresh-reference-call",
        review.approvalReference.approvalDigest,
      ),
    ).resolves.toMatchObject({ state: "ready" });
    expect(f.starts).toEqual([savedCursor, savedCursor + 3]);
    expect(f.apply).toHaveBeenCalledOnce();
    const [applied] = f.apply.mock.calls;
    expect(applied?.[0].record.plan).toEqual(original.plan);
    expect(applied?.[0].record.proposal).toEqual(original.proposal);
    expect(applied?.[0].record.operatorPlan).toEqual(original.operatorPlan);
    expect(applied?.[0].record.plan.effects).toEqual(f.effects);
    const current = f.rows.get(f.plan.operationRef)?.record;
    expect(current?.plan.operationRef).toBe(f.plan.operationRef);
    expect(current?.approval?.approvedByCallId).toBe("fresh-reference-call");
    expect(current?.approvalObservation?.capture.request.idempotencyKey).toBe(
      authSchemaRolloutDigest(f.plan),
    );
    expect(f.reserve).not.toHaveBeenCalled();
    expect(f.propose).not.toHaveBeenCalled();
    expect(f.rows.size).toBe(1);
  });

  it.each([
    "other-actor",
    "cancelled",
    "wrong-call",
    "wrong-hash",
    "extra-fields",
    "truncated-tail",
  ])("does not apply a reference from %s native history", async (variation) => {
    const f = await fixture(variation === "truncated-tail" ? 1 : 0);
    const reference = authSchemaRolloutApprovalReference(f.plan);
    const submitted: MalformedTestReference = { ...reference };
    if (variation === "wrong-hash") {
      submitted.approvalDigest = "0".repeat(64);
    }
    if (variation === "extra-fields") {
      submitted.sql = "unreviewed effect";
    }
    const native = approvalEvents(
      submitted,
      variation === "wrong-call" ? "other-call" : "fresh-call",
    );
    const [, settlement] = native;
    if (settlement?.type !== "approval.settled") {
      throw new Error("Expected settlement");
    }
    if (variation === "other-actor") {
      settlement.data.responderPrincipalId = "other-actor";
    }
    if (variation === "cancelled") {
      settlement.data.outcome = "cancelled";
    }
    f.history.push(...native);
    await expect(
      f.service.execute(
        owner,
        f.plan.operationRef,
        f.plan.planDigest,
        "fresh-call",
        reference.approvalDigest,
      ),
    ).rejects.toThrow();
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.inspect).not.toHaveBeenCalled();
    expect(f.rows.get(f.plan.operationRef)?.record.state).toBe("planned");
    expect(f.rows.get(f.plan.operationRef)?.record.approval).toBeUndefined();
  });

  it("rejects a different full-plan digest before lease, history or mutation credentials", async () => {
    const f = await fixture();
    const readMigration = vi.fn(() => {
      throw new Error("private-credential-canary");
    });
    const handler = createAuthSchemaRolloutNativeHandler(
      Object.defineProperty({ ...environment }, profile.runtime.migrationConnectionEnvironment, {
        get: readMigration,
      }),
      {
        consent: { resolveOwner: async () => owner, verifyWorkload: async () => {} },
        approvalFetch: f.approvalFetch,
        openJournal: async () => ({ store: f.ports.store, close: async () => {} }),
      },
    );
    await expect(
      handler(
        request({
          action: "execute",
          operationRef: f.plan.operationRef,
          planDigest: f.plan.planDigest,
          approvalDigest: "0".repeat(64),
          approvedByCallId: "wrong-reference-call",
        }),
      ),
    ).rejects.toMatchObject({ code: "resource_mismatch" });
    expect(readMigration).not.toHaveBeenCalled();
    expect(f.approvalFetch).not.toHaveBeenCalled();
    expect(f.compareAndSet).not.toHaveBeenCalled();
  });

  it("keeps saved-plan review behind current owner and deployment enrollment", async () => {
    const f = await fixture();
    await expect(
      f.service.review({ ...owner, sessionId: "foreign" }, f.plan.operationRef),
    ).rejects.toThrow("owner_denied");
    f.row.record.runtime.migrationConnectionEnvironment = "UNENROLLED_SCHEMA_OWNER_URL";
    await expect(f.service.review(owner, f.plan.operationRef)).rejects.toThrow();
    expect(f.approvalFetch).not.toHaveBeenCalled();
    expect(f.compareAndSet).not.toHaveBeenCalled();
    expect(f.propose).not.toHaveBeenCalled();
    expect(f.apply).not.toHaveBeenCalled();
  });
});
