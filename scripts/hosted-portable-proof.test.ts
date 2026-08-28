import { describe, expect, it } from "vitest";

import {
  hostedProofScenarioSchema,
  runHostedProof,
  verifiedDraftPrEvidence,
  verifyWorkspaceTokenPair,
} from "./hosted-portable-proof";
import { TOOL_NAMES } from "./portable-release";

const target = {
  repositoryId: "1234",
  repository: "withAutograph/proof-target",
  baseRef: "refs/heads/main",
  baseSha: "a".repeat(40),
  headRef: "refs/heads/autograph/proof",
  appSpecDigest: "b".repeat(64),
  changeSetDigest: "c".repeat(64),
  proposalDigest: "d".repeat(64),
};
const receipt = (phase: "appspec" | "change_set" | "publication") => ({
  format: "autograph-eve-approval-receipt-v2" as const,
  phase,
  repositoryId: target.repositoryId,
  repository: target.repository,
  baseRef: target.baseRef,
  baseSha: target.baseSha,
  subjectDigest:
    phase === "appspec"
      ? target.appSpecDigest
      : phase === "change_set"
        ? target.changeSetDigest
        : target.proposalDigest,
  outcome:
    phase === "appspec"
      ? ("accept-appspec" as const)
      : phase === "change_set"
        ? ("accept-change-set" as const)
        : ("create-draft-pr" as const),
});
const scenario = hostedProofScenarioSchema.parse({
  format: "autograph-hosted-client-proof-scenario-v2",
  createPrompt: "Create a supported app and pause before publication.",
  iterateMessage: "Iterate, validate, and publish the approved draft PR.",
  cancelPrompt: "Begin a cancellable read-only design turn.",
  target,
  oauth: {
    issuer: "https://issuer.autograph.dev",
    audience: "https://preview.autograph.dev/mcp",
    resource: "https://preview.autograph.dev/mcp",
  },
  questionResponses: [],
  approvalReceipts: (["appspec", "change_set", "publication"] as const).map(
    (phase) => ({
      requestTitle: `Approve ${phase}`,
      receipt: receipt(phase),
      response: "approve",
    }),
  ),
  maxPolls: 8,
  pollIntervalMs: 100,
});

function jwt(subject: string, workspaceId: string) {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", kid: "proof" })}.${encode({
    iss: scenario.oauth.issuer,
    aud: scenario.oauth.audience,
    sub: subject,
    workspace_id: workspaceId,
    scope: "eve:session eve:start eve:get eve:send eve:respond eve:cancel",
    nbf: 1_900,
    exp: 2_100,
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
    { status, headers: { "content-type": "application/json" } },
  );

