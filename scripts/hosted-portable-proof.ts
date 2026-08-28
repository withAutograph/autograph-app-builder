import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import {
  eveSessionResultSchema,
  type EveSessionResult,
} from "../lib/mcp/contracts";
import { TOOL_NAMES } from "./portable-release";
import { approvalReceiptSchema } from "../lib/agent/approval-receipt";

export { approvalReceiptSchema } from "../lib/agent/approval-receipt";

const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/u);
const repositoryName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
const gitRef = z.string().regex(/^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/u);

const expectedApprovalSchema = z
  .object({
    requestTitle: z.string().min(1),
    receipt: approvalReceiptSchema,
    response: z.literal("approve"),
  })
  .strict();

const targetProofSchema = z
  .object({
    repositoryId: z.string().regex(/^\d+$/u),
    repository: repositoryName,
    baseRef: gitRef,
    baseSha: objectId,
    headRef: z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]+$/u),
    appSpecDigest: hex64,
    changeSetDigest: hex64,
    proposalDigest: hex64,
  })
  .strict();

const oauthProofSchema = z
  .object({
    issuer: z.string().url().startsWith("https://"),
    audience: z.string().min(1),
    resource: z.string().url().startsWith("https://"),
  })
  .strict();

export const hostedProofScenarioSchema = z
  .object({
    format: z.literal("autograph-hosted-client-proof-scenario-v2"),
    createPrompt: z.string().trim().min(1).max(32_000),
    iterateMessage: z.string().trim().min(1).max(32_000),
    cancelPrompt: z.string().trim().min(1).max(32_000),
    target: targetProofSchema,
    oauth: oauthProofSchema,
    questionResponses: z.array(
      z
        .object({
          requestTitle: z.string().min(1),
          value: z.string().max(16_000),
          optionId: z.string().min(1).optional(),
        })
        .strict(),
    ),
    approvalReceipts: z.array(expectedApprovalSchema).length(3),
    maxPolls: z.number().int().min(1).max(120).default(30),
    pollIntervalMs: z.number().int().min(100).max(10_000).default(1_000),
  })
  .strict()
  .superRefine((scenario, context) => {
    if (scenario.oauth.audience !== scenario.oauth.resource)
      context.addIssue({
        code: "custom",
        path: ["oauth", "audience"],
        message: "OAuth audience must be the exact protected resource.",
      });
    const phases = scenario.approvalReceipts.map(
      ({ receipt }) => receipt.phase,
    );
    if (new Set(phases).size !== 3)
      context.addIssue({
        code: "custom",
        path: ["approvalReceipts"],
        message: "Each approval phase is required exactly once.",
      });
    for (const expected of scenario.approvalReceipts) {
      const receipt = expected.receipt;
      if (
        receipt.repositoryId !== scenario.target.repositoryId ||
        receipt.repository !== scenario.target.repository ||
        receipt.baseRef !== scenario.target.baseRef ||
        receipt.baseSha !== scenario.target.baseSha
      )
        context.addIssue({
          code: "custom",
          path: ["approvalReceipts"],
          message: "Approval target binding drifted.",
        });
      const expectedDigest =
        receipt.phase === "appspec"
          ? scenario.target.appSpecDigest
          : receipt.phase === "change_set"
            ? scenario.target.changeSetDigest
            : scenario.target.proposalDigest;
      const expectedOutcome =
        receipt.phase === "appspec"
          ? "accept-appspec"
          : receipt.phase === "change_set"
            ? "accept-change-set"
            : "create-draft-pr";
      if (
        receipt.subjectDigest !== expectedDigest ||
        receipt.outcome !== expectedOutcome
      )
        context.addIssue({
          code: "custom",
          path: ["approvalReceipts"],
          message: "Approval digest or outcome drifted.",
        });
    }
  });

export type HostedProofScenario = z.infer<typeof hostedProofScenarioSchema>;

export const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

