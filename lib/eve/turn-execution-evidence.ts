import type { MessageStreamEvent } from "eve/client";
import { z } from "zod";

/** Native event positions only. Neither assistant prose nor workflow-state labels establish dispatch. */
export interface NativeEvidenceReference {
  nativeIndex: number;
  eventId: string;
  at: string;
  deliveryIds: readonly string[];
}
export interface NativeExecutionAttempt {
  turnId: string;
  callId: string;
  toolName: string;
  category: "status-read" | "execution" | "unclassified";
  requested?: NativeEvidenceReference;
  result?: NativeEvidenceReference & { status: "completed" | "failed" | "rejected" };
  /** A reference returned by the tool, not independent provider execution proof. */
  commandReferences: { commandId: string; nativeIndex: number }[];
}
export type NativeTurnSelector =
  | { turnId: string }
  | { messageIndex: number }
  | { deliveryId: string };
const statusTools = new Set([
  "artifact_workflow_status",
  "workspace_status",
  "source_status",
  "app_creation_status",
  "change_set_status",
  "get-app-hosted-runtime",
  "get-app-integration-capability",
]);
const executionTools = new Set([
  "prepare_workspace",
  "prepare-app-creation",
  "apply_app_creation",
  "prepare_target_dependencies",
  "compile-app-schema-release",
  "validate_app_creation",
  "validate-app-creation",
  "start_app_preview",
  "prepare-app-local-preview",
  "prepare-app-hosted-runtime",
  "run-app-browser-tests",
  "run-app-continuity-tests",
  "verify_app_behavior",
  "install-app-integrations",
  "reconcile_github_draft_pr",
  "validate_github_draft_pr_reconciliation",
  "prepare-app-public-release",
  "release-app-public",
  "prepare-app-integration-capability",
]);
const category = (toolName: string): NativeExecutionAttempt["category"] => {
  if (statusTools.has(toolName)) {
    return "status-read";
  }
  if (executionTools.has(toolName)) {
    return "execution";
  }
  return "unclassified";
};
const invalid = () => new Error("native_turn_evidence_unavailable");
/** Inspect one own data descriptor without invoking private input/output accessors. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Closed metadata descriptor boundary; never traverse source bodies or errors.
const own = (value: unknown, key: string): unknown => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Object descriptor APIs require an object; this does not authorize its contents.
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(value, key)?.value;
};
const identifierSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,512}$/u);
const identifier = (value: string) => identifierSchema.parse(value);
const commandIdSchema = z.string().regex(/^cmd_[A-Za-z0-9_-]{1,160}$/u);
const selectedBySchema = z.enum([
  "latest-observed-turn",
  "turn-id",
  "native-message-index",
  "delivery-id",
]);
const executionSchema = z.enum(["unexercised", "requested", "result-observed", "unassessed"]);
interface Turn {
  turnId: string;
  sequence: number;
  started: NativeEvidenceReference;
  messages: NativeEvidenceReference[];
  boundary?: NativeEvidenceReference & { kind: "completed" | "failed" | "cancelled" };
  attempts: Map<string, NativeExecutionAttempt>;
}
export interface NativeTurnExecutionEvidence {
  version: 1;
  kind: "native-turn-execution-evidence-v1";
  sessionId: string;
  ownerLineage: readonly string[];
  nativeCursor: number;
  selectedBy: z.infer<typeof selectedBySchema>;
  selectedTurn: {
    turnId: string;
    sequence: number;
    started: NativeEvidenceReference;
    acceptedMessages: NativeEvidenceReference[];
    boundary?: Turn["boundary"];
    attempts: NativeExecutionAttempt[];
    execution: z.infer<typeof executionSchema>;
  };
  lastHistoricalFailedExecution?: NativeExecutionAttempt;
  /** Recovered native streams can contain actions without a corresponding observed turn start. */
  unassociatedEvents: {
    event: NativeEvidenceReference;
    type: "actions.requested" | "action.result";
    turnId: string | null;
    assessment: "unassessed";
  }[];
}