function session(
  sessionId: string,
  status: "working" | "input_required" | "waiting" | "completed" | "cancelled",
  cursor: number,
  events: unknown[] = [],
  inputRequests?: unknown[],
) {
  return {
    sessionId,
    status,
    cursor,
    events,
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
  } = {},
) {
  const approved = new Set<string>();
  let createIterated = false;
  let cancelRequested = false;
  return async (urlInput: string | URL | Request, init?: RequestInit) => {
    const url = String(urlInput);
    if (url.endsWith("/.well-known/oauth-protected-resource"))
      return Response.json({
        resource: options.metadataResource ?? scenario.oauth.resource,
        authorization_servers: [scenario.oauth.issuer],
        bearer_methods_supported: ["header"],
        scopes_supported: [
          "eve:session",
          "eve:start",
          "eve:get",
          "eve:send",
          "eve:respond",
          "eve:cancel",
        ],
      });
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    if (
      authorization === null ||
      authorization === "Bearer invalid-hosted-proof-token"
    )
      return new Response("", {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer error="invalid_token", resource_metadata="https://preview.autograph.dev/.well-known/oauth-protected-resource"',
        },
      });
    const secondary = authorization === `Bearer ${secondaryToken}`;
    const body = JSON.parse(String(init?.body));
    if (body.method === "initialize")
      return rpc(body.id, {
        protocolVersion: "2025-03-26",
        capabilities: {},
        serverInfo: { name: "fixture", version: "1" },
      });
    if (body.method === "notifications/initialized")
      return new Response(undefined, { status: 202 });
    if (body.method === "tools/list")
      return rpc(body.id, { tools: TOOL_NAMES.map((name) => ({ name })) });
    if (body.method !== "tools/call") return new Response("", { status: 400 });
    const name = body.params.name as string;
    const args = body.params.arguments as Record<string, unknown>;
    const tool = (structuredContent: unknown, isError = false) =>
      rpc(body.id, { isError, structuredContent });
    const denialFailure = (
      direction: "primary-reads-secondary" | "secondary-reads-primary",
    ) => {
      if (options.denialFailure?.direction !== direction) return undefined;
      if (options.denialFailure.kind === "transport")
        throw new Error("fixture transport failure");
      if (options.denialFailure.kind === "http500")
        return new Response("", { status: 500 });
      return rpc(body.id, {
        isError: "not-a-boolean",
        structuredContent: session(String(args.sessionId), "working", 0),
      });
    };
    if (name === "eve_start")
      return tool(
        session(
          secondary ? "secondary-session" : "primary-session",
          "working",
          0,
        ),
      );
    if (name === "eve_respond") {
      if (!Array.isArray(args.responses) || args.responses.length === 0)
        return tool(session("primary-session", "working", 0), true);
      for (const response of args.responses) {
        if (
          response === null ||
          typeof response !== "object" ||
          typeof (response as { requestId?: unknown }).requestId !== "string"
        )
          return tool(session("primary-session", "working", 0), true);
        approved.add((response as { requestId: string }).requestId);
      }
      return tool(session("primary-session", "working", 0));
    }
    if (name === "eve_send") {
      createIterated = true;
      return tool(session("primary-session", "working", 0));
    }
    if (name === "eve_cancel") {
      cancelRequested = true;
      return tool(session("secondary-session", "working", 0));
    }
    if (name === "eve_get" && String(args.sessionId).startsWith("stale-"))
      return tool(session(String(args.sessionId), "working", 0), true);
    if (name === "eve_get" && args.sessionId === "secondary-session") {
      if (!secondary) {
        const failure = denialFailure("primary-reads-secondary");
        if (failure !== undefined) return failure;
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
            ? [{ type: "status", index: 0, status: "cancelled" }]
            : [],
        ),
      );
    }
    if (name === "eve_get" && args.sessionId === "primary-session") {
      if (secondary) {
        const failure = denialFailure("secondary-reads-primary");
        if (failure !== undefined) return failure;
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
            requestId: `approve-${phase}`,
            kind: "approval",
            title: `Approve ${phase}`,
            description: JSON.stringify(described),
            allowFreeform: false,
          };
        });
        return tool(
          session(
            "primary-session",
            "input_required",
            approved.size + 1,
            requests.map((request, index) => ({
              type: "input_required",
              index: approved.size + index,
              request,
            })),
            requests,
          ),
        );
      }
      if (!createIterated)
        return tool(
          session("primary-session", "waiting", 3, [
            { type: "status", index: 2, status: "waiting" },
          ]),
        );
      const draft = {
        format: "autograph-draft-pr-publication-receipt-v1",
        url: "https://github.com/withAutograph/proof-target/pull/42",
        draft: true,
        repository: target.repository,
        baseRef: target.baseRef,
        baseSha: target.baseSha,
        headRef: target.headRef,
        headSha: "d".repeat(40),
        changeSetDigest: options.draftDigestDrift
          ? "e".repeat(64)
          : target.changeSetDigest,
        outcome: "draft-pr-created",
      };
      const status = options.iterationStatus ?? "completed";
      return tool(
        session("primary-session", status, 5, [
          {
            type: "assistant_message",
            index: 3,
            turnId: "iterate",
            text: `AUTOGRAPH_DRAFT_PR_RECEIPT ${JSON.stringify(draft)}`,
          },
          { type: "status", index: 4, status },
        ]),
      );
    }
    return new Response("", { status: 400 });
  };
}

const proofInput = (fetcher: typeof fetch) => ({
  endpoint: scenario.oauth.resource,
  token: primaryToken,
  crossTenantToken: secondaryToken,
  scenario,
  sourceSha: "f".repeat(40),
  sourceTree: "0".repeat(40),
  releaseArchiveSha256: "1".repeat(64),
  permitApprovals: true,
  nowEpochSeconds: 2_000,
  fetcher,
});

