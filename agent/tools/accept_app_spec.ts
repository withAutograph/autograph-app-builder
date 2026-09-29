import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  appSpecRepairDiagnostic,
  normalizeBuildReadyAppSpec,
  validateBuildReadyAppSpec,
} from "@/lib/agent/app-spec-validation";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  sha256,
  updateExactWorkflow,
  validAppId,
} from "@/lib/agent/workflow-state";
import { planAcceptedAppSpec as continueAcceptedAppSpec } from "@/lib/agent/accepted-spec-planning";
import { existingAppChangesSchema } from "@/lib/agent/existing-app-changes";

import { prepareAppCreation } from "@/lib/agent/prepare-app-creation";
import { productAcceptanceObligations } from "@/lib/agent/product-acceptance";
import type { AcceptedAppSpec } from "@/lib/agent/workflow-state";
import { inspectCanonicalAppSpec } from "@/lib/agent/accepted-app-spec-stream";
import { isPrototypeArtifactV2 } from "@/lib/agent/prototype-artifacts";
import { createHostedPrototypeChunkStore } from "@/lib/agent/hosted-prototype-chunk-store";
import { openHostedPostgresDatabase } from "@/lib/mcp/hosted-route";

const acceptanceResult = (appSpec: AcceptedAppSpec, reused: boolean) => ({
  ...appSpec,
  productAcceptance: productAcceptanceObligations(appSpec),
  reused,
});

/**
 * Planning is the deterministic continuation of a successfully accepted
 * design.  Keeping it here prevents a live model turn from becoming a
 * required orchestration hop between a complete design and its plan.
 */
const planAcceptedAppSpec = async (
  ctx: Parameters<typeof prepareAppCreation>[1],
  existingAppChanges?: { path: string; content: string }[],
) => {
  const latest = appBuilderWorkflowState.get();
  await continueAcceptedAppSpec({
    phase: latest.phase,
    plan: async () => {
      await prepareAppCreation(existingAppChanges === undefined ? {} : { existingAppChanges }, ctx);
    },
    planComplete: "proposal" in latest,
  });
};

export default defineTool({
  description:
    "Silently validate the complete AppSpec artifact and continue planning. Before authoring it, read design-app references/app-spec.md and use its complete canonical skeleton: every required heading and the final Build handoff status. Missing product sections must be authored, not inferred by this tool. For an existing app, include existingAppChanges with complete replacement contents for each app-owned file to change; if recording the AppSpec said planning needs changes, call this tool with the accepted artifact and those changes before requesting build approval. No new approval receipt is required. This does not publish or change an external repository.",
  async execute(
    { appId, expectedArtifactDigest, expectedArtifactRevision, existingAppChanges },
    ctx,
  ) {
    if (!validAppId(appId)) {
      throw new Error("App id must be one lowercase kebab-case segment.");
    }
    const current = appBuilderWorkflowState.get();
    if (current.phase === "empty") {
      throw new Error("Start a workspace before creating an implementation plan.");
    }
    const path = `prototype/${appId}/app-spec.md`;
    const artifact = current.artifacts.find(
      (candidate) =>
        candidate.path === path &&
        candidate.sessionId === ctx.session.id &&
        (expectedArtifactDigest === undefined || candidate.digest === expectedArtifactDigest) &&
        (expectedArtifactRevision === undefined || candidate.revision === expectedArtifactRevision),
    );
    if (artifact === undefined) {
      throw new Error("Create a product design before creating its implementation plan.");
    }
    if (artifact.mediaType !== "text/markdown" || artifact.transfer !== undefined) {
      throw new Error("The accepted AppSpec artifact media type is invalid.");
    }
    // A resumed acceptance is bound to the recorded artifact revision. New
    // draft normalization must not rewrite an already accepted snapshot or
    // invalidate its preparation, apply, validation, or publication receipts.
    if (
      "appSpec" in current &&
      current.appSpec.appId === appId &&
      current.appSpec.artifactPath === artifact.path &&
      current.appSpec.artifactRevision === artifact.revision
    ) {
      await planAcceptedAppSpec(ctx, existingAppChanges);
      return acceptanceResult(current.appSpec, true);
    }
    let content: string | undefined;
    let digest: string;
    let walkthrough: string | undefined;
    if (isPrototypeArtifactV2(artifact)) {
      const store = createHostedPrototypeChunkStore({
        db: openHostedPostgresDatabase(process.env.DATABASE_URL ?? ""),
        sessionAuth: ctx.session.auth,
        sessionId: ctx.session.id,
      });
      const inspection = await inspectCanonicalAppSpec({
        artifact,
        readChunk: async (chunkIndex) =>
          await store.get({
            chunkIndex,
            path: artifact.path,
            transferDigest: artifact.digest,
          }),
      });
      ({ digest, walkthrough } = inspection);
    } else {
      content = normalizeBuildReadyAppSpec(artifact.content);
      const validation = validateBuildReadyAppSpec(content);
      if (!validation.valid) {
        throw new Error(appSpecRepairDiagnostic(validation));
      }
      digest = sha256(content);
    }
    const accepted: AcceptedAppSpec = {
      acceptedByCallId: ctx.callId,
      appId,
      artifactPath: artifact.path,
      artifactRevision: artifact.revision,
      ...(content === undefined ? { version: 2, walkthrough } : { content }),
      digest,
      ...(current.phase === "ui_accepted" ? { uiRevision: current.uiPreview.revision } : {}),
    };
    if (
      "appSpec" in current &&
      current.appSpec.digest === accepted.digest &&
      current.appSpec.appId === accepted.appId
    ) {
      await planAcceptedAppSpec(ctx, existingAppChanges);
      return acceptanceResult(current.appSpec, true);
    }
    updateExactWorkflow({
      expected: current,
      operation: "AppSpec acceptance",
      transition: () => ({
        appSpec: accepted,
        artifacts: current.artifacts,
        ...(current.githubSource === undefined ? {} : { githubSource: current.githubSource }),
        phase: "app_spec_accepted",
        preparedByCallId: current.preparedByCallId,
        sourceReceipt: current.sourceReceipt,
        version: APP_BUILDER_WORKFLOW_VERSION,
        workspace: current.workspace,
      }),
    });
    await planAcceptedAppSpec(ctx, existingAppChanges);
    return acceptanceResult(accepted, false);
  },
  inputSchema: z.strictObject({
    appId: z.string().min(1),
    existingAppChanges: existingAppChangesSchema.optional(),
    expectedArtifactDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    expectedArtifactRevision: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
  }),
});
