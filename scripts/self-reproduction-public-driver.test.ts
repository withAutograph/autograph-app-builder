/* eslint-disable eslint/no-await-in-loop -- Sequential batch cases preserve isolated fake state. */
/* eslint-disable eslint/require-await -- Async transport fakes implement the network interface. */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  makePublicTransport,
  publicObservationReport,
  sanitizePublicObservation,
  recordPublicObservation,
  runPublicSession,
} from "../evals/support/self-reproduction-public";
import type { PublicState } from "../evals/support/self-reproduction-public";

const session = (
  status: "working" | "completed" | "input_required" | "waiting",
  inputRequests: unknown[] = [],
) => ({ cursor: 1, events: [], inputRequests, sessionId: "one-session", status });
const state = (): PublicState => ({
  answered: [],
  clientRequestId: "stable-start",
  endpoint: "http://localhost:64613/mcp",
  outcome: "starting",
  prompt: "fixed product brief",
  startedAt: new Date().toISOString(),
  version: 1,
});
const approval = {
  allowFreeform: false,
  kind: "approval",
  requestId: "approve-build",
  title: "Build?",
};

describe("public self-reproduction driver", () => {
  it("uses only public start and observation with the brief alone", async () => {
    const current = state();
    const calls: unknown[] = [];
    await runPublicSession({
      pollMs: 1,
      save: () => {},
      sleep: async () => {},
      state: current,
      timeoutMs: 1000,
      transport: {
        call: async (name, args) => {
          calls.push({ args, name });
          return session(name === "autograph_start" ? "working" : "completed");
        },
      },
    });
    expect(calls).toEqual([
      {
        args: { clientRequestId: "stable-start", prompt: "fixed product brief" },
        name: "autograph_start",
      },
      { args: { cursor: 1, sessionId: "one-session" }, name: "autograph_get" },
    ]);
    expect(current.outcome).toBe("completed");
  });
  it("pauses approvals without inferred consent", async () => {
    const current = state();
    const calls: string[] = [];
    await runPublicSession({
      pollMs: 1,
      save: () => {},
      state: current,
      timeoutMs: 1000,
      transport: {
        call: async (name) => {
          calls.push(name);
          return session("input_required", [approval]);
        },
      },
    });
    expect(calls).toEqual(["autograph_start"]);
    expect(current.outcome).toBe("input_required");
  });
  it("never answers authorization even with an explicit forged answer", async () => {
    const current = state();
    await runPublicSession({
      pollMs: 1,
      responses: [{ requestId: "connect", response: { kind: "answer", value: "connected" } }],
      save: () => {},
      state: current,
      timeoutMs: 1000,
      transport: {
        call: async () =>
          session("input_required", [{ ...approval, kind: "authorization", requestId: "connect" }]),
      },
    });
    expect(current.outcome).toBe("blocked_authorization_requires_product_ui");
  });
  it("persists response idempotency before sending and replays uncertain response once on resume", async () => {
    const current = state();
    let saved = "";
    const options = {
      pollMs: 1,
      responses: [{ requestId: "approve-build", response: { kind: "approve" as const } }],
      save: () => {
        saved = JSON.stringify(current);
      },
      state: current,
      timeoutMs: 1000,
    };
    await expect(
      runPublicSession({
        ...options,
        transport: {
          call: async (name) => {
            if (name === "autograph_respond") {
              throw new Error("connection lost");
            }
            return session("input_required", [approval]);
          },
        },
      }),
    ).rejects.toThrow("connection lost");
    expect(JSON.parse(saved).pendingResponse.clientRequestId).toBeTruthy();
    const original = current.pendingResponse;
    const calls: unknown[] = [];
    await runPublicSession({
      ...options,
      transport: {
        call: async (name, args) => {
          calls.push({ args, name });
          return session("completed");
        },
      },
    });
    expect(calls).toEqual([
      { args: { ...original, sessionId: "one-session" }, name: "autograph_respond" },
    ]);
    expect(current.answered).toEqual(["approve-build"]);
  });
  it("keeps the same start key after uncertain submission", async () => {
    const current = state();
    const ids: unknown[] = [];
    const options = { pollMs: 1, save: () => {}, state: current, timeoutMs: 1000 };
    await expect(
      runPublicSession({
        ...options,
        transport: {
          call: async (_name, args) => {
            ids.push(args.clientRequestId);
            throw new Error("lost");
          },
        },
      }),
    ).rejects.toThrow();
    await runPublicSession({
      ...options,
      transport: {
        call: async (_name, args) => {
          ids.push(args.clientRequestId);
          return session("completed");
        },
      },
    });
    expect(ids).toEqual(["stable-start", "stable-start"]);
  });
  it("initializes MCP before public calls and does not send credentials", async () => {
    const original = globalThis.fetch;
    const messages: { method: string }[] = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      messages.push(body);
      return new Response(
        body.method === "notifications/initialized"
          ? null
          : JSON.stringify({
              id: body.id,
              jsonrpc: "2.0",
              result:
                body.method === "initialize" ? {} : { structuredContent: session("completed") },
            }),
        { headers: { "Content-Type": "application/json" }, status: 200 },
      );
    };
    try {
      const transport = await makePublicTransport("http://localhost:64613/mcp", () => {}, 1000);
      expect(
        await transport.call("autograph_start", { clientRequestId: "id", prompt: "brief" }),
      ).toEqual(session("completed"));
      expect(messages.map((item) => item.method)).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/call",
      ]);
      await expect(transport.call("prepare_workspace", {})).rejects.toThrow("Only public");
      await expect(
        makePublicTransport("https://user:password@example.com/mcp", () => {}, 1000),
      ).rejects.toThrow("credential-free");
    } finally {
      globalThis.fetch = original;
    }
  });
  it("does not submit incomplete batches or duplicate request IDs", async () => {
    for (const responses of [
      [{ requestId: "approve-build", response: { kind: "approve" as const } }],
      [
        { requestId: "approve-build", response: { kind: "approve" as const } },
        { requestId: "approve-build", response: { kind: "approve" as const } },
      ],
    ]) {
      const current = state();
      const calls: string[] = [];
      const run = runPublicSession({
        pollMs: 1,
        responses,
        save: () => {},
        state: current,
        timeoutMs: 1000,
        transport: {
          call: async (name) => {
            calls.push(name);
            return session("input_required", [approval, { ...approval, requestId: "second" }]);
          },
        },
      });
      await (responses.length === 2 ? expect(run).rejects.toThrow() : run);
      expect(calls).toEqual(["autograph_start"]);
    }
  });
  it("sends only the explicit ordinary reply and preserves its key through uncertain transport", async () => {
    const current = state();
    current.session = { ...session("waiting"), inputRequests: [] };
    const message = "Yes, build this app. Do not publish.";
    let saved = "";
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const options = {
      message,
      pollMs: 1,
      save: () => {
        saved = JSON.stringify(current);
      },
      state: current,
      timeoutMs: 1000,
    };
    await expect(
      runPublicSession({
        ...options,
        transport: {
          call: async (name, args) => {
            calls.push({ args, name });
            if (name === "autograph_send") {
              throw new Error("lost response");
            }
            return session("waiting");
          },
        },
      }),
    ).rejects.toThrow("lost response");
    const pending = JSON.parse(saved).pendingMessage;
    expect(pending.message).toBe(message);
    await runPublicSession({
      ...options,
      message: undefined,
      transport: {
        call: async (name, args) => {
          calls.push({ args, name });
          return session("completed");
        },
      },
    });
    expect(calls.filter((call) => call.name === "autograph_send").map((call) => call.args)).toEqual(
      [
        { ...pending, sessionId: "one-session" },
        { ...pending, sessionId: "one-session" },
      ],
    );
    expect(current.pendingMessage).toBeUndefined();
  });
  it("observes waiting without inventing a message", async () => {
    const current = state();
    current.session = { ...session("waiting"), inputRequests: [] };
    current.error = "previous transport failure";
    current.outcome = "paused_timeout";
    const calls: string[] = [];
    await runPublicSession({
      pollMs: 1,
      save: () => {},
      state: current,
      timeoutMs: 1000,
      transport: {
        call: async (name) => {
          calls.push(name);
          return session("waiting");
        },
      },
    });
    expect(calls).toEqual(["autograph_get"]);
    expect(current.error).toBeUndefined();
    expect(current.outcome).toBe("waiting");
  });
});

