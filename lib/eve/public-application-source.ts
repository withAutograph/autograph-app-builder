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
    } else if (
      event.type !== "action.result" ||
      event.data.status !== "completed" ||
      event.data.result.kind !== "tool-result" ||
      event.data.result.toolName !== "export-application-source"
    ) {
      // Ignore events that cannot provide an exported source reference.
    } else if (requested.has(event.data.result.callId)) {
      const result = applicationSourceExportReferenceSchema.safeParse(event.data.result.output);
      if (result.success) {
        latest = result.data;
      }
    }
  }
  return latest;
};
