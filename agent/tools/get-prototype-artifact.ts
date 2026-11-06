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
    "Deliberately read or export exact session-scoped raw artifact bytes by digest and revision, including Markdown product documents or a targeted artifact diagnostic. Hosted compiled HTML is served and verified by the authenticated Browser preview route; do not routinely drain it into model context for viewing or planning. Inspect readable authored preview source for planning. Raw reads remain available when their content is specifically needed. For an inline v1 artifact, omit offsetBytes to read its full content when the serialized result fits one Eve event. For a durable v2 artifact, provide the exact revision; offsetBytes may be omitted to start the first verified page at zero. Continue with each returned nextOffsetBytes until complete is true; verify the assembled SHA-256 against digest and each page against chunkDigest.",
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
      if (revision === undefined) {
        throw new Error(
          "Durable prototype artifacts require the exact revision before reading their stored content.",
        );
      }
      const store = createHostedPrototypeChunkStore({
        db: openHostedPostgresDatabase(process.env.DATABASE_URL ?? ""),
        sessionAuth: ctx.session.auth,
        sessionId: ctx.session.id,
      });
      return await readVerifiedPrototypeArtifactChunk({
        artifact,
        offsetBytes: offsetBytes ?? 0,
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