function canonicalPublicResult(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalPublicResult).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${canonicalPublicResult(entry)}`,
      )
      .join(",")}}`;
  const primitive = JSON.stringify(value);
  if (primitive === undefined)
    throw new Error("Public tool result was not canonical JSON.");
  return primitive;
}

function publicResultFingerprint(result: EveSessionResult) {
  return digest(canonicalPublicResult(result));
}

const tokenClaimsSchema = z
  .object({
    iss: z.string().url().startsWith("https://"),
    aud: z.string(),
    sub: z.string().min(1),
    workspace_id: z.string().min(1),
    scope: z.string().min(1),
    nbf: z.number().int(),
    exp: z.number().int(),
  })
  .passthrough();

function tokenClaims(token: string) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("OAuth access token must be a JWT.");
  return tokenClaimsSchema.parse(
    JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")),
  );
}

export function verifyWorkspaceTokenPair(input: {
  primary: string;
  secondary: string;
  scenario: HostedProofScenario;
  nowEpochSeconds: number;
}) {
  const primary = tokenClaims(input.primary);
  const secondary = tokenClaims(input.secondary);
  const requiredScopes = [
    "autograph:session",
    "autograph:start",
    "autograph:get",
    "autograph:send",
    "autograph:respond",
    "autograph:cancel",
  ];
  for (const claims of [primary, secondary]) {
    const scopes = new Set(claims.scope.split(" "));
    if (
      claims.iss !== input.scenario.oauth.issuer ||
      claims.aud !== input.scenario.oauth.audience ||
      claims.nbf > input.nowEpochSeconds ||
      claims.exp <= input.nowEpochSeconds ||
      claims.exp - claims.nbf > 300 ||
      requiredScopes.some((scope) => !scopes.has(scope))
    )
      throw new Error(
        "OAuth token claims did not match the exact hosted proof contract.",
      );
  }
  if (
    primary.sub === secondary.sub ||
    primary.workspace_id === secondary.workspace_id
  )
    throw new Error(
      "Proof tokens must bind two distinct subjects to two distinct workspaces.",
    );
  return {
    primaryIdentityDigest: digest(
      `${primary.iss}\0${primary.sub}\0${primary.workspace_id}`,
    ),
    secondaryIdentityDigest: digest(
      `${secondary.iss}\0${secondary.sub}\0${secondary.workspace_id}`,
    ),
  };
}

const protectedResourceMetadataSchema = z
  .object({
    resource: z.string().url().startsWith("https://"),
    authorization_servers: z
      .array(z.string().url().startsWith("https://"))
      .length(1),
    bearer_methods_supported: z.tuple([z.literal("header")]),
    scopes_supported: z.tuple([
      z.literal("autograph:session"),
      z.literal("autograph:start"),
      z.literal("autograph:get"),
      z.literal("autograph:send"),
      z.literal("autograph:respond"),
      z.literal("autograph:cancel"),
    ]),
  })
  .strict();

const draftPrReceiptSchema = z
  .object({
    format: z.literal("autograph-draft-pr-publication-receipt-v1"),
    url: z.string().url().startsWith("https://github.com/"),
    draft: z.literal(true),
    repository: repositoryName,
    baseRef: gitRef,
    baseSha: objectId,
    headRef: z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]+$/u),
    headSha: objectId,
    changeSetDigest: hex64,
    outcome: z.literal("draft-pr-created"),
  })
  .strict();

