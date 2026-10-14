import type { AgentLimitsDefinition } from "eve";
import type { MessageStreamEvent } from "eve/client";
import { z } from "zod";
import { builderSessionUsageLimits } from "../agent/session-usage-policy";
import type { EveSessionResult } from "../mcp/contracts";
import type { EveSessionService } from "./service";
import { digest } from "./hosted-operation-identifiers";

const sessionLimitKind = "session-limit";
const nativeKindSchema = z.enum(["question", sessionLimitKind, "tool-approval"]);
const nativeRequestSchema = z.strictObject({
  allowFreeform: z.boolean().optional(),
  kind: nativeKindSchema,
  optionIds: z.array(z.string()),
  requestId: z.string().min(1),
  toolName: z.string(),
});
const resolutionSchema = z.strictObject({
  kind: nativeKindSchema,
  outcome: z.enum(["answered", "approved", "denied", "ignored", "invalid"]),
  requestId: z.string().min(1),
  response: z
    .strictObject({
      optionId: z.string().optional(),
      requestId: z.string(),
      text: z.string().optional(),
    })
    .optional(),
});
export const nativeInputBatchSchema = z.strictObject({
  requests: z.array(nativeRequestSchema),
  sequence: z.number().int().nonnegative(),
  stepIndex: z.number().int().nonnegative(),
  turnId: z.string(),
});
const nativeTurnSchema = z.strictObject({
  sequence: z.number().int().nonnegative(),
  turnId: z.string(),
});
export const privateInputStateSchema = z.strictObject({
  activeTurn: nativeTurnSchema.optional(),
  frameworkSessionLimitIds: z.array(z.string().min(1)).optional(),
  pending: z.array(nativeInputBatchSchema),
  pendingFrameworkSessionLimitIds: z.array(z.string().min(1)).optional(),
  resolved: z.array(
    z.strictObject({
      batch: nativeInputBatchSchema,
      resolutions: z.array(resolutionSchema),
      stopCancelled: z.boolean().optional(),
      stopSettled: z.boolean().optional(),
      stopTurn: nativeTurnSchema.optional(),
    }),
  ),
  version: z.literal(1),
});
export type PrivateInputState = z.infer<typeof privateInputStateSchema>;
export type NativeInputBatch = z.infer<typeof nativeInputBatchSchema>;
export const emptyPrivateInputState = (): PrivateInputState => ({
  pending: [],
  resolved: [],
  version: 1,
});

export const uncappedBuilderPolicy = (
  limits: AgentLimitsDefinition = builderSessionUsageLimits,
): boolean =>
  limits.maxInputTokensPerSession === false &&
  limits.maxOutputTokensPerSession === false &&
  limits.maxTokenCostUsdPerSession === false;
export const isFrameworkSessionLimitInput = (request: {
  kind: string;
  action?: { toolName: string };
}): boolean =>
  uncappedBuilderPolicy() &&
  request.kind === sessionLimitKind &&
  request.action?.toolName === "session_limit_continuation";
/** Omit empty reducer metadata from legacy snapshots; retain every actual private input fact. */
export const retainedPrivateInputState = (
  state: PrivateInputState,
): PrivateInputState | undefined => {
  if (state.activeTurn !== undefined || state.pending.length > 0 || state.resolved.length > 0) {
    return state;
  }
  if (
    (state.frameworkSessionLimitIds?.length ?? 0) > 0 ||
    (state.pendingFrameworkSessionLimitIds?.length ?? 0) > 0
  ) {
    return state;
  }
  return undefined;
};

/** Keep framework request kinds and the exact original batch private across native cursor reads. */
const observeStopCancellation = (state: PrivateInputState, event: MessageStreamEvent): void => {
  if (event.type === "turn.cancelled") {
    for (const entry of state.resolved) {
      if (entry.stopTurn?.turnId === event.data.turnId) {
        entry.stopCancelled = true;
      }
    }
  }
};
const observeNativeCancellation = (state: PrivateInputState, event: MessageStreamEvent): void => {
  if (event.type === "turn.started") {
    state.activeTurn = nativeTurnSchema.parse({
      sequence: event.data.sequence,
      turnId: event.data.turnId,
    });
    for (const entry of state.resolved) {
      if (
        entry.stopTurn === undefined &&
        entry.resolutions.some(
          (resolution) =>
            resolution.kind === sessionLimitKind && resolution.response?.optionId === "stop",
        )
      ) {
        entry.stopTurn = state.activeTurn;
      }
    }
  }
  observeStopCancellation(state, event);
  if (
    (event.type === "turn.completed" ||
      event.type === "turn.cancelled" ||
      event.type === "turn.failed") &&
    state.activeTurn?.turnId === event.data.turnId
  ) {
    delete state.activeTurn;
  }
  if (event.type === "session.waiting") {
    for (const entry of state.resolved) {
      if (entry.stopCancelled === true) {
        entry.stopSettled = true;
      }
    }
  }
};

