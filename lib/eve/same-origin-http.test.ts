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
  scopes: ["eve:session", ...Object.values(hostedEveOperationScopes)],
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
      requestId: "req_1",
      response: { kind: "deny" },
    });

    expect(bodies[0]).toMatchObject({
      message: "Continue",
      turnPolicy: "queue",
    });
    expect(bodies[1]).toMatchObject({
      inputResponses: [{ requestId: "req_1", optionId: "cancel" }],
    });
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe(
      "https://builder.example.test/eve/v1/session/wrun_1",
    );
  });

  it("accepts canonical 202 cancellation and rejects inconsistent cancellation replies", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/cancel")) {
        return Response.json(
          { ok: true, sessionId: "wrun_1", status: "accepted" },
          { status: 202 },
        );
      }
      return stream();
    });
    await expect(
      createSameOriginEveTransport({
        config,
        workloadIdentity: identity(),
        fetchImplementation,
      }).cancel({ principal, adapterSessionId: "wrun_1" }),
    ).resolves.toMatchObject({ status: "waiting" });

    await expect(
      createSameOriginEveTransport({
        config,
        workloadIdentity: identity(),
        fetchImplementation: vi.fn(async () =>
          Response.json(
            { ok: true, status: "no_active_turn" },
            { status: 202 },
          ),
        ),
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
