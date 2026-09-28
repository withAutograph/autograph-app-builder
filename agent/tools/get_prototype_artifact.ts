import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  exactPrototypeArtifact,
  isPrototypeArtifactV2,
  prototypeArtifactReadChunk,
  prototypeArtifactPathPattern,
} from "@/lib/agent/prototype-artifacts";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { EVE_MAX_PAYLOAD_BYTES, serializedPayloadBytes } from "@/lib/eve/payload-envelope";
import { readVerifiedPrototypeArtifactChunk } from "@/lib/agent/prototype-artifact-stream";
import { createHostedPrototypeChunkStore } from "@/lib/agent/hosted-prototype-chunk-store";
import { openHostedPostgresDatabase } from "@/lib/mcp/hosted-route";

export default defineTool({
  description:
    "Read one exact session-scoped prototype artifact by digest and revision. Omit offsetBytes to preserve the original full-content response when its serialized result fits one Eve event. For a larger artifact, provide the exact revision and repeatedly read with each returned nextOffsetBytes until complete is true; verify the assembled SHA-256 against digest and each chunk against chunkDigest.",
  async execute({ path, digest, revision, offsetBytes }, ctx) {
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
    if (isPrototypeArtifactV2(artifact)) {
      if (offsetBytes === undefined || revision === undefined) {
        throw new Error(
          "Durable prototype artifacts require the exact revision and offsetBytes: 0, then each returned nextOffsetBytes.",
        );
      }
      const store = createHostedPrototypeChunkStore({
        db: openHostedPostgresDatabase(process.env.DATABASE_URL ?? ""),
        sessionAuth: ctx.session.auth,
        sessionId: ctx.session.id,
      });
      return await readVerifiedPrototypeArtifactChunk({
        artifact,
        offsetBytes,
        readChunk: async (chunkIndex) =>
          await store.get({
            chunkIndex,
            path: artifact.path,
            transferDigest: artifact.digest,
          }),
      });
    }
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