type NativeEvent<K extends MessageStreamEvent["type"]> = Extract<MessageStreamEvent, { type: K }>;
const reference = (event: MessageStreamEvent, nativeIndex: number): NativeEvidenceReference => ({
  nativeIndex,
  eventId: identifier(event.meta.id),
  at: event.meta.at,
  deliveryIds: (event.meta.deliveryIds ?? []).map(identifier),
});
const recordStart = (
  turns: Map<string, Turn>,
  event: NativeEvent<"turn.started">,
  index: number,
) => {
  const turnId = identifier(event.data.turnId);
  if (turns.has(turnId)) {
    throw invalid();
  }
  turns.set(turnId, {
    turnId,
    sequence: event.data.sequence,
    started: reference(event, index),
    messages: [],
    attempts: new Map(),
  });
};
const recordRequests = (
  turns: Map<string, Turn>,
  event: NativeEvent<"actions.requested">,
  index: number,
) => {
  const turn = turns.get(event.data.turnId);
  if (turn === undefined) {
    throw invalid();
  }
  for (const action of event.data.actions) {
    if (action.kind !== "tool-call" && action.kind !== "workflow-tool-call") {
      continue;
    }
    const callId = identifier(action.callId);
    if (turn.attempts.has(callId)) {
      throw invalid();
    }
    turn.attempts.set(callId, {
      turnId: turn.turnId,
      callId,
      toolName: identifier(action.toolName),
      category: category(action.toolName),
      requested: reference(event, index),
      commandReferences: [],
    });
  }
};
const recordResult = (
  turns: Map<string, Turn>,
  event: NativeEvent<"action.result">,
  index: number,
) => {
  const result = event.data.result;
  if (result.kind !== "tool-result") {
    return;
  }
  const turn = turns.get(event.data.turnId);
  if (turn === undefined) {
    throw invalid();
  }
  const callId = identifier(result.callId);
  const attempt = turn.attempts.get(callId) ?? {
    turnId: turn.turnId,
    callId,
    toolName: identifier(result.toolName),
    category: category(result.toolName),
    commandReferences: [],
  };
  if (attempt.toolName !== result.toolName || attempt.result !== undefined) {
    throw invalid();
  }
  attempt.result = { ...reference(event, index), status: event.data.status };
  const command = commandIdSchema.safeParse(own(own(result, "output"), "commandId"));
  if (command.success) {
    attempt.commandReferences.push({ commandId: command.data, nativeIndex: index });
  }
  turn.attempts.set(callId, attempt);
};
const recordEvent = (turns: Map<string, Turn>, event: MessageStreamEvent, index: number) => {
  // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- Only turn/action boundaries establish dispatch; unrelated framework events intentionally remain unassessed.
  switch (event.type) {
    case "turn.started": {
      recordStart(turns, event, index);
      break;
    }
    case "actions.requested": {
      recordRequests(turns, event, index);
      break;
    }
    case "action.result": {
      recordResult(turns, event, index);
      break;
    }
    case "message.received": {
      turns.get(event.data.turnId)?.messages.push(reference(event, index));
      break;
    }
    case "turn.completed": {
      const turn = turns.get(event.data.turnId);
      if (turn !== undefined) {
        turn.boundary = { ...reference(event, index), kind: "completed" };
      }
      break;
    }
    case "turn.failed": {
      const turn = turns.get(event.data.turnId);
      if (turn !== undefined) {
        turn.boundary = { ...reference(event, index), kind: "failed" };
      }
      break;
    }
    case "turn.cancelled": {
      const turn = turns.get(event.data.turnId);
      if (turn !== undefined) {
        turn.boundary = { ...reference(event, index), kind: "cancelled" };
      }
      break;
    }
    default: {
      break;
    }
  }
};
const matches = (turn: Turn, selector: NativeTurnSelector) => {
  if ("turnId" in selector) {
    return turn.turnId === selector.turnId;
  }
  if ("messageIndex" in selector) {
    return turn.messages.some((message) => message.nativeIndex === selector.messageIndex);
  }
  return turn.messages.some((message) => message.deliveryIds.includes(selector.deliveryId));
};
const selectTurn = (turns: Map<string, Turn>, selector?: NativeTurnSelector) => {
  const values = [...turns.values()];
  if (selector === undefined) {
    return values.at(-1);
  }
  const matching = values.filter((turn) => matches(turn, selector));
  if (matching.length === 1) {
    return matching[0];
  }
  // oxlint-disable-next-line unicorn/no-useless-undefined -- Explicit absent match preserves this optional selection contract.
  return undefined;
};
const selectionKind = (
  selector?: NativeTurnSelector,
): NativeTurnExecutionEvidence["selectedBy"] => {
  if (selector === undefined) {
    return "latest-observed-turn";
  }
  if ("turnId" in selector) {
    return "turn-id";
  }
  if ("messageIndex" in selector) {
    return "native-message-index";
  }
  return "delivery-id";
};
const disposition = (
  attempts: NativeExecutionAttempt[],
): NativeTurnExecutionEvidence["selectedTurn"]["execution"] => {
  const executions = attempts.filter(
    (attempt) => attempt.category === "execution" && attempt.requested !== undefined,
  );
  if (executions.some((attempt) => attempt.result !== undefined)) {
    return "result-observed";
  }
  if (executions.length > 0) {
    return "requested";
  }
  if (
    attempts.every(
      (attempt) => attempt.category === "status-read" && attempt.requested !== undefined,
    )
  ) {
    return "unexercised";
  }
  return "unassessed";
};
const historicalFailure = (turns: Map<string, Turn>, selected: Turn) => {
  let failure: NativeExecutionAttempt | undefined;
  for (const turn of turns.values()) {
    if (turn.started.nativeIndex >= selected.started.nativeIndex) {
      continue;
    }
    for (const attempt of turn.attempts.values()) {
      if (
        attempt.category !== "execution" ||
        attempt.requested === undefined ||
        attempt.result?.status !== "failed"
      ) {
        continue;
      }
      if (
        failure === undefined ||
        attempt.result.nativeIndex > (failure.result?.nativeIndex ?? -1)
      ) {
        failure = attempt;
      }
    }
  }
  return failure;
};
/** Complete native prefix only. Never changes workflow state, approvals, cursors or provider effects. */
export const summarizeNativeTurnExecution = (input: {
  sessionId: string;
  ownerLineage: readonly string[];
  events: readonly MessageStreamEvent[];
  nativeCursor: number;
  selector?: NativeTurnSelector;
}): NativeTurnExecutionEvidence => {
  if (input.nativeCursor !== input.events.length || input.ownerLineage[0] !== input.sessionId) {
    throw invalid();
  }
  identifier(input.sessionId);
  for (const owner of input.ownerLineage) {
    identifier(owner);
  }
  const turns = new Map<string, Turn>();
  const unassociatedEvents: NativeTurnExecutionEvidence["unassociatedEvents"] = [];
  for (const [index, event] of input.events.entries()) {
    if (
      (event.type === "actions.requested" || event.type === "action.result") &&
      !turns.has(event.data.turnId)
    ) {
      unassociatedEvents.push({
        event: reference(event, index),
        type: event.type,
        turnId: event.data.turnId.length === 0 ? null : identifier(event.data.turnId),
        assessment: "unassessed",
      });
      continue;
    }
    recordEvent(turns, event, index);
  }
  const selected = selectTurn(turns, input.selector);
  if (selected === undefined) {
    throw invalid();
  }
  const attempts = [...selected.attempts.values()];
  const historical = historicalFailure(turns, selected);
  const evidence: NativeTurnExecutionEvidence = {
    version: 1,
    kind: "native-turn-execution-evidence-v1",
    sessionId: input.sessionId,
    ownerLineage: [...input.ownerLineage],
    nativeCursor: input.nativeCursor,
    selectedBy: selectionKind(input.selector),
    unassociatedEvents,
    selectedTurn: {
      turnId: selected.turnId,
      sequence: selected.sequence,
      started: selected.started,
      acceptedMessages: selected.messages,
      ...(selected.boundary === undefined ? {} : { boundary: selected.boundary }),
      attempts,
      execution: disposition(attempts),
    },
  };
  if (historical !== undefined) {
    evidence.lastHistoricalFailedExecution = historical;
  }
  return evidence;
};