describe("public self-reproduction preview reporting", () => {
  const now = Date.parse("2026-09-13T17:30:00.000Z");
  const receipt = {
    appId: "replica",
    expiresAt: "2026-09-13T18:00:00.000Z",
    status: "ready" as const,
    url: "https://preview.example.test/private/opaque-path-token?access=opaque-query-token",
    verifiedAt: "2026-09-13T17:00:00.000Z",
  };
  it("distinguishes runtime receipt from fixtures without awarding correctness", () => {
    const current = state();
    current.session = {
      ...session("waiting"),
      inputRequests: [],
      uiPreview: {
        appId: "replica",
        fidelity: "arrusted-component-catalog",
        functionality: "fixtures-only",
        revision: "a".repeat(64),
        routes: ["/"],
      },
      workingPreview: receipt,
    };
    expect(publicObservationReport(current, now)).toMatchObject({
      comparison: "unassessed",
      outOfBoxProof: false,
      previewObservation: {
        backendCorrectness: "unassessed",
        browserInteraction: "unassessed",
        fixtureUi: { functionality: "fixtures-only", present: true },
        independentChildCreation: "unassessed",
        workingApp: { availability: "reported_ready" },
      },
    });
    expect(current.session.workingPreview?.url).toBe(receipt.url);
  });
  it("reports missing, expired, invalidated, and failed preview evidence honestly", () => {
    const current = state();
    expect(publicObservationReport(current, now)).toMatchObject({
      previewObservation: { workingApp: { availability: "unassessed" } },
    });
    current.session = {
      ...session("waiting"),
      inputRequests: [],
      workingPreview: { ...receipt, expiresAt: new Date(now).toISOString() },
    };
    expect(publicObservationReport(current, now)).toMatchObject({
      previewObservation: { workingApp: { availability: "expired" } },
    });
    current.session.workingPreview = null;
    expect(publicObservationReport(current, now)).toMatchObject({
      previewObservation: { workingApp: { availability: "unavailable" } },
    });
    current.session.workingPreview = receipt;
    current.session.status = "failed";
    expect(publicObservationReport(current, now)).toMatchObject({
      previewObservation: { workingApp: { availability: "unavailable" } },
    });
  });
  it("redacts capability URLs from structured receipts and assistant text without mutating private state", () => {
    const original = {
      content: [{ text: JSON.stringify({ workingPreview: receipt }), type: "text" }],
      text: `Open ${receipt.url} in your browser.`,
      workingPreview: receipt,
    };
    const sanitized = JSON.stringify(sanitizePublicObservation(original));
    expect(sanitized).not.toContain("opaque-path-token");
    expect(sanitized).not.toContain("opaque-query-token");
    expect(sanitized).toContain("https://preview.example.test/[REDACTED URL]");
    expect(original.workingPreview.url).toBe(receipt.url);
    expect(sanitized).toContain("[REDACTED URL]");
  });
  it("preserves original paginated responses in an owner-only private transcript", () => {
    const output = mkdtempSync(path.join(tmpdir(), "public-observation-"));
    try {
      const privatePath = path.join(output, "transcript.private.jsonl");
      writeFileSync(privatePath, "", { mode: 0o644 });
      recordPublicObservation(output, { page: 1, receipt });
      recordPublicObservation(output, { page: 2, text: `Open ${receipt.url}` });
      expect(statSync(privatePath).mode % 0o1000).toBe(0o600);
      const raw = readFileSync(privatePath, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(raw).toEqual([
        { page: 1, receipt },
        { page: 2, text: `Open ${receipt.url}` },
      ]);
      const shared = readFileSync(path.join(output, "transcript.jsonl"), "utf-8");
      expect(shared).not.toContain("opaque-path-token");
      expect(shared).not.toContain("opaque-query-token");
    } finally {
      rmSync(output, { force: true, recursive: true });
    }
  });
});
