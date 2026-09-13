/* eslint-disable eslint/no-await-in-loop -- Sequential batch cases preserve isolated fake state. */
/* eslint-disable eslint/require-await -- Async transport fakes implement the network interface. */
import { describe, expect, it } from "vitest";
import { makePublicTransport, runPublicSession } from "../evals/support/self-reproduction-public";
import type { PublicState } from "../evals/support/self-reproduction-public";

const session = (
  status: "working" | "completed" | "input_required",
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
            if (name === "autograph_respond") throw new Error("connection lost");
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
});
