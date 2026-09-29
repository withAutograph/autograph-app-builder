/* eslint-disable eslint/no-await-in-loop -- Public session continuations and SSE chunks are ordered. */
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync } from "node:fs";
import path from "node:path";
import {
  eveRespondInputSchema,
  eveSessionResultSchema,
  eveStartInputSchema,
} from "../../lib/mcp/contracts";
import type { EveSessionResult } from "../../lib/mcp/contracts";
import type { z } from "zod";
import { sanitizeEvidence } from "./self-reproduction-evidence";

export type Responses = {
  requestId: string;
  response: { kind: "approve" | "deny" } | { kind: "answer"; value: string; optionId?: string };
}[];
export type PublicStartInput = z.infer<typeof eveStartInputSchema>;
export interface PublicState {
  version: 1;
  endpoint: string;
  prompt: string;
  clientRequestId: string;
  originalStart?: PublicStartInput;
  startSubmitted?: boolean;
  unresolvedStartResult?: EveSessionResult;
  startedAt: string;
  session?: EveSessionResult;
  pendingMessage?: { clientRequestId: string; message: string };
  pendingResponse?: { clientRequestId: string; responses: Responses };
  answered: string[];
  outcome: string;
  error?: string;
  promptSha256?: string;
  sourceRevision?: string;
  driverRevision?: string;
  startRequestSha256?: string;
}
export interface PublicTransport {
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/** Canonical public input is saved before dispatch and reused unchanged on every retry. */
export const originalPublicStart = (state: PublicState): PublicStartInput =>
  eveStartInputSchema.parse(
    state.originalStart ?? { clientRequestId: state.clientRequestId, prompt: state.prompt },
  );

/** The CLI may supply any existing public start shape; it cannot add private source instructions. */
export const parsePublicStartFile = (contents: string): PublicStartInput =>
  eveStartInputSchema.parse(JSON.parse(contents));

const redactObservationUrls = (entry: unknown): unknown => {
  if (typeof entry === "string") {
    return entry.replaceAll(/https?:\/\/[^\s"'<>`]+/giu, (value) => {
      try {
        return `${new URL(value).origin}/[REDACTED URL]`;
      } catch {
        return "[REDACTED URL]";
      }
    });
  }
  if (Array.isArray(entry)) {
    return entry.map(redactObservationUrls);
  }
  if (entry && typeof entry === "object") {
    return Object.fromEntries(
      Object.entries(entry).map(([key, item]) => [key, redactObservationUrls(item)]),
    );
  }
  return entry;
};

/** Public artifacts retain URL origins only; opaque capabilities can live in paths or queries. */
export const sanitizePublicObservation = (value: unknown): unknown =>
  redactObservationUrls(sanitizeEvidence(value));

/** Preserve every original public response privately, separately from the shareable transcript. */
export const recordPublicObservation = (outputDir: string, record: unknown) => {
  const privatePath = path.join(outputDir, "transcript.private.jsonl");
  if (existsSync(privatePath)) {
    chmodSync(privatePath, 0o600);
  }
  appendFileSync(privatePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  appendFileSync(
    path.join(outputDir, "transcript.jsonl"),
    `${JSON.stringify(sanitizePublicObservation(record))}\n`,
    { mode: 0o600 },
  );
};

export const publicObservationReport = (state: PublicState, nowMs = Date.now()) => {
  const receipt = state.session?.workingPreview;
  const failed = state.session?.status === "failed" || state.session?.status === "cancelled";
  let availability: "reported_ready" | "expired" | "unavailable" | "unassessed" = "unassessed";
  let reason = "No working-app receipt was exposed by the public session.";
  if (failed || receipt === null) {
    availability = "unavailable";
    reason = failed
      ? "The public session failed or was cancelled."
      : "The public session explicitly invalidated its working-app preview; the cause is not established by this receipt alone.";
  } else if (receipt) {
    const expired = Date.parse(receipt.expiresAt) <= nowMs;
    availability = expired ? "expired" : "reported_ready";
    reason = expired
      ? "The working-app preview receipt has expired."
      : "The Builder reported runtime readiness at verifiedAt; current reachability and product behavior still require browser assessment.";
  }
  return sanitizePublicObservation({
    ...state,
    comparison: "unassessed",
    elapsedMs: nowMs - Date.parse(state.startedAt),
    note: "A completed Builder session or HTTP-ready preview does not prove a working independent replica. Compare user-visible behavior separately.",
    outOfBoxProof: false,
    previewObservation: {
      backendCorrectness: "unassessed",
      browserInteraction: "unassessed",
      fixtureUi: {
        functionality: "fixtures-only",
        present: state.session?.uiPreview !== undefined,
      },
      independentChildCreation: "unassessed",
      observedAt: new Date(nowMs).toISOString(),
      prototype: {
        functionality: "visual-prototype",
        present: state.session?.prototype !== undefined,
      },
      workingApp: {
        availability,
        reason,
        ...(receipt ? { expiresAt: receipt.expiresAt, verifiedAt: receipt.verifiedAt } : {}),
      },
    },
    redaction:
      "Shareable URLs retain origins only. Original public responses and usable preview URLs remain in owner-only transcript.private.jsonl and state.json; do not share these private files.",
  });
};

export const validatePublicEndpoint = (endpoint: string) => {
  const url = new URL(endpoint);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  ) {
    throw new Error(
      "Endpoint must be credential-free HTTPS or loopback HTTP without query or fragment.",
    );
  }
  return url;
};

const redactTransportToken = (value: unknown, bearerToken: string | undefined): unknown => {
  if (bearerToken === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return value.replaceAll(bearerToken, "[REDACTED TOKEN]");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactTransportToken(entry, bearerToken));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key.replaceAll(bearerToken, "[REDACTED TOKEN]"),
        redactTransportToken(entry, bearerToken),
      ]),
    );
  }
  return value;
};