export const reducePrivateInput = (state: PrivateInputState, event: MessageStreamEvent): void => {
  observeNativeCancellation(state, event);
  if (event.type === "input.requested") {
    // Presentation identity is independent of mutation provenance. Missing coordinates never
    // authorize a response, but a typed framework request must not become a product question.
    const frameworkIds = event.data.requests.flatMap((request) =>
      isFrameworkSessionLimitInput(request) ? [request.requestId] : [],
    );
    state.frameworkSessionLimitIds = [
      ...new Set([...(state.frameworkSessionLimitIds ?? []), ...frameworkIds]),
    ];
    state.pendingFrameworkSessionLimitIds = [
      ...new Set([...(state.pendingFrameworkSessionLimitIds ?? []), ...frameworkIds]),
    ];
    const parsed = nativeInputBatchSchema.safeParse({
      ...event.data,
      requests: event.data.requests.map((request) => ({
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Preserve absence in private native request metadata.
        ...(request.allowFreeform === undefined ? {} : { allowFreeform: request.allowFreeform }),
        kind: request.kind,
        optionIds: (request.options ?? []).map((option) => option.id),
        requestId: request.requestId,
        toolName: request.action?.toolName ?? "",
      })),
    });
    // Older development histories may omit native coordinates. Preserve their public input,
    // but never invent private framework continuation provenance for them.
    if (!parsed.success) {
      return;
    }
    const batch = parsed.data;
    if (!state.pending.some((prior) => digest(prior) === digest(batch))) {
      state.pending.push(batch);
    }
  }
  if (event.type === "input.resolved") {
    const ids = new Set(event.data.resolutions.map((resolution) => resolution.requestId));
    state.pendingFrameworkSessionLimitIds = state.pendingFrameworkSessionLimitIds?.filter(
      (id) => !ids.has(id),
    );
    // oxlint-disable-next-line eslint/no-use-before-define -- Helpers are initialized before the native reducer is called.
    reduceResolvedPrivateInput(state, event);
  }
};
const reduceResolvedPrivateInput = (
  state: PrivateInputState,
  event: Extract<MessageStreamEvent, { type: "input.resolved" }>,
): void => {
  for (const batch of state.pending) {
    const matching = event.data.resolutions.filter((resolution) =>
      batch.requests.some(
        (request) => request.requestId === resolution.requestId && request.kind === resolution.kind,
      ),
    );
    if (matching.length === 0) {
      continue;
    }
    const previous = state.resolved.find((entry) => digest(entry.batch) === digest(batch));
    if (previous === undefined) {
      state.resolved.push({
        batch,
        resolutions: matching.map((resolution) => resolutionSchema.parse(resolution)),
      });
    } else {
      for (const resolution of matching) {
        if (!previous.resolutions.some((prior) => prior.requestId === resolution.requestId)) {
          previous.resolutions.push(resolutionSchema.parse(resolution));
        }
      }
    }
    const resolved = state.resolved.find((entry) => digest(entry.batch) === digest(batch));
    if (
      resolved !== undefined &&
      resolved.stopTurn === undefined &&
      state.activeTurn !== undefined &&
      matching.some(
        (resolution) =>
          resolution.kind === sessionLimitKind && resolution.response?.optionId === "stop",
      )
    ) {
      resolved.stopTurn = state.activeTurn;
    }
    if (
      batch.requests.every(
        (request) =>
          resolved?.resolutions.some((resolution) => resolution.requestId === request.requestId) ===
          true,
      )
    ) {
      state.pending = state.pending.filter((entry) => entry !== batch);
    }
  }
};
export const privateInputForEvents = (events: readonly MessageStreamEvent[]): PrivateInputState => {
  const state = emptyPrivateInputState();
  for (const event of events) {
    reducePrivateInput(state, event);
  }
  return state;
};
const isNativeSessionLimitRequest = (request: NativeInputBatch["requests"][number]): boolean => {
  if (request.kind !== sessionLimitKind || request.toolName !== "session_limit_continuation") {
    return false;
  }
  return request.allowFreeform !== true && request.optionIds.includes("continue");
};
export const isLegacySessionLimitRequest = (
  request: NativeInputBatch["requests"][number],
): boolean => uncappedBuilderPolicy() && isNativeSessionLimitRequest(request);
export const guardRequestIds = (state: PrivateInputState): string[] =>
  state.pending.flatMap((batch) =>
    batch.requests.flatMap((request) =>
      isLegacySessionLimitRequest(request) ? [request.requestId] : [],
    ),
  );
