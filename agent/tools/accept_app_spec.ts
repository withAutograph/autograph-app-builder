import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  approvalReceiptSchema,
  approvalTargetFromGitHubSource,
  assertApprovalReceipt,
  gitObjectIdSchema,
} from "@/lib/agent/approval-receipt";
import { exactPrototypeArtifact } from "@/lib/agent/prototype-artifacts";
import {
  appSpecRepairDiagnostic,
  validateBuildReadyAppSpec,
} from "@/lib/agent/app-spec-validation";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  assertUpstreamMutationAllowed,
  updateExactWorkflow,
  validAppId,
} from "@/lib/agent/workflow-state";

export default defineTool({
  description:
    "Silently validate and record one complete build-ready AppSpec as internal planning state. The Markdown must contain each of the 14 exact level-two headings from the design-app AppSpec reference once and end with its closed build-ready JSON handoff. On rejection, use the structured app_spec_invalid issues and exact example to replace the complete artifact and retry without asking the user. It remains bound to the prepared workspace receipt and does not write or execute anything in the target repository.",
  inputSchema: z.strictObject({
    appId: z.string().min(1),
    expectedArtifactDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    expectedArtifactRevision: z.string().regex(/^[0-9a-f]{64}$/u),
    expectedSourceSha: gitObjectIdSchema,
    expectedSourceTree: gitObjectIdSchema,
    expectedEligibilityDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    expectedWorkspaceDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    approvalReceipt: approvalReceiptSchema.optional(),
  }),
  async execute(
    {
      appId,
      expectedArtifactDigest,
      expectedArtifactRevision,
      expectedSourceSha,
      expectedSourceTree,
      expectedEligibilityDigest,
      expectedWorkspaceDigest,
      approvalReceipt,
    },
    ctx,
  ) {
    if (!validAppId(appId))
      throw new Error("App id must be one lowercase kebab-case segment.");
    const current = appBuilderWorkflowState.get();
    assertUpstreamMutationAllowed(current, "AppSpec acceptance");
    if (current.phase === "validation_pending")
      throw new Error(
        `Target validation attempt ${current.validationAttempt.digest} is pending; AppSpec mutation is disabled until it is recovered.`,
      );
    if (current.phase === "empty")
      throw new Error(
        "Prepare an eligible repository before accepting an AppSpec.",
      );
    const workspace = current.workspace;
    const path = `prototype/${appId}/app-spec.md`;
    const artifact = exactPrototypeArtifact(current.artifacts, {
      path,
      digest: expectedArtifactDigest,
      revision: expectedArtifactRevision,
      sessionId: ctx.session.id,
    });
    if (artifact.mediaType !== "text/markdown")
      throw new Error("The accepted AppSpec artifact media type is invalid.");
    const validation = validateBuildReadyAppSpec(artifact.content);
    if (!validation.valid) throw new Error(appSpecRepairDiagnostic(validation));
    if (
      workspace.sourceSha !== expectedSourceSha ||
      workspace.sourceTree !== expectedSourceTree ||
      workspace.eligibilityDigest !== expectedEligibilityDigest ||
      workspace.workspaceDigest !== expectedWorkspaceDigest
    )
      throw new Error(
        "The prepared workspace receipt changed before AppSpec acceptance.",
      );
    if (current.githubSource === undefined && approvalReceipt !== undefined)
      throw new Error(
        "An AppSpec approval receipt requires an immutable GitHub source binding.",
      );
    const exactApprovalReceipt =
      current.githubSource === undefined || approvalReceipt === undefined
        ? undefined
        : assertApprovalReceipt({
            actual: approvalReceipt,
            phase: "appspec",
            target: approvalTargetFromGitHubSource(current.githubSource),
            subjectDigest: artifact.digest,
          });
    const accepted = {
      appId,
      artifactPath: artifact.path,
      content: artifact.content,
      digest: artifact.digest,
      acceptedByCallId: ctx.callId,
      artifactRevision: artifact.revision,
      ...(exactApprovalReceipt === undefined
        ? {}
        : { approvalReceipt: exactApprovalReceipt }),
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
      if (
        JSON.stringify(current.appSpec.approvalReceipt) !==
        JSON.stringify(accepted.approvalReceipt)
      )
        throw new Error(
          "The AppSpec approval receipt changed after acceptance.",
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
          workspace,
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
    return { ...accepted, reused: false };
  },
});
