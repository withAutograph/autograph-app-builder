import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  exactPrototypeArtifact,
  prototypeArtifactPathPattern,
} from "@/lib/agent/prototype-artifacts";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";

export default defineTool({
  description:
    "Read one exact session-scoped prototype artifact by its content digest.",
  inputSchema: z.object({
    path: z.string().regex(prototypeArtifactPathPattern),
    digest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  async execute({ path, digest }, ctx) {
    const current = appBuilderWorkflowState.get();
    if (current.phase === "empty")
      throw new Error("No prototype artifact is available.");
    const artifact = exactPrototypeArtifact(current.artifacts, {
      path,
      digest,
      sessionId: ctx.session.id,
    });
    return {
      path: artifact.path,
      mediaType: artifact.mediaType,
      digest: artifact.digest,
      revision: artifact.revision,
      content: artifact.content,
    };
  },
});