export const resolvedGuardRequestIds = (state: PrivateInputState): string[] =>
  state.resolved.flatMap(({ batch, resolutions }) =>
    batch.requests.flatMap((request) => {
      if (!isLegacySessionLimitRequest(request)) {
        return [];
      }
      const continued = resolutions.some(
        (resolution) =>
          resolution.requestId === request.requestId &&
          resolution.kind === sessionLimitKind &&
          resolution.outcome === "answered" &&
          resolution.response?.optionId === "continue",
      );
      return continued ? [request.requestId] : [];
    }),
  );
type Responses = Parameters<EveSessionService["respond"]>[0]["responses"];
/** Preserve complete native order, adding only framework continuation answers. */
export const mergeSessionLimitResponses = (
  state: PrivateInputState,
  responses: Responses,
): Responses => {
  const requests = state.pending.flatMap((batch) => batch.requests);
  const human = requests.filter((request) => !isLegacySessionLimitRequest(request));
  if (
    human.length !== responses.length ||
    human.some((request, index) => request.requestId !== responses[index]?.requestId)
  ) {
    throw new Error("The complete outstanding product input batch is required.");
  }
  let index = 0;
  return requests.map((request) => {
    if (isLegacySessionLimitRequest(request)) {
      return {
        requestId: request.requestId,
        response: { kind: "answer", optionId: "continue", value: "continue" },
      };
    }
    const response = responses[index];
    index += 1;
    return response;
  });
};
export const omitControlledGuardQuestions = (
  result: EveSessionResult,
  ids: readonly string[],
): EveSessionResult => {
  if (ids.length === 0) {
    return result;
  }
  const controlledIds = new Set(ids);
  return {
    ...result,
    events: result.events.filter(
      (event) => event.type !== "input_required" || !controlledIds.has(event.request.requestId),
    ),
    inputRequests: (result.inputRequests ?? []).filter(
      (request) => !controlledIds.has(request.requestId),
    ),
  };
};

export const pendingFrameworkGuardIds = (state: PrivateInputState): string[] =>
  uncappedBuilderPolicy()
    ? [...new Set([...(state.pendingFrameworkSessionLimitIds ?? []), ...guardRequestIds(state)])]
    : [];
export const presentSessionLimitState = (
  result: EveSessionResult,
  state: PrivateInputState | undefined,
): EveSessionResult => {
  if (state === undefined || !uncappedBuilderPolicy()) {
    return result;
  }
  const ids = [
    ...new Set([
      ...(state.frameworkSessionLimitIds ?? []),
      ...guardRequestIds(state),
      ...resolvedGuardRequestIds(state),
    ]),
  ];
  const presented = omitControlledGuardQuestions(result, ids);
  if (
    pendingFrameworkGuardIds(state).length === 0 ||
    ["cancelled", "failed", "completed"].includes(result.status)
  ) {
    return presented;
  }
  const humanInput = (presented.inputRequests?.length ?? 0) > 0;
  if (result.error === undefined && !humanInput) {
    presented.error = {
      code: "framework_continuation_unavailable",
      message:
        "Builder's saved continuation is awaiting internal reconciliation. Keep this session; no product decision is required.",
    };
  }
  return {
    ...presented,

    status: result.status === "input_required" && !humanInput ? "waiting" : result.status,
  };
};
export const internalSessionLimitResponseSchema = z
  .strictObject({
    adapterGeneration: z.number().int().positive(),
    adapterSessionId: z.string().min(1),
    batches: z.array(nativeInputBatchSchema),
    decision: z.enum(["continue", "stop"]),
    responses: z.array(
      z.strictObject({
        optionId: z.string().optional(),
        requestId: z.string().min(1),
        text: z.string().optional(),
      }),
    ),
    stoppedBuildTurnId: z.string().optional(),
  })
  .superRefine((marker, context) => {
    const requests = marker.batches.flatMap((batch) => batch.requests);
    if (
      !requests.some(isNativeSessionLimitRequest) ||
      requests.length !== marker.responses.length ||
      requests.some(
        (request, index) =>
          request.requestId !== marker.responses[index]?.requestId ||
          (isNativeSessionLimitRequest(request) &&
            marker.responses[index]?.optionId !== marker.decision),
      ) ||
      new Set(requests.map((request) => request.requestId)).size !== requests.length
    ) {
      context.addIssue({
        code: "custom",
        message: "A framework continuation must bind its complete exact native batch.",
      });
    }
  });
