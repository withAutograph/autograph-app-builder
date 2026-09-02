import type { MessageStreamEvent } from "eve/client";
import { z } from "zod";

import { sessionStatusSchema } from "../mcp/contracts";
import { hostedPrincipalSchema, type HostedPrincipal } from "./hosted-auth";
import {
  HostedCancellationUnsettledError,
  HostedAdapterSessionUnavailableError,
  SubmissionOutcomeUnknownError,
  SubmissionRejectedBeforeDispatchError,
  type HostedEngineSnapshot,
  type HostedEveTransport,
} from "./hosted-service";
import {
  deriveInstalledEveStatus,
  latestInstalledImplementationPlan,
  latestInstalledPrototype,
  latestInstalledUiPreview,
  projectInstalledEveEvent,
} from "./public-events";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_STREAM_EVENTS = 100_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const VERCEL_TRUSTED_OIDC_HEADER = "x-vercel-trusted-oidc-idp-token";
const EVE_STREAM_FORMAT = "ndjson";
const EVE_STREAM_VERSION = "23";

const sameOriginConfigSchema = z
  .object({
    baseUrl: z.string().url().startsWith("https://"),
    timeoutMs: z.number().int().min(1).max(30_000).default(DEFAULT_TIMEOUT_MS),
  })
  .strict()
  .transform((config, context) => {
    const baseUrl = new URL(config.baseUrl);
    if (
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.search ||
      baseUrl.hash ||
      (baseUrl.pathname !== "/" && baseUrl.pathname !== "")
    ) {
      context.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message:
          "The canonical Eve API must use a credential-free HTTPS origin.",
      });
      return z.NEVER;
    }
    return { ...config, baseUrl: baseUrl.origin };
  });

const acceptedTurnSchema = z
  .object({
    ok: z.literal(true),
    sessionId: z.string().min(1).max(500),
    status: z.literal("accepted"),
  })
  .strict();

const cancelResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      ok: z.literal(true),
      sessionId: z.string().min(1).max(500),
      status: z.literal("accepted"),
    })
    .strict(),
  z
    .object({ ok: z.literal(true), status: z.literal("no_active_turn") })
    .strict(),
]);

const errorResponseSchema = z
  .object({ code: z.string().min(1).max(100) })
  .passthrough();

const streamEnvelopeSchema = z
  .object({ type: z.string().min(1), data: z.record(z.string(), z.unknown()) })
  .passthrough();

export interface HostedWorkloadIdentity {
  token(): Promise<string>;
}

function exactToken(value: string): string {
  if (
    value.length === 0 ||
    value.length > 8_192 ||
    value !== value.trim() ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error("Vercel workload identity token is unavailable.");
  }
  return value;
}

function endpoint(
  config: z.infer<typeof sameOriginConfigSchema>,
  path: string,
): string {
  return new URL(path, `${config.baseUrl}/`).href;
}

function forwardedPrincipal(principalInput: HostedPrincipal) {
  const principal = hostedPrincipalSchema.parse(principalInput);
  return {
    current: {
      attributes: {
        "mcp:audience": principal.audience,
        "mcp:scopes": principal.scopes,
        "mcp:workspace-id": principal.workspaceId,
      },
      authenticator: "mcp-oauth-jwks",
      issuer: principal.issuer,
      principalId: principal.ownerUserId,
      principalType: "user",
      subject: principal.ownerUserId,
    },
  };
}

