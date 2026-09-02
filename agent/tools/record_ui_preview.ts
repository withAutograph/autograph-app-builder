import { defineTool } from "eve/tools";
import { createHash } from "node:crypto";

import {
  fallbackUiPreviewHtml,
  uiPreviewInputSchema,
  uiPreviewSourceDigest,
  validateUiPreview,
} from "@/lib/agent/ui-preview";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  assertUpstreamMutationAllowed,
  updateExactWorkflow,
} from "@/lib/agent/workflow-state";

export default defineTool({
  description:
    "Create or revise a fixture-backed UI preview from React source composed with the prepared Arrusted component catalog. This writes only builder-owned preview state. It must not plan, scaffold, validate, or implement backend behavior.",
  inputSchema: uiPreviewInputSchema,
  async execute(input, ctx) {
    validateUiPreview(input);
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
      input.baseRevision !== undefined &&
      input.baseRevision !== prior?.revision
    )
      throw new Error("The UI preview revision is stale.");
    const sourceDigest = uiPreviewSourceDigest(input);
    const revision = sourceDigest;
    const previewHtml = fallbackUiPreviewHtml(input);
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
        artifacts: current.artifacts,
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
