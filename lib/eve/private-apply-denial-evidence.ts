/* oxlint-disable eslint/complexity, sonarjs/cognitive-complexity, sonarjs/expression-complexity -- Preserve all independent request, terminal-decision, result and ordering guards in one negative-evidence verifier. */
import { z } from "zod";
import { createHash } from "node:crypto";
import type { MessageStreamEvent } from "eve/client";

export type NegativePrivateApplyStatus = "denied" | "ignored" | "invalid";
export interface PrivateApplyDenialEvidence {
  sessionId: string;
  callId: string;
  requestId: string;
  outcome: "denied-not-run" | "ignored-not-run" | "invalid-not-run";
  eventIds: readonly string[];
  evidenceDigest: string;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
type ToolOutput = Extract<
  Extract<MessageStreamEvent, { type: "action.result" }>["data"]["result"],
  { kind: "tool-result" }
>["output"];
const deniedResultSchema = z.object({
  approval: z.object({
    requestId: z.string().min(1),
    status: z.enum(["denied", "ignored", "invalid"]),
  }),
  code: z.literal("TOOL_EXECUTION_DENIED"),
  tool: z.object({ result: z.literal("not_run") }),
});
/** Parse only the documented runtime-owned denied action payload. */
export const readFrameworkPrivateApplyDenial = (
  value: ToolOutput,
): { requestId: string; status: NegativePrivateApplyStatus } | undefined => {
  const parsed = deniedResultSchema.safeParse(value);
  return parsed.success
    ? { requestId: parsed.data.approval.requestId, status: parsed.data.approval.status }
    : undefined;
};
/** Read only durably recorded framework events, never model-provided input or a missing-card inference. */
export const observePrivateApplyDenials = (input: {
  sessionId: string;
  events: readonly MessageStreamEvent[];
  calls: readonly string[];
}) => {
  const events = new Map<string, MessageStreamEvent>();
  for (const event of input.events) {
    const prior = events.get(event.meta.id);
    if (prior !== undefined && digest(JSON.stringify(prior)) !== digest(JSON.stringify(event))) {
      throw new Error("private_apply_history_conflict");
    }
    events.set(event.meta.id, event);
  }
  const result: PrivateApplyDenialEvidence[] = [];
  for (const callId of input.calls) {
    const requests = new Map<string, string>();
    const outcomes = new Map<string, Set<string>>();
    const settlements = new Map<string, Set<string>>();
    const results: {
      requestId: string;
      eventId: string;
      status: NegativePrivateApplyStatus;
    }[] = [];
    let conflict = false;
    for (const event of events.values()) {
      if (event.type === "input.requested") {
        for (const request of event.data.requests) {
          if (
            request.kind === "tool-approval" &&
            request.action?.kind === "tool-call" &&
            request.action.callId === callId
          ) {
            if (request.action.toolName !== "apply_app_creation") {
              conflict = true;
            }
            requests.set(request.requestId, event.meta.id);
          }
        }
      }
      if (event.type === "input.resolved") {
        for (const resolution of event.data.resolutions) {
          const found = outcomes.get(resolution.requestId) ?? new Set<string>();
          found.add(resolution.outcome);
          outcomes.set(resolution.requestId, found);
        }
      }
      if (event.type === "approval.settled") {
        const values = settlements.get(event.data.requestId) ?? new Set<string>();
        values.add(event.data.outcome);
        settlements.set(event.data.requestId, values);
      }
      if (
        event.type === "action.result" &&
        event.data.result.kind === "tool-result" &&
        event.data.result.callId === callId
      ) {
        const denied = readFrameworkPrivateApplyDenial(event.data.result.output);
        if (
          event.data.status !== "rejected" ||
          event.data.result.toolName !== "apply_app_creation" ||
          event.data.result.isError !== true ||
          denied === undefined
        ) {
          conflict = true;
        } else {
          results.push({ ...denied, eventId: event.meta.id });
        }
      }
    }
    if (!conflict && requests.size === 1 && results.length === 1) {
      const [requestId, requestEventId] = [...requests.entries()][0] ?? [];
      const terminal = requestId === undefined ? undefined : outcomes.get(requestId);
      if (
        requestId !== undefined &&
        requestEventId !== undefined &&
        results[0]?.requestId === requestId &&
        terminal?.size === 1 &&
        terminal.has(results[0].status)
      ) {
        const settled = settlements.get(requestId);
        if (settled === undefined || (settled.size === 1 && settled.has("cancelled"))) {
          const resolutionEvents = [...events.values()].flatMap((event) =>
            event.type === "input.resolved" &&
            event.data.resolutions.some((item) => item.requestId === requestId)
              ? [event.meta.id]
              : [],
          );
          const positions = [...events.keys()];
          const requestPosition = positions.indexOf(requestEventId);
          const resultPosition = positions.indexOf(results[0].eventId);
          const orderedResolutions = resolutionEvents.every(
            (id) =>
              positions.indexOf(id) > requestPosition && positions.indexOf(id) < resultPosition,
          );
          if (orderedResolutions) {
            const unsigned = {
              callId,
              eventIds: [requestEventId, ...resolutionEvents, results[0].eventId],
              outcome: `${results[0].status}-not-run` as const,
              requestId,
              sessionId: input.sessionId,
            };
            result.push({ ...unsigned, evidenceDigest: digest(JSON.stringify(unsigned)) });
          }
        }
      }
    }
  }
  return result;
};

export const createPrivateApplyDenialEvidence = (
  input: Omit<PrivateApplyDenialEvidence, "outcome" | "evidenceDigest"> & {
    status: NegativePrivateApplyStatus;
  },
): PrivateApplyDenialEvidence => {
  const unsigned = {
    callId: input.callId,
    eventIds: input.eventIds,
    outcome: `${input.status}-not-run` as const,
    requestId: input.requestId,
    sessionId: input.sessionId,
  };
  return { ...unsigned, evidenceDigest: digest(JSON.stringify(unsigned)) };
};