export function verifiedDraftPrEvidence(
  text: string,
  scenario: HostedProofScenario,
) {
  const marker = "AUTOGRAPH_DRAFT_PR_RECEIPT ";
  const candidates = text.split("\n").filter((line) => line.startsWith(marker));
  if (candidates.length !== 1)
    throw new Error("Exactly one structural draft-PR receipt is required.");
  const receipt = draftPrReceiptSchema.parse(
    JSON.parse(candidates[0].slice(marker.length)),
  );
  const url = new URL(receipt.url);
  const expectedPath = `/${receipt.repository}/pull/`;
  if (
    url.origin !== "https://github.com" ||
    !url.pathname.startsWith(expectedPath) ||
    !/^[1-9][0-9]*$/u.test(url.pathname.slice(expectedPath.length)) ||
    url.search !== "" ||
    url.hash !== "" ||
    receipt.repository !== scenario.target.repository ||
    receipt.baseRef !== scenario.target.baseRef ||
    receipt.baseSha !== scenario.target.baseSha ||
    receipt.headRef !== scenario.target.headRef ||
    receipt.headRef === receipt.baseRef ||
    receipt.headSha === receipt.baseSha ||
    receipt.changeSetDigest !== scenario.target.changeSetDigest
  )
    throw new Error(
      "Draft-PR receipt did not match the exact approved target and change set.",
    );
  return { receipt, evidenceDigest: digest(JSON.stringify(receipt)) };
}

function jsonRpcPayload(text: string) {
  const contentTypePayload = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .find((line) => line !== "" && line !== "[DONE]");
  const payload = JSON.parse(contentTypePayload ?? text) as unknown;
  return z
    .object({
      jsonrpc: z.literal("2.0"),
      id: z.union([z.string(), z.number()]).optional(),
      result: z.unknown().optional(),
      error: z
        .object({ code: z.number(), message: z.string() })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .parse(payload);
}

export interface ProofHttpResult {
  status: number;
  headers: Headers;
  payload?: ReturnType<typeof jsonRpcPayload>;
}

export class HostedMcpProofClient {
  private requestId = 0;
  private sessionId?: string;
  private readonly responseBodies: string[] = [];
  private discardedResult?: {
    name: (typeof TOOL_NAMES)[number];
    fingerprint: string;
  };

  constructor(
    readonly endpoint: string,
    private readonly token: string | undefined,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async post(
    method: string,
    params: unknown,
    options: { authenticate?: boolean; notification?: boolean } = {},
  ): Promise<ProofHttpResult> {
    const headers = new Headers({
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-03-26",
    });
    if (options.authenticate !== false && this.token !== undefined)
      headers.set("authorization", `Bearer ${this.token}`);
    if (this.sessionId !== undefined)
      headers.set("mcp-session-id", this.sessionId);
    const body = {
      jsonrpc: "2.0",
      ...(options.notification ? {} : { id: ++this.requestId }),
      method,
      params,
    };
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
    });
    const returnedSession = response.headers.get("mcp-session-id");
    if (returnedSession !== null) this.sessionId = returnedSession;
    const text = await response.text();
    this.responseBodies.push(text);
    return {
      status: response.status,
      headers: response.headers,
      ...(text === "" ? {} : { payload: jsonRpcPayload(text) }),
    };
  }

  async initialize() {
    const response = await this.post("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "autograph-hosted-proof", version: "1" },
    });
    if (response.status !== 200 || response.payload?.error !== undefined)
      throw new Error(`MCP initialize failed with HTTP ${response.status}.`);
    const initialized = await this.post(
      "notifications/initialized",
      {},
      { notification: true },
    );
    if (![200, 202, 204].includes(initialized.status))
      throw new Error("MCP initialized notification was rejected.");
  }

  async listTools() {
    const response = await this.post("tools/list", {});
    if (response.status !== 200 || response.payload?.error !== undefined)
      throw new Error(`MCP tools/list failed with HTTP ${response.status}.`);
    const listed = z
      .object({ tools: z.array(z.object({ name: z.string() }).passthrough()) })
      .passthrough()
      .parse(response.payload?.result);
    if ("nextCursor" in listed)
      throw new Error("Hosted tools/list unexpectedly required pagination.");
    return listed.tools.map(({ name }) => name);
  }

  async callTool(name: (typeof TOOL_NAMES)[number], args: unknown) {
    const response = await this.post("tools/call", { name, arguments: args });
    if (response.status !== 200 || response.payload?.error !== undefined)
      throw new Error(`${name} failed with HTTP ${response.status}.`);
    const result = z
      .object({
        isError: z.boolean().optional(),
        structuredContent: z.unknown().optional(),
      })
      .passthrough()
      .parse(response.payload?.result);
    return {
      isError: result.isError === true,
      session:
        result.structuredContent === undefined
          ? undefined
          : eveSessionResultSchema.safeParse(result.structuredContent),
    };
  }

  async callToolAndDiscardResult(
    name: (typeof TOOL_NAMES)[number],
    args: unknown,
  ) {
    const response = await this.post("tools/call", { name, arguments: args });
    if (response.status !== 200 || response.payload?.error !== undefined)
      throw new Error(`${name} failed with HTTP ${response.status}.`);
    const result = z
      .object({
        isError: z.boolean().optional(),
        structuredContent: z.unknown(),
      })
      .passthrough()
      .parse(response.payload?.result);
    if (result.isError === true)
      throw new Error(`${name} returned an error before result loss.`);
    const publicResult = eveSessionResultSchema.parse(result.structuredContent);
    // Retain only a private canonical fingerprint. This models a caller that
    // loses the successful operation result before it can retain the public
    // session identity while still binding a retry to the discarded result.
    this.discardedResult = {
      name,
      fingerprint: publicResultFingerprint(publicResult),
    };
  }

  async callToolMatchingDiscardedResult(
    name: (typeof TOOL_NAMES)[number],
    args: unknown,
  ) {
    const discarded = this.discardedResult;
    if (discarded === undefined || discarded.name !== name)
      throw new Error("No matching discarded tool result was recorded.");
    const result = await this.callTool(name, args);
    if (
      !result.isError &&
      result.session?.success === true &&
      publicResultFingerprint(result.session.data) !== discarded.fingerprint
    )
      throw new Error(
        "Lost-response retry did not match the discarded hosted session result.",
      );
    return result;
  }

  rawInitialize(authenticate = true) {
    return this.post(
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "autograph-hosted-proof-negative", version: "1" },
      },
      { authenticate },
    );
  }

  disclosureEvidence(forbiddenValues: readonly string[]) {
    const joined = this.responseBodies.join("\n");
    if (
      forbiddenValues.some((value) => value !== "" && joined.includes(value)) ||
      /\bwrun_[A-Za-z0-9]+\b/u.test(joined) ||
      joined.includes("x-vercel-trusted-oidc-idp-token")
    ) {
      throw new Error(
        "Hosted public responses disclosed private runtime material.",
      );
    }
    return {
      publicResponsesScanned: this.responseBodies.length,
      publicResponseDisclosureScanDigest: digest(joined),
    };
  }
}

