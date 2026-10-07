import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { hostedEveOperationScopes } from "./hosted-auth";
import type { HostedPrincipal } from "./hosted-auth";
import { HostedSessionReadTimeoutError } from "./hosted-session-read-timeout-error";
import {
  createSameOriginEveTransport,
  observeSameOriginEveStream,
  streamSameOriginEveEvents,
} from "./same-origin-http";
import type { HostedWorkloadIdentity } from "./same-origin-http";
import {
  HostedCancellationUnsettledError,
  SubmissionOutcomeUnknownError,
  SubmissionRejectedBeforeDispatchError,
} from "./hosted-service";

const principal: HostedPrincipal = {
  audience: "eve-hosted",
  issuer: "https://identity.example.test",
  ownerUserId: "user_1",
  scopes: ["autograph:session", ...Object.values(hostedEveOperationScopes)],
  workspaceId: "workspace_1",
};

const config = { baseUrl: "https://builder.example.test" };

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function identity(token = "project-oidc-token"): HostedWorkloadIdentity {
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  return { token: vi.fn(async () => token) };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function accepted(sessionId = "wrun_1", continuation = true) {
  const body = {
    ok: true,
    sessionId,
    status: "accepted",
  };
  return Response.json(continuation ? { ...body, deliveryId: "delivery_1" } : body, {
    headers: { "x-eve-session-id": sessionId },
    status: 202,
  });
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function stream(
  events: unknown[] = [
    { data: {}, type: "session.started" },
    {
      data: {},
      meta: { at: 1, id: "evt_1" },
      type: "session.waiting",
    },
  ],
) {
  return new Response(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "x-eve-session-id": "wrun_1",
      "x-eve-stream-format": "ndjson",
      "x-eve-stream-tail-index": String(events.length - 1),
      "x-eve-stream-version": "25",
    },
    status: 200,
  });
}

