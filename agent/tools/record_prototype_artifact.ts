import { defineTool } from "eve/tools";
import { z } from "zod";

import {
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

export default defineTool({
  description:
    "Record a bounded, session-scoped non-published prototype artifact receipt without pausing for approval. It never writes the target workspace.",
  inputSchema: z.object({
    path: z.string().regex(prototypeArtifactPathPattern),
    mediaType: z.enum(prototypeArtifactMediaTypes),
    content: z.string().min(1).max(262144),
  }),
  async execute({ path, mediaType, content }, ctx) {
    const current = appBuilderWorkflowState.get();
    assertUpstreamMutationAllowed(current, "prototype artifact recording");
    if (current.phase === "empty")
      throw new Error(
        "Prepare a workspace before recording prototype artifacts.",
      );
    if (current.phase === "validation_pending")
      throw new Error(
        `Target validation attempt ${current.validationAttempt.digest} is pending; artifact mutation is disabled until it is recovered.`,
      );
    const recorded = recordPrototypeArtifactRevision({
      artifacts: current.artifacts,
      path,
      mediaType,
      content,
      sessionId: ctx.session.id,
      callId: ctx.callId,
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
    });
    if (recorded.reused)
      return { ...prototypeArtifactReceipt(recorded.artifact), reused: true };
    updateExactWorkflow({
      expected: current,
      operation: "prototype artifact recording",
      transition: () => {
        return {
          version: APP_BUILDER_WORKFLOW_VERSION,
          phase: "prepared",
          preparedByCallId: current.preparedByCallId,
          workspace: current.workspace,
          sourceReceipt: current.sourceReceipt,
          ...(current.githubSource === undefined
            ? {}
            : { githubSource: current.githubSource }),
          artifacts: recorded.artifacts,
        };
      },
    });
    return {
      ...prototypeArtifactReceipt(recorded.artifact),
      reused: false,
      invalidated: current.phase !== "prepared",
    };
  },
});
