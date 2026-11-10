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
    "Prepare or resume the implementation plan for the already accepted AppSpec. When continuing a delivered app that needs current repository capabilities, first pass only refreshSource: true. Builder privately reads its saved connected destination and owned merged publication, reconciles current shared source while preserving the same app and authored files, and retires outdated validation/review/seals. Then inspect the current repository and prepare the app changes normally; do not use a public GitHub endpoint, ask the creator for a ref, replace the source, or start another app. This refresh is optional and never a release prerequisite. In local development ordinary planning reconciles current shared source. After a settled build, explicit nonempty existingAppChanges prepares a fresh same-app repair proposal; no-files calls reuse the current plan. If an unapplied repair displaced an approved build, pass only resumeApprovedBuild: true to return to it. Repairs within the same accepted behavior retain their existing approved repair path; a different new proposal requires its normal current Build approval. This tool does not apply, publish, deploy, provision resources or connect providers.",
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
