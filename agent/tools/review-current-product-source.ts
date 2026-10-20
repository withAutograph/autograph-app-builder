import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { continueApplicationReviewWorkflow } from "../../lib/agent/application-review-workflow";

export default defineWorkflowTool({
  description:
    "Continue the independent source review prepared by accept_change_set. Pass only its exact opaque appId/contextRef. Each reviewer round resumes through a private durable checkpoint; no repository command or outward effect is performed. After this tool returns, automatically call accept_change_set with its returned sourceReview reference. If unavailable, finalize with the original reference and report the assessment as unassessed; do not ask the user for technical continuation.",
  async execute(input, ctx) {
    "use workflow";
    return { sourceReview: await continueApplicationReviewWorkflow(input, ctx) };
  },
  inputSchema: z.strictObject({
    appId: z.string().min(1),
    contextRef: z.string().min(1),
  }),
});