async function workloadHeaders(identity: HostedWorkloadIdentity) {
  const token = exactToken(await identity.token());
  return {
    Authorization: `Bearer ${token}`,
    [VERCEL_TRUSTED_OIDC_HEADER]: token,
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0];
  if (contentType !== "application/json") {
    throw new Error("The canonical Eve API returned a non-JSON response.");
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) ||
      Number(declaredLength) > MAX_RESPONSE_BYTES)
  ) {
    throw new Error("The canonical Eve API response is too large.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("The canonical Eve API response is too large.");
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

async function postMutation(input: {
  config: z.infer<typeof sameOriginConfigSchema>;
  workloadIdentity: HostedWorkloadIdentity;
  fetchImplementation: typeof fetch;
  path: string;
  principal: HostedPrincipal;
  body: Record<string, unknown>;
}) {
  let headers: Record<string, string>;
  try {
    headers = await workloadHeaders(input.workloadIdentity);
  } catch {
    throw new SubmissionRejectedBeforeDispatchError(
      "workload_identity_unavailable",
    );
  }

  let response: Response;
  try {
    response = await input.fetchImplementation(
      endpoint(input.config, input.path),
      {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(input.config.timeoutMs),
        headers: {
          ...headers,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...input.body,
          forwardedPrincipal: forwardedPrincipal(input.principal),
        }),
      },
    );
  } catch {
    throw new SubmissionOutcomeUnknownError();
  }

  try {
    const body = await boundedJson(response);
    if (response.status >= 400 && response.status < 500) {
      const parsed = errorResponseSchema.safeParse(body);
      throw new SubmissionRejectedBeforeDispatchError(
        parsed.success ? parsed.data.code : "eve_request_rejected",
      );
    }
    if (response.status !== 202) throw new Error("Unexpected response status.");
    return acceptedTurnSchema.parse(body);
  } catch (error) {
    if (error instanceof SubmissionRejectedBeforeDispatchError) throw error;
    throw new SubmissionOutcomeUnknownError();
  }
}

async function authenticatedFetch(input: {
  config: z.infer<typeof sameOriginConfigSchema>;
  workloadIdentity: HostedWorkloadIdentity;
  fetchImplementation: typeof fetch;
  path: string;
  init?: RequestInit;
}) {
  const headers = await workloadHeaders(input.workloadIdentity);
  return input.fetchImplementation(endpoint(input.config, input.path), {
    ...input.init,
    redirect: "manual",
    signal: input.init?.signal ?? AbortSignal.timeout(input.config.timeoutMs),
    headers: { ...headers, ...input.init?.headers },
  });
}

async function readInstalledSnapshot(input: {
  config: z.infer<typeof sameOriginConfigSchema>;
  workloadIdentity: HostedWorkloadIdentity;
  fetchImplementation: typeof fetch;
  sessionId: string;
}): Promise<{
  snapshot: HostedEngineSnapshot;
  installed: MessageStreamEvent[];
}> {
  const path = `/eve/v1/session/${encodeURIComponent(input.sessionId)}/stream?startIndex=0&includeTailIndex=1`;
  const response = await authenticatedFetch({ ...input, path });
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Canonical Eve redirects are not allowed.");
  }
  if (response.status === 404) throw new HostedAdapterSessionUnavailableError();
  if (response.status !== 200 || response.body === null) {
    throw new Error("Canonical Eve stream was unavailable.");
  }
  if (
    response.headers.get("content-type")?.split(";", 1)[0] !==
    "application/x-ndjson"
  ) {
    throw new Error("Canonical Eve returned an invalid stream type.");
  }
  if (
    response.headers.get("x-eve-session-id") !== input.sessionId ||
    response.headers.get("x-eve-stream-format") !== EVE_STREAM_FORMAT ||
    response.headers.get("x-eve-stream-version") !== EVE_STREAM_VERSION
  ) {
    throw new Error("Canonical Eve returned an incompatible stream contract.");
  }
  const tailValue = response.headers.get("x-eve-stream-tail-index");
  if (tailValue === null || !/^-?\d+$/u.test(tailValue)) {
    throw new Error("Canonical Eve omitted its durable stream tail.");
  }
  const tail = Number(tailValue);
  if (!Number.isSafeInteger(tail) || tail < -1 || tail >= MAX_STREAM_EVENTS) {
    throw new Error("Canonical Eve returned an invalid durable stream tail.");
  }
  if (tail === -1) {
    await response.body.cancel().catch(() => undefined);
    return {
      snapshot: { status: sessionStatusSchema.parse("working"), events: [] },
      installed: [],
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const events: MessageStreamEvent[] = [];
  let buffered = "";
  let receivedBytes = 0;
  try {
    while (events.length <= tail) {
      const chunk = await reader.read();
      if (chunk.done) {
        buffered += decoder.decode();
        const line = buffered.trim();
        if (line.length > 0 && events.length <= tail) {
          events.push(
            streamEnvelopeSchema.parse(
              JSON.parse(line),
            ) as unknown as MessageStreamEvent,
          );
        }
        break;
      }
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > MAX_RESPONSE_BYTES) {
        throw new Error("Canonical Eve stream is too large.");
      }
      buffered += decoder.decode(chunk.value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline !== -1 && events.length <= tail) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line.length > 0) {
          events.push(
            streamEnvelopeSchema.parse(
              JSON.parse(line),
            ) as unknown as MessageStreamEvent,
          );
        }
        newline = buffered.indexOf("\n");
      }
    }
    if (events.length !== tail + 1) {
      throw new Error("Canonical Eve stream ended before its durable tail.");
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const projected = events
    .flatMap((event) => projectInstalledEveEvent(event, 0))
    .map((event, index) => ({ ...event, index }));
  const prototype = latestInstalledPrototype(events);
  const uiPreview = latestInstalledUiPreview(events);
  const implementationPlan = latestInstalledImplementationPlan(events);
  return {
    snapshot: {
      status: deriveInstalledEveStatus(events),
      events: projected,
      ...(prototype === undefined ? {} : { prototype }),
      ...(uiPreview === undefined ? {} : { uiPreview }),
      ...(implementationPlan === undefined ? {} : { implementationPlan }),
    },
    installed: events,
  };
}

async function readSnapshot(
  input: Parameters<typeof readInstalledSnapshot>[0],
): Promise<HostedEngineSnapshot> {
  return (await readInstalledSnapshot(input)).snapshot;
}

function activeTurnId(
  events: readonly MessageStreamEvent[],
): string | undefined {
  let active: string | undefined;
  for (const event of events) {
    const turnId =
      "data" in event && "turnId" in event.data
        ? (event.data.turnId as string | undefined)
        : undefined;
    if (
      turnId !== undefined &&
      !["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type)
    )
      active = turnId;
    if (
      ["turn.completed", "turn.failed", "turn.cancelled"].includes(
        event.type,
      ) &&
      (turnId === undefined || turnId === active)
    )
      active = undefined;
    if (
      ["session.waiting", "session.completed", "session.failed"].includes(
        event.type,
      )
    )
      active = undefined;
  }
  return active;
}

function cancellationSettled(
  events: readonly MessageStreamEvent[],
  startIndex: number,
  turnId: string,
): boolean {
  const next = events.slice(startIndex);
  const cancelledAt = next.findIndex(
    (event) => event.type === "turn.cancelled" && event.data.turnId === turnId,
  );
  return (
    cancelledAt >= 0 &&
    next
      .slice(cancelledAt + 1)
      .some((event) => event.type === "session.waiting")
  );
}

function outstandingRequestIds(
  events: readonly MessageStreamEvent[],
): ReadonlySet<string> {
  const outstanding = new Set<string>();
  for (const event of events) {
    if (event.type === "input.requested")
      for (const request of event.data.requests)
        outstanding.add(request.requestId);
    if (event.type === "input.resolved")
      for (const resolution of event.data.resolutions)
        outstanding.delete(resolution.requestId);
    if (event.type === "approval.settled")
      outstanding.delete(event.data.requestId);
  }
  return outstanding;
}

async function readRespondSettlement(input: {
  config: z.infer<typeof sameOriginConfigSchema>;
  workloadIdentity: HostedWorkloadIdentity;
  fetchImplementation: typeof fetch;
  sessionId: string;
  requestIds: readonly string[];
}): Promise<HostedEngineSnapshot> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const observed = await readInstalledSnapshot(input);
    const outstanding = outstandingRequestIds(observed.installed);
    if (
      observed.snapshot.status !== "input_required" ||
      input.requestIds.every((requestId) => !outstanding.has(requestId))
    )
      return observed.snapshot;
  }
  throw new SubmissionOutcomeUnknownError();
}

