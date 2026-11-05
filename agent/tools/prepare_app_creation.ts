/* oxlint-disable github/filenames-match-regex -- Preserve the existing registered Eve tool name and public workflow identity. */
import { localSourcePrerequisiteResponse } from "@/lib/agent/local-source-prerequisite-response";
import { PRIVATE_COMPUTE_PROFILE_ID } from "@/lib/sandbox/private-compute-profile";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { prepareAppCreation } from "@/lib/agent/prepare-app-creation";
import { existingAppChangesSchema } from "@/lib/agent/existing-app-changes";
import { emitCurrentBuildWorkflowProjection } from "@/lib/agent/approved-build-continuation-runtime";
import { appBuilderWorkflowState, assertUpstreamMutationAllowed } from "@/lib/agent/workflow-state";

export default defineTool({
  description:
    "Prepare or resume the implementation plan for the already accepted AppSpec. In local development this reconciles current shared source with the same saved app, preserving app changes and historical receipts. After a settled private build, explicit nonempty existingAppChanges prepares a fresh same-app repair proposal while retaining the accepted AppSpec; no-files calls reuse the current plan. Existing-app product edits use existingAppChanges; a verified local source-only refresh needs no artificial app edits. This creates a new plan for private execution and review; it does not apply, publish, deploy, provision resources or connect providers.",
  inputSchema: z.object({
    existingAppChanges: existingAppChangesSchema.optional(),
    frameworkUpgrade: z.literal("latest").optional(),
    privateCompute: z.literal(PRIVATE_COMPUTE_PROFILE_ID).optional(),
  }),
  async execute(input, ctx) {
    assertUpstreamMutationAllowed(appBuilderWorkflowState.get(), "implementation planning");
    try {
      const result = await prepareAppCreation(input, ctx);
      await emitCurrentBuildWorkflowProjection(ctx);
      return result;
    } catch (error) {
      return await localSourcePrerequisiteResponse(error, ctx);
    }
  },
});