interface PublicTransportOptions {
  /** Supplied from the CLI's server-side environment, never from the brief or persisted state. */
  bearerToken?: string;
}

const publicRequestHeaders = (
  session: string | undefined,
  bearerToken: string | undefined,
): Headers => {
  const headers = new Headers({
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": "2025-03-26",
  });
  if (session !== undefined) {
    headers.set("Mcp-Session-Id", session);
  }
  if (bearerToken !== undefined) {
    headers.set("Authorization", `Bearer ${bearerToken}`);
  }
  return headers;
};

export const makePublicTransport = async (
  endpoint: string,
  record: (value: unknown) => void,
  timeoutMs: number,
  options: PublicTransportOptions = {},
): Promise<PublicTransport> => {
  const url = validatePublicEndpoint(endpoint);
  const { bearerToken } = options;
  if (bearerToken !== undefined && (!bearerToken || /[\r\n]/u.test(bearerToken))) {
    throw new Error("The public MCP access token must be nonempty and contain no line breaks.");
  }
  const recordSafely = (value: unknown) => {
    record(redactTransportToken(value, bearerToken));
  };
  let session: string | undefined;
  let sequence = 0;
  const performRpc = async (
    method: string,
    params: unknown,
    notification = false,
  ): Promise<unknown> => {
    sequence += 1;
    const id = sequence;
    const response = await fetch(url, {
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params }),
      credentials: "omit",
      headers: publicRequestHeaders(session, bearerToken),
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Public MCP HTTP ${response.status}`);
    }
    session = response.headers.get("mcp-session-id") ?? session;
    if (notification) {
      await response.body?.cancel();
      return undefined;
    }
    let envelope: { id?: number; result?: unknown; error?: unknown };
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("Missing public MCP response body");
      }
      const decoder = new TextDecoder();
      let buffer = "";
      let found: typeof envelope | undefined;
      try {
        while (!found) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const event = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = event
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (data) {
              const parsed = JSON.parse(data) as typeof envelope;
              if (parsed.id === id) {
                found = parsed;
              }
            }
            boundary = buffer.indexOf("\n\n");
          }
        }
      } finally {
        await reader.cancel();
      }
      if (!found) {
        throw new Error("Public MCP stream ended without response");
      }
      envelope = found;
    } else {
      envelope = (await response.json()) as typeof envelope;
    }
    if (envelope.error) {
      throw new Error(
        `Public MCP error: ${JSON.stringify(redactTransportToken(envelope.error, bearerToken))}`,
      );
    }
    return envelope.result;
  };
  const rpc = async (method: string, params: unknown, notification = false): Promise<unknown> => {
    try {
      return await performRpc(method, params, notification);
    } catch (error) {
      // oxlint-disable-next-line eslint/preserve-caught-error -- A raw provider cause can echo credentials; only sanitized text leaves the transport boundary.
      throw new Error(
        String(
          redactTransportToken(error instanceof Error ? error.message : String(error), bearerToken),
        ),
      );
    }
  };
  await rpc("initialize", {
    capabilities: {},
    clientInfo: { name: "self-reproduction-public-observer", version: "1" },
    protocolVersion: "2025-03-26",
  });
  await rpc("notifications/initialized", {}, true);
  return {
    call: async (name, args) => {
      if (
        !["autograph_start", "autograph_get", "autograph_respond", "autograph_send"].includes(name)
      ) {
        throw new Error("Only public user lifecycle calls are permitted");
      }
      recordSafely({ arguments: args, at: new Date().toISOString(), direction: "request", name });
      const result = (await rpc("tools/call", { arguments: args, name })) as {
        isError?: boolean;
        structuredContent?: unknown;
        content?: { type: string; text?: string }[];
      };
      recordSafely({ at: new Date().toISOString(), direction: "response", name, result });
      if (result.isError && !eveSessionResultSchema.safeParse(result.structuredContent).success) {
        throw new Error("Public App Builder tool returned an error; see transcript");
      }
      return redactTransportToken(
        result.structuredContent ??
          JSON.parse(
            String(
              redactTransportToken(
                result.content?.find((item) => item.type === "text")?.text ?? "null",
                bearerToken,
              ),
            ),
          ),
        bearerToken,
      );
    },
  };
};

interface SessionOptions {
  state: PublicState;
  transport: PublicTransport;
  save: () => void;
  responses?: Responses;
  message?: string;
  timeoutMs: number;
  pollMs: number;
  sleep?: (ms: number) => Promise<void>;
  onObservation?: (state: PublicState) => void;
}

type AcceptSession = (raw: unknown) => void;

const canRecoverStart = (result: EveSessionResult): boolean =>
  result.error?.code === "submission_unknown" || result.error?.code === "start_request_not_found";

/** A missing handle is an unresolved start result, never a usable session or replacement request. */
const observeOriginalStart = async (
  options: SessionOptions,
  accept: AcceptSession,
): Promise<boolean> => {
  const { state, transport, save } = options;
  const originalStart = originalPublicStart(state);
  state.originalStart = originalStart;
  const observe = (raw: unknown): boolean => {
    const result = eveSessionResultSchema.parse(raw);
    if (result.sessionId.length > 0) {
      accept(result);
      delete state.unresolvedStartResult;
      save();
      return true;
    }
    state.unresolvedStartResult = result;
    state.outcome = canRecoverStart(result)
      ? "start_submission_unresolved"
      : "blocked_missing_public_session";
    state.error =
      result.error?.message ??
      "Builder did not return a public session handle. Preserve the original start request and inspect the retained response.";
    save();
    return false;
  };
  const recover = async () =>
    observe(
      await transport.call("autograph_get", { clientRequestId: originalStart.clientRequestId }),
    );
  if (state.unresolvedStartResult && !canRecoverStart(state.unresolvedStartResult)) {
    return false;
  }
  if (state.startSubmitted) {
    if (await recover()) {
      return true;
    }
    if (!state.unresolvedStartResult || !canRecoverStart(state.unresolvedStartResult)) {
      return false;
    }
  }
  state.startSubmitted = true;
  save();
  if (observe(await transport.call("autograph_start", originalStart))) {
    return true;
  }
  if (state.unresolvedStartResult && canRecoverStart(state.unresolvedStartResult)) {
    return await recover();
  }
  return false;
};

const sendPendingMessage = async (options: SessionOptions, accept: AcceptSession) => {
  const { state, save, transport } = options;
  if (options.message !== undefined && !state.pendingMessage) {
    if (!options.message.trim() || options.message.length > 32_000) {
      throw new Error("Message must contain 1 to 32000 characters");
    }
    if (state.session?.status !== "waiting" || state.session.inputRequests?.length) {
      throw new Error(
        "Ordinary messages require a waiting public conversation without structured input requests",
      );
    }
    state.pendingMessage = { clientRequestId: randomUUID(), message: options.message };
    save();
  }
  if (state.pendingMessage) {
    const pending = state.pendingMessage;
    if (!state.session) {
      throw new Error("Missing public session for pending message");
    }
    accept(
      await transport.call("autograph_send", { ...pending, sessionId: state.session.sessionId }),
    );
    delete state.pendingMessage;
    save();
  }
};
const validateResponses = (session: EveSessionResult, responses: Responses) => {
  const requests = session.inputRequests ?? [];
  eveRespondInputSchema.parse({
    clientRequestId: "validation",
    responses,
    sessionId: session.sessionId,
  });
  for (const item of responses) {
    const request = requests.find((entry) => entry.requestId === item.requestId);
    if (!request) {
      throw new Error("Unknown request");
    }
    if (request.kind === "approval" && item.response.kind === "answer") {
      throw new Error("Approval requires explicit approve or deny");
    }
    if (request.kind === "question" && item.response.kind !== "answer") {
      throw new Error("Question requires an ordinary answer");
    }
    const { response } = item;
    if (
      response.kind === "answer" &&
      ((!request.allowFreeform && !response.optionId) ||
        (response.optionId && !request.options?.some((option) => option.id === response.optionId)))
    ) {
      throw new Error("Answer must use a supported option");
    }
  }
};
// Persist a complete response batch before any public continuation call.
const prepareResponse = (options: SessionOptions, session: EveSessionResult): boolean => {
  const { state, save } = options;
  const requests = session.inputRequests ?? [];
  if (requests.some((request) => request.kind === "authorization")) {
    state.outcome = "blocked_authorization_requires_product_ui";
    save();
    return false;
  }
  if (!requests.length || !options.responses) {
    state.outcome = "input_required";
    save();
    return false;
  }
  const { responses } = options;
  const requested = new Set(requests.map((request) => request.requestId));
  if (
    responses.length !== requests.length ||
    responses.some(
      (item) => !requested.has(item.requestId) || state.answered.includes(item.requestId),
    )
  ) {
    state.outcome = "input_required";
    save();
    return false;
  }
  validateResponses(session, responses);
  state.pendingResponse = { clientRequestId: randomUUID(), responses };
  save();
  return true;
};

export const runPublicSession = async (options: SessionOptions) => {
  const { state, transport, save } = options;
  if (state.session?.sessionId === "") {
    state.unresolvedStartResult = state.session;
    state.startSubmitted = true;
    delete state.session;
    save();
  }
  if (options.message !== undefined && !state.session) {
    throw new Error("An ordinary message requires an existing public session");
  }
  if (options.message !== undefined && (state.pendingResponse || options.responses)) {
    throw new Error("Send one complete response batch or one ordinary message at a time");
  }
  const deadline = Date.now() + options.timeoutMs;
  const accept = (raw: unknown) => {
    const result = eveSessionResultSchema.parse(raw);
    if (!result.sessionId) {
      throw new Error(
        "Builder returned no public session handle. The prior session and exact pending request are preserved; inspect the retained response before resuming.",
      );
    }
    state.session = result;
    state.outcome = state.session.status;
    delete state.error;
    save();
    options.onObservation?.(state);
  };
  const respond = async () => {
    const pending = state.pendingResponse;
    if (!pending || !state.session) {
      throw new Error("Missing pending response session");
    }
    accept(
      await transport.call("autograph_respond", {
        ...pending,
        sessionId: state.session.sessionId,
      }),
    );
    state.answered.push(...pending.responses.map((item) => item.requestId));
    delete state.pendingResponse;
    save();
  };
  if (!state.session) {
    if (!(await observeOriginalStart(options, accept))) {
      return;
    }
  } else if (!state.pendingResponse && !state.pendingMessage) {
    accept(
      await transport.call("autograph_get", {
        cursor: state.session.cursor,
        sessionId: state.session.sessionId,
      }),
    );
  }
  if (state.pendingResponse) {
    await respond();
  }
  await sendPendingMessage(options, accept);
  while (Date.now() < deadline) {
    const { session } = state;
    if (!session) {
      throw new Error("Missing public session");
    }
    if (["completed", "failed", "cancelled"].includes(session.status)) {
      state.outcome = session.status;
      save();
      return;
    }
    if (session.status === "waiting") {
      state.outcome = "waiting";
      save();
      return;
    }
    if (session.status === "input_required") {
      if (!prepareResponse(options, session)) {
        return;
      }
      await respond();
    } else {
      await (options.sleep ?? delay)(options.pollMs);
      accept(
        await transport.call("autograph_get", {
          cursor: session.cursor,
          sessionId: session.sessionId,
        }),
      );
    }
  }
  state.outcome = "paused_timeout";
  save();
};
