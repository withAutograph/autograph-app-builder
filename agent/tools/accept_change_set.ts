import { defineTool } from "eve/tools";
import { z } from "zod";

import { exactNormalizedChangeSet } from "./change_set_status";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
} from "@/lib/agent/workflow-state";
import { createReviewedChangeSetReceipt } from "@/lib/repository/reviewed-change-set";

export default defineTool({
  description:
    "Record the current reviewed change summary after repository validation succeeds. This is internal and never publishes or changes an external repository.",
  inputSchema: z.strictObject({}),
  async execute(_input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (state.phase !== "validated" && state.phase !== "reviewed")
      throw new Error(
        "Run the repository validation before reviewing its changes.",
      );
    const changeSet = await exactNormalizedChangeSet({ state });
    if (state.phase === "reviewed") {
      const expectedReceipt = createReviewedChangeSetReceipt(
        changeSet,
        state.reviewReceipt.reviewedByCallId,
      );
      return { ...expectedReceipt, reused: true };
    }
    const receipt = createReviewedChangeSetReceipt(changeSet, ctx.callId);
    appBuilderWorkflowState.update(() => ({
      version: APP_BUILDER_WORKFLOW_VERSION,
      phase: "reviewed",
      preparedByCallId: state.preparedByCallId,
      workspace: state.workspace,
      sourceReceipt: state.sourceReceipt,
      ...(state.githubSource === undefined
        ? {}
        : { githubSource: state.githubSource }),
      artifacts: state.artifacts,
      appSpec: state.appSpec,
      dependencyReceipt: state.dependencyReceipt,
      identityReceipt: state.identityReceipt,
      proposal: state.proposal,
      applyReceipt: state.applyReceipt,
      validationReceipt: state.validationReceipt,
      reviewReceipt: receipt,
    }));
    return { ...receipt, reused: false };
  },
});
