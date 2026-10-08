import { createHostedReadTrace } from "./hosted-read-diagnostic";
import type { HostedReadTrace } from "./hosted-read-diagnostic";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { MessageStreamEvent } from "eve/client";
import { z } from "zod";

import { readJsonStringChecks } from "../agent/streaming-json-pointer";
import type {
  EveSessionStatus,
  PublicInputRequest,
  PublicPrototype,
  PublicPrototypeReference,
  PublicUiPreview,
  PublicWorkingPreview,
} from "../mcp/contracts";
import { hostedPrincipalSchema } from "./hosted-auth";
import type { HostedPrincipal } from "./hosted-auth";
import {
  HostedCancellationUnsettledError,
  HostedAdapterSessionUnavailableError,
  SubmissionOutcomeUnknownError,
  SubmissionRejectedBeforeDispatchError,
} from "./hosted-service";
import type { HostedEngineSnapshot, HostedEveTransport } from "./hosted-service";
import {
  nativeObservationStateSchema,
  artifactReadbackStateSchema,
} from "./native-observation-state";
import type { NativeObservationState, ArtifactReadbackState } from "./native-observation-state";
import { HostedSessionReadTimeoutError } from "./hosted-session-read-timeout-error";
import {
  createInstalledPrototypeProjector,
  createInstalledPrototypeReferenceReducer,
  deriveInstalledEveStatus,
  latestInstalledPrototype,
  latestInstalledUiPreview,
  latestInstalledWorkingPreview,
  projectInstalledEveEvent,
  toPublicEvent,
} from "./public-events";
import type { InternalEveEvent } from "./public-events";
import { reportHostedSubmissionDiagnostic } from "./hosted-submission-diagnostic";
import type { HostedSubmissionDiagnosticSink } from "./hosted-submission-diagnostic";

const DEFAULT_TIMEOUT_MS = 10_000;
const SESSION_READ_TIMEOUT_MS = 30_000;
const SESSION_SETTLEMENT_POLL_INTERVAL_MS = 200;
const VERCEL_TRUSTED_OIDC_HEADER = "x-vercel-trusted-oidc-idp-token";
const EVE_STREAM_FORMAT = "ndjson";
const EVE_STREAM_VERSION = "25";

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
        message: "The canonical Eve API must use a credential-free HTTPS origin.",
        path: ["baseUrl"],
      });
      return z.NEVER;
    }
    return { ...config, baseUrl: baseUrl.origin };
  });

const acceptedTurnSchema = z
  .object({
    deliveryId: z.string().min(1).max(500).optional(),
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
  z.object({ ok: z.literal(true), status: z.literal("no_active_turn") }).strict(),
]);

const errorResponseSchema = z.object({ code: z.string().min(1).max(100) }).passthrough();

const streamEnvelopeSchema = z
  .object({ data: z.record(z.string(), z.unknown()), type: z.string().min(1) })
  .passthrough();

