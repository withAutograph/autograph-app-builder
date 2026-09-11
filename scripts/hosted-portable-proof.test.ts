import { describe, expect, it } from "vitest";

import {
  hostedProofScenarioSchema,
  runHostedProof,
  verifiedDraftPrEvidence,
  verifyWorkspaceTokenPair,
} from "./hosted-portable-proof";
import { TOOL_NAMES } from "./portable-release";

const target = {
  appSpecDigest: "b".repeat(64),
  baseRef: "refs/heads/main",
  baseSha: "a".repeat(40),
  changeSetDigest: "c".repeat(64),
  headRef: "refs/heads/autograph/proof",
  proposalDigest: "d".repeat(64),
  repository: "withAutograph/proof-target",
  repositoryId: "1234",
};
const receipt = (phase: "appspec" | "change_set" | "publication") => ({
  baseRef: target.baseRef,
  baseSha: target.baseSha,
  format: "autograph-eve-approval-receipt-v2" as const,
  outcome:
    phase === "appspec"
      ? ("accept-appspec" as const)
      : phase === "change_set"
        ? ("accept-change-set" as const)
        : ("create-draft-pr" as const),
  phase,
  repository: target.repository,
  repositoryId: target.repositoryId,
  subjectDigest:
    phase === "appspec"
      ? target.appSpecDigest
      : phase === "change_set"
        ? target.changeSetDigest
        : target.proposalDigest,
});
const scenario = hostedProofScenarioSchema.parse({
  approvalReceipts: (["appspec", "change_set", "publication"] as const).map(
    (phase) => ({
      requestTitle: `Approve ${phase}`,
      receipt: receipt(phase),
      response: "approve",
    })
  ),
  cancelPrompt: "Begin a cancellable read-only design turn.",
  createPrompt: "Create a supported app and pause before publication.",
  format: "autograph-hosted-client-proof-scenario-v2",
  iterateMessage: "Iterate, validate, and publish the approved draft PR.",
  maxPolls: 8,
  oauth: {
    audience: "https://preview.autograph.dev/mcp",
    issuer: "https://issuer.autograph.dev",
    resource: "https://preview.autograph.dev/mcp",
  },
  pollIntervalMs: 100,
  questionResponses: [],
  target,
});

