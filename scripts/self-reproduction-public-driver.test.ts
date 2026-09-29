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
  parsePublicStartFile,
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
const unresolvedStart = (code = "submission_unknown") => ({
  cursor: 0,
  error: { code, message: "Keep the same original start request." },
  events: [],
  sessionId: "",
  status: "failed",
});

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
  it("recovers a lost prompt-start response by its original request ID without dispatching another start", async () => {
    const current = state();
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const options = { pollMs: 1, save: () => {}, state: current, timeoutMs: 1000 };
    await expect(
      runPublicSession({
        ...options,
        transport: {
          call: async (name, args) => {
            calls.push({ args, name });
            throw new Error("lost");
          },
        },
      }),
    ).rejects.toThrow();
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
      {
        args: { clientRequestId: "stable-start", prompt: "fixed product brief" },
        name: "autograph_start",
      },
      { args: { clientRequestId: "stable-start" }, name: "autograph_get" },
    ]);
  });
  it("retries the unchanged original request only after a request lookup finds no bound session", async () => {
    const current = state();
    const original = {
      clientRequestId: "selected-source",
      prompt:
        "Revise Spend Review from repository branch pilot-authenticated-app; prepare a draft for review.",
    };
    current.originalStart = original;
    current.startSubmitted = true;
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    await runPublicSession({
      pollMs: 1,
      save: () => {},
      state: current,
      timeoutMs: 1000,
      transport: {
        call: async (name, args) => {
          calls.push({ args, name });
          return name === "autograph_get"
            ? unresolvedStart("start_request_not_found")
            : session("input_required", [approval]);
        },
      },
    });
    expect(calls).toEqual([
      { args: { clientRequestId: original.clientRequestId }, name: "autograph_get" },
      { args: original, name: "autograph_start" },
    ]);
    expect(current.originalStart).toEqual(original);
    expect(current.answered).toEqual([]);
    expect(current.outcome).toBe("input_required");
  });
  it("preserves an unresolved no-handle response without ever polling an empty session", async () => {
    const current = state();
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const saved: PublicState[] = [];
    await runPublicSession({
      pollMs: 1,
      save: () => {
        saved.push(structuredClone(current));
      },
      state: current,
      timeoutMs: 1000,
      transport: {
        call: async (name, args) => {
          calls.push({ args, name });
          return unresolvedStart();
        },
      },
    });
    expect(calls.map(({ name }) => name)).toEqual(["autograph_start", "autograph_get"]);
    expect(calls[1]?.args).toEqual({ clientRequestId: "stable-start" });
    expect(current.session).toBeUndefined();
    expect(current.unresolvedStartResult).toEqual(unresolvedStart());
    expect(current.outcome).toBe("start_submission_unresolved");
    expect(saved.every((snapshot) => snapshot.session?.sessionId !== "")).toBe(true);
  });
  it("repairs a legacy saved empty handle through request lookup", async () => {
    const current = state();
    current.session = { ...unresolvedStart(), status: "failed" };
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    await runPublicSession({
      pollMs: 1,
      save: () => {},
      state: current,
      timeoutMs: 1000,
      transport: {
        call: async (name, args) => {
          calls.push({ args, name });
          return session("completed");
        },
      },
    });
    expect(calls).toEqual([{ args: { clientRequestId: "stable-start" }, name: "autograph_get" }]);
    expect(current.session?.sessionId).toBe("one-session");
  });
  it("retains the full unresolved public response in its private transcript while recovering the real session", async () => {
    const originalFetch = globalThis.fetch;
    const output = mkdtempSync(path.join(tmpdir(), "public-start-recovery-"));
    const current = state();
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      const result =
        body.method === "initialize"
          ? {}
          : {
              isError: body.params?.name === "autograph_start",
              structuredContent:
                body.params?.name === "autograph_start" ? unresolvedStart() : session("completed"),
            };
      return new Response(
        body.method === "notifications/initialized"
          ? null
          : JSON.stringify({ id: body.id, jsonrpc: "2.0", result }),
        { headers: { "Content-Type": "application/json" }, status: 200 },
      );
    };
    try {
      const transport = await makePublicTransport(
        current.endpoint,
        (entry) => {
          recordPublicObservation(output, entry);
        },
        1000,
      );
      await runPublicSession({
        pollMs: 1,
        save: () => {},
        state: current,
        timeoutMs: 1000,
        transport,
      });
      const transcript = readFileSync(path.join(output, "transcript.private.jsonl"), "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        transcript.find(
          (entry) => entry.direction === "response" && entry.name === "autograph_start",
        ).result.structuredContent,
      ).toEqual(unresolvedStart());
      expect(
        transcript.find((entry) => entry.direction === "request" && entry.name === "autograph_get")
          .arguments,
      ).toEqual({ clientRequestId: "stable-start" });
      expect(current.session?.sessionId).toBe("one-session");
      expect(current.unresolvedStartResult).toBeUndefined();
      expect(statSync(path.join(output, "transcript.private.jsonl")).mode % 0o1000).toBe(0o600);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(output, { force: true, recursive: true });
    }
  });
  it("recovers a prepared handoff by its original public request ID without another start", async () => {
    const current = state();
    const original = parsePublicStartFile(
      JSON.stringify({
        clientRequestId: "handoff-start",
        handoffId: "5b8938e5-d80a-4bdb-8849-2fd70a8651ad",
      }),
    );
    current.originalStart = original;
    current.startSubmitted = true;
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    await runPublicSession({
      pollMs: 1,
      save: () => {},
      state: current,
      timeoutMs: 1000,
      transport: {
        call: async (name, args) => {
          calls.push({ args, name });
          return session("completed");
        },
      },
    });
    expect(calls).toEqual([
      { args: { clientRequestId: original.clientRequestId }, name: "autograph_get" },
    ]);
    expect(() =>
      parsePublicStartFile(JSON.stringify({ ...original, source: { branch: "other" } })),
    ).toThrow();
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
  it("authenticates hosted requests without recording or returning an echoed environment token", async () => {
    const originalFetch = globalThis.fetch;
    const token = "hosted-test-secret-token";
    const records: unknown[] = [];
    const headers: Headers[] = [];
    globalThis.fetch = async (_url, options) => {
      headers.push(new Headers(options?.headers));
      const body = JSON.parse(String(options?.body));
      return new Response(
        body.method === "notifications/initialized"
          ? null
          : JSON.stringify({
              id: body.id,
              jsonrpc: "2.0",
              result:
                body.method === "initialize"
                  ? {}
                  : {
                      structuredContent: {
                        ...session("completed"),
                        error: { code: "diagnostic", message: `Echoed ${token}` },
                      },
                    },
            }),
        { headers: { "Content-Type": "application/json" }, status: 200 },
      );
    };
    try {
      const transport = await makePublicTransport(
        "https://builder.example.test/mcp",
        (entry) => {
          records.push(entry);
        },
        1000,
        { bearerToken: token },
      );
      const result = await transport.call("autograph_start", {
        clientRequestId: "start",
        prompt: "Build a full application.",
      });
      expect(headers.every((header) => header.get("authorization") === `Bearer ${token}`)).toBe(
        true,
      );
      expect(JSON.stringify(records)).not.toContain(token);
      expect(JSON.stringify(result)).not.toContain(token);
      expect(JSON.stringify(records)).toContain("[REDACTED TOKEN]");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  it("retains 401 as an authentication blocker without leaking the token or dispatching a start", async () => {
    const originalFetch = globalThis.fetch;
    const token = "expired-hosted-test-secret";
    const records: unknown[] = [];
    const methods: string[] = [];
    globalThis.fetch = async (_url, options) => {
      methods.push(JSON.parse(String(options?.body)).method);
      return new Response(`Do not record ${token}`, { status: 401 });
    };
    try {
      await expect(
        makePublicTransport(
          "https://builder.example.test/mcp",
          (entry) => {
            records.push(entry);
          },
          1000,
          { bearerToken: token },
        ),
      ).rejects.toThrow("Public MCP HTTP 401");
      expect(methods).toEqual(["initialize"]);
      expect(JSON.stringify(records)).not.toContain(token);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  it("redacts tokens from transport errors before the CLI can retain them", async () => {
    const originalFetch = globalThis.fetch;
    const token = "hosted-error-test-secret";
    globalThis.fetch = async () => {
      throw new Error(`Failure echoed ${token}`);
    };
    try {
      await expect(
        makePublicTransport("https://builder.example.test/mcp", () => {}, 1000, {
          bearerToken: token,
        }),
      ).rejects.toThrow("Failure echoed [REDACTED TOKEN]");
    } finally {
      globalThis.fetch = originalFetch;
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
