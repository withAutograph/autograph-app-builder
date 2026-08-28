import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { githubPublicationRuntimeForSession } from "@/lib/agent/deployment-github-publication-runtime";
import { publicationContentSourceForReviewedWorkflow } from "@/lib/agent/github-publication-content-source";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";

export default defineTool({
  description:
    "After approval of the exact sealed proposal digest, create one private fresh-history repository through the selected GitHub App installation. The release gate must remain absent. This tool cannot publish a branch or PR.",
  inputSchema: z.strictObject({
    expectedProposalDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  approval: always(),
  async execute(input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (state.phase !== "reviewed")
      throw new Error(
        "An exact reviewed change set is required before repository creation.",
      );
    const sandbox = await ctx.getSandbox();
    const contentSource = await publicationContentSourceForReviewedWorkflow({
      state,
      sandbox,
    });
    const runtime = await githubPublicationRuntimeForSession(ctx.session.auth);
    return runtime.createFreshRepository({
      ...input,
      review: state.reviewReceipt,
      contentSource,
      approvedByCallId: ctx.callId,
    });
  },
});
