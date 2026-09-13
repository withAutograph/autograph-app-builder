import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  completeBuildReadyPrototypeAppSpec,
  prototypeArtifactMediaTypes,
  prototypeArtifactPathPattern,
  prototypeArtifactReceipt,
  recordPrototypeArtifactRevision,
} from "@/lib/agent/prototype-artifacts";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  assertUpstreamMutationAllowed,
  updateExactWorkflow,
} from "@/lib/agent/workflow-state";

import acceptAppSpec from "./accept-app-spec";

export default defineTool({
  description:
    "Record internal product decisions and implementation design without pausing for approval. Use record_ui_preview for visual content composed from Arrusted components; never author replacement HTML controls here. A complete design continues into planning automatically.",
  async execute({ path, mediaType, content }, ctx) {
    const current = appBuilderWorkflowState.get();
    assertUpstreamMutationAllowed(current, "prototype artifact recording");
    if (current.phase === "empty")
      throw new Error("Prepare a workspace before recording prototype artifacts.");
    if (current.phase === "validation_pending")
      throw new Error(
        `Target validation attempt ${current.validationAttempt.digest} is pending; artifact mutation is disabled until it is recovered.`,
      );
    const recorded = recordPrototypeArtifactRevision({
      artifacts: current.artifacts,
      callId: ctx.callId,
      content,
      expectedAppId:
        current.phase === "app_spec_accepted" ||
        current.phase === "dependencies_prepared" ||
        current.phase === "identity_resolved" ||
        current.phase === "planned" ||
        current.phase === "apply_failed" ||
        current.phase === "applied" ||
        current.phase === "validation_failed" ||
        current.phase === "validated" ||
        current.phase === "reviewed"
          ? current.appSpec.appId
          : undefined,
      mediaType,
      path,
      sessionId: ctx.session.id,
    });
    if (!recorded.reused)
      updateExactWorkflow({
        expected: current,
        operation: "prototype artifact recording",
        transition: () => {
          if (current.phase === "ui_previewed" || current.phase === "ui_accepted")
            return { ...current, artifacts: recorded.artifacts };
          return {
            artifacts: recorded.artifacts,
            phase: "prepared",
            preparedByCallId: current.preparedByCallId,
            sourceReceipt: current.sourceReceipt,
            ...(current.githubSource === undefined ? {} : { githubSource: current.githubSource }),
            version: APP_BUILDER_WORKFLOW_VERSION,
            workspace: current.workspace,
          };
        },
      });
    const buildReadyAppSpec = completeBuildReadyPrototypeAppSpec({
      appId: recorded.artifact.appId,
      artifacts: recorded.artifacts,
    });
    if (buildReadyAppSpec !== undefined) {
      // The model has completed the product-facing design. Continue the
      // deterministic acceptance/planning transition here so a fourth model
      // continuation is not required merely to choose internal operations.
      await acceptAppSpec.execute(
        {
          appId: recorded.artifact.appId,
          expectedArtifactDigest: buildReadyAppSpec.digest,
          expectedArtifactRevision: buildReadyAppSpec.revision,
        },
        ctx,
      );
    }
    return {
      ...prototypeArtifactReceipt(recorded.artifact),
      reused: recorded.reused,
      ...(recorded.reused ? {} : { invalidated: current.phase !== "prepared" }),
      ...(buildReadyAppSpec === undefined ? {} : { implementationPlanReady: true }),
    };
  },
  inputSchema: z.object({
    content: z.string().min(1).max(262_144),
    mediaType: z.enum(prototypeArtifactMediaTypes),
    path: z.string().regex(prototypeArtifactPathPattern),
  }),
});
