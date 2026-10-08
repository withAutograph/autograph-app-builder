import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { hostedEveOperationScopes } from "./hosted-auth";
import {
  createHostedEveSessionService,
  HostedSubmissionUnknownError,
  SubmissionOutcomeUnknownError,
} from "./hosted-service";
import type { HostedEveTransport } from "./hosted-service";
import { InMemoryHostedEveStore } from "./hosted-store";
import { SubmissionRejectedBeforeDispatchError } from "./submission-rejected-before-dispatch-error";
import { reportHostedSubmissionDiagnostic } from "./hosted-submission-diagnostic";
import type {
  HostedSubmissionDiagnostic,
  HostedSubmissionDiagnosticSink,
} from "./hosted-submission-diagnostic";
import { createSameOriginEveTransport } from "./same-origin-http";

const canary = "private-prompt user-one postgresql://installer:secret@database.example/query";
const principal = {
  audience: "https://builder.example.test/mcp",
  issuer: "https://builder.example.test/api/auth",
  ownerUserId: "private-user",
  scopes: Object.values(hostedEveOperationScopes),
  workspaceId: "private-workspace",
};
const request = { clientRequestId: `private-request-${canary}`, prompt: canary };
const hash = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const snapshot = { events: [], status: "working" as const };
const adapter = (): HostedEveTransport => ({
  // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous transport test contract.
  cancel: vi.fn(async () => snapshot),
  // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous transport test contract.
  get: vi.fn(async () => snapshot),
  // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous transport test contract.
  respond: vi.fn(async () => snapshot),
  // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous transport test contract.
  send: vi.fn(async () => snapshot),
  // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous transport test contract.
  start: vi.fn(async () => ({ adapterSessionId: "private-adapter", snapshot })),
});
const databaseError = (code: string): Error =>
  new Error(canary, { cause: Object.assign(new Error(canary), { code, query: canary }) });

