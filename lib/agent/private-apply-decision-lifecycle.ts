/* oxlint-disable eslint/complexity, sonarjs/cognitive-complexity, sonarjs/expression-complexity -- Keep the three genuine runtime event transitions and their exact denial guards together. */
import { defineState } from "eve/context";
import type { HookEvent } from "eve/hooks";
import {
  createPrivateApplyDenialEvidence,
  readFrameworkPrivateApplyDenial,
} from "../eve/private-apply-denial-evidence";
import { readPrivateApplyAuthority, retainPrivateApplyDenials } from "./private-apply-authority";

interface Decision {
  sessionId: string;
  callId: string;
  requestId: string;
  requestEventId: string;
  resolution?: { outcome: string; eventId: string };
  conflict?: true;
}
const decisions = defineState<readonly Decision[]>(
  "autograph-app-builder.private-apply-decision-lifecycle.v1",
  () => [],
);
/** Observe runtime-authored terminal decisions; no model input or generic tool error can retire authority. */
export const observePrivateApplyDecisionEvent = (
  event: HookEvent<"input.requested" | "input.resolved" | "action.result">,
  sessionId: string,
) => {
  const authority = readPrivateApplyAuthority();
  let rows = [...decisions.get()];
  if (event.type === "input.requested") {
    for (const request of event.data.requests) {
      if (
        request.kind !== "tool-approval" ||
        request.action?.kind !== "tool-call" ||
        request.action.toolName !== "apply_app_creation"
      ) {
        continue;
      }
      const { callId } = request.action;
      if (
        authority.pending.some(
          (entry) => entry.callId === callId && entry.scope.sessionId === sessionId,
        )
      ) {
        const prior = rows.find((row) => row.callId === callId);
        if (prior === undefined) {
          rows.push({
            sessionId,
            callId,
            requestId: request.requestId,
            requestEventId: event.meta.id,
          });
        } else if (prior.requestId !== request.requestId || prior.sessionId !== sessionId) {
          rows = rows.map((row) => (row === prior ? { ...row, conflict: true } : row));
        }
      }
    }
  }
  if (event.type === "input.resolved") {
    for (const resolution of event.data.resolutions) {
      rows = rows.map((row) => {
        if (row.requestId !== resolution.requestId || row.sessionId !== sessionId) {
          return row;
        }
        if (row.resolution !== undefined && row.resolution.outcome !== resolution.outcome) {
          return { ...row, conflict: true };
        }
        return { ...row, resolution: { outcome: resolution.outcome, eventId: event.meta.id } };
      });
    }
  }
  decisions.update(() => rows);
  if (
    event.type !== "action.result" ||
    event.data.status !== "rejected" ||
    event.data.result.kind !== "tool-result" ||
    event.data.result.toolName !== "apply_app_creation" ||
    event.data.result.isError !== true
  ) {
    return;
  }
  const negative = readFrameworkPrivateApplyDenial(event.data.result.output);
  const row = rows.find(
    (item) => item.callId === event.data.result.callId && item.sessionId === sessionId,
  );
  if (
    negative === undefined ||
    row === undefined ||
    row.conflict ||
    row.requestId !== negative.requestId ||
    row.resolution?.outcome !== negative.status
  ) {
    return;
  }
  retainPrivateApplyDenials({
    expected: authority,
    proofs: [
      createPrivateApplyDenialEvidence({
        sessionId,
        callId: row.callId,
        requestId: row.requestId,
        status: negative.status,
        eventIds: [row.requestEventId, row.resolution.eventId, event.meta.id],
      }),
    ],
  });
};
