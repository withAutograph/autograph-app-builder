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
import { refreshOwnedAppSource } from "@/lib/agent/refresh-owned-app-source";

export default defineTool({
  description:
    "Prepare or resume the implementation plan for the already accepted AppSpec. Ordinary app creation uses the current workspace. Use privateCompute only for an explicitly requested local checker investigation. For a new change on a delivered app, inspect its existing app files and submit nonempty existingAppChanges; a no-files call reuses the old plan. A connected GitHub checkout obtains updated compiler capabilities automatically during approved schema compilation. Only if a delivered starter-backed workspace needs newer shared source, pass refreshSource: true by itself, then inspect and prepare the change. If the tool returns connected_source_retained, continue planning immediately with that checkout. Live app observation is not a planning prerequisite. Never ask the creator for a ref or start another app. If an unapplied repair displaced an approved build, pass only resumeApprovedBuild: true to return to it. Repairs within the same accepted behavior retain their existing approved repair path; a different new proposal requires its normal current Build approval. This tool does not apply, publish, deploy, provision resources or connect providers.",
  inputSchema: z
    .object({
      existingAppChanges: existingAppChangesSchema.optional(),
      frameworkUpgrade: z.literal("latest").optional(),
      privateCompute: z.literal(PRIVATE_COMPUTE_PROFILE_ID).optional(),
      resumeApprovedBuild: z.literal(true).optional(),
      refreshSource: z.literal(true).optional(),
    })
    .refine(
      (input) =>
        input.resumeApprovedBuild !== true ||
        [
          input.existingAppChanges,
          input.frameworkUpgrade,
          input.privateCompute,
          input.refreshSource,
        ].every((option) => option === undefined),
      { message: "Pass only resumeApprovedBuild when resuming an approved build." },
    )
    .refine(
      (input) =>
        input.refreshSource !== true ||
        [
          input.existingAppChanges,
          input.frameworkUpgrade,
          input.privateCompute,
          input.resumeApprovedBuild,
        ].every((option) => option === undefined),
      { message: "Refresh the source first, then inspect and prepare this app's changes." },
    ),
  async execute(input, ctx) {
    assertUpstreamMutationAllowed(appBuilderWorkflowState.get(), "implementation planning");
    try {
      let result;
      if (input.refreshSource === true) {
        result = await refreshOwnedAppSource(ctx);
      } else {
        result =
          input.resumeApprovedBuild === true
            ? await resumeApprovedAppBuild(ctx)
            : await prepareAppCreation(input, ctx);
      }
      await emitCurrentBuildWorkflowProjection(ctx);
      return result;
    } catch (error) {
      return await localSourcePrerequisiteResponse(error, ctx);
    }
  },
});