export function createSameOriginEveTransport(input: {
  config: unknown;
  workloadIdentity: HostedWorkloadIdentity;
  fetchImplementation?: typeof fetch;
}): HostedEveTransport {
  const config = sameOriginConfigSchema.parse(input.config);
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const common = {
    config,
    workloadIdentity: input.workloadIdentity,
    fetchImplementation,
  };
  return {
    async start(request) {
      const accepted = await postMutation({
        ...common,
        path: "/eve/v1/session",
        principal: request.principal,
        body: { message: request.prompt, operationId: request.operationId },
      });
      return {
        adapterSessionId: accepted.sessionId,
        snapshot: await readSnapshot({
          ...common,
          sessionId: accepted.sessionId,
        }),
      };
    },
    get: (request) =>
      readSnapshot({ ...common, sessionId: request.adapterSessionId }),
    async send(request) {
      const accepted = await postMutation({
        ...common,
        path: `/eve/v1/session/${encodeURIComponent(request.adapterSessionId)}`,
        principal: request.principal,
        body: { message: request.message, turnPolicy: "queue" },
      });
      if (accepted.sessionId !== request.adapterSessionId) {
        throw new SubmissionOutcomeUnknownError();
      }
      return readSnapshot({ ...common, sessionId: request.adapterSessionId });
    },
    async respond(request) {
      const accepted = await postMutation({
        ...common,
        path: `/eve/v1/session/${encodeURIComponent(request.adapterSessionId)}`,
        principal: request.principal,
        body: {
          inputResponses: request.responses.map(({ requestId, response }) =>
            response.kind === "approve"
              ? { requestId, optionId: "approve" }
              : response.kind === "deny"
                ? { requestId, optionId: "cancel" }
                : {
                    requestId,
                    ...(response.optionId === undefined
                      ? { text: response.value }
                      : { optionId: response.optionId }),
                  },
          ),
        },
      });
      if (accepted.sessionId !== request.adapterSessionId) {
        throw new SubmissionOutcomeUnknownError();
      }
      return readRespondSettlement({
        ...common,
        sessionId: request.adapterSessionId,
        requestIds: request.responses.map(({ requestId }) => requestId),
      });
    },
    async cancel(request) {
      const before = await readInstalledSnapshot({
        ...common,
        sessionId: request.adapterSessionId,
      });
      const observedTurnId = activeTurnId(before.installed);
      if (request.turnId !== undefined && request.turnId !== observedTurnId) {
        throw new SubmissionRejectedBeforeDispatchError("turn_changed");
      }
      const guardedTurnId = request.turnId ?? observedTurnId;
      const response = await authenticatedFetch({
        ...common,
        path: `/eve/v1/session/${encodeURIComponent(request.adapterSessionId)}/cancel`,
        init: {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(
            guardedTurnId === undefined ? {} : { turnId: guardedTurnId },
          ),
        },
      });
      if (response.status !== 200 && response.status !== 202) {
        throw new Error("Canonical Eve cancellation failed.");
      }
      const cancelled = cancelResponseSchema.parse(await boundedJson(response));
      if (
        (response.status === 202 && cancelled.status !== "accepted") ||
        (response.status === 200 && cancelled.status !== "no_active_turn")
      ) {
        throw new Error("Canonical Eve cancellation status was inconsistent.");
      }
      if (
        cancelled.status === "accepted" &&
        cancelled.sessionId !== request.adapterSessionId
      ) {
        throw new Error("Canonical Eve cancellation changed the session.");
      }
      if (cancelled.status === "no_active_turn") return before.snapshot;
      if (guardedTurnId === undefined)
        throw new HostedCancellationUnsettledError();
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const observed = await readInstalledSnapshot({
          ...common,
          sessionId: request.adapterSessionId,
        });
        if (
          cancellationSettled(
            observed.installed,
            before.installed.length,
            guardedTurnId,
          )
        )
          return observed.snapshot;
        const newerTurn = activeTurnId(observed.installed);
        if (newerTurn !== undefined && newerTurn !== guardedTurnId)
          throw new SubmissionRejectedBeforeDispatchError("turn_changed");
      }
      throw new HostedCancellationUnsettledError();
    },
  };
}