async function verifyProtectedResourceMetadata(input: {
  endpoint: string;
  scenario: HostedProofScenario;
  fetcher: typeof fetch;
}) {
  const endpoint = new URL(input.endpoint);
  const metadataUrl = new URL(
    "/.well-known/oauth-protected-resource",
    endpoint,
  );
  if (input.scenario.oauth.resource !== endpoint.href)
    throw new Error("OAuth resource must be the exact release MCP endpoint.");
  const response = await input.fetcher(metadataUrl, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "error",
  });
  if (response.status !== 200)
    throw new Error("OAuth protected-resource metadata was unavailable.");
  const metadata = protectedResourceMetadataSchema.parse(await response.json());
  if (
    metadata.resource !== input.scenario.oauth.resource ||
    metadata.authorization_servers[0] !== input.scenario.oauth.issuer
  )
    throw new Error("OAuth protected-resource metadata binding drifted.");
  return {
    metadataUrl: metadataUrl.href,
    digest: digest(JSON.stringify(metadata)),
  };
}

function toolSession(
  name: string,
  result: Awaited<ReturnType<HostedMcpProofClient["callTool"]>>,
) {
  if (result.isError || result.session?.success !== true)
    throw new Error(`${name} returned a tool error or invalid public result.`);
  return result.session.data;
}

function assistantText(result: EveSessionResult) {
  return result.events
    .filter((event) => event.type === "assistant_message")
    .map((event) => event.text)
    .join("\n");
}

