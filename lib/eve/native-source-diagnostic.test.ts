import { describe, expect, it, vi } from "vitest";
import { createSameOriginEveTransport } from "./same-origin-http";
import { nativeSourceDiagnosticSchema } from "./native-source-diagnostic";

const principal = {
  audience: "builder",
  issuer: "https://owner.example",
  ownerUserId: "owner",
  scopes: ["autograph:get"],
  workspaceId: "workspace",
};
const source = {
  cancellationRevision: 0,
  sourceAdapterGeneration: 1,
  sourceAdapterSessionId: "anchor",
  sourcePublicSessionId: "source",
};
const summary = nativeSourceDiagnosticSchema.parse({
  anchorRead: {
    errorCategory: "schema",
    outcome: "failed",
    stage: "steps_list",
    status: "completed",
    stepCounts: null,
    unsettledStepCount: null,
  },
  collectionBoundary: { allowParked: true, stage: "handoff_parent", status: "running" },
  collectionErrorCategory: null,
  collectionKind: "unavailable",
  collectionReason: "source-not-terminal",
  collectionStage: "candidate_collect",
  lineageRead: {
    errorCategory: null,
    httpStatus: null,
    outcome: "unassessed",
    provenRunCount: null,
    stepCounts: null,
    unsettledStepCount: null,
  },
  reconciliation: { errorCategory: null, kind: "unassessed", reason: null },
  version: 1,
});

describe("private source diagnostic transport relay", () => {
  it.each([
    { diagnostic: summary, label: "valid", outcome: "available", reason: undefined },
    { diagnostic: undefined, label: "missing", outcome: "unavailable", reason: "missing_summary" },
    {
      diagnostic: { ...summary, privateContent: "private-canary-secret" },
      label: "extra secret field",
      outcome: "unavailable",
      reason: "invalid_summary",
    },
    {
      diagnostic: {
        ...summary,
        anchorRead: { ...summary.anchorRead, status: "private-canary-status" },
      },
      label: "unknown status",
      outcome: "unavailable",
      reason: "invalid_summary",
    },
  ])(
    "parses actual postMutation response without exposing $label data",
    async ({ diagnostic, outcome, reason }) => {
      const request = vi.fn<typeof fetch>(async () =>
        Response.json(
          {
            ok: true,
            sessionId: "anchor",
            status: "accepted",
            ...(diagnostic === undefined ? {} : { sourceDiagnostic: diagnostic }),
          },
          { status: 202 },
        ),
      );
      const adapter = createSameOriginEveTransport({
        config: { baseUrl: "https://builder.example.test" },
        fetchImplementation: request,
        workloadIdentity: { token: async () => "synthetic-token" },
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
      fetchImplementation: async () =>
        Response.json(
          { ok: true, sessionId: "wrong-anchor", sourceDiagnostic: summary, status: "accepted" },
          { status: 202 },
        ),
      workloadIdentity: { token: async () => "synthetic-token" },
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
