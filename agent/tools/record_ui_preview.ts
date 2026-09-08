import { defineTool } from "eve/tools";
import { createHash } from "node:crypto";

import {
  uiPreviewInputSchema,
  uiPreviewSourceDigest,
  validateUiPreview,
} from "@/lib/agent/ui-preview";
import { renderUiPreview } from "@/lib/agent/ui-preview-renderer";
import { recordPrototypeArtifactRevision } from "@/lib/agent/prototype-artifacts";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  assertUpstreamMutationAllowed,
  updateExactWorkflow,
} from "@/lib/agent/workflow-state";
import sourceStatus from "./source_status";
import prepareWorkspace from "./prepare_workspace";

export default defineTool({
  description:
    "Create or revise the Browser prototype from React source composed only from current Arrusted public components and compositions. Export a default screen component from each screen entry. This automatically compiles the submitted source and actual Arrusted theme; it never replaces unavailable components with custom HTML. Use in local and hosted creation before recording the product decisions and complete app specification.",
  inputSchema: uiPreviewInputSchema,
  async execute(input, ctx) {
    validateUiPreview(input);
    if (appBuilderWorkflowState.get().phase === "empty") {
      await sourceStatus.execute({}, ctx);
      await prepareWorkspace.execute({}, ctx);
    }
    const current = appBuilderWorkflowState.get();
    assertUpstreamMutationAllowed(current, "UI preview recording");
    if (current.phase === "empty")
      throw new Error(
        "Prepare the Arrusted source before creating a UI preview.",
      );
    if (
      current.phase !== "prepared" &&
      current.phase !== "ui_previewed" &&
      current.phase !== "ui_accepted"
    )
      throw new Error("The current workflow cannot return to UI preview work.");
    const prior = "uiPreview" in current ? current.uiPreview : undefined;
    if (
      prior !== undefined &&
      input.baseRevision !== undefined &&
      input.baseRevision !== prior?.revision
    )
      throw new Error("The UI preview revision is stale.");
    const sourceDigest = uiPreviewSourceDigest(input);
    const revision = sourceDigest;
    const previewHtml = await renderUiPreview(input, await ctx.getSandbox());
    const recorded = recordPrototypeArtifactRevision({
      artifacts: current.artifacts,
      path: `prototype/${input.appId}/index.html`,
      mediaType: "text/html",
      content: previewHtml,
      sessionId: ctx.session.id,
      callId: ctx.callId,
    });
    const uiPreview = {
      appId: input.appId,
      revision,
      sourceDigest,
      catalogDigest: current.workspace.eligibilityDigest,
      sourceSha: current.workspace.sourceSha,
      sourceTree: current.workspace.sourceTree,
      routes: [...input.routes].toSorted(),
      files: [...input.files].toSorted((left, right) =>
        left.path.localeCompare(right.path),
      ),
      manifest: input.manifest,
      catalogGaps: [...input.catalogGaps].toSorted((left, right) =>
        left.path.localeCompare(right.path),
      ),
      previewHtml,
      createdByCallId: ctx.callId,
    } as const;
    updateExactWorkflow({
      expected: current,
      operation: "UI preview recording",
      transition: () => ({
        version: APP_BUILDER_WORKFLOW_VERSION,
        phase: "ui_previewed",
        preparedByCallId: current.preparedByCallId,
        workspace: current.workspace,
        sourceReceipt: current.sourceReceipt,
        ...(current.githubSource === undefined
          ? {}
          : { githubSource: current.githubSource }),
        artifacts: recorded.artifacts,
        uiPreview,
      }),
    });
    return {
      appId: uiPreview.appId,
      revision: uiPreview.revision,
      routes: uiPreview.routes,
      fidelity: "arrusted-component-catalog" as const,
      functionality: "fixtures-only" as const,
      content: uiPreview.previewHtml,
      digest: createHash("sha256").update(uiPreview.previewHtml).digest("hex"),
      reused: prior?.revision === revision,
    };
  },
});