describe("hosted portable fresh-client proof", () => {
  it("accepts a SHA-256 GitHub object id for the target and every receipt", () => {
    const sha256Target = { ...target, baseSha: "a".repeat(64) };
    const parsed = hostedProofScenarioSchema.parse({
      ...scenario,
      target: sha256Target,
      approvalReceipts: scenario.approvalReceipts.map((approval) => ({
        ...approval,
        receipt: { ...approval.receipt, baseSha: sha256Target.baseSha },
      })),
    });
    expect(parsed.target.baseSha).toHaveLength(64);
  });

  it("proves exact approvals, metadata, identities, publication, and five tools", async () => {
    const result = await runHostedProof(
      proofInput(hostedFixture() as typeof fetch),
    );
    expect(result.discoveredTools).toEqual(TOOL_NAMES);
    expect(result).toMatchObject({
      missingAuthRejected: true,
      invalidAuthRejected: true,
      oauthMetadataBound: true,
      idempotentStart: true,
      discardedStartResponseRecovered: true,
      responseCount: 3,
      responseBatchCount: 2,
      iterationProved: true,
      publicationEvidenceProved: true,
      staleSessionRejected: true,
      mutualWorkspaceDenial: true,
      cancellationProved: true,
      publicResponsesScanned: expect.any(Number),
      publicResponseDisclosureScanDigest:
        expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("rejects a bearer or adapter session disclosure in public responses", async () => {
    const leaking = hostedFixture() as typeof fetch;
    const fetcher: typeof fetch = async (url, init) => {
      const response = await leaking(url, init);
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        method?: string;
        params?: { name?: string };
      };
      if (body.method !== "tools/call" || body.params?.name !== "eve_get") {
        return response;
      }
      const payload = JSON.parse(await response.text()) as {
        result?: { structuredContent?: { events?: unknown[] } };
      };
      payload.result?.structuredContent?.events?.push({
        type: "assistant_message",
        index: 99,
        turnId: "leak",
        text: `private ${primaryToken} wrun_PRIVATE`,
      });
      return Response.json(payload);
    };
    await expect(runHostedProof(proofInput(fetcher))).rejects.toThrow(
      "disclosed private runtime material",
    );
  });

  it("rejects approval digest drift and missing approval authority", async () => {
    await expect(
      runHostedProof(
        proofInput(
          hostedFixture({ approvalDigestDrift: true }) as typeof fetch,
        ),
      ),
    ).rejects.toThrow("exact digest-bound receipt");
    await expect(
      runHostedProof({
        ...proofInput(hostedFixture() as typeof fetch),
        permitApprovals: false,
      }),
    ).rejects.toThrow("explicit --permit-approvals gate");
  });

  it("rejects nonterminal iteration and invalid draft evidence", async () => {
    await expect(
      runHostedProof(
        proofInput(
          hostedFixture({ iterationStatus: "waiting" }) as typeof fetch,
        ),
      ),
    ).rejects.toThrow("successful completed state");
    await expect(
      runHostedProof(
        proofInput(hostedFixture({ draftDigestDrift: true }) as typeof fetch),
      ),
    ).rejects.toThrow("approved target and change set");
    expect(() =>
      verifiedDraftPrEvidence("https://github.com/x/y/pull/1", scenario),
    ).toThrow("Exactly one structural draft-PR receipt");
  });

  it("rejects metadata drift and reused subject or workspace bindings", async () => {
    await expect(
      runHostedProof(
        proofInput(
          hostedFixture({
            metadataResource: "https://wrong.autograph.dev/mcp",
          }) as typeof fetch,
        ),
      ),
    ).rejects.toThrow("metadata binding drifted");
    expect(() =>
      verifyWorkspaceTokenPair({
        primary: primaryToken,
        secondary: primaryToken,
        scenario,
        nowEpochSeconds: 2_000,
      }),
    ).toThrow("two distinct subjects to two distinct workspaces");
    expect(() =>
      verifyWorkspaceTokenPair({
        primary: primaryToken,
        secondary: jwt("proof-user-primary", "workspace-secondary"),
        scenario,
        nowEpochSeconds: 2_000,
      }),
    ).toThrow("two distinct subjects to two distinct workspaces");
    expect(() =>
      verifyWorkspaceTokenPair({
        primary: primaryToken,
        secondary: jwt("proof-user-secondary", "workspace-primary"),
        scenario,
        nowEpochSeconds: 2_000,
      }),
    ).toThrow("two distinct subjects to two distinct workspaces");
  });

  it("requires mutual server-backed workspace denial", async () => {
    await expect(
      runHostedProof(
        proofInput(hostedFixture({ mutualDenial: false }) as typeof fetch),
      ),
    ).rejects.toThrow("not mutually isolated");
  });

  it.each([
    ["primary-reads-secondary", "transport", "fixture transport failure"],
    ["primary-reads-secondary", "http500", "eve_get failed with HTTP 500"],
    ["primary-reads-secondary", "malformed", "expected boolean"],
    ["secondary-reads-primary", "transport", "fixture transport failure"],
    ["secondary-reads-primary", "http500", "eve_get failed with HTTP 500"],
    ["secondary-reads-primary", "malformed", "expected boolean"],
  ] as const)(
    "does not treat %s %s failure as workspace denial",
    async (direction, kind, expectedFailure) => {
      await expect(
        runHostedProof(
          proofInput(
            hostedFixture({
              denialFailure: { direction, kind },
            }) as typeof fetch,
          ),
        ),
      ).rejects.toThrow(expectedFailure);
    },
  );
});
