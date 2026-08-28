import { describe, expect, it, vi } from "vitest";

import { hostedEveOperationScopes, type HostedPrincipal } from "./hosted-auth";
import {
  createSameOriginEveTransport,
  type HostedWorkloadIdentity,
} from "./same-origin-http";
import {
  SubmissionOutcomeUnknownError,
  SubmissionRejectedBeforeDispatchError,
} from "./hosted-service";

const principal: HostedPrincipal = {
  issuer: "https://identity.example.test",
  audience: "eve-hosted",
  workspaceId: "workspace_1",
  ownerUserId: "user_1",
  scopes: ["autograph:session", ...Object.values(hostedEveOperationScopes)],
};

const config = { baseUrl: "https://builder.example.test" };

function identity(token = "project-oidc-token"): HostedWorkloadIdentity {
  return { token: vi.fn(async () => token) };
}

function accepted(sessionId = "wrun_1") {
  return Response.json(
    { ok: true, sessionId, status: "accepted" },
    { status: 202, headers: { "x-eve-session-id": sessionId } },
  );
}

function stream(
  events: unknown[] = [
    {
      type: "session.waiting",
      data: {},
      meta: { at: 1, id: "evt_1" },
    },
  ],
) {
  return new Response(
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "x-eve-session-id": "wrun_1",
        "x-eve-stream-format": "ndjson",
        "x-eve-stream-tail-index": String(events.length - 1),
        "x-eve-stream-version": "23",
      },
    },
  );
}