function jwt(subject: string, workspaceId: string) {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", kid: "proof" })}.${encode({
    aud: scenario.oauth.audience,
    exp: 2_100,
    iss: scenario.oauth.issuer,
    nbf: 1_900,
    scope:
      "autograph:session autograph:start autograph:get autograph:send autograph:respond autograph:cancel",
    sub: subject,
    workspace_id: workspaceId,
  })}.signature`;
}
const primaryToken = jwt("proof-user-primary", "workspace-primary");
const secondaryToken = jwt("proof-user-secondary", "workspace-secondary");

const rpc = (id: unknown, result: unknown, status = 200) =>
  new Response(
    status === 204
      ? undefined
      : JSON.stringify({
          jsonrpc: "2.0",
          ...(id === undefined ? {} : { id }),
          result,
        }),
    { headers: { "content-type": "application/json" }, status }
  );

function session(
  sessionId: string,
  status: "working" | "input_required" | "waiting" | "completed" | "cancelled",
  cursor: number,
  events: unknown[] = [],
  inputRequests?: unknown[]
) {
  return {
    cursor,
    events,
    sessionId,
    status,
    ...(inputRequests === undefined ? {} : { inputRequests }),
  };
}

function hostedFixture(
  options: {
    metadataResource?: string;
    approvalDigestDrift?: boolean;
    iterationStatus?: "completed" | "waiting";
    draftDigestDrift?: boolean;
    mutualDenial?: boolean;
    denialFailure?: {
      direction: "primary-reads-secondary" | "secondary-reads-primary";
      kind: "transport" | "http500" | "malformed";
    };
    discardedStartRetryDrift?: boolean;
  } = {}
) {
  const approved = new Set<string>();
  let createIterated = false;
  let cancelRequested = false;
  let primaryStartCount = 0;
  return async (urlInput: string | URL | Request, init?: RequestInit) => {
    const url = String(urlInput);
    if (url.endsWith("/.well-known/oauth-protected-resource")) {
      return Response.json({
        resource: options.metadataResource ?? scenario.oauth.resource,
        authorization_servers: [scenario.oauth.issuer],
        bearer_methods_supported: ["header"],
        scopes_supported: [
          "autograph:session",
          "autograph:start",
          "autograph:get",
          "autograph:send",
          "autograph:respond",
          "autograph:cancel",
        ],
      });
    }
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    if (
      authorization === null ||
      authorization === "Bearer invalid-hosted-proof-token"
    ) {
      return new Response("", {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer error="invalid_token", resource_metadata="https://preview.autograph.dev/.well-known/oauth-protected-resource"',
        },
      });
    }
    const secondary = authorization === `Bearer ${secondaryToken}`;
    const body = JSON.parse(String(init?.body));
    if (body.method === "initialize") {
      return rpc(body.id, {
        protocolVersion: "2025-03-26",
        capabilities: {},
        serverInfo: { name: "fixture", version: "1" },
      });
    }
    if (body.method === "notifications/initialized") {
      return new Response(undefined, { status: 202 });
    }
    if (body.method === "tools/list") {
      return rpc(body.id, { tools: TOOL_NAMES.map((name) => ({ name })) });
    }
    if (body.method !== "tools/call") {
      return new Response("", { status: 400 });
    }
    const name = body.params.name as string;
    const args = body.params.arguments as Record<string, unknown>;
    const tool = (structuredContent: unknown, isError = false) =>
      rpc(body.id, { isError, structuredContent });
    const denialFailure = (
      direction: "primary-reads-secondary" | "secondary-reads-primary"
    ) => {
      if (options.denialFailure?.direction !== direction) {
        return undefined;
      }
      if (options.denialFailure.kind === "transport") {
        throw new Error("fixture transport failure");
      }
      if (options.denialFailure.kind === "http500") {
        return new Response("", { status: 500 });
      }
      return rpc(body.id, {
        isError: "not-a-boolean",
        structuredContent: session(String(args.sessionId), "working", 0),
      });
    };
    if (name === "autograph_start") {
      if (!secondary) {
        primaryStartCount += 1;
      }
      return tool(
        session(
          secondary
            ? "secondary-session"
            : options.discardedStartRetryDrift && primaryStartCount === 1
              ? "discarded-session-a"
              : "primary-session",
          "working",
          0
        )
      );
    }
    if (name === "autograph_respond") {
      if (!Array.isArray(args.responses) || args.responses.length === 0) {
        return tool(session("primary-session", "working", 0), true);
      }
      for (const response of args.responses) {
        if (
          response === null ||
          typeof response !== "object" ||
          typeof (response as { requestId?: unknown }).requestId !== "string"
        ) {
          return tool(session("primary-session", "working", 0), true);
        }
        approved.add((response as { requestId: string }).requestId);
      }
      return tool(session("primary-session", "working", 0));
    }
    if (name === "autograph_send") {
      createIterated = true;
      return tool(session("primary-session", "working", 0));
    }
    if (name === "autograph_cancel") {
      cancelRequested = true;
      return tool(session("secondary-session", "working", 0));
    }
    if (
      name === "autograph_get" &&
      String(args.sessionId).startsWith("stale-")
    ) {
      return tool(session(String(args.sessionId), "working", 0), true);
    }
    if (name === "autograph_get" && args.sessionId === "secondary-session") {
      if (!secondary) {
        const failure = denialFailure("primary-reads-secondary");
        if (failure !== undefined) {
          return failure;
        }
        return options.mutualDenial === false
          ? tool(session("secondary-session", "working", 0))
          : tool(session("secondary-session", "working", 0), true);
      }
      return tool(
        session(
          "secondary-session",
          cancelRequested ? "cancelled" : "working",
          cancelRequested ? 1 : 0,
          cancelRequested
            ? [{ index: 0, status: "cancelled", type: "status" }]
            : []
        )
      );
    }
    if (name === "autograph_get" && args.sessionId === "primary-session") {
      if (secondary) {
        const failure = denialFailure("secondary-reads-primary");
        if (failure !== undefined) {
          return failure;
        }
        return options.mutualDenial === false
          ? tool(session("primary-session", "working", 0))
          : tool(session("primary-session", "working", 0), true);
      }
      const pendingPhases = (
        createIterated
          ? (["publication"] as const)
          : (["appspec", "change_set"] as const)
      ).filter((phase) => !approved.has(`approve-${phase}`));
      if (pendingPhases.length > 0) {
        const requests = pendingPhases.map((phase) => {
          const expected = receipt(phase);
          const described =
            options.approvalDigestDrift && phase === "appspec"
              ? { ...expected, subjectDigest: "d".repeat(64) }
              : expected;
          return {
            allowFreeform: false,
            description: JSON.stringify(described),
            kind: "approval",
            requestId: `approve-${phase}`,
            title: `Approve ${phase}`,
          };
        });
        return tool(
          session(
            "primary-session",
            "input_required",
            approved.size + 1,
            requests.map((request, index) => ({
              index: approved.size + index,
              request,
              type: "input_required",
            })),
            requests
          )
        );
      }
      if (!createIterated) {
        return tool(
          session("primary-session", "waiting", 3, [
            { type: "status", index: 2, status: "waiting" },
          ])
        );
      }
      const draft = {
        baseRef: target.baseRef,
        baseSha: target.baseSha,
        changeSetDigest: options.draftDigestDrift
          ? "e".repeat(64)
          : target.changeSetDigest,
        draft: true,
        format: "autograph-draft-pr-publication-receipt-v1",
        headRef: target.headRef,
        headSha: "d".repeat(40),
        outcome: "draft-pr-created",
        repository: target.repository,
        url: "https://github.com/withAutograph/proof-target/pull/42",
      };
      const status = options.iterationStatus ?? "completed";
      return tool(
        session("primary-session", status, 5, [
          {
            index: 3,
            text: `AUTOGRAPH_DRAFT_PR_RECEIPT ${JSON.stringify(draft)}`,
            turnId: "iterate",
            type: "assistant_message",
          },
          { index: 4, status, type: "status" },
        ])
      );
    }
    return new Response("", { status: 400 });
  };
}

const proofInput = (fetcher: typeof fetch) => ({
  crossTenantToken: secondaryToken,
  endpoint: scenario.oauth.resource,
  fetcher,
  nowEpochSeconds: 2_000,
  permitApprovals: true,
  releaseArchiveSha256: "1".repeat(64),
  scenario,
  sourceSha: "f".repeat(40),
  sourceTree: "0".repeat(40),
  token: primaryToken,
});

describe("hosted portable fresh-client proof", () => {
  it("accepts a SHA-256 GitHub object id for the target and every receipt", () => {
    const sha256Target = { ...target, baseSha: "a".repeat(64) };
    const parsed = hostedProofScenarioSchema.parse({
      ...scenario,
      approvalReceipts: scenario.approvalReceipts.map((approval) => ({
        ...approval,
        receipt: { ...approval.receipt, baseSha: sha256Target.baseSha },
      })),
      target: sha256Target,
    });
    expect(parsed.target.baseSha).toHaveLength(64);
  });

  it("proves exact approvals, metadata, identities, publication, and five tools", async () => {
    const result = await runHostedProof(
      proofInput(hostedFixture() as typeof fetch)
    );
    expect(result.discoveredTools).toEqual(TOOL_NAMES);
    expect(result).toMatchObject({
      cancellationProved: true,
      discardedStartResponseRecovered: true,
      idempotentStart: true,
      invalidAuthRejected: true,
      iterationProved: true,
      missingAuthRejected: true,
      mutualWorkspaceDenial: true,
      oauthMetadataBound: true,
      publicResponseDisclosureScanDigest:
        expect.stringMatching(/^[a-f0-9]{64}$/u),
      publicResponsesScanned: expect.any(Number),
      publicationEvidenceProved: true,
      responseBatchCount: 2,
      responseCount: 3,
      staleSessionRejected: true,
    });
    expect(
      Object.keys(result).some((key) =>
        /discarded.*(?:digest|fingerprint)/iu.test(key)
      )
    ).toBe(false);
  });

  it("rejects retries that differ from the discarded start result", async () => {
    await expect(
      runHostedProof(
        proofInput(
          hostedFixture({ discardedStartRetryDrift: true }) as typeof fetch
        )
      )
    ).rejects.toThrow(
      "Lost-response retry did not match the discarded hosted session result"
    );
  });

  it("rejects a bearer or adapter session disclosure in public responses", async () => {
    const leaking = hostedFixture() as typeof fetch;
    const fetcher: typeof fetch = async (url, init) => {
      const response = await leaking(url, init);
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        method?: string;
        params?: { name?: string };
      };
      if (
        body.method !== "tools/call" ||
        body.params?.name !== "autograph_get"
      ) {
        return response;
      }
      const payload = JSON.parse(await response.text()) as {
        result?: { structuredContent?: { events?: unknown[] } };
      };
      payload.result?.structuredContent?.events?.push({
        index: 99,
        text: `private ${primaryToken} wrun_PRIVATE`,
        turnId: "leak",
        type: "assistant_message",
      });
      return Response.json(payload);
    };
    await expect(runHostedProof(proofInput(fetcher))).rejects.toThrow(
      "disclosed private runtime material"
    );
  });

  it("rejects approval digest drift and missing approval authority", async () => {
    await expect(
      runHostedProof(
        proofInput(hostedFixture({ approvalDigestDrift: true }) as typeof fetch)
      )
    ).rejects.toThrow("exact digest-bound receipt");
    await expect(
      runHostedProof({
        ...proofInput(hostedFixture() as typeof fetch),
        permitApprovals: false,
      })
    ).rejects.toThrow("explicit --permit-approvals gate");
  });

  it("rejects nonterminal iteration and invalid draft evidence", async () => {
    await expect(
      runHostedProof(
        proofInput(
          hostedFixture({ iterationStatus: "waiting" }) as typeof fetch
        )
      )
    ).rejects.toThrow("successful completed state");
    await expect(
      runHostedProof(
        proofInput(hostedFixture({ draftDigestDrift: true }) as typeof fetch)
      )
    ).rejects.toThrow("approved target and change set");
    expect(() =>
      verifiedDraftPrEvidence("https://github.com/x/y/pull/1", scenario)
    ).toThrow("Exactly one structural draft-PR receipt");
  });

  it("rejects metadata drift and reused subject or workspace bindings", async () => {
    await expect(
      runHostedProof(
        proofInput(
          hostedFixture({
            metadataResource: "https://wrong.autograph.dev/mcp",
          }) as typeof fetch
        )
      )
    ).rejects.toThrow("metadata binding drifted");
    expect(() =>
      verifyWorkspaceTokenPair({
        nowEpochSeconds: 2_000,
        primary: primaryToken,
        scenario,
        secondary: primaryToken,
      })
    ).toThrow("two distinct subjects to two distinct workspaces");
    expect(() =>
      verifyWorkspaceTokenPair({
        nowEpochSeconds: 2_000,
        primary: primaryToken,
        scenario,
        secondary: jwt("proof-user-primary", "workspace-secondary"),
      })
    ).toThrow("two distinct subjects to two distinct workspaces");
    expect(() =>
      verifyWorkspaceTokenPair({
        nowEpochSeconds: 2_000,
        primary: primaryToken,
        scenario,
        secondary: jwt("proof-user-secondary", "workspace-primary"),
      })
    ).toThrow("two distinct subjects to two distinct workspaces");
  });

  it("requires mutual server-backed workspace denial", async () => {
    await expect(
      runHostedProof(
        proofInput(hostedFixture({ mutualDenial: false }) as typeof fetch)
      )
    ).rejects.toThrow("not mutually isolated");
  });

  it.each([
    ["primary-reads-secondary", "transport", "fixture transport failure"],
    [
      "primary-reads-secondary",
      "http500",
      "autograph_get failed with HTTP 500",
    ],
    ["primary-reads-secondary", "malformed", "expected boolean"],
    ["secondary-reads-primary", "transport", "fixture transport failure"],
    [
      "secondary-reads-primary",
      "http500",
      "autograph_get failed with HTTP 500",
    ],
    ["secondary-reads-primary", "malformed", "expected boolean"],
  ] as const)(
    "does not treat %s %s failure as workspace denial",
    async (direction, kind, expectedFailure) => {
      await expect(
        runHostedProof(
          proofInput(
            hostedFixture({
              denialFailure: { direction, kind },
            }) as typeof fetch
          )
        )
      ).rejects.toThrow(expectedFailure);
    }
  );
});