describe("incremental canonical Eve stream", () => {
  it("exposes observation only with tenant verification and fetches only after authorization", async () => {
    // oxlint-disable-next-line eslint/require-await -- The fetch double follows the async fetch contract.
    const fetchImplementation = vi.fn(async () => stream());
    const verifyReadAuthority = vi.fn(
      // oxlint-disable-next-line eslint/require-await -- Authorization callback follows the async store contract.
      async ({
        principal: candidate,
        sessionId,
        adapterSessionId,
      }: {
        principal: HostedPrincipal;
        sessionId: string;
        adapterSessionId: string;
      }) =>
        candidate.workspaceId === principal.workspaceId &&
        sessionId === "session_1" &&
        adapterSessionId === "wrun_1",
    );
    const withoutAuthority = createSameOriginEveTransport({
      config,
      fetchImplementation,
      workloadIdentity: identity(),
    });
    expect(withoutAuthority.observe).toBeUndefined();
    const transport = createSameOriginEveTransport({
      config,
      fetchImplementation,
      verifyReadAuthority,
      workloadIdentity: identity(),
    });
    await expect(
      transport.observe?.({
        adapterSessionId: "wrun_1",
        onEvent() {},
        principal: { ...principal, workspaceId: "other_workspace" },
        sessionId: "session_1",
      }),
    ).rejects.toBeInstanceOf(SubmissionRejectedBeforeDispatchError);
    await expect(
      transport.observe?.({
        adapterSessionId: "wrong_adapter",
        onEvent() {},
        principal,
        sessionId: "session_1",
      }),
    ).rejects.toBeInstanceOf(SubmissionRejectedBeforeDispatchError);
    expect(fetchImplementation).not.toHaveBeenCalled();
    await transport.observe?.({
      adapterSessionId: "wrun_1",
      onEvent() {},
      principal,
      sessionId: "session_1",
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("projects dense events and tracks only unresolved requests", async () => {
    const projected: { index: number; type: string }[] = [];
    const events = [
      { data: { turnId: "turn_1" }, type: "step.started" },
      {
        data: {
          requests: [
            {
              action: { input: {}, kind: "tool-call", toolName: "resolve-github-source" },
              kind: "tool-approval",
              prompt: "Approve source",
              requestId: "request_1",
            },
          ],
        },
        type: "input.requested",
      },
      { data: { resolutions: [{ requestId: "request_1" }] }, type: "input.resolved" },
      { data: {}, type: "session.waiting" },
    ];
    const observed = await observeSameOriginEveStream({
      config: { ...config, timeoutMs: 10_000 },
      // oxlint-disable-next-line eslint/require-await -- The fetch double follows the async fetch contract.
      fetchImplementation: vi.fn(async () => stream(events)),
      onEvent(event) {
        projected.push({ index: event.index, type: event.type });
      },
      sessionId: "wrun_1",
      workloadIdentity: identity(),
    });
    expect(projected.map(({ index }) => index)).toEqual(projected.map((_, index) => index));
    expect(observed).toMatchObject({
      artifactProjectionRequiresLegacyReadback: false,
      installedEventCount: events.length,
      pendingRequests: [],
      publicEventCount: projected.length,
      status: "waiting",
    });
  });

  it("delivers raw Eve events to the private observer without changing public projection", async () => {
    const privateEvents: { type: string; data: unknown }[] = [];
    const events = [
      {
        data: {
          requests: [
            {
              action: {
                callId: "private_call",
                input: { planDigest: "private" },
                kind: "tool-call",
                toolName: "prepare-app-hosted-runtime",
              },
              kind: "tool-approval",
              prompt: "Approve runtime preparation",
              requestId: "private_request",
            },
          ],
          sequence: 4,
          stepIndex: 1,
          turnId: "turn_1",
        },
        meta: { at: "2026-10-06T00:00:00.000Z", id: "private_input" },
        type: "input.requested",
      },
      {
        data: {
          outcome: "approved",
          requestId: "private_request",
          responderPrincipalId: "owner_1",
          sequence: 5,
          stepIndex: 1,
          turnId: "turn_1",
        },
        meta: { at: "2026-10-06T00:00:01.000Z", id: "private_settlement" },
        type: "approval.settled",
      },
    ];
    const projected: { type: string }[] = [];
    await observeSameOriginEveStream({
      config: { ...config, timeoutMs: 10_000 },
      // oxlint-disable-next-line eslint/require-await -- The fetch double follows the async fetch contract.
      fetchImplementation: vi.fn(async () => stream(events)),
      onEvent(event) {
        projected.push({ type: event.type });
      },
      onPrivateEvent(event) {
        privateEvents.push({ data: "data" in event ? event.data : undefined, type: event.type });
      },
      sessionId: "wrun_1",
      workloadIdentity: identity(),
    });
    expect(privateEvents.map(({ type }) => type)).toEqual([
      "input.requested",
      "approval.settled",
    ]);
    expect(JSON.stringify(projected)).not.toContain("private_call");
    expect(JSON.stringify(projected)).not.toContain("private_request");
  });

  it("flags prototype receipts for the verified artifact readback path", async () => {
    const observed = await observeSameOriginEveStream({
      config: { ...config, timeoutMs: 10_000 },
      // oxlint-disable-next-line eslint/require-await -- The fetch double follows the async fetch contract.
      fetchImplementation: vi.fn(async () =>
        stream([
          {
            data: {
              actions: [
                {
                  callId: "call_1",
                  input: {},
                  kind: "tool-call",
                  toolName: "record_prototype_artifact",
                },
              ],
            },
            type: "actions.requested",
          },
        ]),
      ),
      onEvent() {},
      sessionId: "wrun_1",
      workloadIdentity: identity(),
    });
    expect(observed.artifactProjectionRequiresLegacyReadback).toBe(true);
  });

  it("keeps verified v2 artifact, UI-preview, and chunk reads on paged history", async () => {
    const content = "<html>Review</html>";
    const path = "prototype/spend-review/index.html";
    const digest = createHash("sha256").update(content).digest("hex");
    const revision = createHash("sha256")
      .update(JSON.stringify({ digest, mediaType: "text/html", path }))
      .digest("hex");
    const v2Artifact = [
      {
        data: {
          actions: [
            {
              callId: "artifact",
              input: { content, mediaType: "text/html", path },
              kind: "tool-call",
              toolName: "record_prototype_artifact",
            },
          ],
        },
        type: "actions.requested",
      },
      {
        data: {
          result: {
            callId: "artifact",
            kind: "tool-result",
            output: {
              appId: "spend-review",
              chunkCount: 1,
              complete: true,
              contentBytes: Buffer.byteLength(content),
              digest,
              mediaType: "text/html",
              path,
              recordedByCallId: "artifact",
              revision,
              sessionId: "wrun_1",
              version: 2,
            },
            toolName: "record_prototype_artifact",
          },
          status: "completed",
        },
        type: "action.result",
      },
    ];
    const v2Read = [
      {
        data: {
          actions: [
            {
              callId: "read",
              input: { digest, offsetBytes: 0, path, revision },
              kind: "tool-call",
              toolName: "get_prototype_artifact",
            },
          ],
        },
        type: "actions.requested",
      },
      {
        data: {
          result: {
            callId: "read",
            kind: "tool-result",
            output: {
              byteOffset: 0,
              chunkDigest: digest,
              complete: true,
              content,
              digest,
              mediaType: "text/html",
              nextOffsetBytes: Buffer.byteLength(content),
              path,
              revision,
              totalBytes: Buffer.byteLength(content),
            },
            toolName: "get_prototype_artifact",
          },
          status: "completed",
        },
        type: "action.result",
      },
    ];
    const v2UiPreview = [
      {
        data: {
          actions: [
            {
              callId: "preview",
              input: { appId: "spend-review", sourceFiles: [] },
              kind: "tool-call",
              toolName: "record_ui_preview",
            },
          ],
        },
        type: "actions.requested",
      },
      {
        data: {
          result: {
            callId: "preview",
            kind: "tool-result",
            output: {
              appId: "spend-review",
              artifactDigest: digest,
              artifactRevision: revision,
              chunkCount: 1,
              complete: true,
              contentBytes: Buffer.byteLength(content),
              digest,
              fidelity: "arrusted-component-catalog",
              functionality: "fixtures-only",
              mediaType: "text/html",
              path,
              recordedByCallId: "preview",
              requiresChunkedRead: true,
              revision: "a".repeat(64),
              routes: ["/"],
              sessionId: "wrun_1",
              version: 2,
            },
            toolName: "record_ui_preview",
          },
          status: "completed",
        },
        type: "action.result",
      },
    ];
    const v1Request = {
      data: {
        actions: [
          {
            callId: "legacy",
            input: { content, mediaType: "text/html", path },
            kind: "tool-call",
            toolName: "record_prototype_artifact",
          },
        ],
      },
      type: "actions.requested",
    };
    const markdown = "# Spend Review";
    const markdownPath = "prototype/spend-review/app-spec.md";
    const markdownDigest = createHash("sha256").update(markdown).digest("hex");
    const v1Markdown = [
      {
        data: {
          actions: [
            {
              callId: "app-spec",
              input: { content: markdown, mediaType: "text/markdown", path: markdownPath },
              kind: "tool-call",
              toolName: "record_prototype_artifact",
            },
          ],
        },
        type: "actions.requested",
      },
      {
        data: {
          result: {
            callId: "app-spec",
            kind: "tool-result",
            output: {
              appId: "spend-review",
              digest: markdownDigest,
              mediaType: "text/markdown",
              path: markdownPath,
              recordedByCallId: "app-spec",
              reused: false,
              revision: createHash("sha256")
                .update(
                  JSON.stringify({
                    digest: markdownDigest,
                    mediaType: "text/markdown",
                    path: markdownPath,
                  }),
                )
                .digest("hex"),
              sessionId: "wrun_1",
              size: Buffer.byteLength(markdown),
            },
            toolName: "record_prototype_artifact",
          },
          status: "completed",
        },
        type: "action.result",
      },
    ];
    const observe = async (events: unknown[]) =>
      await observeSameOriginEveStream({
        config: { ...config, timeoutMs: 10_000 },
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double.
        fetchImplementation: vi.fn(async () => stream(events)),
        onEvent() {},
        sessionId: "wrun_1",
        workloadIdentity: identity(),
      });
    const v2Observed = await observe([...v2Artifact, ...v2Read, ...v2UiPreview]);
    expect(v2Observed.artifactProjectionRequiresLegacyReadback).toBe(false);
    expect(v2Observed.prototypeRef).toMatchObject({ digest, path, version: 2 });
    const mixedMarkdownObserved = await observe([...v1Markdown, ...v2Artifact, ...v2UiPreview]);
    expect(mixedMarkdownObserved.artifactProjectionRequiresLegacyReadback).toBe(false);
    const legacyObserved = await observe([
      v1Request,
      {
        data: {
          result: {
            callId: "legacy",
            kind: "tool-result",
            output: {
              appId: "spend-review",
              digest,
              mediaType: "text/html",
              path,
              recordedByCallId: "legacy",
              reused: false,
              revision,
              sessionId: "wrun_1",
              size: Buffer.byteLength(content),
            },
            toolName: "record_prototype_artifact",
          },
          status: "completed",
        },
        type: "action.result",
      },
    ]);
    expect(legacyObserved.artifactProjectionRequiresLegacyReadback).toBe(true);
    expect(legacyObserved.prototype).toMatchObject({ content, digest, path });
    const partialV2 = [
      {
        data: {
          actions: [
            {
              callId: "partial",
              input: { content: "<html>", expectedDigest: digest, finalChunk: false, path },
              kind: "tool-call",
              toolName: "record_prototype_artifact",
            },
          ],
        },
        type: "actions.requested",
      },
      {
        data: {
          result: {
            callId: "partial",
            kind: "tool-result",
            output: { complete: false, path, version: 2 },
            toolName: "record_prototype_artifact",
          },
          status: "completed",
        },
        type: "action.result",
      },
    ];
    const incompleteObserved = await observe(partialV2);
    expect(incompleteObserved.artifactProjectionRequiresLegacyReadback).toBe(true);
    const completedAfterPartial = await observe([...partialV2, ...v2Artifact]);
    expect(completedAfterPartial.artifactProjectionRequiresLegacyReadback).toBe(false);
    const pendingObserved = await observe([...v2Artifact, ...v2Read, ...v2UiPreview, v1Request]);
    expect(pendingObserved.artifactProjectionRequiresLegacyReadback).toBe(true);
    const mixedObserved = await observe([
      ...v2Artifact,
      ...v2Read,
      v1Request,
      {
        data: {
          result: {
            callId: "legacy",
            kind: "tool-result",
            output: { version: 1 },
            toolName: "record_prototype_artifact",
          },
          status: "completed",
        },
        type: "action.result",
      },
    ]);
    expect(mixedObserved.artifactProjectionRequiresLegacyReadback).toBe(true);
  });

  it("consumes more than 100,000 events without retaining them in the transport", async () => {
    const total = 100_001;
    let produced = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const encoder = new TextEncoder();
        const lines: string[] = [];
        while (produced < total && lines.length < 128) {
          lines.push(JSON.stringify({ data: {}, type: "step.started" }));
          produced += 1;
        }
        if (lines.length > 0) {
          controller.enqueue(encoder.encode(`${lines.join("\n")}\n`));
        } else {
          controller.close();
        }
      },
    });
    const response = new Response(body, {
      headers: {
        "content-type": "application/x-ndjson",
        "x-eve-session-id": "wrun_1",
        "x-eve-stream-format": "ndjson",
        "x-eve-stream-tail-index": String(total - 1),
        "x-eve-stream-version": "25",
      },
      status: 200,
    });
    let observed = 0;
    for await (const event of streamSameOriginEveEvents({
      config: { ...config, timeoutMs: 10_000 },
      // oxlint-disable-next-line eslint/require-await -- The fetch double follows the async fetch contract.
      fetchImplementation: vi.fn(async () => response),
      sessionId: "wrun_1",
      workloadIdentity: identity(),
    })) {
      expect(event.type).toBe("step.started");
      observed += 1;
    }
    expect(observed).toBe(total);
  });
});

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function pendingApprovalEvents(requestId: string) {
  return [
    {
      data: {
        requests: [
          {
            action: {
              input: { repository: "withAutograph/arrusted-development" },
              kind: "tool-call",
              toolName: "resolve-github-source",
            },
            kind: "tool-approval",
            prompt: "Approve tool call: resolve-github-source",
            requestId,
          },
        ],
      },
      meta: { at: 1, id: "evt_input" },
      type: "input.requested",
    },
    {
      data: {},
      meta: { at: 2, id: "evt_waiting" },
      type: "session.waiting",
    },
  ];
}

describe("same-origin canonical Eve transport", () => {
  it("bounds both durable session reads and mutation requests", async () => {
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning fetch test double
    const fetchImplementation = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/stream?") ? stream() : accepted(),
    );
    const transport = createSameOriginEveTransport({
      config,
      fetchImplementation,
      workloadIdentity: identity(),
    });

    await transport.get({ adapterSessionId: "wrun_1", principal });
    expect(fetchImplementation.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);

    await transport.send({
      adapterSessionId: "wrun_1",
      message: "Continue",
      operationId: "send_1",
      principal,
    });
    expect(fetchImplementation.mock.calls[1]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(fetchImplementation.mock.calls[1]?.[1]?.signal?.aborted).toBe(false);
  });

  it("forwards the prepared reference on start and every mutating continuation without putting it in messages", async () => {
    const sourceHandoffId = "123e4567-e89b-42d3-a456-426614174001";
    const bodies: Record<string, unknown>[] = [];
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes("/stream?")) {
        return stream();
      }
      bodies.push(JSON.parse(String(init?.body)));
      return accepted();
    });
    const adapter = createSameOriginEveTransport({
      config,
      fetchImplementation,
      workloadIdentity: identity(),
    });
    await adapter.start({
      operationId: "start",
      principal,
      prompt: "Build",
      sourceHandoffId,
    });
    await adapter.send({
      adapterSessionId: "wrun_1",
      message: "Continue",
      operationId: "send",
      principal,
      sourceHandoffId,
    });
    await adapter.respond({
      adapterSessionId: "wrun_1",
      operationId: "respond",
      principal,
      responses: [],
      sourceHandoffId,
    });
    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      expect(body).toMatchObject({
        forwardedPrincipal: {
          current: {
            attributes: { "autograph:source-handoff-id": sourceHandoffId },
          },
        },
      });
      expect(body).not.toHaveProperty("sourceHandoffId");
      expect(String(body.message)).not.toContain(sourceHandoffId);
    }
  });
  it("carries verified prototype HTML without projecting raw action events", async () => {
    const content = "<!doctype html><html><body><button>Approve vendor</button></body></html>";
    const path = "prototype/vendor-onboarding/index.html";
    const mediaType = "text/html";
    const digest = createHash("sha256").update(content).digest("hex");
    const revision = createHash("sha256")
      .update(JSON.stringify({ digest, mediaType, path }))
      .digest("hex");
    const events = [
      {
        data: {
          actions: [
            {
              callId: "call_prototype",
              input: { content, mediaType, path },
              kind: "tool-call",
              toolName: "record_prototype_artifact",
            },
          ],
        },
        type: "actions.requested",
      },
      {
        data: {
          result: {
            callId: "call_prototype",
            kind: "tool-result",
            output: {
              appId: "vendor-onboarding",
              digest,
              mediaType,
              path,
              recordedByCallId: "call_prototype",
              reused: false,
              revision,
              sessionId: "wrun_1",
              size: Buffer.byteLength(content),
            },
            toolName: "record_prototype_artifact",
          },
          status: "completed",
        },
        type: "action.result",
      },
      { data: {}, type: "session.completed" },
    ];
    const transport = createSameOriginEveTransport({
      config,
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      fetchImplementation: vi.fn(async () => stream(events)),
      workloadIdentity: identity(),
    });

    const snapshot = await transport.get({
      adapterSessionId: "wrun_1",
      principal,
    });
    expect(snapshot.prototype).toEqual({
      content,
      digest,
      mediaType,
      path,
      revision,
    });
    expect(JSON.stringify(snapshot.events)).not.toContain(content);
    expect(snapshot.events).toEqual([{ index: 0, status: "completed", type: "status" }]);
  });

  it("confirms startup without waiting for the live turn boundary", async () => {
    const workloadIdentity = identity();
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const headers = new Headers(init?.headers);
      expect(init?.redirect).toBe("manual");
      expect(headers.get("authorization")).toBe("Bearer project-oidc-token");
      expect(headers.get("x-vercel-trusted-oidc-idp-token")).toBe("project-oidc-token");
      if (String(url).includes("/stream?")) {
        return stream();
      }
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        forwardedPrincipal: {
          current: {
            attributes: { "mcp:workspace-id": principal.workspaceId },
            authenticator: "mcp-oauth-jwks",
            issuer: principal.issuer,
            principalId: principal.ownerUserId,
            principalType: "user",
            subject: principal.ownerUserId,
          },
        },
        message: "Build",
        operationId: "op_1",
      });
      return accepted();
    });
    const transport = createSameOriginEveTransport({
      config,
      fetchImplementation,
      workloadIdentity,
    });

    await expect(
      transport.start({ operationId: "op_1", principal, prompt: "Build" }),
    ).resolves.toEqual({
      adapterSessionId: "wrun_1",
      snapshot: {
        events: [],
        status: "working",
      },
    });
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe(
      "https://builder.example.test/eve/v1/session",
    );
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(workloadIdentity.token).toHaveBeenCalledTimes(2);
    await expect(transport.get({ adapterSessionId: "wrun_1", principal })).resolves.toEqual({
      events: [{ index: 0, status: "waiting", type: "status" }],
      status: "waiting",
    });
    expect(fetchImplementation.mock.calls[2]?.[0]).toBe(
      "https://builder.example.test/eve/v1/session/wrun_1/stream?startIndex=0&includeTailIndex=1",
    );
  });

  it("keeps an unconfirmed create candidate uncertain without dispatching another create", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    // oxlint-disable-next-line eslint/require-await -- The fetch double follows the async fetch contract.
    const fetchImplementation = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/stream?") ? stream([]) : accepted("wrun_1", false),
    );
    try {
      const transport = createSameOriginEveTransport({
        config,
        fetchImplementation,
        workloadIdentity: identity(),
      });
      const pending = transport.start({
        operationId: "op_hung_stream",
        principal,
        prompt: "Build",
      });
      const rejected = expect(pending).rejects.toBeInstanceOf(SubmissionOutcomeUnknownError);
      await vi.waitFor(() => {
        expect(fetchImplementation).toHaveBeenCalledTimes(2);
      });
      controller.abort();
      await rejected;
      expect(
        fetchImplementation.mock.calls.filter(([url]) => String(url).endsWith("/eve/v1/session")),
      ).toHaveLength(1);
    } finally {
      timeout.mockRestore();
    }
  });

  it("returns at the winning candidate's startup event while its turn stream remains open", async () => {
    const cancelled = vi.fn();
    const startup = new Response(
      new ReadableStream({
        cancel: cancelled,
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"data":{},"type":"session.started"}\n'));
        },
      }),
      {
        headers: {
          "content-type": "application/x-ndjson",
          "x-eve-session-id": "wrun_1",
          "x-eve-stream-format": "ndjson",
          "x-eve-stream-tail-index": "1",
          "x-eve-stream-version": "25",
        },
      },
    );
    // oxlint-disable-next-line eslint/require-await -- The fetch double follows the async fetch contract.
    const fetchImplementation = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/stream?") ? startup : accepted("wrun_1", false),
    );
    await expect(
      createSameOriginEveTransport({
        config,
        fetchImplementation,
        workloadIdentity: identity(),
      }).start({ operationId: "op_winner", principal, prompt: "Build" }),
    ).resolves.toMatchObject({ adapterSessionId: "wrun_1" });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("preserves the operation on an uncertain loser and resolves the owner on a later exact retry", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const createBodies: unknown[] = [];
    let retry = false;
    // oxlint-disable-next-line eslint/require-await -- The fetch double follows the async fetch contract.
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/eve/v1/session")) {
        createBodies.push(JSON.parse(String(init?.body)));
        return accepted(retry ? "wrun_owner" : "wrun_loser", false);
      }
      const response = stream(
        retry ? [{ data: {}, type: "session.started" }] : [{ data: {}, type: "session.completed" }],
      );
      response.headers.set("x-eve-session-id", retry ? "wrun_owner" : "wrun_loser");
      return response;
    });
    const transport = createSameOriginEveTransport({
      config,
      fetchImplementation,
      workloadIdentity: identity(),
    });
    const request = { operationId: "op_original", principal, prompt: "Build" };
    try {
      const pending = transport.start(request);
      const rejected = expect(pending).rejects.toBeInstanceOf(SubmissionOutcomeUnknownError);
      await vi.waitFor(() => {
        expect(fetchImplementation).toHaveBeenCalledTimes(2);
      });
      controller.abort();
      await rejected;
      expect(createBodies).toHaveLength(1);
      timeout.mockRestore();
      retry = true;
      await expect(transport.start(request)).resolves.toMatchObject({
        adapterSessionId: "wrun_owner",
      });
      expect(createBodies).toHaveLength(2);
      expect(createBodies[1]).toEqual(createBodies[0]);
    } finally {
      timeout.mockRestore();
    }
  });

  it("aborts a stalled durable read and reports a retryable read timeout", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    try {
      const response = Promise.withResolvers<Response>();
      const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => {
        const signal = init?.signal;
        expect(signal).toBe(controller.signal);
        signal?.addEventListener("abort", () => {
          response.reject(new DOMException("Timed out", "TimeoutError"));
        });
        return await response.promise;
      });
      const transport = createSameOriginEveTransport({
        config,
        fetchImplementation,
        workloadIdentity: identity(),
      });
      const pending = transport.get({ adapterSessionId: "wrun_1", principal });
      await vi.waitFor(() => {
        expect(fetchImplementation).toHaveBeenCalledOnce();
      });
      controller.abort();
      await expect(pending).rejects.toBeInstanceOf(HostedSessionReadTimeoutError);
      expect(timeout).toHaveBeenCalledWith(30_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it("bounds a stream that sends headers but stalls before its durable tail", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    try {
      // oxlint-disable-next-line eslint/require-await -- Preserve the fetch promise contract in this test double.
      const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => {
        const body = new ReadableStream<Uint8Array>({
          start(streamController) {
            init?.signal?.addEventListener("abort", () => {
              streamController.error(new DOMException("Timed out", "TimeoutError"));
            });
          },
        });
        return new Response(body, {
          headers: {
            "content-type": "application/x-ndjson",
            "x-eve-session-id": "wrun_1",
            "x-eve-stream-format": "ndjson",
            "x-eve-stream-tail-index": "0",
            "x-eve-stream-version": "25",
          },
          status: 200,
        });
      });
      const transport = createSameOriginEveTransport({
        config,
        fetchImplementation,
        workloadIdentity: identity(),
      });
      const pending = transport.get({ adapterSessionId: "wrun_1", principal });
      await vi.waitFor(() => {
        expect(fetchImplementation).toHaveBeenCalledOnce();
      });
      controller.abort();
      await expect(pending).rejects.toBeInstanceOf(HostedSessionReadTimeoutError);
    } finally {
      timeout.mockRestore();
    }
  });

  it("returns the complete durable tail even if stream cancellation never settles", async () => {
    const cancellation = Promise.withResolvers<undefined>();
    const encoded = new TextEncoder().encode(
      `${JSON.stringify({ data: {}, meta: { at: 1, id: "evt_1" }, type: "session.waiting" })}\n`,
    );
    const fetchImplementation = vi.fn<typeof fetch>(
      // oxlint-disable-next-line eslint/require-await -- Preserve the fetch promise contract in this test double.
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async cancel() {
              await cancellation.promise;
            },
            start(controller) {
              controller.enqueue(encoded);
            },
          }),
          {
            headers: {
              "content-type": "application/x-ndjson",
              "x-eve-session-id": "wrun_1",
              "x-eve-stream-format": "ndjson",
              "x-eve-stream-tail-index": "0",
              "x-eve-stream-version": "25",
            },
            status: 200,
          },
        ),
    );
    const transport = createSameOriginEveTransport({
      config,
      fetchImplementation,
      workloadIdentity: identity(),
    });
    await expect(transport.get({ adapterSessionId: "wrun_1", principal })).resolves.toMatchObject({
      status: "waiting",
    });
  });

  it("bounds accepted response settlement so the caller can recover through a read", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    try {
      // oxlint-disable-next-line eslint/require-await -- Preserve the fetch promise contract in this test double.
      const fetchImplementation = vi.fn<typeof fetch>(async (url) =>
        String(url).includes("/stream?") ? stream(pendingApprovalEvents("approval_1")) : accepted(),
      );
      const transport = createSameOriginEveTransport({
        config,
        fetchImplementation,
        workloadIdentity: identity(),
      });
      const pending = transport.respond({
        adapterSessionId: "wrun_1",
        operationId: "op_respond",
        principal,
        responses: [{ requestId: "approval_1", response: { kind: "approve" } }],
      });
      await vi.waitFor(() => {
        expect(fetchImplementation).toHaveBeenCalledTimes(2);
      });
      controller.abort();
      await expect(pending).rejects.toBeInstanceOf(HostedSessionReadTimeoutError);
    } finally {
      timeout.mockRestore();
    }
  });

  it("uses canonical continuation and inputResponses bodies", async () => {
    const bodies: unknown[] = [];
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes("/stream?")) {
        return stream();
      }
      bodies.push(JSON.parse(String(init?.body)));
      return accepted();
    });
    const transport = createSameOriginEveTransport({
      config,
      fetchImplementation,
      workloadIdentity: identity(),
    });

    await transport.send({
      adapterSessionId: "wrun_1",
      message: "Continue",
      operationId: "op_send",
      principal,
    });
    await transport.respond({
      adapterSessionId: "wrun_1",
      operationId: "op_respond",
      principal,
      responses: [
        { requestId: "req_1", response: { kind: "deny" } },
        { requestId: "req_2", response: { kind: "approve" } },
        {
          requestId: "req_3",
          response: { kind: "answer", value: "Choice" },
        },
      ],
    });

    expect(bodies[0]).toMatchObject({
      message: "Continue",
      turnPolicy: "queue",
    });
    expect(bodies[1]).toMatchObject({
      inputResponses: [
        { optionId: "cancel", requestId: "req_1" },
        { optionId: "approve", requestId: "req_2" },
        { requestId: "req_3", text: "Choice" },
      ],
    });
    expect(bodies).toHaveLength(2);
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe(
      "https://builder.example.test/eve/v1/session/wrun_1",
    );
  });

  it("settles accepted mutations through the incremental reader", async () => {
    const requestId = "aitxt-0oQwVrjWKWZWGigsWFL0FUqy";
    const pending = pendingApprovalEvents(requestId);
    const settled = [
      ...pending,
      {
        data: { resolutions: [{ requestId }] },
        meta: { at: 3, id: "evt_resolved" },
        type: "input.resolved",
      },
    ];
    let streamReads = 0;
    // oxlint-disable-next-line eslint/require-await -- Preserve the fetch promise contract.
    const fetchImplementation = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes("/stream?")) {
        streamReads += 1;
        return stream(streamReads === 1 ? pending : settled);
      }
      return accepted();
    });
    const transport = createSameOriginEveTransport({
      config,
      fetchImplementation,
      workloadIdentity: identity(),
    });
    await expect(
      transport.sendAccepted?.({
        adapterSessionId: "wrun_1",
        message: "Continue",
        operationId: "op_send_accepted",
        principal,
      }),
    ).resolves.toBeUndefined();
    expect(streamReads).toBe(0);
    await expect(
      transport.respondAccepted?.({
        adapterSessionId: "wrun_1",
        operationId: "op_respond_accepted",
        principal,
        responses: [{ requestId, response: { kind: "approve" } }],
      }),
    ).resolves.toBeUndefined();
    expect(streamReads).toBe(2);
    expect(fetchImplementation).toHaveBeenCalledTimes(4);
  });

  it("waits for the exact accepted input response to settle", async () => {
    const requestId = "aitxt-0oQwVrjWKWZWGigsWFL0FUqy";
    const pending = pendingApprovalEvents(requestId);
    const settled = [
      ...pending,
      {
        data: { resolutions: [{ requestId }] },
        meta: { at: 3, id: "evt_resolved" },
        type: "input.resolved",
      },
    ];
    let streamReads = 0;
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes("/stream?")) {
        streamReads += 1;
        return stream(streamReads < 10 ? pending : settled);
      }
      expect(JSON.parse(String(init?.body))).toMatchObject({
        inputResponses: [{ optionId: "cancel", requestId }],
      });
      return accepted();
    });

    await expect(
      createSameOriginEveTransport({
        config,
        fetchImplementation,
        workloadIdentity: identity(),
      }).respond({
        adapterSessionId: "wrun_1",
        operationId: "op_respond_settlement",
        principal,
        responses: [{ requestId, response: { kind: "deny" } }],
      }),
    ).resolves.toMatchObject({ status: "waiting" });
    expect(streamReads).toBe(10);
  });

  it("waits for a new guarded cancel and waiting boundary", async () => {
    const active = [{ data: { turnId: "turn_1" }, type: "step.started" }];
    const settled = [
      ...active,
      { data: { turnId: "turn_1" }, type: "turn.cancelled" },
      { data: {}, type: "session.waiting" },
    ];
    let streamReads = 0;
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/cancel")) {
        expect(JSON.parse(String(init?.body))).toEqual({ turnId: "turn_1" });
        return Response.json(
          { ok: true, sessionId: "wrun_1", status: "accepted" },
          { status: 202 },
        );
      }
      streamReads += 1;
      return stream(streamReads < 10 ? active : settled);
    });
    await expect(
      createSameOriginEveTransport({
        config,
        fetchImplementation,
        workloadIdentity: identity(),
      }).cancel({ adapterSessionId: "wrun_1", principal }),
    ).resolves.toMatchObject({ status: "waiting" });
  });

  it("confirms a guarded cancellation through incremental reads", async () => {
    const active = [{ data: { turnId: "turn_1" }, type: "step.started" }];
    const settled = [
      ...active,
      { data: { turnId: "turn_1" }, type: "turn.cancelled" },
      { data: {}, type: "session.waiting" },
    ];
    let streamReads = 0;
    // oxlint-disable-next-line eslint/require-await -- Preserve the fetch promise contract.
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/cancel")) {
        expect(JSON.parse(String(init?.body))).toEqual({ turnId: "turn_1" });
        return Response.json(
          { ok: true, sessionId: "wrun_1", status: "accepted" },
          { status: 202 },
        );
      }
      streamReads += 1;
      return stream(streamReads === 1 ? active : settled);
    });
    const transport = createSameOriginEveTransport({
      config,
      fetchImplementation,
      workloadIdentity: identity(),
    });
    await expect(
      transport.cancelAccepted?.({ adapterSessionId: "wrun_1", principal, turnId: "turn_1" }),
    ).resolves.toBeUndefined();
    expect(streamReads).toBe(2);
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it("reports accepted cancellation as unsettled when its durable read times out", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    try {
      const active = [{ data: { turnId: "turn_1" }, type: "step.started" }];
      // oxlint-disable-next-line eslint/require-await -- Preserve the fetch promise contract.
      const fetchImplementation = vi.fn<typeof fetch>(async (url) =>
        String(url).endsWith("/cancel")
          ? Response.json({ ok: true, sessionId: "wrun_1", status: "accepted" }, { status: 202 })
          : stream(active),
      );
      const transport = createSameOriginEveTransport({
        config,
        fetchImplementation,
        workloadIdentity: identity(),
      });
      const cancellation = transport.cancelAccepted?.({
        adapterSessionId: "wrun_1",
        principal,
        turnId: "turn_1",
      });
      await vi.waitFor(() => {
        expect(fetchImplementation).toHaveBeenCalledTimes(3);
      });
      controller.abort();
      await expect(cancellation).rejects.toBeInstanceOf(HostedCancellationUnsettledError);
    } finally {
      timeout.mockRestore();
    }
  });

  it("waits beyond the former poll limit for the current cancellation receipt", async () => {
    const historical = [
      { data: { turnId: "turn_old" }, type: "turn.cancelled" },
      { data: {}, type: "session.waiting" },
      { data: { turnId: "turn_new" }, type: "step.started" },
    ];
    const settled = [
      ...historical,
      { data: { turnId: "turn_new" }, type: "turn.cancelled" },
      { data: {}, type: "session.waiting" },
    ];
    let streamReads = 0;
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const fetchImplementation = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/cancel")) {
        return Response.json(
          { ok: true, sessionId: "wrun_1", status: "accepted" },
          { status: 202 },
        );
      }
      streamReads += 1;
      return stream(streamReads < 10 ? historical : settled);
    });
    await expect(
      createSameOriginEveTransport({
        config,
        fetchImplementation,
        workloadIdentity: identity(),
      }).cancel({ adapterSessionId: "wrun_1", principal }),
    ).resolves.toMatchObject({ status: "waiting" });
    expect(streamReads).toBe(10);
  });

  it("rejects a stale guarded turn and keeps no-active-turn observational", async () => {
    const active = [{ data: { turnId: "turn_new" }, type: "step.started" }];
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const staleGuardFetch = vi.fn<typeof fetch>(async () => stream(active));
    await expect(
      createSameOriginEveTransport({
        config,
        fetchImplementation: staleGuardFetch,
        workloadIdentity: identity(),
      }).cancel({
        adapterSessionId: "wrun_1",
        principal,
        turnId: "turn_old",
      }),
    ).rejects.toMatchObject({ code: "turn_changed" });
    expect(staleGuardFetch).toHaveBeenCalledTimes(1);

    const waiting = [{ data: {}, type: "session.waiting" }];
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const noActiveGuardFetch = vi.fn<typeof fetch>(async () => stream(waiting));
    await expect(
      createSameOriginEveTransport({
        config,
        fetchImplementation: noActiveGuardFetch,
        workloadIdentity: identity(),
      }).cancel({
        adapterSessionId: "wrun_1",
        principal,
        turnId: "turn_0",
      }),
    ).rejects.toMatchObject({ code: "turn_changed" });
    expect(noActiveGuardFetch).toHaveBeenCalledTimes(1);

    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const noActiveFetch = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/cancel")
        ? Response.json({ ok: true, status: "no_active_turn" })
        : stream(waiting),
    );
    await expect(
      createSameOriginEveTransport({
        config,
        fetchImplementation: noActiveFetch,
        workloadIdentity: identity(),
      }).cancel({ adapterSessionId: "wrun_1", principal }),
    ).resolves.toMatchObject({ status: "waiting" });
  });

  it("rejects inconsistent canonical cancellation replies", async () => {
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const fetchImplementation = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/cancel")
        ? Response.json({ ok: true, status: "no_active_turn" }, { status: 202 })
        : stream([{ data: { turnId: "turn_1" }, type: "step.started" }]),
    );
    await expect(
      createSameOriginEveTransport({
        config,
        fetchImplementation,
        workloadIdentity: identity(),
      }).cancel({ adapterSessionId: "wrun_1", principal }),
    ).rejects.toThrow("status was inconsistent");
  });

  it("separates pre-dispatch identity rejection from uncertain fetch failure", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    await expect(
      createSameOriginEveTransport({
        config,
        fetchImplementation,
        workloadIdentity: {
          // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
          token: async () => {
            throw new Error("unavailable");
          },
        },
      }).start({ operationId: "op_1", principal, prompt: "Build" }),
    ).rejects.toBeInstanceOf(SubmissionRejectedBeforeDispatchError);
    expect(fetchImplementation).not.toHaveBeenCalled();

    await expect(
      createSameOriginEveTransport({
        config,
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        fetchImplementation: vi.fn(async () => {
          throw new Error("connection lost");
        }),
        workloadIdentity: identity(),
      }).start({ operationId: "op_1", principal, prompt: "Build" }),
    ).rejects.toBeInstanceOf(SubmissionOutcomeUnknownError);
  });

  it("treats canonical 4xx rejection as pre-dispatch and other bad replies as uncertain", async () => {
    await expect(
      createSameOriginEveTransport({
        config,
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        fetchImplementation: vi.fn(async () =>
          Response.json(
            { code: "session_not_active", error: "inactive", ok: false },
            { status: 409 },
          ),
        ),
        workloadIdentity: identity(),
      }).send({
        adapterSessionId: "wrun_1",
        message: "Continue",
        operationId: "op_2",
        principal,
      }),
    ).rejects.toMatchObject({
      code: "session_not_active",
      name: SubmissionRejectedBeforeDispatchError.name,
    });

    await expect(
      createSameOriginEveTransport({
        config,
        fetchImplementation: vi.fn(
          // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
          async () =>
            new Response(null, {
              headers: { location: "https://attacker.example.test" },
              status: 307,
            }),
        ),
        workloadIdentity: identity(),
      }).start({ operationId: "op_3", principal, prompt: "Build" }),
    ).rejects.toBeInstanceOf(SubmissionOutcomeUnknownError);
  });

  it.each([
    { ok: true, sessionId: "wrun_1", status: "accepted" },
    { deliveryId: "", ok: true, sessionId: "wrun_1", status: "accepted" },
    { deliveryId: 42, ok: true, sessionId: "wrun_1", status: "accepted" },
    {
      deliveryId: "delivery_1",
      extra: "unexpected",
      ok: true,
      sessionId: "wrun_1",
      status: "accepted",
    },
  ])("keeps malformed accepted continuation replies uncertain: %j", async (body) => {
    // oxlint-disable-next-line eslint/require-await -- The fetch double follows the async fetch contract.
    const fetchImplementation = vi.fn(async () => Response.json(body, { status: 202 }));
    const transport = createSameOriginEveTransport({
      config,
      fetchImplementation,
      workloadIdentity: identity(),
    });
    await expect(
      transport.sendAccepted?.({
        adapterSessionId: "wrun_1",
        message: "Continue",
        operationId: "op_2",
        principal,
      }),
    ).rejects.toBeInstanceOf(SubmissionOutcomeUnknownError);
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("accepts a create reply without a continuation delivery identity", async () => {
    // oxlint-disable-next-line eslint/require-await -- The fetch double follows the async fetch contract.
    const fetchImplementation = vi.fn(async (url) =>
      String(url).includes("/stream?") ? stream() : accepted("wrun_1", false),
    );
    await expect(
      createSameOriginEveTransport({
        config,
        fetchImplementation,
        workloadIdentity: identity(),
      }).start({ operationId: "op_create", principal, prompt: "Build" }),
    ).resolves.toMatchObject({
      adapterSessionId: "wrun_1",
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("reads generated-code histories larger than 2 MiB without exposing tool input", async () => {
    const generatedSource = "private-generated-source".repeat(140_000);
    const events = [
      {
        data: {
          actions: [
            {
              callId: "apply_1",
              input: {
                implementationFiles: [
                  {
                    content: generatedSource,
                    path: "apps/stock-exceptions/app/page.tsx",
                  },
                ],
              },
              kind: "tool-call",
              toolName: "apply_target_proposal",
            },
          ],
        },
        type: "actions.requested",
      },
      { data: {}, type: "session.waiting" },
    ];
    const transport = createSameOriginEveTransport({
      config,
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      fetchImplementation: vi.fn(async () => stream(events)),
      workloadIdentity: identity(),
    });
    const result = await transport.get({
      adapterSessionId: "wrun_1",
      principal,
    });
    expect(result.status).toBe("waiting");
    expect(JSON.stringify(result)).not.toContain("private-generated-source");
  });

  it("rejects non-origin configuration and invalid durable tail numbers", async () => {
    expect(() =>
      createSameOriginEveTransport({
        config: { baseUrl: "https://user@example.test/path" },
        workloadIdentity: identity(),
      }),
    ).toThrow();

    const transport = createSameOriginEveTransport({
      config,
      fetchImplementation: vi.fn(
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        async () =>
          new Response("", {
            headers: {
              "content-type": "application/x-ndjson; charset=utf-8",
              "x-eve-session-id": "wrun_1",
              "x-eve-stream-format": "ndjson",
              "x-eve-stream-tail-index": "9007199254740992",
              "x-eve-stream-version": "25",
            },
            status: 200,
          }),
      ),
      workloadIdentity: identity(),
    });
    await expect(transport.get({ adapterSessionId: "wrun_1", principal })).rejects.toThrow(
      "invalid durable stream tail",
    );
  });

  it("rejects a stream that is not bound to the pinned Eve 0.68 protocol", async () => {
    for (const headers of [
      { "x-eve-session-id": "wrun_other" },
      { "x-eve-stream-format": "sse" },
      { "x-eve-stream-version": "24" },
    ]) {
      const response = stream();
      for (const [name, value] of Object.entries(headers)) {
        response.headers.set(name, value);
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      await expect(
        createSameOriginEveTransport({
          config,
          // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
          fetchImplementation: vi.fn(async () => response),
          workloadIdentity: identity(),
        }).get({ adapterSessionId: "wrun_1", principal }),
      ).rejects.toThrow("incompatible stream contract");
    }
  });
});
