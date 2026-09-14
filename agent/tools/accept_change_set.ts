import {
  productRequestState,
  reviewCurrentProductSource,
} from "@/lib/agent/product-source-review-state";
import { readProductReviewSource } from "@/lib/agent/product-source-review-input";
import { inspectApplyOverlay } from "@/lib/repository/target-apply";
import { hasTestCapability } from "@/lib/testing/test-capability";
import { unavailableSourceAssessment } from "@/lib/agent/product-source-review";
import type {
  ProductSourceAssessment,
  ProductSourceReviewInput,
} from "@/lib/agent/product-source-review";
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
    const request = productRequestState.get();
    const reviewInput: ProductSourceReviewInput = {
      appSpec: state.appSpec.content,
      appSpecDigest: state.appSpec.digest,
      clarifications: request.clarifications,
      files: [],
      omissions: [],
      originalRequest: request.original,
      sourceDigest: changeSet.postTreeDigest,
    };
    let sourceAssessment: ProductSourceAssessment;
    if (hasTestCapability("mock-model")) {
      sourceAssessment = unavailableSourceAssessment(
        reviewInput,
        "Independent review is unassessed in the credential-free mock profile.",
      );
    } else if (request.original === null) {
      sourceAssessment = unavailableSourceAssessment(
        reviewInput,
        "Original user request was not retained; the AppSpec cannot substitute for it.",
      );
    } else {
      try {
        const sandbox = await ctx.getSandbox();
        const observed = await inspectApplyOverlay(sandbox, state.applyReceipt.applyRoot);
        const source = await readProductReviewSource({
          appId: state.appSpec.appId,
          applyRoot: state.applyReceipt.applyRoot,
          changedPaths: state.applyReceipt.changes.map((change) => change.path),
          observed,
          sandbox,
        });
        sourceAssessment = await reviewCurrentProductSource(
          { ...reviewInput, ...source, sourceDigest: observed.treeDigest },
          false,
          async () => {
            const latest = await inspectApplyOverlay(sandbox, state.applyReceipt.applyRoot);
            return latest.treeDigest;
          },
          undefined,
          ctx.abortSignal,
        );
      } catch {
        sourceAssessment = unavailableSourceAssessment(
          reviewInput,
          "Applied source observation was unavailable; independent review remains blocked.",
          "blocked",
        );
      }
    }
    ctx.abortSignal?.throwIfAborted();
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
            sourceAssessment,
          ),
          reused: true,
          sourceAssessment,
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
        sourceAssessment,
      ),
      reused: false,
      sourceAssessment,
    };
  },
  inputSchema: z.strictObject({}),
});