export type InternalSessionLimitResponse = z.infer<typeof internalSessionLimitResponseSchema>;
export const nativeResponses = (responses: Responses): InternalSessionLimitResponse["responses"] =>
  responses.map(({ requestId, response }) => {
    if (response.kind === "approve") {
      return { optionId: "approve", requestId };
    }
    if (response.kind === "deny") {
      return { optionId: "cancel", requestId };
    }
    return response.optionId === undefined
      ? { requestId, text: response.value }
      : { optionId: response.optionId, requestId };
  });
/** Disappearance, a new native cursor, or a stop response never proves continuation. */
export const provesSessionLimitResponse = (
  marker: InternalSessionLimitResponse,
  state: PrivateInputState,
): boolean =>
  marker.batches.every((batch) => {
    const resolved = state.resolved.find((entry) => digest(entry.batch) === digest(batch));
    if (marker.decision === "stop" && resolved?.stopSettled !== true) {
      return false;
    }
    return batch.requests.every((request) => {
      const evidence = resolved?.resolutions.find(
        (resolution) =>
          resolution.requestId === request.requestId && resolution.kind === request.kind,
      );
      const expected = marker.responses.find(
        (response) => response.requestId === request.requestId,
      );
      if (evidence === undefined || evidence.response === undefined || expected === undefined) {
        return false;
      }
      if (digest(evidence.response) !== digest(expected)) {
        return false;
      }
      if (request.kind === "tool-approval") {
        const outcome = expected.optionId === "approve" ? "approved" : "denied";
        return evidence.outcome === outcome;
      }
      if (evidence.outcome !== "answered") {
        return false;
      }
      return (
        !isNativeSessionLimitRequest(request) || evidence.response.optionId === marker.decision
      );
    });
  });

export const frameworkGuardBatches = (state: PrivateInputState): NativeInputBatch[] =>
  state.pending.filter(
    (batch) => batch.requests.length > 0 && batch.requests.every(isLegacySessionLimitRequest),
  );
export const matchesReservedGuardResponse = (
  state: PrivateInputState,
  marker: InternalSessionLimitResponse,
  responses: Responses,
): boolean => {
  if (digest(nativeResponses(responses)) !== digest(marker.responses)) {
    return false;
  }
  if (marker.decision === "continue") {
    return digest(state.pending) === digest(marker.batches);
  }
  return marker.batches.every(
    (batch) =>
      batch.requests.every(
        (request) => isLegacySessionLimitRequest(request) && request.optionIds.includes("stop"),
      ) && state.pending.some((current) => digest(current) === digest(batch)),
  );
};

export const matchesPendingGuardStop = (
  marker: InternalSessionLimitResponse,
  state: PrivateInputState,
): boolean =>
  marker.decision === "stop" &&
  marker.batches.some((batch) =>
    state.pending.some((pending) => digest(pending) === digest(batch)),
  );

/** Use observed opaque turn IDs, never a synthesized active identity or source/version comparison. */
export const sessionLimitCancelledTurns = (state: PrivateInputState): string[] =>
  state.resolved.flatMap((entry) =>
    entry.stopSettled === true && entry.stopTurn !== undefined ? [entry.stopTurn.turnId] : [],
  );
