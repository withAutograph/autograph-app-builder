import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  completeBuildReadyPrototypeAppSpec,
  prototypeArtifactMediaTypes,
  prototypeArtifactPathPattern,
  prototypeArtifactReceipt,
  recordPrototypeArtifactChunk,
  recordPrototypeArtifactRevision,
} from "@/lib/agent/prototype-artifacts";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  assertUpstreamMutationAllowed,
  updateExactWorkflow,
} from "@/lib/agent/workflow-state";

import acceptAppSpec from "./accept_app_spec";
import { continuePrototypePlanning } from "@/lib/agent/existing-app-plan-recovery";

const expectedAppIdForWorkflow = (
  current: Exclude<ReturnType<typeof appBuilderWorkflowState.get>, { phase: "empty" }>,
) => ("appSpec" in current ? current.appSpec.appId : null);

export default defineTool({
  description:
    "Record internal product decisions and implementation design without pausing for approval. Use record_ui_preview for visual content composed from Arrusted components; never author replacement HTML controls here. Small content can use the original single-call shape. For larger content, split the exact UTF-8 text into chunks whose complete JSON tool-call envelope is below Eve's 10 MiB event ceiling; send chunkIndex 0 with expectedDigest equal to SHA-256 of the full UTF-8 content and finalChunk false unless it is the only chunk, then append each next chunk using the exact revision and nextChunkIndex from the prior receipt. Mark the last chunk finalChunk true. Retry only the same last chunk with the same call id after an uncertain response. Continue until complete is true. A complete design continues into planning automatically.",
  async execute(
    { path, mediaType, content, expectedDigest, chunkIndex, finalChunk, baseRevision },
    ctx,
  ) {
    const current = appBuilderWorkflowState.get();
    assertUpstreamMutationAllowed(current, "prototype artifact recording");
    if (current.phase === "empty") {
      throw new Error("Prepare a workspace before recording prototype artifacts.");
    }
    if (current.phase === "validation_pending") {
      throw new Error(
        `Target validation attempt ${current.validationAttempt.digest} is pending; artifact mutation is disabled until it is recovered.`,
      );
    }
    const artifactInput = {
      artifacts: current.artifacts,
      callId: ctx.callId,
      content,
      expectedAppId: expectedAppIdForWorkflow(current),
      mediaType,
      path,
      sessionId: ctx.session.id,
    } as const;
    let recorded;
    let complete = true;
    if (expectedDigest === undefined) {
      recorded = recordPrototypeArtifactRevision(artifactInput);
    } else {
      if (chunkIndex === undefined || finalChunk === undefined) {
        throw new Error("Chunked prototype artifact writes require chunkIndex and finalChunk.");
      }
      recorded = recordPrototypeArtifactChunk({
        ...artifactInput,
        chunkIndex,
        expectedDigest,
        finalChunk,
        ...(baseRevision === undefined ? {} : { baseRevision }),
      });
      ({ complete } = recorded);
    }
    if (!recorded.reused) {
      updateExactWorkflow({
        expected: current,
        operation: "prototype artifact recording",
        transition: () => {
          if (current.phase === "ui_previewed" || current.phase === "ui_accepted") {
            return { ...current, artifacts: recorded.artifacts };
          }
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
    }
    const buildReadyAppSpec = complete
      ? completeBuildReadyPrototypeAppSpec({
          appId: recorded.artifact.appId,
          artifacts: recorded.artifacts,
        })
      : undefined;
    let planning = {};
    if (buildReadyAppSpec !== undefined) {
      // The model has completed the product-facing design. Continue the
      // deterministic acceptance/planning transition here so a fourth model
      // continuation is not required merely to choose internal operations.
      planning = await continuePrototypePlanning(async () => {
        await acceptAppSpec.execute(
          {
            appId: recorded.artifact.appId,
            expectedArtifactDigest: buildReadyAppSpec.digest,
            expectedArtifactRevision: buildReadyAppSpec.revision,
          },
          ctx,
        );
      });
    }
    return {
      ...prototypeArtifactReceipt(recorded.artifact),
      complete,
      reused: recorded.reused,
      ...("nextChunkIndex" in recorded ? { nextChunkIndex: recorded.nextChunkIndex } : {}),
      ...(recorded.reused ? {} : { invalidated: current.phase !== "prepared" }),
      ...planning,
    };
  },
  inputSchema: z
    .object({
      baseRevision: z
        .string()
        .regex(/^[0-9a-f]{64}$/u)
        .optional(),
      chunkIndex: z.number().int().nonnegative().optional(),
      content: z.string().min(1),
      expectedDigest: z
        .string()
        .regex(/^[0-9a-f]{64}$/u)
        .optional(),
      finalChunk: z.boolean().optional(),
      mediaType: z.enum(prototypeArtifactMediaTypes),
      path: z.string().regex(prototypeArtifactPathPattern),
    })
    .superRefine((input, context) => {
      if (input.chunkIndex === undefined && input.expectedDigest !== undefined) {
        context.addIssue({
          code: "custom",
          message: "Chunked writes require a chunk index.",
          path: ["chunkIndex"],
        });
      }
      if (input.chunkIndex !== undefined && input.expectedDigest === undefined) {
        context.addIssue({
          code: "custom",
          message: "Chunked writes require the full artifact digest.",
          path: ["expectedDigest"],
        });
      }
      if (input.chunkIndex !== undefined && input.finalChunk === undefined) {
        context.addIssue({
          code: "custom",
          message: "Chunked writes must identify the final chunk.",
          path: ["finalChunk"],
        });
      }
      if (input.chunkIndex === undefined && input.finalChunk !== undefined) {
        context.addIssue({
          code: "custom",
          message: "The legacy single-call form does not use finalChunk.",
          path: ["finalChunk"],
        });
      }
      if (input.chunkIndex === 0 && input.baseRevision !== undefined) {
        context.addIssue({
          code: "custom",
          message: "The first chunk must not set a base revision.",
          path: ["baseRevision"],
        });
      }
      if (
        input.chunkIndex !== undefined &&
        input.chunkIndex > 0 &&
        input.baseRevision === undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "Later chunks must use the prior chunk's exact revision.",
          path: ["baseRevision"],
        });
      }
    }),
});