function responseFor(
  request: NonNullable<EveSessionResult["inputRequests"]>[number],
  scenario: HostedProofScenario,
  permitApprovals: boolean,
) {
  if (request.kind === "question") {
    const matches = scenario.questionResponses.filter(
      (candidate) => candidate.requestTitle === request.title,
    );
    if (matches.length !== 1)
      throw new Error(
        "Question did not match exactly one title-bound response.",
      );
    const match = matches[0];
    return {
      response: {
        kind: "answer" as const,
        value: match.value,
        ...(match.optionId === undefined ? {} : { optionId: match.optionId }),
      },
    };
  }
  if (request.kind !== "approval" || request.description === undefined)
    throw new Error(
      "Only closed question or approval requests can be automated.",
    );
  const parsedReceipt = approvalReceiptSchema.parse(
    JSON.parse(request.description),
  );
  const matches = scenario.approvalReceipts.filter(
    (candidate) =>
      candidate.requestTitle === request.title &&
      JSON.stringify(candidate.receipt) === JSON.stringify(parsedReceipt),
  );
  if (matches.length !== 1)
    throw new Error("Approval did not match one exact digest-bound receipt.");
  if (!permitApprovals)
    throw new Error(
      "Approval response requires the explicit --permit-approvals gate.",
    );
  return {
    response: { kind: "approve" as const },
    approvalPhase: parsedReceipt.phase,
  };
}

async function pollUntilSettled(input: {
  client: HostedMcpProofClient;
  scenario: HostedProofScenario;
  sessionId: string;
  cursor: number;
  permitApprovals: boolean;
  requestPrefix: string;
}) {
  let cursor = input.cursor;
  let allText = "";
  let responseCount = 0;
  let responseBatchCount = 0;
  const approvalPhases: string[] = [];
  for (let poll = 0; poll < input.scenario.maxPolls; poll += 1) {
    const page = toolSession(
      "autograph_get",
      await input.client.callTool("autograph_get", {
        sessionId: input.sessionId,
        cursor,
        limit: 250,
      }),
    );
    cursor = page.cursor;
    allText += `\n${assistantText(page)}`;
    const responses = (page.inputRequests ?? []).map((request) => {
      const selected = responseFor(
        request,
        input.scenario,
        input.permitApprovals,
      );
      if (selected.approvalPhase !== undefined) {
        approvalPhases.push(selected.approvalPhase);
      }
      return { requestId: request.requestId, response: selected.response };
    });
    if (responses.length > 0) {
      toolSession(
        "autograph_respond",
        await input.client.callTool("autograph_respond", {
          sessionId: input.sessionId,
          responses,
          clientRequestId: `${input.requestPrefix}-respond-batch-${responseBatchCount}`,
        }),
      );
      responseCount += responses.length;
      responseBatchCount += 1;
    }
    if (
      page.status === "waiting" ||
      page.status === "completed" ||
      page.status === "failed" ||
      page.status === "cancelled"
    )
      return {
        page,
        cursor,
        allText,
        responseCount,
        responseBatchCount,
        approvalPhases,
      };
    await new Promise((resolve) =>
      setTimeout(resolve, input.scenario.pollIntervalMs),
    );
  }
  throw new Error(
    "Hosted session did not settle within the bounded poll window.",
  );
}

export interface HostedProofResult {
  sourceSha: string;
  sourceTree: string;
  releaseArchiveSha256: string;
  endpointOrigin: string;
  discoveredTools: readonly string[];
  missingAuthRejected: boolean;
  invalidAuthRejected: boolean;
  oauthMetadataBound: boolean;
  oauthMetadataDigest: string;
  primaryIdentityDigest: string;
  secondaryIdentityDigest: string;
  idempotentStart: boolean;
  discardedStartResponseRecovered: boolean;
  responseCount: number;
  responseBatchCount: number;
  iterationProved: boolean;
  publicationEvidenceProved: boolean;
  draftPrEvidenceDigest: string;
  staleSessionRejected: boolean;
  mutualWorkspaceDenial: boolean;
  cancellationProved: boolean;
  publicResponsesScanned: number;
  publicResponseDisclosureScanDigest: string;
  sessionEvidenceDigest: string;
}

