import { defineTool } from "eve/tools";
import { z } from "zod";
import { APP_BUILDER_SOURCE_VERSION, sourceWorkflowState } from "@/lib/agent/source-state";
import {
  canAutoSelectDevelopmentSource,
  developmentSourceReceipt,
} from "@/lib/repository/development-source";
import { acquireCanonicalArrustedTemplate } from "@/lib/repository/arrusted-template";
import { appBaselineState } from "@/lib/agent/app-baseline-state";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { savedAppBaselineSummary } from "@/lib/agent/saved-app-baseline-selection";

export default defineTool({
  description:
    "Return the durable source-review phase and current app baseline provenance when selected. receipt.sourceSha identifies the platform checkout, while appBaseline.commitSha identifies the historical app version; a pending baseline is not prepared. To start a new hosted app, explicitly pass sourceKind=fresh-template to acquire the canonical Arrusted starter. Existing hosted apps use resolve_github_source instead.",
  async execute(input, ctx) {
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
      } else if (input.sourceKind === "fresh-template") {
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
    if (state.phase === "empty") {
      return state;
    }
    const workflow = appBuilderWorkflowState.get();
    // Report saved provenance; source binding and compute verification stay with source acquisition.
    const githubSource =
      workflow.phase === "empty"
        ? state.githubSource
        : (workflow.githubSource ?? state.githubSource);
    const appBaseline = savedAppBaselineSummary({
      baseline: appBaselineState.get(),
      githubSource,
      sessionId: ctx.session.id,
    });
    const result = {
      phase: state.phase,
      receipt: state.receipt,
      version: state.version,
    };
    if (githubSource === undefined) {
      return result;
    }
    const platformResult = { ...result, sourceShaScope: "platform" as const };
    return appBaseline === null ? platformResult : { ...platformResult, appBaseline };
  },
  inputSchema: z.strictObject({
    sourceKind: z.literal("fresh-template").optional(),
  }),
});
