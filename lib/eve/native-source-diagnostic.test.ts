import { describe, expect, it, vi } from "vitest";
import { createSameOriginEveTransport } from "./same-origin-http";
import { nativeSourceDiagnosticSchema } from "./native-source-diagnostic";

const principal = {
  issuer: "https://owner.example",
  audience: "builder",
  workspaceId: "workspace",
  ownerUserId: "owner",
  scopes: ["autograph:get"],
};
const source = {
  sourcePublicSessionId: "source",
  sourceAdapterSessionId: "anchor",
  sourceAdapterGeneration: 1,
  cancellationRevision: 0,
};
const summary = nativeSourceDiagnosticSchema.parse({
  version: 1,
  collectionKind: "unavailable",
  collectionReason: "source-not-terminal",
  collectionBoundary: { stage: "handoff_parent", status: "running", allowParked: true },
  collectionErrorCategory: null,
  collectionStage: "candidate_collect",
  reconciliation: { kind: "unassessed", reason: null, errorCategory: null },
  lineageRead: {
    outcome: "unassessed",
    provenRunCount: null,
    unsettledStepCount: null,
    stepCounts: null,
    errorCategory: null,
    httpStatus: null,
  },
  anchorRead: {
    outcome: "failed",
    stage: "steps_list",
    errorCategory: "schema",
    status: "completed",
    unsettledStepCount: null,
    stepCounts: null,
  },
});

describe("private source diagnostic transport relay", () => {
  it.each([
    { label: "valid", diagnostic: summary, outcome: "available", reason: undefined },
    { label: "missing", diagnostic: undefined, outcome: "unavailable", reason: "missing_summary" },
    {
      label: "extra secret field",
      diagnostic: { ...summary, privateContent: "private-canary-secret" },
      outcome: "unavailable",
      reason: "invalid_summary",
    },
    {
      label: "unknown status",
      diagnostic: {
        ...summary,
        anchorRead: { ...summary.anchorRead, status: "private-canary-status" },
      },
      outcome: "unavailable",
      reason: "invalid_summary",
    },
  ])(
    "parses actual postMutation response without exposing $label data",
    async ({ diagnostic, outcome, reason }) => {
      const request = vi.fn<typeof fetch>(() =>
        Promise.resolve(
          Response.json(
            {
              ok: true,
              status: "accepted",
              sessionId: "anchor",
              ...(diagnostic === undefined ? {} : { sourceDiagnostic: diagnostic }),
            },
            { status: 202 },
          ),
        ),
      );
      const adapter = createSameOriginEveTransport({
        config: { baseUrl: "https://builder.example.test" },
        workloadIdentity: { token: () => Promise.resolve("synthetic-token") },
        fetchImplementation: request,
      });
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        await expect(adapter.observeSource?.({ principal, source })).resolves.toBeUndefined();
        expect(request).toHaveBeenCalledOnce();
        const logged: unknown = JSON.parse(String(info.mock.calls[0]?.[0]));
        expect(logged).toMatchObject({
          event: "builder.native_source_observation_relay",
          outcome,
          ...(reason === undefined ? { diagnostic: summary } : { reason }),
        });
        expect(JSON.stringify(info.mock.calls)).not.toContain("private-canary");
        expect(JSON.stringify(info.mock.calls)).not.toContain("synthetic-token");
      } finally {
        info.mockRestore();
      }
    },
  );
  it("checks exact source identity before relaying a valid private summary", async () => {
    const adapter = createSameOriginEveTransport({
      config: { baseUrl: "https://builder.example.test" },
      workloadIdentity: { token: () => Promise.resolve("synthetic-token") },
      fetchImplementation: () =>
        Promise.resolve(
          Response.json(
            { ok: true, status: "accepted", sessionId: "wrong-anchor", sourceDiagnostic: summary },
            { status: 202 },
          ),
        ),
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await expect(adapter.observeSource?.({ principal, source })).rejects.toThrow();
      expect(info.mock.calls.map(([value]) => String(value))).toEqual([
        JSON.stringify({
          event: "builder.native_source_observation_relay",
          outcome: "unavailable",
          reason: "identity_mismatch",
        }),
      ]);
    } finally {
      info.mockRestore();
    }
  });
});
