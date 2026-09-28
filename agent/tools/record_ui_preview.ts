import { defineTool } from "eve/tools";
import { createHash } from "node:crypto";

import {
  uiPreviewInputEnvelopeSchema,
  uiPreviewSourceDigest,
  stageUiPreviewSourceChunk,
  validateUiPreview,
} from "@/lib/agent/ui-preview";
import { renderUiPreview } from "@/lib/agent/ui-preview-renderer";
import { recordPrototypeArtifactRevision } from "@/lib/agent/prototype-artifacts";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  assertUpstreamMutationAllowed,
  updateExactWorkflow,
  uiPreviewTransferState,
} from "@/lib/agent/workflow-state";
import sourceStatus from "./source_status";
import prepareWorkspace from "./prepare_workspace";
import { canAutoSelectDevelopmentSource } from "@/lib/repository/development-source";
import { EVE_MAX_PAYLOAD_BYTES, serializedPayloadBytes } from "@/lib/eve/payload-envelope";

const ensurePreviewWorkspace = async (ctx: Parameters<typeof sourceStatus.execute>[1]) => {
  if (appBuilderWorkflowState.get().phase !== "empty") {
    return;
  }
  if (canAutoSelectDevelopmentSource()) {
    await sourceStatus.execute({}, ctx);
  }
  if (appBuilderWorkflowState.get().phase === "empty") {
    await prepareWorkspace.execute({}, ctx);
  }
};

export default defineTool({
  description:
    "Create or revise the Browser prototype from readable, formatted React source composed only from current Arrusted public components and compositions. Before the first call, inspect-repository must establish the exact public exports and props. Use capitalized component/composition/icon imports and inventory each exact name and source in the manifest; never infer an icon name. Lowercase package helpers are unsupported preview imports. Never author raw button, input, select, textarea, dialog, or table JSX. Keep catalogGaps empty. Export a default screen component from each screen entry. Navigation must set location.hash to an exact manifest screen route. Every enabled action must produce its intended fixture-backed visible result. Follow design-app interaction guidance and verify the rendered controls in the Browser. When revising, set baseRevision to the prior UI preview revision returned by this tool. File count and content size are unrestricted. For a source bundle that does not fit one Eve event, declare sourceFiles with each file's UTF-8 byte length and SHA-256, then send one file chunk per call using sourceChunk. Start at chunkIndex 0 and byte offset 0; continue with the returned transferId, transferRevision, nextFilePath, nextFileOffsetBytes, and nextChunkIndex. Keep each serialized event within Eve's actual envelope by reducing chunk size as needed. The source bundle is validated and rendered only after every declared file digest matches. The renderer includes the actual Arrusted theme automatically and installs missing repository dependencies as needed. If the returned receipt says requiresChunkedRead, read the stored prototype with get_prototype_artifact using its artifactDigest and artifactRevision, then continue from each returned nextOffsetBytes until complete before opening the Browser preview.",
  async execute(input, ctx) {
    let previewInput = uiPreviewInputEnvelopeSchema.parse(input);
    await ensurePreviewWorkspace(ctx);
    const current = appBuilderWorkflowState.get();
    assertUpstreamMutationAllowed(current, "UI preview recording");
    if (current.phase === "empty") {
      throw new Error("Prepare the Arrusted source before creating a UI preview.");
    }
    if (current.phase === "validation_pending") {
      throw new Error("Finish the running build check before revising the preview.");
    }
    const prior = "uiPreview" in current ? current.uiPreview : undefined;
    if (
      prior !== undefined &&
      previewInput.baseRevision !== undefined &&
      previewInput.baseRevision !== prior?.revision
    ) {
      throw new Error("The UI preview revision is stale.");
    }
    if (previewInput.sourceFiles !== undefined || previewInput.sourceChunk !== undefined) {
      const existingTransfer = uiPreviewTransferState.get() ?? undefined;
      const transfer =
        existingTransfer?.sessionId === ctx.session.id &&
        existingTransfer.sourceSha === current.workspace.sourceSha &&
        existingTransfer.sourceTree === current.workspace.sourceTree
          ? existingTransfer
          : undefined;
      const staged = stageUiPreviewSourceChunk({
        callId: ctx.callId,
        current: transfer,
        value: previewInput,
      });
      const stagedTransfer = staged.transfer;
      if (stagedTransfer !== undefined) {
        uiPreviewTransferState.update(() => ({
          ...stagedTransfer,
          sessionId: ctx.session.id,
          sourceSha: current.workspace.sourceSha,
          sourceTree: current.workspace.sourceTree,
        }));
      }
      if (staged.completeInput === undefined) {
        return staged.receipt;
      }
      previewInput = staged.completeInput;
    }
    validateUiPreview(previewInput);
    const sourceDigest = uiPreviewSourceDigest(previewInput);
    const revision = sourceDigest;
    const previewHtml = await renderUiPreview(previewInput, await ctx.getSandbox());
    const recorded = recordPrototypeArtifactRevision({
      artifacts: current.artifacts,
      callId: ctx.callId,
      content: previewHtml,
      mediaType: "text/html",
      path: `prototype/${previewInput.appId}/index.html`,
      sessionId: ctx.session.id,
    });
    const uiPreview = {
      appId: previewInput.appId,
      catalogDigest: current.workspace.eligibilityDigest,
      catalogGaps: [...previewInput.catalogGaps].toSorted((left, right) =>
        left.path.localeCompare(right.path),
      ),
      createdByCallId: ctx.callId,
      files: [...previewInput.files].toSorted((left, right) => left.path.localeCompare(right.path)),
      manifest: previewInput.manifest,
      revision,
      routes: [...previewInput.routes].toSorted(),
      sourceDigest,
      sourceSha: current.workspace.sourceSha,
      sourceTree: current.workspace.sourceTree,
    } as const;
    updateExactWorkflow({
      expected: current,
      operation: "UI preview recording",
      transition: () => ({
        artifacts: recorded.artifacts,
        ...(current.githubSource === undefined ? {} : { githubSource: current.githubSource }),
        phase: "ui_previewed",
        preparedByCallId: current.preparedByCallId,
        sourceReceipt: current.sourceReceipt,
        uiPreview,
        version: APP_BUILDER_WORKFLOW_VERSION,
        workspace: current.workspace,
      }),
    });
    uiPreviewTransferState.update(() => null);
    const result = {
      appId: uiPreview.appId,
      artifactDigest: recorded.artifact.digest,
      artifactRevision: recorded.artifact.revision,
      content: previewHtml,
      digest: createHash("sha256").update(previewHtml).digest("hex"),
      fidelity: "arrusted-component-catalog" as const,
      functionality: "fixtures-only" as const,
      reused: prior?.revision === revision,
      revision: uiPreview.revision,
      routes: uiPreview.routes,
    };
    const serializedResult = {
      data: {
        result: { kind: "tool-result", output: result, toolName: "record_ui_preview" },
      },
      type: "action.result",
    };
    if (serializedPayloadBytes(serializedResult) <= EVE_MAX_PAYLOAD_BYTES) {
      return result;
    }
    return {
      appId: result.appId,
      artifactDigest: result.artifactDigest,
      artifactRevision: result.artifactRevision,
      digest: result.digest,
      fidelity: result.fidelity,
      functionality: result.functionality,
      requiresChunkedRead: true,
      reused: result.reused,
      revision: result.revision,
      routes: result.routes,
      totalBytes: Buffer.byteLength(previewHtml, "utf-8"),
    };
  },
  inputSchema: uiPreviewInputEnvelopeSchema,
});
