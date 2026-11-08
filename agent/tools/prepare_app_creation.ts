/* oxlint-disable unicorn/filename-case -- Eve derives the public tool identifier from this existing filename. */
/* oxlint-disable github/filenames-match-regex -- Preserve the existing registered Eve tool name and public workflow identity. */
import { localSourcePrerequisiteResponse } from "@/lib/agent/local-source-prerequisite-response";
import { PRIVATE_COMPUTE_PROFILE_ID } from "@/lib/sandbox/private-compute-profile";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { prepareAppCreation } from "@/lib/agent/prepare-app-creation";
import { existingAppChangesSchema } from "@/lib/agent/existing-app-changes";
import { resumeApprovedAppBuild } from "@/lib/agent/existing-app-repair-planning";
import { emitCurrentBuildWorkflowProjection } from "@/lib/agent/approved-build-continuation-runtime";
import { appBuilderWorkflowState, assertUpstreamMutationAllowed } from "@/lib/agent/workflow-state";

export default defineTool({
  description:
    "Prepare or resume the implementation plan for the already accepted AppSpec. In local development this reconciles current shared source with the same saved app, preserving app changes and historical receipts. After a settled build, explicit nonempty existingAppChanges prepares a fresh same-app repair proposal while retaining the accepted AppSpec; no-files calls reuse the current plan. If an unapplied same-app repair proposal displaced a build that still owns the private approval, pass only resumeApprovedBuild: true to return to that approved checkout for preview or repair. Existing-app product edits use existingAppChanges; a verified local source-only refresh needs no artificial app edits. This tool does not apply, publish, deploy, provision resources or connect providers.",
  inputSchema: z
    .object({
      existingAppChanges: existingAppChangesSchema.optional(),
      frameworkUpgrade: z.literal("latest").optional(),
      privateCompute: z.literal(PRIVATE_COMPUTE_PROFILE_ID).optional(),
      resumeApprovedBuild: z.literal(true).optional(),
    })
    .refine(
      (input) =>
        input.resumeApprovedBuild !== true ||
        [input.existingAppChanges, input.frameworkUpgrade, input.privateCompute].every(
          (option) => option === undefined,
        ),
      { message: "Pass only resumeApprovedBuild when resuming an approved build." },
    ),
  async execute(input, ctx) {
    assertUpstreamMutationAllowed(appBuilderWorkflowState.get(), "implementation planning");
    try {
      const result =
        input.resumeApprovedBuild === true
          ? await resumeApprovedAppBuild(ctx)
          : await prepareAppCreation(input, ctx);
      await emitCurrentBuildWorkflowProjection(ctx);
      return result;
    } catch (error) {
      return await localSourcePrerequisiteResponse(error, ctx);
    }
  },
});
