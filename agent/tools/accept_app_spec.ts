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

import planAppCreation from "./plan_app_creation";

/**
 * Planning is the deterministic continuation of a successfully accepted
 * design.  Keeping it here prevents a live model turn from becoming a
 * required orchestration hop between a complete design and its plan.
 *
 * `plan_app_creation` remains independently callable for diagnostics and its
 * own state transition makes retries safe.  This guard avoids even invoking
 * it again once the accepted design has already produced a proposal.
 */
async function planAcceptedAppSpec(
  digest: string,
  ctx: Parameters<typeof planAppCreation.execute>[1],
  existingAppChanges?: { path: string; content: string }[],
) {
  const latest = appBuilderWorkflowState.get();
  await continueAcceptedAppSpec({
    phase: latest.phase,
    planComplete:
      latest.phase === "planned" ||
      latest.phase === "apply_failed" ||
      latest.phase === "applied" ||
      latest.phase === "validation_pending" ||
      latest.phase === "validation_failed" ||
      latest.phase === "validated" ||
      latest.phase === "reviewed",
    plan: async () => {
      await planAppCreation.execute(
        {
          expectedAppSpecDigest: digest,
          ...(existingAppChanges === undefined ? {} : { existingAppChanges }),
        },
        ctx,
      );
    },
  });
}

export default defineTool({
  description:
    "Silently turn the current product design into internal planning state and continue planning. It repairs routine internal document gaps itself and never requires a source receipt, workspace receipt, or approval receipt. It does not publish or otherwise change an external repository.",
  inputSchema: z.strictObject({
    appId: z.string().min(1),
    expectedArtifactDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    expectedArtifactRevision: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    existingAppChanges: existingAppChangesSchema.optional(),
  }),
  async execute(
    {
      appId,
      expectedArtifactDigest,
      expectedArtifactRevision,
      existingAppChanges,
    },
    ctx,
  ) {
    if (!validAppId(appId))
      throw new Error("App id must be one lowercase kebab-case segment.");
    const current = appBuilderWorkflowState.get();
    if (current.phase === "empty")
      throw new Error(
        "Start a workspace before creating an implementation plan.",
      );
    const path = `prototype/${appId}/app-spec.md`;
    const artifact = current.artifacts.find(
      (candidate) =>
        candidate.path === path &&
        candidate.sessionId === ctx.session.id &&
        (expectedArtifactDigest === undefined ||
          candidate.digest === expectedArtifactDigest) &&
        (expectedArtifactRevision === undefined ||
          candidate.revision === expectedArtifactRevision),
    );
    if (artifact === undefined)
      throw new Error(
        "Create a product design before creating its implementation plan.",
      );
    if (artifact.mediaType !== "text/markdown")
      throw new Error("The accepted AppSpec artifact media type is invalid.");
    const content = normalizeBuildReadyAppSpec(artifact.content);
    const validation = validateBuildReadyAppSpec(content);
    if (!validation.valid) throw new Error(appSpecRepairDiagnostic(validation));
    const accepted = {
      appId,
      artifactPath: artifact.path,
      content,
      digest: sha256(content),
      acceptedByCallId: ctx.callId,
      artifactRevision: artifact.revision,
      ...(current.phase === "ui_accepted"
        ? { uiRevision: current.uiPreview.revision }
        : {}),
    };
    if (
      (current.phase === "app_spec_accepted" ||
        current.phase === "dependencies_prepared" ||
        current.phase === "identity_resolved" ||
        current.phase === "planned" ||
        current.phase === "apply_failed" ||
        current.phase === "applied" ||
        current.phase === "validation_failed" ||
        current.phase === "validated" ||
        current.phase === "reviewed") &&
      current.appSpec.digest === accepted.digest &&
      current.appSpec.appId === accepted.appId
    ) {
      await planAcceptedAppSpec(
        current.appSpec.digest,
        ctx,
        existingAppChanges,
      );
      return { ...current.appSpec, reused: true };
    }
    updateExactWorkflow({
      expected: current,
      operation: "AppSpec acceptance",
      transition: () => {
        return {
          version: APP_BUILDER_WORKFLOW_VERSION,
          phase: "app_spec_accepted",
          workspace: current.workspace,
          sourceReceipt: current.sourceReceipt,
          ...(current.githubSource === undefined
            ? {}
            : { githubSource: current.githubSource }),
          preparedByCallId: current.preparedByCallId,
          artifacts: current.artifacts,
          appSpec: accepted,
        };
      },
    });
    await planAcceptedAppSpec(accepted.digest, ctx, existingAppChanges);
    return { ...accepted, reused: false };
  },
});
