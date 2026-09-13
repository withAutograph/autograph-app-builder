import { defineTool } from "eve/tools";
import { z } from "zod";
import { APP_BUILDER_SOURCE_VERSION, sourceWorkflowState } from "@/lib/agent/source-state";
import {
  canAutoSelectDevelopmentSource,
  developmentSourceReceipt,
} from "@/lib/repository/development-source";
import { acquireCanonicalArrustedTemplate } from "@/lib/repository/arrusted-template";

export default defineTool({
  description:
    "Return the durable source-review phase. An empty local development flow binds its configured source, while an empty hosted new-app flow automatically acquires the canonical Arrusted starter.",
  async execute(_input, ctx) {
    let state = sourceWorkflowState.get();
    if (state.phase === "empty") {
      if (canAutoSelectDevelopmentSource()) {
        const receipt = await developmentSourceReceipt("existing-repository");
        if (receipt !== undefined) {
          sourceWorkflowState.update(() => ({
            phase: "reviewed",
            receipt,
            version: APP_BUILDER_SOURCE_VERSION,
          }));
        }
      } else {
        const receipt = await acquireCanonicalArrustedTemplate({
          callId: ctx.callId,
          sandbox: () => ctx.getSandbox(),
          sessionId: ctx.session.id,
        });
        sourceWorkflowState.update(() => ({
          approvedByCallId: ctx.callId,
          phase: "acquisition_approved",
          receipt,
          version: APP_BUILDER_SOURCE_VERSION,
        }));
      }
      state = sourceWorkflowState.get();
    }
    return state.phase === "empty"
      ? state
      : { phase: state.phase, receipt: state.receipt, version: state.version };
  },
  inputSchema: z.object({}),
});
