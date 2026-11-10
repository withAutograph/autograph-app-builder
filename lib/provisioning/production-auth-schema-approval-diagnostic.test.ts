/* oxlint-disable eslint/require-await -- Controlled transport and journal ports retain asynchronous production contracts. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageStreamEvent } from "eve/client";
import { z } from "zod";
import { createSameOriginEveTransport } from "../eve/same-origin-http";
import { readAuthSchemaRolloutApproval } from "../eve/private-auth-schema-rollout-approval";
import { HostedSessionReadTimeoutError } from "../eve/hosted-session-read-timeout-error";
import {
  configuration,
  owner,
  profile,
  proposal,
  rolloutFixture,
} from "./production-auth-schema-rollout.test-fixture";
import { createAuthSchemaRolloutNativeHandler } from "./production-auth-schema-rollout-native";
import { createAuthSchemaRollout } from "./production-auth-schema-rollout";
import { authSchemaRolloutDigest } from "./production-auth-schema-rollout-contract";
import type { AuthSchemaRolloutApproval } from "./production-auth-schema-rollout-contract";
import { projectAuthSchemaApprovalInput } from "../eve/auth-schema-approval-diagnostic";

const diagnosticRecords = (calls: readonly unknown[][]) =>
  calls.flatMap(([value]) =>
    z.string().safeParse(value).success &&
    String(value).startsWith('{"event":"builder.auth_schema_approval_')
      ? [z.record(z.string(), z.json()).parse(JSON.parse(String(value)))]
      : [],
  );
const secret = "private-canary-must-not-appear";
const setup = async () => {
  const f = rolloutFixture();
  const prepared = z
    .object({
      version: z.literal(1),
      resource: z.json(),
      schemaPlan: z.object({
        version: z.literal(1),
        resource: z.json(),
        authOperatorRole: z.string(),
        planDigest: z.string(),
        targetDigest: z.string(),
        effects: z.array(z.object({ owner: z.string(), sql: z.string(), sha256: z.string() })),
      }),
    })
    .parse(proposal);
  const propose = vi.spyOn(f.ports, "propose").mockResolvedValue({
    ...prepared,
    schemaPlan: {
      ...prepared.schemaPlan,
      effects: [
        {
          owner: "platform",
          sql: `SELECT '${secret}${"x".repeat(40_000)}'`,
          sha256: "a".repeat(64),
        },
      ],
    },
  });
  const { plan } = await f.service.plan(owner, profile.id);
  const row = f.rows.get(plan.operationRef);
  if (row === undefined) {
    throw new Error("Expected frozen plan");
  }
  row.record.approvalObservation = {
    adapterSessionId: owner.adapterSessionId,
    adapterGeneration: owner.adapterGeneration,
    nextNativeIndex: 2,
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
  const compareAndSet = vi.spyOn(f.ports.store, "compareAndSet");
  const reserve = vi.spyOn(f.ports.store, "reserve");
  const withLease = vi.spyOn(f.ports, "withLease");
  propose.mockClear();
  return { ...f, plan, row, compareAndSet, reserve, withLease, propose };
};
const events = (plan: AuthSchemaRolloutApproval): MessageStreamEvent[] => [
  {
    type: "input.requested",
    meta: { at: "2026-11-09T00:00:00Z", id: "request" },
    data: {
      sequence: 1,
      stepIndex: 0,
      turnId: "turn",
      requests: [
        {
          kind: "tool-approval",
          requestId: "approval",
          prompt: "Apply this plan?",
          action: {
            kind: "tool-call",
            toolName: "apply-production-auth-schema-rollout",
            callId: "original-call",
            input: {
              ...plan,
              effects: plan.effects.map((effect) => ({
                ...effect,
                sql: `${effect.sql}\n-- changed`,
              })),
            },
          },
        },
      ],
    },
  },
  {
    type: "approval.settled",
    meta: { at: "2026-11-09T00:00:01Z", id: "settlement" },
    data: {
      sequence: 2,
      stepIndex: 0,
      turnId: "turn",
      requestId: "approval",
      responderPrincipalId: owner.authority.ownerUserId,
      outcome: "approved",
    },
  },
  {
    type: "session.waiting",
    meta: { at: "2026-11-09T00:00:02Z", id: "waiting" },
    data: { wait: "next-user-message", continuationToken: "not-reported" },
  },
];
const environment = {
  PRODUCTION_AUTH_SCHEMA_ROLLOUT_CONFIGURATION: JSON.stringify(configuration),
  DATABASE_URL: "postgresql://synthetic:synthetic@localhost/synthetic?sslmode=verify-full",
  BETTER_AUTH_URL: owner.authority.issuer,
  MCP_RESOURCE_URL: owner.authority.audience,
};
const request = (operationRef: string) =>
  new Request("https://operator.example/v1/auth-schema-rollout", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({
      version: 1,
      action: "status",
      sessionId: owner.sessionId,
      ownerContext: owner,
      operationRef,
    }),
  });
const wire = (native: MessageStreamEvent[], tail = native.length - 1) =>
  new Response(`${native.map((event) => JSON.stringify(event)).join("\n")}\n`, {
    headers: {
      "content-type": "application/x-ndjson",
      "x-eve-session-id": owner.adapterSessionId,
      "x-eve-stream-format": "ndjson",
      "x-eve-stream-tail-index": String(tail),
      "x-eve-stream-version": "25",
    },
  });
afterEach(() => vi.restoreAllMocks());

describe("read-only Auth approval mismatch diagnostics", () => {
  it("reads the original 40k input through the authorized native wire without accepting approval or any effects", async () => {
    const f = await setup();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const before = structuredClone(f.row);
    const approvalFetch = vi.fn<typeof fetch>(async () => wire(events(f.plan)));
    const resolveOwner = vi.fn(async () => owner);
    const verifyWorkload = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const readMigration = vi.fn(() => {
      throw new Error(secret);
    });
    const env = Object.defineProperty(
      { ...environment },
      profile.runtime.migrationConnectionEnvironment,
      { get: readMigration },
    );
    const response = await createAuthSchemaRolloutNativeHandler(env, {
      consent: { resolveOwner, verifyWorkload },
      approvalFetch,
      propose: async () => await f.ports.propose(profile, async () => {}),
      openJournal: async () => ({ store: f.ports.store, close }),
    })(request(f.plan.operationRef));
    expect(await response.json()).toEqual({
      version: 1,
      operationRef: f.plan.operationRef,
      state: "planned",
    });
    const records = diagnosticRecords(info.mock.calls);
    expect(
      records.find((value) => value.event === "builder.auth_schema_approval_request_diagnostic"),
    ).toMatchObject({
      nativeIndex: 0,
      requestKind: "tool-approval",
      toolMatches: true,
      comparison: {
        inputKind: "object",
        schemaValid: true,
        fullPlanEqual: false,
        fieldsEqual: { effects: false, resource: true },
        effects: [{ sqlEqual: false, declaredSha256Equal: true }],
      },
    });
    expect(
      records.find((value) => value.event === "builder.auth_schema_approval_settlement_diagnostic"),
    ).toMatchObject({ approved: true, ownerMatches: true });
    expect(
      records.find((value) => value.event === "builder.auth_schema_approval_prefix_diagnostic"),
    ).toMatchObject({
      nextNativeIndex: 2,
      nativeTailIndex: 2,
      complete: false,
      prefixComplete: true,
      matchingTools: 1,
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain(secret);
    expect(f.rows.get(f.plan.operationRef)).toEqual(before);
    expect(readMigration).not.toHaveBeenCalled();
    expect(f.compareAndSet).not.toHaveBeenCalled();
    expect(f.reserve).not.toHaveBeenCalled();
    expect(f.withLease).not.toHaveBeenCalled();
    expect(f.ports.approval).not.toHaveBeenCalled();
    expect(f.ports.apply).not.toHaveBeenCalled();
    expect(f.ports.inspect).not.toHaveBeenCalled();
    expect(f.ports.propose).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    const [url] = approvalFetch.mock.calls[0] ?? [];
    const targetUrl = url instanceof Request ? url.url : z.string().parse(url);
    expect(targetUrl).toContain(`/${owner.adapterSessionId}/stream?`);
    expect(new URL(targetUrl).searchParams.get("startIndex")).toBe("0");
  });

  it("reports a partial prefix without saving or accepting anything when the real native read times out", async () => {
    const f = await setup();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
      originalTimeout(ms === 30_000 ? 30 : ms),
    );
    const native = events(f.plan);
    const approvalFetch: typeof fetch = async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`${JSON.stringify(native[0])}\n`));
            init?.signal?.addEventListener(
              "abort",
              () => {
                controller.error(init.signal?.reason);
              },
              {
                once: true,
              },
            );
          },
        }),
        { headers: wire(native).headers },
      );
    const before = structuredClone(f.row);
    const response = await createAuthSchemaRolloutNativeHandler(environment, {
      consent: { resolveOwner: async () => owner, verifyWorkload: async () => {} },
      approvalFetch,
      openJournal: async () => ({ store: f.ports.store, close: async () => {} }),
    })(request(f.plan.operationRef));
    const result = z.object({ state: z.string() }).parse(await response.json());
    expect(result.state).toBe("planned");
    expect(diagnosticRecords(info.mock.calls)).toContainEqual(
      expect.objectContaining({
        event: "builder.auth_schema_approval_prefix_diagnostic",
        nextNativeIndex: 1,
        nativeTailIndex: 2,
        complete: false,
        prefixComplete: false,
      }),
    );
    expect(f.rows.get(f.plan.operationRef)).toEqual(before);
    expect(f.compareAndSet).not.toHaveBeenCalled();
  });

  it("does not let a bounded diagnostic prefix prove approval even when it contains the exact approved pair", async () => {
    const f = await setup();
    const native = events(f.plan);
    const [first] = native;
    if (first?.type !== "input.requested" || first.data.requests[0]?.kind !== "tool-approval") {
      throw new Error("Expected approval");
    }
    first.data.requests[0].action.input = f.plan;
    const transport = createSameOriginEveTransport({
      config: { baseUrl: "https://builder.example" },
      workloadIdentity: { token: async () => "synthetic" },
      fetchImplementation: async () => wire(native),
      verifyReadAuthority: async () => true,
    });
    const history = transport.observePrivateHistory;
    if (history === undefined) {
      throw new Error("Expected private reader");
    }
    await expect(
      readAuthSchemaRolloutApproval({
        plan: f.plan,
        callId: "original-call",
        owner,
        assertOwner: async () => {},
        readHistory: async (startIndex, onEvent) =>
          await history({
            principal: owner.principal,
            sessionId: owner.sessionId,
            adapterSessionId: owner.adapterSessionId,
            startIndex,
            endIndexExclusive: 2,
            onEvent,
          }),
      }),
    ).rejects.toBeInstanceOf(HostedSessionReadTimeoutError);
    expect(f.compareAndSet).not.toHaveBeenCalled();
  });

  it("emits only schema-owned issue paths and hashes when invalid input contains secrets", async () => {
    const f = await setup();
    const projected = projectAuthSchemaApprovalInput(
      { ...f.plan, [secret]: secret, effects: [{ sql: 17, sha256: secret, owner: secret }] },
      f.plan,
    );
    expect(projected).toMatchObject({
      schemaValid: false,
      unknownTopKeyCount: 1,
      fieldsEqual: { effects: false },
    });
    expect(JSON.stringify(projected)).not.toContain(secret);
    const getter = vi.fn(() => secret);
    expect(
      projectAuthSchemaApprovalInput(Object.defineProperty({}, "effects", { get: getter }), f.plan),
    ).toMatchObject({ jsonAvailable: false, schemaValid: false });
    expect(getter).not.toHaveBeenCalled();
  });

  it("caps schema issues and effect comparisons without exposing malformed values", async () => {
    const f = await setup();
    const projected = projectAuthSchemaApprovalInput(
      {
        ...f.plan,
        effects: Array.from({ length: 50 }, () => ({ sql: 17, owner: secret, sha256: secret })),
      },
      f.plan,
    );
    const result = z
      .object({
        schemaIssueCount: z.number(),
        schemaIssuesOmitted: z.number(),
        schemaIssues: z.array(z.json()),
        actualEffectCount: z.number(),
        effectComparisonsOmitted: z.number(),
        effects: z.array(z.json()),
      })
      .parse(projected);
    expect(result.schemaIssues).toHaveLength(32);
    expect(result.schemaIssuesOmitted).toBe(result.schemaIssueCount - 32);
    expect(result.actualEffectCount).toBe(50);
    expect(result.effects).toHaveLength(32);
    expect(result.effectComparisonsOmitted).toBe(18);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("counts unrelated requests and caps matching request and settlement logs on the actual wire", async () => {
    const f = await setup();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const [first, settlement, waiting] = events(f.plan);
    if (
      first?.type !== "input.requested" ||
      first.data.requests[0]?.kind !== "tool-approval" ||
      settlement?.type !== "approval.settled" ||
      waiting === undefined
    ) {
      throw new Error("Expected native request and settlement");
    }
    const [original] = first.data.requests;
    if (original?.kind !== "tool-approval") {
      throw new Error("Expected tool approval");
    }
    const native: MessageStreamEvent[] = [
      {
        ...first,
        data: {
          ...first.data,
          requests: [
            ...Array.from({ length: 100 }, (_, index) => ({
              ...original,
              requestId: `other-${index}`,
              action: { ...original.action, toolName: secret },
            })),
            ...Array.from({ length: 34 }, (_, index) => ({
              ...original,
              requestId: `matching-${index}`,
              action: { ...original.action, callId: `call-${index}` },
            })),
          ],
        },
      },
      ...Array.from({ length: 34 }, (_, index) => ({
        ...settlement,
        meta: { ...settlement.meta, id: `settlement-${index}` },
        data: { ...settlement.data, requestId: `matching-${index}` },
      })),
      ...Array.from({ length: 10 }, (_, index) => ({
        ...settlement,
        meta: { ...settlement.meta, id: `duplicate-${index}` },
        data: { ...settlement.data, requestId: "matching-0" },
      })),
    ];
    const observed = f.row.record.approvalObservation;
    if (observed === undefined) {
      throw new Error("Expected observation");
    }
    observed.nextNativeIndex = native.length;
    native.push(waiting);
    const response = await createAuthSchemaRolloutNativeHandler(environment, {
      consent: { resolveOwner: async () => owner, verifyWorkload: async () => {} },
      approvalFetch: async () => wire(native),
      openJournal: async () => ({ store: f.ports.store, close: async () => {} }),
    })(request(f.plan.operationRef));
    expect(response.status).toBe(200);
    const records = diagnosticRecords(info.mock.calls);
    expect(
      records.filter((value) => value.event === "builder.auth_schema_approval_request_diagnostic"),
    ).toHaveLength(32);
    expect(
      records.filter(
        (value) => value.event === "builder.auth_schema_approval_settlement_diagnostic",
      ),
    ).toHaveLength(32);
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "builder.auth_schema_approval_prefix_diagnostic",
        requests: 134,
        toolApprovalRequests: 134,
        matchingTools: 34,
        matchingRequestsOmitted: 2,
        prefixComplete: true,
        complete: false,
      }),
    );
    expect(records).toHaveLength(65);
    expect(JSON.stringify(info.mock.calls)).not.toContain(secret);
    expect(f.compareAndSet).not.toHaveBeenCalled();
  });

  it("never promotes exact request/settlement diagnostics into native approval", async () => {
    const f = await setup();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const matching = events(f.plan);
    const [first] = matching;
    if (first?.type !== "input.requested") {
      throw new Error("Expected request");
    }
    const [approval] = first.data.requests;
    if (approval?.kind !== "tool-approval") {
      throw new Error("Expected approval");
    }
    approval.action.input = f.plan;
    const response = await createAuthSchemaRolloutNativeHandler(environment, {
      consent: { resolveOwner: async () => owner, verifyWorkload: async () => {} },
      approvalFetch: async () => wire(matching),
      openJournal: async () => ({ store: f.ports.store, close: async () => {} }),
    })(request(f.plan.operationRef));
    const result = z.object({ state: z.string() }).parse(await response.json());
    expect(result.state).toBe("planned");
    expect(f.row.record.approval).toBeUndefined();
    expect(f.row.record.approvalObservation?.capture.entries).toEqual([]);
    expect(f.compareAndSet).not.toHaveBeenCalled();
    expect(
      diagnosticRecords(info.mock.calls).find(
        (value) => value.event === "builder.auth_schema_approval_request_diagnostic",
      ),
    ).toMatchObject({ comparison: { fullPlanEqual: true } });
  });

  it.each([
    "captured",
    "other-adapter",
    "other-generation",
    "other-owner",
    "other-plan",
    "wrong-fingerprint",
    "no-prefix",
    "approved",
  ])("skips an ineligible %s observation", async (kind) => {
    const f = await setup();
    const observed = f.row.record.approvalObservation;
    if (observed === undefined) {
      throw new Error("Expected observation");
    }
    if (kind === "captured") {
      observed.capture.entries.push({
        requestId: "approval",
        callId: "call",
        approved: false,
        cancelled: false,
        completedApproved: false,
        completedCancelled: false,
      });
    }
    if (kind === "other-adapter") {
      observed.adapterSessionId = "other";
    }
    if (kind === "other-generation") {
      observed.adapterGeneration += 1;
    }
    if (kind === "other-owner") {
      observed.capture.ownerUserId = "other";
    }
    if (kind === "other-plan") {
      observed.capture.request.planRef = "other";
    }
    if (kind === "wrong-fingerprint") {
      observed.capture.request.idempotencyKey = "0".repeat(64);
    }
    if (kind === "no-prefix") {
      observed.nextNativeIndex = 0;
    }
    if (kind === "approved") {
      f.row.record.approval = { approvalId: "saved", approvedByCallId: "original-call" };
    }
    const diagnoseApproval = vi.fn(async () => {});
    const service = createAuthSchemaRollout({ ...f.ports, diagnoseApproval });
    const result = await service.status(owner, f.plan.operationRef);
    expect(result.state).toBe("planned");
    expect(diagnoseApproval).not.toHaveBeenCalled();
    expect(f.compareAndSet).not.toHaveBeenCalled();
  });

  it("retains normal status after diagnostic transport failure but rechecks owner loss", async () => {
    const f = await setup();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const service = createAuthSchemaRollout({
      ...f.ports,
      diagnoseApproval: async () => {
        throw new Error(secret);
      },
    });
    const result = await service.status(owner, f.plan.operationRef);
    expect(result.state).toBe("planned");
    expect(JSON.stringify(info.mock.calls)).not.toContain(secret);
    const lost = createAuthSchemaRollout({
      ...f.ports,
      diagnoseApproval: async () => {
        f.setAuthorized(false);
        throw new Error(secret);
      },
    });
    await expect(lost.status(owner, f.plan.operationRef)).rejects.toThrow("owner_denied");
    expect(f.compareAndSet).not.toHaveBeenCalled();
  });

  it("denies current owner and enrollment failures before any history read", async () => {
    const f = await setup();
    const approvalFetch = vi.fn<typeof fetch>();
    const dependencies = {
      consent: {
        resolveOwner: async () => ({ ...owner, sessionId: "foreign" }),
        verifyWorkload: async () => {},
      },
      approvalFetch,
      openJournal: async () => ({ store: f.ports.store, close: async () => {} }),
    };
    await expect(
      createAuthSchemaRolloutNativeHandler(environment, dependencies)(request(f.plan.operationRef)),
    ).rejects.toThrow();
    await expect(
      createAuthSchemaRolloutNativeHandler({}, dependencies)(request(f.plan.operationRef)),
    ).rejects.toThrow();
    expect(approvalFetch).not.toHaveBeenCalled();
  });
});
