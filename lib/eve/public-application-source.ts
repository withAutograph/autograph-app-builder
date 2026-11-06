import type { MessageStreamEvent } from "eve/client";
import { applicationSourceExportReferenceSchema } from "../handoff/application-source-contract";
/** Only a successful native tool result projects a source download; assistant prose never does. */
export const latestInstalledApplicationSource = (events: readonly MessageStreamEvent[]) => {
  let latest;
  const requested = new Set<string>();
  for (const event of events) {
    if (event.type === "actions.requested") {
      for (const action of event.data.actions) {
        if (
          (action.kind === "tool-call" || action.kind === "workflow-tool-call") &&
          action.toolName === "export-application-source"
        ) {
          requested.add(action.callId);
        }
      }
    }
    if (event.type !== "action.result") {
      continue;
    }
    if (event.data.status !== "completed") {
      continue;
    }
    if (event.data.result.kind !== "tool-result") {
      continue;
    }
    const resultEvent = event.data.result;
    if (resultEvent.toolName !== "export-application-source") {
      continue;
    }
    if (!requested.has(resultEvent.callId)) {
      continue;
    }
    const result = applicationSourceExportReferenceSchema.safeParse(resultEvent.output);
    if (result.success) {
      latest = result.data;
    }
  }
  return latest;
};
