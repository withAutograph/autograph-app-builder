import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
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
} from "@/lib/agent/workflow-state";

export default defineTool({
  description:
    "Record a bounded, session-scoped prototype artifact receipt. It never writes the target workspace.",
  inputSchema: z.object({
    path: z.string().regex(prototypeArtifactPathPattern),
    mediaType: z.enum(prototypeArtifactMediaTypes),
    content: z.string().min(1).max(262144),
  }),
  approval: always(),
  async execute({ path, mediaType, content }, ctx) {
    const current = appBuilderWorkflowState.get();
    if (current.phase === "empty")
      throw new Error(
        "Prepare a workspace before recording prototype artifacts.",
      );
    const recorded = recordPrototypeArtifactRevision({
      artifacts: current.artifacts,
      path,
      mediaType,
      content,
      sessionId: ctx.session.id,
      callId: ctx.callId,
      expectedAppId:
        current.phase === "app_spec_accepted" || current.phase === "planned"
          ? current.appSpec.appId
          : undefined,
    });
    if (recorded.reused)
      return { ...prototypeArtifactReceipt(recorded.artifact), reused: true };
    appBuilderWorkflowState.update(() => ({
      version: APP_BUILDER_WORKFLOW_VERSION,
      phase: "prepared",
      preparedByCallId: current.preparedByCallId,
      workspace: current.workspace,
      artifacts: recorded.artifacts,
    }));
    return {
      ...prototypeArtifactReceipt(recorded.artifact),
      reused: false,
      invalidated: current.phase !== "prepared",
    };
  },
});
