import { currentProductBehaviorEvidence } from "@/lib/agent/product-behavior-state";
import { productAcceptanceObligations } from "@/lib/agent/product-acceptance";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { exactNormalizedChangeSet } from "./change_set_status";
import { APP_BUILDER_WORKFLOW_VERSION, appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { createReviewedChangeSetReceipt } from "@/lib/repository/reviewed-change-set";

export default defineTool({
  description:
    "Record the current reviewed change summary after repository validation succeeds. This is internal and never publishes or changes an external repository.",
  async execute(_input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (state.phase !== "validated" && state.phase !== "reviewed") {
      throw new Error("Run the repository validation before reviewing its changes.");
    }
    const changeSet = await exactNormalizedChangeSet({
      sandbox: await ctx.getSandbox(),
      state,
    });
    if (state.phase === "reviewed") {
      const expectedReceipt = createReviewedChangeSetReceipt(
        changeSet,
        state.reviewReceipt.reviewedByCallId,
      );
      if (expectedReceipt.digest === state.reviewReceipt.digest) {
        return {
          ...state.reviewReceipt,
          productAcceptance: productAcceptanceObligations(
            state.appSpec,
            currentProductBehaviorEvidence(state.appSpec.digest, state.applyReceipt.digest),
          ),
          reused: true,
        };
      }
    }
    const receipt = createReviewedChangeSetReceipt(changeSet, ctx.callId);
    appBuilderWorkflowState.update(() => ({
      appSpec: state.appSpec,
      applyReceipt: state.applyReceipt,
      artifacts: state.artifacts,
      dependencyReceipt: state.dependencyReceipt,
      ...(state.githubSource === undefined ? {} : { githubSource: state.githubSource }),
      identityReceipt: state.identityReceipt,
      phase: "reviewed",
      preparedByCallId: state.preparedByCallId,
      proposal: state.proposal,
      reviewReceipt: receipt,
      sourceReceipt: state.sourceReceipt,
      validationReceipt: state.validationReceipt,
      version: APP_BUILDER_WORKFLOW_VERSION,
      workspace: state.workspace,
    }));
    return {
      ...receipt,
      productAcceptance: productAcceptanceObligations(
        state.appSpec,
        currentProductBehaviorEvidence(state.appSpec.digest, state.applyReceipt.digest),
      ),
      reused: false,
    };
  },
  inputSchema: z.strictObject({}),
});
