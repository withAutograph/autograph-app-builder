import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  exactPrototypeArtifact,
  prototypeArtifactReadChunk,
  prototypeArtifactPathPattern,
} from "@/lib/agent/prototype-artifacts";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { EVE_MAX_PAYLOAD_BYTES, serializedPayloadBytes } from "@/lib/eve/payload-envelope";

export default defineTool({
  description:
    "Read one exact session-scoped prototype artifact by digest and revision. Omit offsetBytes to preserve the original full-content response when its serialized result fits one Eve event. For a larger artifact, provide the exact revision and repeatedly read with each returned nextOffsetBytes until complete is true; verify the assembled SHA-256 against digest and each chunk against chunkDigest.",
  execute({ path, digest, revision, offsetBytes }, ctx) {
    const current = appBuilderWorkflowState.get();
    if (current.phase === "empty") {
      throw new Error("No prototype artifact is available.");
    }
    const artifactReference: Parameters<typeof exactPrototypeArtifact>[1] = {
      digest,
      path,
      sessionId: ctx.session.id,
    };
    if (revision !== undefined) {
      artifactReference.revision = revision;
    }
    const artifact = exactPrototypeArtifact(current.artifacts, artifactReference);
    const output = {
      content: artifact.content,
      digest: artifact.digest,
      mediaType: artifact.mediaType,
      path: artifact.path,
      revision: artifact.revision,
    };
    if (offsetBytes === undefined) {
      const envelope = {
        data: { result: { kind: "tool-result", output, toolName: "get_prototype_artifact" } },
        type: "action.result",
      };
      const size = serializedPayloadBytes(envelope);
      if (size > EVE_MAX_PAYLOAD_BYTES) {
        throw new Error(
          `The full prototype artifact read serializes to ${size} bytes, above Eve's ${EVE_MAX_PAYLOAD_BYTES}-byte event envelope. Retry with the exact revision and offsetBytes: 0, then continue from each returned nextOffsetBytes.`,
        );
      }
      return output;
    }

    return prototypeArtifactReadChunk(artifact, { offsetBytes });
  },
  inputSchema: z
    .object({
      digest: z.string().regex(/^[0-9a-f]{64}$/u),
      offsetBytes: z.number().int().nonnegative().optional(),
      path: z.string().regex(prototypeArtifactPathPattern),
      revision: z
        .string()
        .regex(/^[0-9a-f]{64}$/u)
        .optional(),
    })
    .superRefine((input, context) => {
      if (input.offsetBytes !== undefined && input.revision === undefined) {
        context.addIssue({
          code: "custom",
          message: "Chunked reads require the exact artifact revision.",
          path: ["revision"],
        });
      }
    }),
});
