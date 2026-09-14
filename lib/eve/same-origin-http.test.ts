import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { hostedEveOperationScopes } from "./hosted-auth";
import type { HostedPrincipal } from "./hosted-auth";
import { createSameOriginEveTransport } from "./same-origin-http";
import type { HostedWorkloadIdentity } from "./same-origin-http";
import {
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
function accepted(sessionId = "wrun_1") {
  return Response.json(
    { ok: true, sessionId, status: "accepted" },
    { headers: { "x-eve-session-id": sessionId }, status: 202 },
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function stream(
  events: unknown[] = [
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
      "x-eve-stream-version": "23",
    },
    status: 200,
  });
}

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

// Keep event fixture construction scoped to this test.
// oxlint-disable-next-line unicorn/consistent-function-scoping
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function plannedEvents() {
  const callId = "call_plan";
  const appSpecDigest = "a".repeat(64);
  const existingAppChanges = [
    {
      content: "export default function Page() { return 'Ready'; }\n",
      path: "apps/vendor-onboarding/app/page.tsx",
    },
  ];
  // Keep fixture hashing local to the planned event factory.
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const target = {
    blockers: [],
    contract: {
      appId: "vendor-onboarding",
      appSpec: {
        path: "prototype/vendor-onboarding/app-spec.md",
        sha256: appSpecDigest,
      },
      version: 1,
    },
    futurePath: "apps/vendor-onboarding/app.contract.json",
    iteration: {
      changes: existingAppChanges.map(({ path, content }) => ({
        after: { content, digest: hash(content), mode: "644" },
        before: { digest: hash(`before:${path}`), mode: "644" },
        path,
      })),
      digest: hash(
        JSON.stringify(
          existingAppChanges.map(({ path, content }) => ({
            after: { content, digest: hash(content), mode: "644" },
            before: { digest: hash(`before:${path}`), mode: "644" },
            path,
          })),
        ),
      ),
    },
    mutations: [],
    operation: "iterate-existing-app",
    plan: {
      product: {
        appSpec: {
          path: "prototype/vendor-onboarding/app-spec.md",
          sha256: appSpecDigest,
        },
        optionalCapabilities: { hostedResources: [], integrations: [] },
        owner: "operations",
      },
      source: {
        packageName: "@autograph/vendor-onboarding",
        runtime: "nextjs",
        schema: { kind: "none" },
        workspacePath: "apps/vendor-onboarding",
      },
      topology: {
        configPath: "microfrontends.json",
        packageName: "@autograph/vendor-onboarding",
        projectName: "apps-vendor-onboarding",
        routes: ["/vendor-onboarding", "/vendor-onboarding/:path*"],
      },
    },
  };
  const unsigned = {
    appSpecDigest,
    artifactRevision: "7".repeat(64),
    contractDigest: hash(JSON.stringify(target.contract)),
    dependencyCacheDigest: `sha256:${"6".repeat(64)}`,
    eligibilityDigest: "3".repeat(64),
    identityDigest: "8".repeat(64),
    imageDigest: `vercel-sandbox-seed@sha256:${"5".repeat(64)}`,
    plannedByCallId: callId,
    sourceReceiptDigest: "0".repeat(64),
    sourceSha: "1".repeat(40),
    sourceTree: "2".repeat(40),
    target,
    version: 1,
    workspaceDigest: "4".repeat(64),
  };
  return [
    {
      data: {
        actions: [
          {
            callId,
            input: {
              existingAppChanges,
              expectedAppSpecDigest: appSpecDigest,
            },
            kind: "tool-call",
            toolName: "plan_app_creation",
          },
        ],
      },
      type: "actions.requested",
    },
    {
      data: {
        result: {
          callId,
          kind: "tool-result",
          output: {
            ...unsigned,
            digest: hash(JSON.stringify(unsigned)),
            reused: false,
          },
          toolName: "plan_app_creation",
        },
        status: "completed",
      },
      type: "action.result",
    },
  ];
}

describe("same-origin canonical Eve transport", () => {
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
  it("carries a verified target plan without projecting raw planning output", async () => {
    const events = [...plannedEvents(), { data: {}, type: "session.completed" }];
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
    expect(snapshot.implementationPlan).toEqual({
      appId: "vendor-onboarding",
      packageName: "@autograph/vendor-onboarding",
      projectName: "apps-vendor-onboarding",
      readOnly: true,
      routes: ["/vendor-onboarding", "/vendor-onboarding/:path*"],
      runtime: "nextjs",
    });
    expect(JSON.stringify(snapshot.events)).not.toContain("proposalDigest");
    expect(snapshot.events).toEqual([{ index: 0, status: "completed", type: "status" }]);
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

  it("uses fresh project OIDC and canonical create/stream routes", async () => {
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
        events: [{ index: 0, status: "waiting", type: "status" }],
        status: "waiting",
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
        return stream(streamReads < 3 ? pending : settled);
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
    expect(streamReads).toBe(3);
  });

  it("keeps an accepted but unsettled input response non-replayable", async () => {
    const requestId = "aitxt-0oQwVrjWKWZWGigsWFL0FUqy";
    let streamReads = 0;
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const fetchImplementation = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes("/stream?")) {
        streamReads += 1;
        return stream(pendingApprovalEvents(requestId));
      }
      return accepted();
    });

    await expect(
      createSameOriginEveTransport({
        config,
        fetchImplementation,
        workloadIdentity: identity(),
      }).respond({
        adapterSessionId: "wrun_1",
        operationId: "op_respond_unsettled",
        principal,
        responses: [{ requestId, response: { kind: "deny" } }],
      }),
    ).rejects.toBeInstanceOf(SubmissionOutcomeUnknownError);
    expect(streamReads).toBe(8);
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
      return stream(streamReads < 3 ? active : settled);
    });
    await expect(
      createSameOriginEveTransport({
        config,
        fetchImplementation,
        workloadIdentity: identity(),
      }).cancel({ adapterSessionId: "wrun_1", principal }),
    ).resolves.toMatchObject({ status: "waiting" });
  });

  it("does not accept stale or historical cancellation and times out honestly", async () => {
    const historical = [
      { data: { turnId: "turn_old" }, type: "turn.cancelled" },
      { data: {}, type: "session.waiting" },
      { data: { turnId: "turn_new" }, type: "step.started" },
    ];
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const fetchImplementation = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/cancel")
        ? Response.json({ ok: true, sessionId: "wrun_1", status: "accepted" }, { status: 202 })
        : stream(historical),
    );
    await expect(
      createSameOriginEveTransport({
        config,
        fetchImplementation,
        workloadIdentity: identity(),
      }).cancel({ adapterSessionId: "wrun_1", principal }),
    ).rejects.toMatchObject({ name: "HostedCancellationUnsettledError" });
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
              "x-eve-stream-version": "23",
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
