import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  exactPrototypeArtifact,
  prototypeArtifactPathPattern,
} from "@/lib/agent/prototype-artifacts";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";

export default defineTool({
  description: "Read one exact session-scoped prototype artifact by its content digest.",
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
  async execute({ path, digest }, ctx) {
    const current = appBuilderWorkflowState.get();
    if (current.phase === "empty") throw new Error("No prototype artifact is available.");
    const artifact = exactPrototypeArtifact(current.artifacts, {
      digest,
      path,
      sessionId: ctx.session.id,
    });
    return {
      content: artifact.content,
      digest: artifact.digest,
      mediaType: artifact.mediaType,
      path: artifact.path,
      revision: artifact.revision,
    };
  },
  inputSchema: z.object({
    digest: z.string().regex(/^[0-9a-f]{64}$/u),
    path: z.string().regex(prototypeArtifactPathPattern),
  }),
});