describe("sanitized hosted submission diagnostics", () => {
  it("correlates a failed reservation without dispatching or leaking the nested SQL error", async () => {
    const store = new InMemoryHostedEveStore();
    const transport = adapter();
    const sink = vi.fn<HostedSubmissionDiagnosticSink>();
    vi.spyOn(store, "reserveOperation").mockRejectedValue(databaseError("42P01"));
    const service = createHostedEveSessionService({
      onSubmissionDiagnostic: sink,
      principal,
      store,
      transport,
    });

    await expect(service.start(request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    expect(transport.start).not.toHaveBeenCalled();
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "storage_schema_unavailable",
        clientRequestIdHash: hash(request.clientRequestId),
        event: "builder.hosted_submission_uncertain",
        operationKind: "start",
        phase: "reservation",
        sqlState: "42P01",
      }),
    );
    expect(sink.mock.calls[0]?.[0].operationIdHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(sink.mock.calls)).not.toContain(canary);
    expect(JSON.stringify(sink.mock.calls)).not.toContain(principal.ownerUserId);
    expect(JSON.stringify(sink.mock.calls)).not.toContain(principal.workspaceId);
  });

  it("preserves an accepted start's reservation after settlement failure and does not replay on read or early retry", async () => {
    const store = new InMemoryHostedEveStore();
    const transport = adapter();
    const sink = vi.fn<HostedSubmissionDiagnosticSink>();
    vi.spyOn(store, "settleSucceeded").mockRejectedValue(databaseError("42703"));
    const service = createHostedEveSessionService({
      now: () => 1000,
      onSubmissionDiagnostic: sink,
      principal,
      store,
      transport,
    });

    await expect(service.start(request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    await expect(
      service.getStart?.({ clientRequestId: request.clientRequestId, cursor: 0, limit: 10 }),
    ).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    await expect(service.start(request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    expect(transport.start).toHaveBeenCalledOnce();
    expect(await store.getStartOperation(principal, request.clientRequestId)).toMatchObject({
      state: "reserved",
    });
    expect(sink.mock.calls.map(([record]) => record.phase)).toEqual([
      "settlement",
      "recovery",
      "reservation_verification",
    ]);
    expect(sink.mock.calls[0]?.[0]).toMatchObject({
      adapterSessionIdHash: hash("private-adapter"),
      sqlState: "42703",
    });
    expect(sink.mock.calls[1]?.[0]).toMatchObject({ savedState: "reserved" });
    expect(JSON.stringify(sink.mock.calls)).not.toContain(canary);
    expect(JSON.stringify(sink.mock.calls)).not.toContain("private-adapter");
  });

  it("distinguishes an unknown dispatch from a failed unsuccessful settlement", async () => {
    const store = new InMemoryHostedEveStore();
    const transport = adapter();
    const sink = vi.fn<HostedSubmissionDiagnosticSink>();
    vi.mocked(transport.start).mockRejectedValue(new SubmissionOutcomeUnknownError());
    vi.spyOn(store, "settleUnsuccessful").mockRejectedValue(databaseError("25P02"));
    const service = createHostedEveSessionService({
      onSubmissionDiagnostic: sink,
      principal,
      store,
      transport,
    });

    await expect(service.start(request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    expect(sink.mock.calls.map(([record]) => record.phase)).toEqual([
      "dispatch",
      "unsuccessful_settlement",
    ]);
    expect(sink.mock.calls[1]?.[0]).toMatchObject({
      category: "storage_transaction_aborted",
      sqlState: "25P02",
    });
    expect(transport.start).toHaveBeenCalledOnce();
  });

  it("reports a start receipt lookup failure without changing its error or performing a mutation", async () => {
    const store = new InMemoryHostedEveStore();
    const transport = adapter();
    const sink = vi.fn<HostedSubmissionDiagnosticSink>();
    const failure = databaseError("42501");
    vi.spyOn(store, "getStartOperation").mockRejectedValue(failure);
    const service = createHostedEveSessionService({
      onSubmissionDiagnostic: sink,
      principal,
      store,
      transport,
    });

    await expect(
      service.getStart?.({ clientRequestId: request.clientRequestId, cursor: 0, limit: 10 }),
    ).rejects.toBe(failure);
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ phase: "start_lookup" }));
    expect(transport.start).not.toHaveBeenCalled();
  });

  it("preserves the public unknown outcome when the diagnostic sink fails", async () => {
    const store = new InMemoryHostedEveStore();
    const transport = adapter();
    vi.spyOn(store, "reserveOperation").mockRejectedValue(databaseError("42P01"));
    const service = createHostedEveSessionService({
      // oxlint-disable-next-line eslint/require-await -- A rejected asynchronous sink must also leave the public outcome unchanged.
      onSubmissionDiagnostic: async () => {
        throw new Error(canary);
      },
      principal,
      store,
      transport,
    });

    await expect(service.start(request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    expect(transport.start).not.toHaveBeenCalled();
  });

  it.each(["conflict", "rejected"] as const)(
    "does not label a definite reservation %s as uncertain",
    async (disposition) => {
      const store = new InMemoryHostedEveStore();
      const transport = adapter();
      const sink = vi.fn<HostedSubmissionDiagnosticSink>();
      vi.spyOn(store, "reserveOperation").mockResolvedValue(
        disposition === "conflict" ? { disposition } : { disposition, reason: "session_busy" },
      );
      const service = createHostedEveSessionService({
        onSubmissionDiagnostic: sink,
        principal,
        store,
        transport,
      });

      await expect(service.start(request)).rejects.toThrow();
      expect(sink).not.toHaveBeenCalled();
      expect(transport.start).not.toHaveBeenCalled();
    },
  );

  it("ignores cycles, accessors, unknown codes, and failed sinks", () => {
    const sink = vi.fn<HostedSubmissionDiagnosticSink>();
    interface CyclicCause {
      cause?: CyclicCause;
      code: string;
    }
    const cycle: CyclicCause = { code: canary };
    cycle.cause = cycle;
    reportHostedSubmissionDiagnostic({
      error: cycle,
      operationKind: "start",
      phase: "recovery",
      sink,
    });
    const accessors = Object.defineProperties(
      {},
      {
        cause: {
          get: () => {
            throw new Error(canary);
          },
        },
        code: {
          get: () => {
            throw new Error(canary);
          },
        },
      },
    );
    reportHostedSubmissionDiagnostic({
      error: accessors,
      operationKind: "start",
      phase: "recovery",
      sink,
    });
    expect(sink.mock.calls).toEqual([
      [
        {
          category: "unclassified_failure",
          event: "builder.hosted_submission_uncertain",
          operationKind: "start",
          phase: "recovery",
        },
      ],
      [
        {
          category: "unclassified_failure",
          event: "builder.hosted_submission_uncertain",
          operationKind: "start",
          phase: "recovery",
        },
      ],
    ]);
    expect(() => {
      reportHostedSubmissionDiagnostic({
        error: new Proxy(
          {},
          {
            getOwnPropertyDescriptor: () => {
              throw new Error(canary);
            },
          },
        ),
        operationKind: "start",
        phase: "recovery",
        sink,
      });
    }).not.toThrow();
    expect(() => {
      reportHostedSubmissionDiagnostic({
        error: databaseError("42P01"),
        operationKind: "start",
        phase: "recovery",
        sink: () => {
          throw new Error(canary);
        },
      });
    }).not.toThrow();
  });

  it.each(["dispatch", "acceptance", "confirmation"] as const)(
    "identifies the transport %s boundary without disclosing a candidate receipt",
    async (stage) => {
      const diagnostics: HostedSubmissionDiagnostic[] = [];
      // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous fetch test contract.
      const fetchImplementation = vi.fn<typeof fetch>(async (url) => {
        if (stage === "dispatch") {
          throw new Error(canary);
        }
        if (stage === "acceptance") {
          return new Response(canary, { status: 202 });
        }
        const endpoint = new URL(url instanceof Request ? url.url : url);
        return endpoint.pathname.endsWith("/stream")
          ? new Response(canary, { status: 200 })
          : Response.json(
              { ok: true, sessionId: "candidate-private", status: "accepted" },
              {
                headers: { "content-type": "application/json" },
                status: 202,
              },
            );
      });
      const transport = createSameOriginEveTransport({
        config: { baseUrl: "https://builder.example.test" },
        fetchImplementation,
        onSubmissionDiagnostic: (diagnostic) => {
          diagnostics.push(diagnostic);
        },
        workloadIdentity: {
          // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous workload identity test contract.
          token: async () => "secret-workload-token",
        },
      });

      await expect(
        transport.start({ operationId: "private-operation", principal, prompt: canary }),
      ).rejects.toBeInstanceOf(SubmissionOutcomeUnknownError);
      expect(diagnostics).toEqual([
        expect.objectContaining({
          operationIdHash: hash("private-operation"),
          phase: stage === "confirmation" ? "transport_start_confirmation" : `transport_${stage}`,
        }),
      ]);
      expect(JSON.stringify(diagnostics)).not.toContain(canary);
      expect(JSON.stringify(diagnostics)).not.toContain("candidate-private");
      expect(JSON.stringify(diagnostics)).not.toContain("secret-workload-token");
      if (stage === "confirmation") {
        expect(diagnostics[0]?.adapterSessionIdHash).toBe(hash("candidate-private"));
      }
    },
  );
});

describe("verified pre-dispatch rejection diagnostics", () => {
  it.each(["send_preflight_unavailable", "workload_identity_unavailable", "session_not_ready"])(
    "reports the allowlisted source reason %s without uncertainty",
    (reason) => {
      const sink = vi.fn<HostedSubmissionDiagnosticSink>();
      reportHostedSubmissionDiagnostic({
        error: new SubmissionRejectedBeforeDispatchError(reason),
        operationKind: "send",
        phase: "dispatch",
        sink,
      });
      expect(sink.mock.calls).toEqual([
        [
          {
            category: "rejected_before_dispatch",
            event: "builder.hosted_submission_rejected",
            operationKind: "send",
            phase: "dispatch",
            rejectedReason: reason,
          },
        ],
      ]);
    },
  );
  it("does not trust plain error codes or inspect secret source-error properties", () => {
    const sink = vi.fn<HostedSubmissionDiagnosticSink>();
    const access = vi.fn(() => {
      throw new Error(canary);
    });
    const source = new SubmissionRejectedBeforeDispatchError(canary);
    Object.defineProperties(source, {
      cause: { get: access },
      code: { get: access },
      message: { get: access },
    });
    for (const error of [
      source,
      new SubmissionRejectedBeforeDispatchError(canary),
      { code: "send_preflight_unavailable", message: canary },
      new SubmissionOutcomeUnknownError(),
    ]) {
      reportHostedSubmissionDiagnostic({ error, operationKind: "send", phase: "dispatch", sink });
    }
    expect(access).not.toHaveBeenCalled();
    expect(
      sink.mock.calls.map(([value]) => [value.event, value.category, value.rejectedReason]),
    ).toEqual([
      ["builder.hosted_submission_rejected", "rejected_before_dispatch", undefined],
      ["builder.hosted_submission_rejected", "rejected_before_dispatch", undefined],
      ["builder.hosted_submission_uncertain", "unclassified_failure", undefined],
      ["builder.hosted_submission_uncertain", "unclassified_failure", undefined],
    ]);
    expect(JSON.stringify(sink.mock.calls)).not.toContain(canary);
  });
});