export interface HostedWorkloadIdentity {
  token: () => Promise<string>;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function exactToken(value: string): string {
  if (
    value.length === 0 ||
    value.length > 8192 ||
    value !== value.trim() ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error("Vercel workload identity token is unavailable.");
  }
  return value;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function endpoint(config: z.infer<typeof sameOriginConfigSchema>, path: string): string {
  return new URL(path, `${config.baseUrl}/`).href;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function forwardedPrincipal(principalInput: HostedPrincipal, sourceHandoffId?: string) {
  const principal = hostedPrincipalSchema.parse(principalInput);
  return {
    current: {
      attributes: {
        "mcp:audience": principal.audience,
        "mcp:scopes": principal.scopes,
        "mcp:workspace-id": principal.workspaceId,
        ...(sourceHandoffId === undefined
          ? {}
          : {
              "autograph:source-handoff-id": z.string().uuid().parse(sourceHandoffId),
            }),
      },
      authenticator: "mcp-oauth-jwks",
      issuer: principal.issuer,
      principalId: principal.ownerUserId,
      principalType: "user",
      subject: principal.ownerUserId,
    },
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function workloadHeaders(identity: HostedWorkloadIdentity) {
  const token = exactToken(await identity.token());
  return {
    Authorization: `Bearer ${token}`,
    [VERCEL_TRUSTED_OIDC_HEADER]: token,
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0];
  if (contentType !== "application/json") {
    throw new Error("The canonical Eve API returned a non-JSON response.");
  }
  if (response.status >= 400) {
    const parsed = await readJsonStringChecks(response.body, [{ capture: true, pointer: "/code" }]);
    return { code: parsed.matches[0] ? parsed.values[0] : undefined };
  }
  const parsed = await readJsonStringChecks(
    response.body,
    [
      { expectedLiteral: "true", pointer: "/ok" },
      { capture: true, optional: true, pointer: "/sessionId" },
      { capture: true, pointer: "/status" },
      { capture: true, optional: true, pointer: "/deliveryId" },
    ],
    { allowedRootKeys: ["ok", "sessionId", "status", "deliveryId"] },
  );
  return {
    ok: parsed.matches[0],
    ...(parsed.values[1] === undefined ? {} : { sessionId: parsed.values[1] }),
    ...(parsed.values[2] === undefined ? {} : { status: parsed.values[2] }),
    ...(parsed.values[3] === undefined ? {} : { deliveryId: parsed.values[3] }),
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function postMutation(input: {
  config: z.infer<typeof sameOriginConfigSchema>;
  workloadIdentity: HostedWorkloadIdentity;
  fetchImplementation: typeof fetch;
  path: string;
  principal: HostedPrincipal;
  body: Record<string, unknown>;
  sourceHandoffId?: string;
  startDiagnostic?: {
    operationId: string;
    sink?: HostedSubmissionDiagnosticSink;
  };
}) {
  let headers: Record<string, string>;
  try {
    headers = await workloadHeaders(input.workloadIdentity);
  } catch {
    throw new SubmissionRejectedBeforeDispatchError("workload_identity_unavailable");
  }

  let response: Response;
  try {
    response = await input.fetchImplementation(endpoint(input.config, input.path), {
      body: JSON.stringify({
        ...input.body,
        forwardedPrincipal: forwardedPrincipal(input.principal, input.sourceHandoffId),
      }),
      headers: {
        ...headers,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(input.config.timeoutMs),
    });
  } catch (error) {
    if (input.startDiagnostic !== undefined) {
      reportHostedSubmissionDiagnostic({
        ...input.startDiagnostic,
        error,
        operationKind: "start",
        phase: "transport_dispatch",
      });
    }
    throw new SubmissionOutcomeUnknownError();
  }

  try {
    const body = await readJson(response);
    if (response.status >= 400 && response.status < 500) {
      const parsed = errorResponseSchema.safeParse(body);
      throw new SubmissionRejectedBeforeDispatchError(
        parsed.success ? parsed.data.code : "eve_request_rejected",
      );
    }
    if (response.status !== 202) {
      throw new Error("Unexpected response status.");
    }
    const accepted = acceptedTurnSchema.parse(body);
    if (input.path !== "/eve/v1/session" && accepted.deliveryId === undefined) {
      throw new Error("Canonical Eve omitted the accepted delivery identity.");
    }
    return accepted;
  } catch (error) {
    if (error instanceof SubmissionRejectedBeforeDispatchError) {
      throw error;
    }
    if (input.startDiagnostic !== undefined) {
      reportHostedSubmissionDiagnostic({
        ...input.startDiagnostic,
        error,
        operationKind: "start",
        phase: "transport_acceptance",
      });
    }
    throw new SubmissionOutcomeUnknownError();
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function authenticatedFetch(input: {
  config: z.infer<typeof sameOriginConfigSchema>;
  workloadIdentity: HostedWorkloadIdentity;
  fetchImplementation: typeof fetch;
  path: string;
  timeout?: "bounded" | "unbounded";
  init?: RequestInit;
  readTrace?: HostedReadTrace;
}) {
  input.readTrace?.enter("workload_identity");
  const headers = await workloadHeaders(input.workloadIdentity);
  input.readTrace?.enter("fetch");
  return input.fetchImplementation(endpoint(input.config, input.path), {
    ...input.init,
    headers: { ...headers, ...input.init?.headers },
    redirect: "manual",
    signal:
      input.init?.signal ??
      (input.timeout === "unbounded" ? undefined : AbortSignal.timeout(input.config.timeoutMs)),
  });
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function* streamSameOriginEveEvents(input: {
  config: z.infer<typeof sameOriginConfigSchema>;
  workloadIdentity: HostedWorkloadIdentity;
  fetchImplementation: typeof fetch;
  sessionId: string;
  readDeadline?: boolean;
  readSignal?: AbortSignal;
  startIndex?: number;
  readTrace?: HostedReadTrace;
}): AsyncGenerator<MessageStreamEvent, void, undefined> {
  // Matches the supported SDK's absolute startIndex + follow:false contract: pin this opened durable tail.
  const startIndex = z
    .number()
    .int()
    .nonnegative()
    .parse(input.startIndex ?? 0);
  const path = `/eve/v1/session/${encodeURIComponent(input.sessionId)}/stream?startIndex=${startIndex}&includeTailIndex=1`;
  const signal =
    input.readSignal ??
    (input.readDeadline === true ? AbortSignal.timeout(SESSION_READ_TIMEOUT_MS) : undefined);
  let response: Response;
  try {
    response = await authenticatedFetch({
      ...input,
      path,
      timeout: "unbounded",
      ...(signal === undefined ? {} : { init: { signal } }),
    });
  } catch (error) {
    if (signal?.aborted === true) {
      throw new HostedSessionReadTimeoutError();
    }
    throw error;
  }
  input.readTrace?.enter("headers");
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Canonical Eve redirects are not allowed.");
  }
  if (response.status === 404) {
    throw new HostedAdapterSessionUnavailableError();
  }
  if (response.status !== 200 || response.body === null) {
    throw new Error("Canonical Eve stream was unavailable.");
  }
  if (response.headers.get("content-type")?.split(";", 1)[0] !== "application/x-ndjson") {
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
  if (!Number.isSafeInteger(tail) || tail < -1) {
    throw new Error("Canonical Eve returned an invalid durable stream tail.");
  }
  if (startIndex > tail + 1) {
    // oxlint-disable-next-line promise/prefer-await-to-then -- Cancel best effort without waiting for a provider handshake.
    void response.body.cancel().catch(() => null);
    throw new Error("Canonical Eve durable tail precedes the saved native cursor.");
  }
  if (startIndex === tail + 1) {
    // Provider cancellation is best effort; a stalled cancel must not hold the response.
    // oxlint-disable-next-line promise/prefer-await-to-then -- Cleanup must not delay the reader.
    void response.body.cancel().catch(() => null);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let eventCount = startIndex;
  let buffered = "";
  try {
    while (eventCount <= tail) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      input.readTrace?.enter("decode");
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve stream backpressure
      const chunk = await reader.read();
      input.readTrace?.increment("bodyBytes", chunk.value?.byteLength ?? 0);
      if (chunk.done) {
        buffered += decoder.decode();
        const line = buffered.trim();
        if (line.length > 0 && eventCount <= tail) {
          const event = streamEnvelopeSchema.parse(
            JSON.parse(line),
          ) as unknown as MessageStreamEvent;
          eventCount += 1;
          yield event;
          if (signal?.aborted === true) {
            throw new HostedSessionReadTimeoutError();
          }
        }
        break;
      }
      // Generated files make a legitimate session history large. Read through
      // the provider's observed tail rather than imposing a lifetime byte quota.
      buffered += decoder.decode(chunk.value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline !== -1 && eventCount <= tail) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line.length > 0) {
          const event = streamEnvelopeSchema.parse(
            JSON.parse(line),
          ) as unknown as MessageStreamEvent;
          eventCount += 1;
          yield event;
          if (signal?.aborted === true) {
            throw new HostedSessionReadTimeoutError();
          }
        }
        newline = buffered.indexOf("\n");
      }
    }
    if (eventCount !== tail + 1) {
      throw new Error("Canonical Eve stream ended before its durable tail.");
    }
  } catch (error) {
    if (signal?.aborted === true) {
      throw new HostedSessionReadTimeoutError();
    }
    throw error;
  } finally {
    // The complete durable tail is already installed (or this read failed).
    // Do not let a provider stream's cancellation handshake hold the MCP reply.
    // oxlint-disable-next-line promise/prefer-await-to-then -- This cleanup must not delay the MCP response.
    void reader.cancel().catch(() => null);
    try {
      reader.releaseLock();
    } catch {
      // A pending cancellation can retain the lock until the provider closes.
    }
  }
}

/** Scan the durable tail with backpressure. Artifact content must be recovered by a receipt verifier. */
const artifactTools = new Set([
  "record_prototype_artifact",
  "record_ui_preview",
  "get_prototype_artifact",
]);
const markdownPrototypePath =
  /^prototype\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/(?:app-spec|decisions)\.md$/u;
const markdownPrototypeInputSchema = z
  .object({
    mediaType: z.string().optional(),
    path: z.string().regex(markdownPrototypePath),
  })
  .passthrough();

const v2ReadRequestSchema = z.object({
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  offsetBytes: z.number().int().nonnegative(),
  path: z.string(),
  revision: z.string().regex(/^[a-f0-9]{64}$/u),
});
const v2ReadResultSchema = z.object({
  byteOffset: z.number().int().nonnegative(),
  chunkDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  complete: z.boolean(),
  content: z.string().min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  mediaType: z.literal("text/html"),
  nextOffsetBytes: z.number().int().positive(),
  path: z.string(),
  revision: z.string().regex(/^[a-f0-9]{64}$/u),
  totalBytes: z.number().int().positive(),
});

/** A v2 receipt is sufficient for paged history; unresolved or v1 actions require legacy readback. */
const createArtifactReadbackClassifier = (sessionId: string, seed?: ArtifactReadbackState) => {
  const state = seed === undefined ? undefined : artifactReadbackStateSchema.parse(seed);
  const references = createInstalledPrototypeReferenceReducer({
    sessionId,
    state: state?.references,
  });
  const pending = new Map<
    string,
    { input: ArtifactReadbackState["pending"][number][1]["input"]; toolName: string }
  >(state?.pending);
  const markdownCalls = new Map<string, string>(state?.markdownCalls);
  const incompleteArtifacts = new Set<string>(state?.incompleteArtifacts);
  const incompleteUiPreviews = new Set<string>(state?.incompleteUiPreviews);
  let legacy = state?.legacy ?? false;
  return {
    accept(event: MessageStreamEvent) {
      references.accept(event);
      if (event.type === "actions.requested") {
        for (const action of event.data.actions) {
          if (action.kind === "tool-call" && artifactTools.has(action.toolName)) {
            if (pending.has(action.callId) || markdownCalls.has(action.callId)) {
              legacy = true;
            }
            const markdown = markdownPrototypeInputSchema.safeParse(action.input);
            if (
              markdown.success &&
              (action.toolName === "get_prototype_artifact" ||
                (action.toolName === "record_prototype_artifact" &&
                  markdown.data.mediaType === "text/markdown"))
            ) {
              markdownCalls.set(action.callId, action.toolName);
            } else {
              pending.set(action.callId, {
                input: z.json().parse(action.input ?? null),
                toolName: action.toolName,
              });
            }
          }
        }
        return;
      }
      if (event.type !== "action.result" || event.data.result.kind !== "tool-result") {
        return;
      }
      const { result } = event.data;
      if (!artifactTools.has(result.toolName)) {
        return;
      }
      const markdownTool = markdownCalls.get(result.callId);
      if (markdownTool !== undefined) {
        markdownCalls.delete(result.callId);
        if (markdownTool !== result.toolName) {
          legacy = true;
        }
        return;
      }
      const request = pending.get(result.callId);
      pending.delete(result.callId);
      if (
        request?.toolName !== result.toolName ||
        event.data.status !== "completed" ||
        result.isError === true
      ) {
        legacy = true;
        return;
      }
      const reference = references.snapshot();
      if (result.toolName === "get_prototype_artifact") {
        const read = v2ReadRequestSchema.safeParse(request.input);
        const output = v2ReadResultSchema.safeParse(result.output);
        if (
          !read.success ||
          !output.success ||
          reference === undefined ||
          read.data.path !== reference.path ||
          read.data.digest !== reference.digest ||
          read.data.revision !== reference.revision ||
          read.data.offsetBytes !== output.data.byteOffset ||
          output.data.path !== reference.path ||
          output.data.digest !== reference.digest ||
          output.data.revision !== reference.revision ||
          output.data.totalBytes !== reference.contentBytes ||
          output.data.nextOffsetBytes <= output.data.byteOffset ||
          output.data.nextOffsetBytes > reference.contentBytes ||
          output.data.complete !== (output.data.nextOffsetBytes === reference.contentBytes) ||
          createHash("sha256").update(output.data.content).digest("hex") !==
            output.data.chunkDigest ||
          Buffer.byteLength(output.data.content, "utf-8") !==
            output.data.nextOffsetBytes - output.data.byteOffset
        ) {
          legacy = true;
        }
        return;
      }
      if (result.toolName === "record_prototype_artifact") {
        const chunk = z
          .object({
            expectedDigest: z.string().regex(/^[a-f0-9]{64}$/u),
            finalChunk: z.literal(false),
            path: z.string(),
          })
          .passthrough()
          .safeParse(request.input);
        const incomplete = z
          .object({ complete: z.literal(false), path: z.string(), version: z.literal(2) })
          .passthrough()
          .safeParse(result.output);
        if (chunk.success && incomplete.success && chunk.data.path === incomplete.data.path) {
          incompleteArtifacts.add(chunk.data.path);
          return;
        }
      }
      if (result.toolName === "record_ui_preview") {
        const preview = z.object({ appId: z.string() }).passthrough().safeParse(request.input);
        const incomplete = z
          .object({ complete: z.literal(false), transferId: z.string() })
          .passthrough()
          .safeParse(result.output);
        if (preview.success && incomplete.success) {
          incompleteUiPreviews.add(preview.data.appId);
          return;
        }
      }
      const output = z
        .object({ complete: z.literal(true), version: z.literal(2) })
        .passthrough()
        .safeParse(result.output);
      if (
        !output.success ||
        reference === undefined ||
        reference.recordedByCallId !== result.callId
      ) {
        legacy = true;
      } else if (result.toolName === "record_prototype_artifact") {
        incompleteArtifacts.delete(reference.path);
      } else {
        incompleteUiPreviews.delete(reference.appId);
      }
    },
    checkpoint: (): ArtifactReadbackState =>
      artifactReadbackStateSchema.parse({
        incompleteArtifacts: [...incompleteArtifacts],
        incompleteUiPreviews: [...incompleteUiPreviews],
        legacy,
        markdownCalls: [...markdownCalls],
        pending: [...pending],
        references: references.checkpoint(),
      }),
    requiresLegacy: () =>
      legacy || pending.size > 0 || incompleteArtifacts.size > 0 || incompleteUiPreviews.size > 0,
  };
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function observeSameOriginEveStream(
  input: Parameters<typeof streamSameOriginEveEvents>[0] & {
    onEvent: (event: InternalEveEvent) => Promise<void> | void;
    onInstalledEvent?: (event: MessageStreamEvent) => void;
    onPrivateEvent?: (event: MessageStreamEvent) => Promise<void> | void;
    nativeObservationState?: NativeObservationState;
  },
): Promise<{
  installedEventCount: number;
  nextNativeIndex: number;
  nativeObservationState: NativeObservationState;
  publicEventCount: number;
  status: EveSessionStatus;
  pendingRequests: PublicInputRequest[];
  prototype?: PublicPrototype;
  prototypeRef?: PublicPrototypeReference;
  activeTurnId?: string;
  uiPreview?: PublicUiPreview;
  workingPreview?: PublicWorkingPreview | null;
  artifactProjectionRequiresLegacyReadback: boolean;
}> {
  const readTrace = input.readTrace ?? createHostedReadTrace({ sessionId: input.sessionId });
  const readSignal =
    input.readSignal ??
    (input.readDeadline === true ? AbortSignal.timeout(SESSION_READ_TIMEOUT_MS) : undefined);
  const stopWatching = readTrace.watch(readSignal);
  try {
    const state =
      input.nativeObservationState === undefined
        ? undefined
        : nativeObservationStateSchema.parse(input.nativeObservationState);
    if (state !== undefined && state.adapterSessionId !== input.sessionId) {
      throw new Error("Native observer state belongs to another adapter session.");
    }
    const pending = new Map<string, PublicInputRequest>(
      state?.pendingRequests.map((request) => [request.requestId, request]),
    );
    let installedEventCount = state?.nextNativeIndex ?? 0;
    let publicEventCount = state?.publicEventCount ?? 0;
    let boundary: EveSessionStatus = state?.boundary ?? "working";
    let invalidInput = state?.invalidInput ?? false;
    let currentTurnId: string | undefined = state?.currentTurnId;
    let uiPreview: PublicUiPreview | undefined = state?.uiPreview;
    let workingPreview: PublicWorkingPreview | null | undefined = state?.workingPreview;
    const artifactReadback = createArtifactReadbackClassifier(
      input.sessionId,
      state?.artifactReadback,
    );
    const prototype = createInstalledPrototypeProjector(state?.prototypeProjector);
    const prototypeReference = createInstalledPrototypeReferenceReducer({
      sessionId: input.sessionId,
      state: state?.prototypeReference,
    });
    readTrace.set("nativeStartIndex", installedEventCount);
    readTrace.set("nativeNextIndex", installedEventCount);
    for await (const event of streamSameOriginEveEvents({
      ...input,
      readSignal,
      readTrace,
      startIndex: state?.nextNativeIndex ?? 0,
    })) {
      readTrace.increment("decodedEvents");
      artifactReadback.accept(event);
      prototype.observe(event);
      prototypeReference.accept(event);
      input.onInstalledEvent?.(event);
      readTrace.enter("private_callback");
      await input.onPrivateEvent?.(event);
      readTrace.increment("privateCallbacks");
      readTrace.enter("decode");
      installedEventCount += 1;
      readTrace.set("nativeNextIndex", installedEventCount);
      const turnId =
        "data" in event && "turnId" in event.data
          ? (event.data.turnId as string | undefined)
          : undefined;
      if (
        turnId !== undefined &&
        !["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type)
      ) {
        currentTurnId = turnId;
      }
      if (
        ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type) &&
        (turnId === undefined || turnId === currentTurnId)
      ) {
        currentTurnId = undefined;
      }
      if (["session.waiting", "session.completed", "session.failed"].includes(event.type)) {
        currentTurnId = undefined;
      }
      if (event.type === "turn.cancelled") {
        boundary = "cancelled";
      }
      if (event.type === "session.waiting") {
        boundary = "waiting";
      }
      if (event.type === "session.completed") {
        boundary = "completed";
      }
      if (event.type === "session.failed") {
        boundary = "failed";
      }
      if (event.type === "step.started") {
        boundary = "working";
      }
      if (event.type === "approval.settled") {
        pending.delete(event.data.requestId);
      }
      const nextUiPreview = latestInstalledUiPreview([event]);
      if (nextUiPreview !== undefined) {
        uiPreview = nextUiPreview;
      }
      const nextWorkingPreview = latestInstalledWorkingPreview([event]);
      if (nextWorkingPreview !== undefined) {
        workingPreview = nextWorkingPreview;
      }
      for (const projected of projectInstalledEveEvent(event, 0)) {
        const indexed = { ...projected, index: publicEventCount };
        // Internal resolution events still update reducers/callbacks but have no public checkpoint row.
        if (toPublicEvent(indexed) !== null) {
          publicEventCount += 1;
        }
        if (indexed.type === "input.requested" && indexed.request !== undefined) {
          pending.set(indexed.request.requestId, indexed.request);
        }
        if (indexed.type === "input.resolved") {
          for (const requestId of indexed.requestIds ?? []) {
            pending.delete(requestId);
          }
        }
        if (
          event.type === "input.requested" &&
          indexed.type === "status" &&
          indexed.status === "failed"
        ) {
          invalidInput = true;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- the callback controls storage backpressure
        readTrace.enter("public_spool");
        // oxlint-disable-next-line eslint/no-await-in-loop -- preserve storage backpressure
        await input.onEvent(indexed);
        readTrace.increment("publicSpoolEvents");
        readTrace.enter("decode");
      }
    }
    let status: EveSessionStatus = boundary;
    if (invalidInput) {
      status = "failed";
    } else if (boundary !== "completed" && boundary !== "failed" && pending.size > 0) {
      status = "input_required";
    }
    readTrace.completed();
    return {
      artifactProjectionRequiresLegacyReadback: artifactReadback.requiresLegacy(),
      installedEventCount,
      nativeObservationState: nativeObservationStateSchema.parse({
        adapterSessionId: input.sessionId,
        artifactReadback: artifactReadback.checkpoint(),
        boundary,
        invalidInput,
        nextNativeIndex: installedEventCount,
        pendingRequests: [...pending.values()],
        prototypeProjector: prototype.checkpoint(),
        prototypeReference: prototypeReference.checkpoint(),
        publicEventCount,
        version: 1,
        ...(currentTurnId === undefined ? {} : { currentTurnId }),
        ...(uiPreview === undefined ? {} : { uiPreview }),
        ...(workingPreview === undefined ? {} : { workingPreview }),
      }),
      nextNativeIndex: installedEventCount,
      pendingRequests: [...pending.values()],
      ...(prototype.current() === undefined ? {} : { prototype: prototype.current() }),
      ...(prototypeReference.snapshot() === undefined
        ? {}
        : { prototypeRef: prototypeReference.snapshot() }),
      publicEventCount,
      status,
      ...(currentTurnId === undefined ? {} : { activeTurnId: currentTurnId }),
      ...(uiPreview === undefined ? {} : { uiPreview }),
      ...(workingPreview === undefined ? {} : { workingPreview }),
    };
  } catch (error) {
    readTrace.failed();
    throw error;
  } finally {
    stopWatching();
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function readInstalledSnapshot(
  input: Parameters<typeof streamSameOriginEveEvents>[0],
): Promise<{
  snapshot: HostedEngineSnapshot;
  installed: MessageStreamEvent[];
}> {
  const events: MessageStreamEvent[] = [];
  const projected: InternalEveEvent[] = [];
  for await (const event of streamSameOriginEveEvents(input)) {
    events.push(event);
    for (const publicEvent of projectInstalledEveEvent(event, 0)) {
      projected.push({ ...publicEvent, index: projected.length });
    }
  }
  const prototype = latestInstalledPrototype(events);
  const uiPreview = latestInstalledUiPreview(events);
  const workingPreview = latestInstalledWorkingPreview(events);
  return {
    installed: events,
    snapshot: {
      events: projected,
      status: deriveInstalledEveStatus(events),
      ...(prototype === undefined ? {} : { prototype }),
      ...(uiPreview === undefined ? {} : { uiPreview }),
      ...(workingPreview === undefined ? {} : { workingPreview }),
    },
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function readSnapshot(
  input: Parameters<typeof readInstalledSnapshot>[0],
): Promise<HostedEngineSnapshot> {
  const events: InternalEveEvent[] = [];
  const prototype = createInstalledPrototypeProjector();
  const observation = await observeSameOriginEveStream({
    ...input,
    onEvent(event) {
      events.push(event);
    },
    onInstalledEvent: prototype.observe,
  });
  const latest = prototype.current();
  return {
    events,
    status: observation.status,
    ...(latest === undefined ? {} : { prototype: latest }),
    ...(observation.uiPreview === undefined ? {} : { uiPreview: observation.uiPreview }),
    ...(observation.workingPreview === undefined
      ? {}
      : { workingPreview: observation.workingPreview }),
  };
}

/** A create reply may name a losing candidate; only its started stream proves ownership. */
const confirmStartedSession = async (input: Parameters<typeof streamSameOriginEveEvents>[0]) => {
  const signal = AbortSignal.timeout(SESSION_READ_TIMEOUT_MS);
  while (true) {
    signal.throwIfAborted();
    // oxlint-disable-next-line eslint/no-await-in-loop -- Startup is observed on the same candidate only.
    for await (const event of streamSameOriginEveEvents({ ...input, readSignal: signal })) {
      if (event.type === "session.started") {
        return;
      }
    }
    // No event can be treated as a replacement ownership receipt. Retry only
    // this read; another create before startup can allocate another candidate.
    // oxlint-disable-next-line eslint/no-await-in-loop -- Preserve bounded sequential startup observation.
    await delay(SESSION_SETTLEMENT_POLL_INTERVAL_MS, undefined, { signal });
  }
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function activeTurnId(events: readonly MessageStreamEvent[]): string | undefined {
  let active: string | undefined;
  for (const event of events) {
    const turnId =
      "data" in event && "turnId" in event.data
        ? (event.data.turnId as string | undefined)
        : undefined;
    if (
      turnId !== undefined &&
      !["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type)
    ) {
      active = turnId;
    }
    if (
      ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type) &&
      (turnId === undefined || turnId === active)
    ) {
      active = undefined;
    }
    if (["session.waiting", "session.completed", "session.failed"].includes(event.type)) {
      active = undefined;
    }
  }
  return active;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
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
    cancelledAt !== -1 &&
    next.slice(cancelledAt + 1).some((event) => event.type === "session.waiting")
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function outstandingRequestIds(events: readonly MessageStreamEvent[]): ReadonlySet<string> {
  const outstanding = new Set<string>();
  for (const event of events) {
    if (event.type === "input.requested") {
      for (const request of event.data.requests) {
        outstanding.add(request.requestId);
      }
    }
    if (event.type === "input.resolved") {
      for (const resolution of event.data.resolutions) {
        outstanding.delete(resolution.requestId);
      }
    }
    if (event.type === "approval.settled") {
      outstanding.delete(event.data.requestId);
    }
  }
  return outstanding;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function readRespondSettlement(input: {
  config: z.infer<typeof sameOriginConfigSchema>;
  workloadIdentity: HostedWorkloadIdentity;
  fetchImplementation: typeof fetch;
  sessionId: string;
  requestIds: readonly string[];
}): Promise<HostedEngineSnapshot> {
  const readSignal = AbortSignal.timeout(SESSION_READ_TIMEOUT_MS);
  while (true) {
    if (readSignal.aborted) {
      throw new HostedSessionReadTimeoutError();
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    const observed = await readInstalledSnapshot({ ...input, readSignal });
    const outstanding = outstandingRequestIds(observed.installed);
    if (
      observed.snapshot.status !== "input_required" ||
      input.requestIds.every((requestId) => !outstanding.has(requestId))
    ) {
      return observed.snapshot;
    }
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- retry only after the prior durable snapshot was observed
      await delay(SESSION_SETTLEMENT_POLL_INTERVAL_MS, undefined, { signal: readSignal });
    } catch (error) {
      if (readSignal.aborted) {
        throw new HostedSessionReadTimeoutError();
      }
      throw error;
    }
  }
}

// eslint-disable-next-line eslint/func-style -- Shared exact response encoding for both settlement paths.
function responsePayload(responses: Parameters<HostedEveTransport["respond"]>[0]["responses"]) {
  return responses.map(({ requestId, response }) => {
    if (response.kind === "approve") {
      return { optionId: "approve", requestId };
    }
    if (response.kind === "deny") {
      return { optionId: "cancel", requestId };
    }
    if (response.optionId === undefined) {
      return { requestId, text: response.value };
    }
    return { optionId: response.optionId, requestId };
  });
}

// eslint-disable-next-line eslint/func-style -- Wait for durable resolution without materializing Eve history.
async function readRespondSettlementIncremental(input: {
  config: z.infer<typeof sameOriginConfigSchema>;
  workloadIdentity: HostedWorkloadIdentity;
  fetchImplementation: typeof fetch;
  sessionId: string;
  requestIds: readonly string[];
}): Promise<void> {
  const readSignal = AbortSignal.timeout(SESSION_READ_TIMEOUT_MS);
  while (true) {
    if (readSignal.aborted) {
      throw new HostedSessionReadTimeoutError();
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each read verifies the durable tail before polling again.
    const observed = await observeSameOriginEveStream({
      ...input,
      onEvent() {
        // Settlement only needs the reducer's pending-request state.
      },
      readSignal,
    });
    const outstanding = new Set(observed.pendingRequests.map((request) => request.requestId));
    if (
      observed.status !== "input_required" ||
      input.requestIds.every((requestId) => !outstanding.has(requestId))
    ) {
      return;
    }
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Poll only after the prior durable tail was observed.
      await delay(SESSION_SETTLEMENT_POLL_INTERVAL_MS, undefined, { signal: readSignal });
    } catch (error) {
      if (readSignal.aborted) {
        throw new HostedSessionReadTimeoutError();
      }
      throw error;
    }
  }
}

// eslint-disable-next-line eslint/func-style -- A guarded cancel needs a durable cancel/waiting boundary.
async function readCancellationSettlementIncremental(input: {
  config: z.infer<typeof sameOriginConfigSchema>;
  workloadIdentity: HostedWorkloadIdentity;
  fetchImplementation: typeof fetch;
  sessionId: string;
  turnId: string;
  beforeEventCount: number;
}): Promise<void> {
  const readSignal = AbortSignal.timeout(SESSION_READ_TIMEOUT_MS);
  while (true) {
    if (readSignal.aborted) {
      throw new HostedSessionReadTimeoutError();
    }
    let index = 0;
    let cancelled = false;
    let settled = false;
    let currentTurnId: string | undefined;
    // oxlint-disable-next-line eslint/no-await-in-loop -- Observe the full durable tail before another poll.
    for await (const event of streamSameOriginEveEvents({ ...input, readSignal })) {
      const eventTurnId =
        "data" in event && "turnId" in event.data
          ? (event.data.turnId as string | undefined)
          : undefined;
      if (
        eventTurnId !== undefined &&
        !["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type)
      ) {
        currentTurnId = eventTurnId;
      }
      if (
        ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type) &&
        (eventTurnId === undefined || eventTurnId === currentTurnId)
      ) {
        currentTurnId = undefined;
      }
      if (["session.waiting", "session.completed", "session.failed"].includes(event.type)) {
        currentTurnId = undefined;
      }
      if (
        index >= input.beforeEventCount &&
        event.type === "turn.cancelled" &&
        event.data.turnId === input.turnId
      ) {
        cancelled = true;
      }
      if (cancelled && event.type === "session.waiting") {
        settled = true;
      }
      index += 1;
    }
    if (settled) {
      return;
    }
    if (currentTurnId !== undefined && currentTurnId !== input.turnId) {
      throw new SubmissionRejectedBeforeDispatchError("turn_changed");
    }
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Poll only after reading the durable tail.
      await delay(SESSION_SETTLEMENT_POLL_INTERVAL_MS, undefined, { signal: readSignal });
    } catch (error) {
      if (readSignal.aborted) {
        throw new HostedSessionReadTimeoutError();
      }
      throw error;
    }
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createSameOriginEveTransport(input: {
  config: unknown;
  workloadIdentity: HostedWorkloadIdentity;
  fetchImplementation?: typeof fetch;
  onSubmissionDiagnostic?: HostedSubmissionDiagnosticSink;
  verifyReadAuthority?: (input: {
    principal: HostedPrincipal;
    sessionId: string;
    adapterSessionId: string;
  }) => Promise<boolean>;
}): HostedEveTransport & {
  observe?: (request: {
    principal: HostedPrincipal;
    sessionId: string;
    adapterSessionId: string;
    onEvent: (event: InternalEveEvent) => Promise<void> | void;
    onPrivateEvent?: (event: MessageStreamEvent) => Promise<void> | void;
    readDeadline?: boolean;
    nativeObservationState?: NativeObservationState;
  }) => ReturnType<typeof observeSameOriginEveStream>;
} {
  const config = sameOriginConfigSchema.parse(input.config);
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const common = {
    config,
    fetchImplementation,
    workloadIdentity: input.workloadIdentity,
  };
  return {
    observeStarted(request) {
      // Public observation catches up to the opened durable tail; it never waits for a long-running turn.
      return observeSameOriginEveStream({
        ...common,
        nativeObservationState:
          "nativeObservationState" in request && request.nativeObservationState !== undefined
            ? nativeObservationStateSchema.parse(request.nativeObservationState)
            : undefined,
        onEvent: request.onEvent,
        onPrivateEvent: request.onPrivateEvent,
        readDeadline: request.readDeadline ?? true,
        sessionId: request.adapterSessionId,
      });
    },
    ...(input.verifyReadAuthority === undefined
      ? {}
      : {
          async observe(request) {
            const principal = hostedPrincipalSchema.parse(request.principal);
            const authorized = await input.verifyReadAuthority?.({
              adapterSessionId: request.adapterSessionId,
              principal,
              sessionId: request.sessionId,
            });
            if (authorized !== true) {
              throw new SubmissionRejectedBeforeDispatchError("session_access_denied");
            }
            return observeSameOriginEveStream({
              ...common,
              nativeObservationState:
                "nativeObservationState" in request && request.nativeObservationState !== undefined
                  ? nativeObservationStateSchema.parse(request.nativeObservationState)
                  : undefined,
              onEvent: request.onEvent,
              onPrivateEvent: request.onPrivateEvent,
              readDeadline: request.readDeadline ?? true,
              sessionId: request.adapterSessionId,
            });
          },
        }),
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
        init: {
          body: JSON.stringify(guardedTurnId === undefined ? {} : { turnId: guardedTurnId }),
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          method: "POST",
        },
        path: `/eve/v1/session/${encodeURIComponent(request.adapterSessionId)}/cancel`,
      });
      if (response.status !== 200 && response.status !== 202) {
        throw new Error("Canonical Eve cancellation failed.");
      }
      const cancelled = cancelResponseSchema.parse(await readJson(response));
      if (
        (response.status === 202 && cancelled.status !== "accepted") ||
        (response.status === 200 && cancelled.status !== "no_active_turn")
      ) {
        throw new Error("Canonical Eve cancellation status was inconsistent.");
      }
      if (cancelled.status === "accepted" && cancelled.sessionId !== request.adapterSessionId) {
        throw new Error("Canonical Eve cancellation changed the session.");
      }
      if (cancelled.status === "no_active_turn") {
        return before.snapshot;
      }
      if (guardedTurnId === undefined) {
        throw new HostedCancellationUnsettledError();
      }
      while (true) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
        const observed = await readInstalledSnapshot({
          ...common,
          sessionId: request.adapterSessionId,
        });
        if (cancellationSettled(observed.installed, before.installed.length, guardedTurnId)) {
          return observed.snapshot;
        }
        const newerTurn = activeTurnId(observed.installed);
        if (newerTurn !== undefined && newerTurn !== guardedTurnId) {
          throw new SubmissionRejectedBeforeDispatchError("turn_changed");
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- retry only after the prior durable snapshot was observed
        await delay(SESSION_SETTLEMENT_POLL_INTERVAL_MS);
      }
    },
    async cancelAccepted(request) {
      const before = await observeSameOriginEveStream({
        ...common,
        onEvent() {
          // Guarding cancellation needs only the durable stream summary.
        },
        readDeadline: true,
        sessionId: request.adapterSessionId,
      });
      if (request.turnId !== undefined && request.turnId !== before.activeTurnId) {
        throw new SubmissionRejectedBeforeDispatchError("turn_changed");
      }
      const guardedTurnId = request.turnId ?? before.activeTurnId;
      if (guardedTurnId === undefined) {
        throw new SubmissionRejectedBeforeDispatchError("no_active_turn");
      }
      let response: Response;
      try {
        response = await authenticatedFetch({
          ...common,
          init: {
            body: JSON.stringify({ turnId: guardedTurnId }),
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            method: "POST",
          },
          path: `/eve/v1/session/${encodeURIComponent(request.adapterSessionId)}/cancel`,
        });
      } catch {
        throw new SubmissionOutcomeUnknownError();
      }
      if (response.status !== 200 && response.status !== 202) {
        throw new SubmissionOutcomeUnknownError();
      }
      const cancelled = cancelResponseSchema.parse(await readJson(response));
      if (
        (response.status === 202 && cancelled.status !== "accepted") ||
        (response.status === 200 && cancelled.status !== "no_active_turn") ||
        (cancelled.status === "accepted" && cancelled.sessionId !== request.adapterSessionId)
      ) {
        throw new SubmissionOutcomeUnknownError();
      }
      if (cancelled.status === "no_active_turn") {
        return;
      }
      try {
        await readCancellationSettlementIncremental({
          ...common,
          beforeEventCount: before.installedEventCount,
          sessionId: request.adapterSessionId,
          turnId: guardedTurnId,
        });
      } catch (error) {
        if (error instanceof HostedSessionReadTimeoutError) {
          throw new HostedCancellationUnsettledError();
        }
        throw error;
      }
    },
    get: (request) =>
      readSnapshot({ ...common, readDeadline: true, sessionId: request.adapterSessionId }),
    async respond(request) {
      const accepted = await postMutation({
        ...common,
        body: { inputResponses: responsePayload(request.responses) },
        path: `/eve/v1/session/${encodeURIComponent(request.adapterSessionId)}`,
        principal: request.principal,
        sourceHandoffId: request.sourceHandoffId,
      });
      if (accepted.sessionId !== request.adapterSessionId) {
        throw new SubmissionOutcomeUnknownError();
      }
      return readRespondSettlement({
        ...common,
        requestIds: request.responses.map(({ requestId }) => requestId),
        sessionId: request.adapterSessionId,
      });
    },
    async respondAccepted(request) {
      const accepted = await postMutation({
        ...common,
        body: { inputResponses: responsePayload(request.responses) },
        path: `/eve/v1/session/${encodeURIComponent(request.adapterSessionId)}`,
        principal: request.principal,
        sourceHandoffId: request.sourceHandoffId,
      });
      if (accepted.sessionId !== request.adapterSessionId) {
        throw new SubmissionOutcomeUnknownError();
      }
      await readRespondSettlementIncremental({
        ...common,
        requestIds: request.responses.map(({ requestId }) => requestId),
        sessionId: request.adapterSessionId,
      });
    },
    async send(request) {
      const accepted = await postMutation({
        ...common,
        body: { message: request.message, turnPolicy: "queue" },
        path: `/eve/v1/session/${encodeURIComponent(request.adapterSessionId)}`,
        principal: request.principal,
        sourceHandoffId: request.sourceHandoffId,
      });
      if (accepted.sessionId !== request.adapterSessionId) {
        throw new SubmissionOutcomeUnknownError();
      }
      return readSnapshot({ ...common, sessionId: request.adapterSessionId });
    },
    async sendAccepted(request) {
      const accepted = await postMutation({
        ...common,
        body: { message: request.message, turnPolicy: "queue" },
        path: `/eve/v1/session/${encodeURIComponent(request.adapterSessionId)}`,
        principal: request.principal,
        sourceHandoffId: request.sourceHandoffId,
      });
      if (accepted.sessionId !== request.adapterSessionId) {
        throw new SubmissionOutcomeUnknownError();
      }
    },
    async start(request) {
      const accepted = await postMutation({
        ...common,
        body: { message: request.prompt, operationId: request.operationId },
        path: "/eve/v1/session",
        principal: request.principal,
        sourceHandoffId: request.sourceHandoffId,
        startDiagnostic: {
          operationId: request.operationId,
          sink: input.onSubmissionDiagnostic,
        },
      });
      try {
        await confirmStartedSession({ ...common, sessionId: accepted.sessionId });
      } catch (error) {
        reportHostedSubmissionDiagnostic({
          adapterSessionId: accepted.sessionId,
          error,
          operationId: request.operationId,
          operationKind: "start",
          phase: "transport_start_confirmation",
          sink: input.onSubmissionDiagnostic,
        });
        // The create was dispatched, but a candidate ID alone does not prove
        // it claimed the authenticated operation. Keep the reserved operation
        // uncertain so an exact later retry can resolve its canonical owner.
        throw new SubmissionOutcomeUnknownError();
      }
      return {
        adapterSessionId: accepted.sessionId,
        // Ownership is established; the model may still be running. Persist
        // the provisional public session and observe the turn on autograph_get.
        snapshot: { events: [], status: "working" },
      };
    },
  };
}