export async function runHostedProof(input: {
  endpoint: string;
  token: string;
  crossTenantToken: string;
  scenario: HostedProofScenario;
  sourceSha: string;
  sourceTree: string;
  releaseArchiveSha256: string;
  permitApprovals: boolean;
  nowEpochSeconds?: number;
  fetcher?: typeof fetch;
}): Promise<HostedProofResult> {
  const fetcher = input.fetcher ?? fetch;
  const tokenPair = verifyWorkspaceTokenPair({
    primary: input.token,
    secondary: input.crossTenantToken,
    scenario: input.scenario,
    nowEpochSeconds: input.nowEpochSeconds ?? Math.floor(Date.now() / 1_000),
  });
  const metadata = await verifyProtectedResourceMetadata({
    endpoint: input.endpoint,
    scenario: input.scenario,
    fetcher,
  });
  const noAuth = new HostedMcpProofClient(input.endpoint, undefined, fetcher);
  const missing = await noAuth.rawInitialize(false);
  if (
    missing.status !== 401 ||
    !/^Bearer(?:\s|$)/iu.test(missing.headers.get("www-authenticate") ?? "") ||
    !missing.headers
      .get("www-authenticate")
      ?.includes(`resource_metadata="${metadata.metadataUrl}"`)
  )
    throw new Error("Hosted endpoint did not fail closed without OAuth.");
  const invalid = new HostedMcpProofClient(
    input.endpoint,
    "invalid-hosted-proof-token",
    fetcher,
  );
  const invalidResult = await invalid.rawInitialize(true);
  if (
    invalidResult.status !== 401 ||
    !/^Bearer(?:\s|$)/iu.test(
      invalidResult.headers.get("www-authenticate") ?? "",
    ) ||
    !invalidResult.headers
      .get("www-authenticate")
      ?.includes(`resource_metadata="${metadata.metadataUrl}"`)
  )
    throw new Error("Hosted endpoint did not reject an invalid bearer token.");

  const client = new HostedMcpProofClient(input.endpoint, input.token, fetcher);
  await client.initialize();
  const discoveredTools = await client.listTools();
  if (JSON.stringify(discoveredTools) !== JSON.stringify(TOOL_NAMES))
    throw new Error(
      "Hosted endpoint did not expose exactly the five Autograph tools.",
    );

  const proofId = digest(
    `${input.sourceSha}\0${JSON.stringify(input.scenario)}\0${randomUUID()}`,
  ).slice(0, 24);
  const startArgs = {
    prompt: input.scenario.createPrompt,
    clientRequestId: `hosted-create-${proofId}`,
  };
  await client.callToolAndDiscardResult("autograph_start", startArgs);
  const first = toolSession(
    "autograph_start",
    await client.callToolMatchingDiscardedResult("autograph_start", startArgs),
  );
  toolSession(
    "autograph_start",
    await client.callToolMatchingDiscardedResult("autograph_start", startArgs),
  );
  const created = await pollUntilSettled({
    client,
    scenario: input.scenario,
    sessionId: first.sessionId,
    cursor: first.cursor,
    permitApprovals: input.permitApprovals,
    requestPrefix: `hosted-create-${proofId}`,
  });
  if (created.responseCount < 1)
    throw new Error("Hosted proof did not exercise autograph_respond.");
  if (created.page.status !== "waiting")
    throw new Error(
      "Create phase did not reach the waiting state for iteration.",
    );

  const sent = toolSession(
    "autograph_send",
    await client.callTool("autograph_send", {
      sessionId: first.sessionId,
      message: input.scenario.iterateMessage,
      clientRequestId: `hosted-iterate-${proofId}`,
    }),
  );
  const iterated = await pollUntilSettled({
    client,
    scenario: input.scenario,
    sessionId: first.sessionId,
    cursor: created.cursor,
    permitApprovals: input.permitApprovals,
    requestPrefix: `hosted-iterate-${proofId}`,
  });
  if (iterated.page.status !== "completed")
    throw new Error("Iteration did not reach a successful completed state.");
  const observedApprovalPhases = [
    ...created.approvalPhases,
    ...iterated.approvalPhases,
  ].sort();
  if (
    JSON.stringify(observedApprovalPhases) !==
    JSON.stringify(["appspec", "change_set", "publication"])
  )
    throw new Error(
      "The live lifecycle did not consume all exact approval receipts.",
    );
  const draftPr = verifiedDraftPrEvidence(iterated.allText, input.scenario);

  const stale = await client.callTool("autograph_get", {
    sessionId: `stale-${proofId}`,
    cursor: 0,
    limit: 1,
  });
  if (!stale.isError)
    throw new Error("Stale or unknown session access did not fail closed.");

  const crossTenant = new HostedMcpProofClient(
    input.endpoint,
    input.crossTenantToken,
    fetcher,
  );
  await crossTenant.initialize();
  const cancellationStart = toolSession(
    "autograph_start",
    await crossTenant.callTool("autograph_start", {
      prompt: input.scenario.cancelPrompt,
      clientRequestId: `hosted-cancel-${proofId}`,
    }),
  );
  const denied = async (clientInput: HostedMcpProofClient, sessionId: string) =>
    (
      await clientInput.callTool("autograph_get", {
        sessionId,
        cursor: 0,
        limit: 1,
      })
    ).isError;
  if (
    !(await denied(crossTenant, first.sessionId)) ||
    !(await denied(client, cancellationStart.sessionId))
  )
    throw new Error(
      "The two server-accepted workspace identities were not mutually isolated.",
    );
  toolSession(
    "autograph_cancel",
    await crossTenant.callTool("autograph_cancel", {
      sessionId: cancellationStart.sessionId,
    }),
  );
  const cancelled = await pollUntilSettled({
    client: crossTenant,
    scenario: input.scenario,
    sessionId: cancellationStart.sessionId,
    cursor: cancellationStart.cursor,
    permitApprovals: false,
    requestPrefix: `hosted-cancel-${proofId}`,
  });
  if (cancelled.page.status !== "cancelled")
    throw new Error(
      "Cooperative cancellation was not proven by public events.",
    );
  const primaryDisclosure = client.disclosureEvidence([
    input.token,
    input.crossTenantToken,
  ]);
  const secondaryDisclosure = crossTenant.disclosureEvidence([
    input.token,
    input.crossTenantToken,
  ]);

  return {
    sourceSha: input.sourceSha,
    sourceTree: input.sourceTree,
    releaseArchiveSha256: input.releaseArchiveSha256,
    endpointOrigin: new URL(input.endpoint).origin,
    discoveredTools,
    missingAuthRejected: true,
    invalidAuthRejected: true,
    oauthMetadataBound: true,
    oauthMetadataDigest: metadata.digest,
    ...tokenPair,
    idempotentStart: true,
    discardedStartResponseRecovered: true,
    responseCount: created.responseCount + iterated.responseCount,
    responseBatchCount:
      created.responseBatchCount + iterated.responseBatchCount,
    iterationProved: sent.sessionId === first.sessionId,
    publicationEvidenceProved: true,
    draftPrEvidenceDigest: draftPr.evidenceDigest,
    staleSessionRejected: true,
    mutualWorkspaceDenial: true,
    cancellationProved: true,
    publicResponsesScanned:
      primaryDisclosure.publicResponsesScanned +
      secondaryDisclosure.publicResponsesScanned,
    publicResponseDisclosureScanDigest: digest(
      `${primaryDisclosure.publicResponseDisclosureScanDigest}\0${secondaryDisclosure.publicResponseDisclosureScanDigest}`,
    ),
    sessionEvidenceDigest: digest(
      `${first.sessionId}\0${created.allText}\0${iterated.allText}\0${cancelled.page.status}`,
    ),
  };
}
