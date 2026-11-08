import { describe, expect, it, vi } from "vitest";
import { createSameOriginEveTransport } from "./same-origin-http";
import { nativeSourceDiagnosticSchema } from "./native-source-diagnostic";

interface SourceDiagnosticResponse<T> {
  ok: boolean;
  sessionId: string;
  sourceDiagnostic?: T;
  status: string;
}

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
    // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
    { diagnostic: summary, label: "valid", outcome: "available", reason: undefined },
    // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
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
      const request = vi.fn<typeof fetch>(() => {
        const response: SourceDiagnosticResponse<typeof diagnostic> = {
          ok: true,
          status: "accepted",
          sessionId: "anchor",
        };
        if (diagnostic !== undefined) {
          response.sourceDiagnostic = diagnostic;
        }
        return Promise.resolve(Response.json(response, { status: 202 }));
      });
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
