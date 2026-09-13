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
import sourceStatus from "./source-status";
import prepareWorkspace from "./prepare-workspace";

export default defineTool({
  description:
    "Create or revise the Browser prototype from readable, formatted React source composed only from current Arrusted public components and compositions. Before the first call, inspect-repository must establish the exact public exports and props. Use capitalized component/composition/icon imports and inventory each exact name and source in the manifest; never infer an icon name (for example, use the exported ChevronLeft rather than an invented ArrowLeft). Lowercase package helpers such as buttonClassName are unsupported preview imports even when exported by the package. Use Button and its public props instead. Never author raw button, input, select, textarea, dialog, or table JSX, even inline in route files. Keep catalogGaps empty. Export a default screen component from each screen entry. Navigation must set location.hash to an exact manifest screen route (for example #/employees), preserving the preview pathname; the renderer reacts to hashchange, not pathname-only pushState. Every enabled action must produce its intended fixture-backed visible result. Follow design-app references/interactions.md and verify the rendered controls in the Browser; compilation alone does not prove they work. If this tool reports an import, syntax, or compilation error, repair the source and call record_ui_preview again; call accept-ui-preview only after this tool returns a current valid revision. When revising, set baseRevision to the prior UI preview revision returned by this tool, never an outer artifact or document digest. The renderer includes the actual Arrusted theme automatically: do not invent or import components/styles.css or components/tokens.css. It installs missing repository dependencies automatically when compilation requires them, and never replaces unavailable components with custom HTML. Use in local and hosted creation before recording the product decisions and complete app specification.",
  async execute(input, ctx) {
    validateUiPreview(input);
    if (appBuilderWorkflowState.get().phase === "empty") {
      await sourceStatus.execute({}, ctx);
      await prepareWorkspace.execute({}, ctx);
    }
    const current = appBuilderWorkflowState.get();
    assertUpstreamMutationAllowed(current, "UI preview recording");
    if (current.phase === "empty")
      throw new Error("Prepare the Arrusted source before creating a UI preview.");
    if (current.phase === "validation_pending")
      throw new Error("Finish the running build check before revising the preview.");
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
      callId: ctx.callId,
      content: previewHtml,
      mediaType: "text/html",
      path: `prototype/${input.appId}/index.html`,
      sessionId: ctx.session.id,
    });
    const uiPreview = {
      appId: input.appId,
      catalogDigest: current.workspace.eligibilityDigest,
      catalogGaps: [...input.catalogGaps].toSorted((left, right) =>
        left.path.localeCompare(right.path),
      ),
      createdByCallId: ctx.callId,
      files: [...input.files].toSorted((left, right) => left.path.localeCompare(right.path)),
      manifest: input.manifest,
      previewHtml,
      revision,
      routes: [...input.routes].toSorted(),
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
    return {
      appId: uiPreview.appId,
      content: uiPreview.previewHtml,
      digest: createHash("sha256").update(uiPreview.previewHtml).digest("hex"),
      fidelity: "arrusted-component-catalog" as const,
      functionality: "fixtures-only" as const,
      reused: prior?.revision === revision,
      revision: uiPreview.revision,
      routes: uiPreview.routes,
    };
  },
  inputSchema: uiPreviewInputSchema,
});
