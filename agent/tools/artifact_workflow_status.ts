import { defineTool } from "eve/tools";
import { z } from "zod";

import { prototypeArtifactReceipt } from "@/lib/agent/prototype-artifacts";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";

export default defineTool({
  description:
    "Return session-bound artifact workflow receipt metadata without artifact content or mutation.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (state.phase === "empty")
      return {
        version: state.version,
        phase: state.phase,
        sessionId: ctx.session.id,
      };
    if (state.artifacts.some(({ sessionId }) => sessionId !== ctx.session.id))
      throw new Error(
        "Prototype artifact state belongs to a different session.",
      );
    return {
      version: state.version,
      sessionId: ctx.session.id,
      phase: state.phase,
      artifacts: state.artifacts.map(prototypeArtifactReceipt),
      workspace: {
        sourceSha: state.workspace.sourceSha,
        eligibilityDigest: state.workspace.eligibilityDigest,
        workspaceDigest: state.workspace.workspaceDigest,
      },
      ...(state.phase === "app_spec_accepted" ||
      state.phase === "identity_resolved" ||
      state.phase === "planned"
        ? {
            appSpec: {
              path: state.appSpec.artifactPath,
              digest: state.appSpec.digest,
              artifactRevision: state.appSpec.artifactRevision,
            },
          }
        : {}),
      ...(state.phase === "identity_resolved" || state.phase === "planned"
        ? { identity: { digest: state.identityReceipt.digest } }
        : {}),
      ...(state.phase === "planned"
        ? { proposal: { digest: state.proposal.digest } }
        : {}),
    };
  },
});