describe("same-origin canonical Eve transport", () => {
  it("uses fresh project OIDC and canonical create/stream routes", async () => {
    const workloadIdentity = identity();
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const headers = new Headers(init?.headers);
      expect(init?.redirect).toBe("manual");
      expect(headers.get("authorization")).toBe("Bearer project-oidc-token");
      expect(headers.get("x-vercel-trusted-oidc-idp-token")).toBe(
        "project-oidc-token",
      );
      if (String(url).includes("/stream?")) return stream();
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        message: "Build",
        operationId: "op_1",
        forwardedPrincipal: {
          current: {
            authenticator: "mcp-oauth-jwks",
            issuer: principal.issuer,
            principalId: principal.ownerUserId,
            principalType: "user",
            subject: principal.ownerUserId,
            attributes: { "mcp:workspace-id": principal.workspaceId },
          },
        },
      });
      return accepted();
    });
    const transport = createSameOriginEveTransport({
      config,
      workloadIdentity,
      fetchImplementation,
    });

    await expect(
      transport.start({ principal, operationId: "op_1", prompt: "Build" }),
    ).resolves.toEqual({
      adapterSessionId: "wrun_1",
      snapshot: {
        status: "waiting",
        events: [{ index: 0, status: "waiting", type: "status" }],
      },
    });
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe(
      "https://builder.example.test/eve/v1/session",
    );
    expect(fetchImplementation.mock.calls[1]?.[0]).toBe(
      "https://builder.example.test/eve/v1/session/wrun_1/stream?startIndex=0&includeTailIndex=1",
    );
    expect(workloadIdentity.token).toHaveBeenCalledTimes(2);
  });

  it("uses canonical continuation and inputResponses bodies", async () => {
    const bodies: unknown[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes("/stream?")) return stream();
      bodies.push(JSON.parse(String(init?.body)));
      return accepted();
    });
    const transport = createSameOriginEveTransport({
      config,
      workloadIdentity: identity(),
      fetchImplementation,
    });

    await transport.send({
      principal,
      operationId: "op_send",
      adapterSessionId: "wrun_1",
      message: "Continue",
    });
    await transport.respond({
      principal,
      operationId: "op_respond",
      adapterSessionId: "wrun_1",
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
        { requestId: "req_1", optionId: "cancel" },
        { requestId: "req_2", optionId: "approve" },
        { requestId: "req_3", text: "Choice" },
      ],
    });
    expect(bodies).toHaveLength(2);
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe(
      "https://builder.example.test/eve/v1/session/wrun_1",
    );
  });

  it("waits for a new guarded cancel and waiting boundary", async () => {
    const active = [{ type: "step.started", data: { turnId: "turn_1" } }];
    const settled = [
      ...active,
      { type: "turn.cancelled", data: { turnId: "turn_1" } },
      { type: "session.waiting", data: {} },
    ];
    let streamReads = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/cancel")) {
        expect(JSON.parse(String(init?.body))).toEqual({ turnId: "turn_1" });
        return Response.json(
          { ok: true, sessionId: "wrun_1", status: "accepted" },
          { status: 202 },
        );
      }
      streamReads += 1;
      return stream(streamReads < 3 ? active : settled);
    });
    await expect(
      createSameOriginEveTransport({
        config,
        workloadIdentity: identity(),
        fetchImplementation,
      }).cancel({ principal, adapterSessionId: "wrun_1" }),
    ).resolves.toMatchObject({ status: "waiting" });
  });

  it("does not accept stale or historical cancellation and times out honestly", async () => {
    const historical = [
      { type: "turn.cancelled", data: { turnId: "turn_old" } },
      { type: "session.waiting", data: {} },
      { type: "step.started", data: { turnId: "turn_new" } },
    ];
    const fetchImplementation = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/cancel")
        ? Response.json(
            { ok: true, sessionId: "wrun_1", status: "accepted" },
            { status: 202 },
          )
        : stream(historical),
    );
    await expect(
      createSameOriginEveTransport({
        config,
        workloadIdentity: identity(),
        fetchImplementation,
      }).cancel({ principal, adapterSessionId: "wrun_1" }),
    ).rejects.toMatchObject({ name: "HostedCancellationUnsettledError" });
  });

  it("rejects a stale guarded turn and keeps no-active-turn observational", async () => {
    const active = [{ type: "step.started", data: { turnId: "turn_new" } }];
    const staleGuardFetch = vi.fn<typeof fetch>(async () => stream(active));
    await expect(
      createSameOriginEveTransport({
        config,
        workloadIdentity: identity(),
        fetchImplementation: staleGuardFetch,
      }).cancel({
        principal,
        adapterSessionId: "wrun_1",
        turnId: "turn_old",
      }),
    ).rejects.toMatchObject({ code: "turn_changed" });
    expect(staleGuardFetch).toHaveBeenCalledTimes(1);

    const waiting = [{ type: "session.waiting", data: {} }];
    const noActiveFetch = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/cancel")
        ? Response.json({ ok: true, status: "no_active_turn" })
        : stream(waiting),
    );
    await expect(
      createSameOriginEveTransport({
        config,
        workloadIdentity: identity(),
        fetchImplementation: noActiveFetch,
      }).cancel({ principal, adapterSessionId: "wrun_1" }),
    ).resolves.toMatchObject({ status: "waiting" });
  });

  it("rejects inconsistent canonical cancellation replies", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/cancel")
        ? Response.json({ ok: true, status: "no_active_turn" }, { status: 202 })
        : stream([{ type: "step.started", data: { turnId: "turn_1" } }]),
    );
    await expect(
      createSameOriginEveTransport({
        config,
        workloadIdentity: identity(),
        fetchImplementation,
      }).cancel({ principal, adapterSessionId: "wrun_1" }),
    ).rejects.toThrow("status was inconsistent");
  });

  it("separates pre-dispatch identity rejection from uncertain fetch failure", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    await expect(
      createSameOriginEveTransport({
        config,
        workloadIdentity: {
          token: async () => {
            throw new Error("unavailable");
          },
        },
        fetchImplementation,
      }).start({ principal, operationId: "op_1", prompt: "Build" }),
    ).rejects.toBeInstanceOf(SubmissionRejectedBeforeDispatchError);
    expect(fetchImplementation).not.toHaveBeenCalled();

    await expect(
      createSameOriginEveTransport({
        config,
        workloadIdentity: identity(),
        fetchImplementation: vi.fn(async () => {
          throw new Error("connection lost");
        }),
      }).start({ principal, operationId: "op_1", prompt: "Build" }),
    ).rejects.toBeInstanceOf(SubmissionOutcomeUnknownError);
  });

  it("treats canonical 4xx rejection as pre-dispatch and other bad replies as uncertain", async () => {
    await expect(
      createSameOriginEveTransport({
        config,
        workloadIdentity: identity(),
        fetchImplementation: vi.fn(async () =>
          Response.json(
            { code: "session_not_active", error: "inactive", ok: false },
            { status: 409 },
          ),
        ),
      }).send({
        principal,
        operationId: "op_2",
        adapterSessionId: "wrun_1",
        message: "Continue",
      }),
    ).rejects.toMatchObject({
      name: SubmissionRejectedBeforeDispatchError.name,
      code: "session_not_active",
    });

    await expect(
      createSameOriginEveTransport({
        config,
        workloadIdentity: identity(),
        fetchImplementation: vi.fn(
          async () =>
            new Response(null, {
              status: 307,
              headers: { location: "https://attacker.example.test" },
            }),
        ),
      }).start({ principal, operationId: "op_3", prompt: "Build" }),
    ).rejects.toBeInstanceOf(SubmissionOutcomeUnknownError);
  });

  it("rejects non-origin configuration and oversized durable tails", async () => {
    expect(() =>
      createSameOriginEveTransport({
        config: { baseUrl: "https://user@example.test/path" },
        workloadIdentity: identity(),
      }),
    ).toThrow();

    const transport = createSameOriginEveTransport({
      config,
      workloadIdentity: identity(),
      fetchImplementation: vi.fn(
        async () =>
          new Response("", {
            status: 200,
            headers: {
              "content-type": "application/x-ndjson; charset=utf-8",
              "x-eve-session-id": "wrun_1",
              "x-eve-stream-format": "ndjson",
              "x-eve-stream-tail-index": "100000",
              "x-eve-stream-version": "23",
            },
          }),
      ),
    });
    await expect(
      transport.get({ principal, adapterSessionId: "wrun_1" }),
    ).rejects.toThrow("invalid durable stream tail");
  });

  it("rejects a stream that is not bound to the pinned Eve 0.43 protocol", async () => {
    for (const headers of [
      { "x-eve-session-id": "wrun_other" },
      { "x-eve-stream-format": "sse" },
      { "x-eve-stream-version": "24" },
    ]) {
      const response = stream();
      for (const [name, value] of Object.entries(headers)) {
        response.headers.set(name, value);
      }
      await expect(
        createSameOriginEveTransport({
          config,
          workloadIdentity: identity(),
          fetchImplementation: vi.fn(async () => response),
        }).get({ principal, adapterSessionId: "wrun_1" }),
      ).rejects.toThrow("incompatible stream contract");
    }
  });
});
