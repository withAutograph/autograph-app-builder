import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  APP_BUILDER_SOURCE_VERSION,
  sourceWorkflowState,
} from "@/lib/agent/source-state";
import {
  canAutoSelectDevelopmentSource,
  developmentSourceReceipt,
} from "@/lib/repository/development-source";
import { acquireCanonicalArrustedTemplate } from "@/lib/repository/arrusted-template";

export default defineTool({
  description:
    "Return the durable source-review phase. An empty local development flow binds its configured source, while an empty hosted new-app flow automatically acquires the canonical Arrusted starter.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    let state = sourceWorkflowState.get();
    if (state.phase === "empty") {
      if (canAutoSelectDevelopmentSource()) {
        const receipt = await developmentSourceReceipt("existing-repository");
        if (receipt !== undefined) {
          sourceWorkflowState.update(() => ({
            version: APP_BUILDER_SOURCE_VERSION,
            phase: "reviewed",
            receipt,
          }));
        }
      } else {
        const receipt = await acquireCanonicalArrustedTemplate({
          sandbox: await ctx.getSandbox(),
          callId: ctx.callId,
        });
        sourceWorkflowState.update(() => ({
          version: APP_BUILDER_SOURCE_VERSION,
          phase: "acquisition_approved",
          receipt,
          approvedByCallId: ctx.callId,
        }));
      }
      state = sourceWorkflowState.get();
    }
    return state.phase === "empty"
      ? state
      : { version: state.version, phase: state.phase, receipt: state.receipt };
  },
});
