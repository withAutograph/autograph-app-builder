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
import { ownedPublishedDraftRecovery } from "@/lib/agent/draft-reconciliation-prerequisites";

export default defineTool({
  description:
    "Return the durable source-review phase and current app baseline provenance when selected. receipt.sourceSha identifies the platform checkout, while appBaseline.commitSha identifies the historical app version. For an owned prepared baseline, historical app files are projected into the selected platform checkout; the platform branch (which may be main) remains selected, and the source-bound sandbox restores that projection on use. There is no separate baseline activation or ref switch. A pending baseline is not prepared. To start a new hosted app, explicitly pass sourceKind=fresh-template to acquire the canonical Arrusted starter. Initial selection of an existing app uses resolve_github_source. A starter-created app that already published its own draft keeps its starter origin and continues in the same session through prepare_github_draft_pr_reconciliation; its ownedDraftRecovery result describes the explicit fresh-review recovery when replay of the old app review is ambiguous.",
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
    const savedBaseline = appBaselineState.get();
    const appBaseline = savedAppBaselineSummary({
      baseline: savedBaseline,
      githubSource,
      sessionId: ctx.session.id,
    });
    const ownedDraftRecovery = ownedPublishedDraftRecovery(workflow);
    const result = {
      phase: state.phase,
      receipt: state.receipt,
      version: state.version,
      ...(ownedDraftRecovery === undefined ? {} : { ownedDraftRecovery }),
    };
    if (githubSource === undefined) {
      return result;
    }
    const platformResult = { ...result, sourceShaScope: "platform" as const };
    if (appBaseline === null) {
      return platformResult;
    }
    if (appBaseline.status !== "prepared") {
      return { ...platformResult, appBaseline };
    }
    return {
      ...platformResult,
      appBaseline: {
        ...appBaseline,
        guidance:
          "Historical app files are the baseline in the selected platform checkout and are restored on use. Platform Git HEAD, including main, may differ from appBaseline.commitSha; no separate activation or HEAD switch is needed.",
      },
    };
  },
  inputSchema: z.strictObject({
    sourceKind: z.literal("fresh-template").optional(),
  }),
});
