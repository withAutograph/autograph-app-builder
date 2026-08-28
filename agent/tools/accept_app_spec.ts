import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  approvalReceiptSchema,
  approvalRequestDecision,
  approvalTargetFromGitHubSource,
  assertApprovalReceipt,
  gitObjectIdSchema,
} from "@/lib/agent/approval-receipt";
import { exactPrototypeArtifact } from "@/lib/agent/prototype-artifacts";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  assertExactWorkflowState,
  assertUpstreamMutationAllowed,
  validAppId,
} from "@/lib/agent/workflow-state";

function validBuildReadyAppSpec(content: string): boolean {
  const headings = [
    "Status and prototype",
    "User and outcome",
    "Interfaces and navigation",
    "Controls and behavior",
    "Data model",
    "Integrations and reconciliation",
    "Temporal semantics",
    "Writes, review, and authority",
    "Access and tenancy",
    "Agent behavior",
    "Operational states",
    "Defaults, non-goals, and risks",
    "Acceptance walkthrough",
    "Build handoff",
  ];
  if (
    headings.some(
      (heading) =>
        (content.match(new RegExp(`^## ${heading}$`, "gmu")) ?? []).length !==
        1,
    )
  )
    return false;
  const block = /^## Build handoff\n\n```json\n([\s\S]*?)\n```$/mu.exec(
    content,
  );
  if (block?.[1] === undefined) return false;
  try {
    const handoff = JSON.parse(block[1]) as unknown;
    return (
      typeof handoff === "object" &&
      handoff !== null &&
      !Array.isArray(handoff) &&
      (handoff as { status?: unknown }).status === "build-ready"
    );
  } catch {
    return false;
  }
}

export default defineTool({
  description:
    "Record explicit acceptance of one complete build-ready AppSpec. The acceptance is bound to the prepared workspace receipt and does not write or execute anything in the target repository.",
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
  approval: ({ toolInput }) => {
    const state = appBuilderWorkflowState.get();
    if (toolInput === undefined || state.phase === "empty")
      return {
        type: "denied",
        reason: "A prepared workflow is required before AppSpec approval.",
      };
    if (
      state.workspace.sourceSha !== toolInput.expectedSourceSha ||
      state.workspace.sourceTree !== toolInput.expectedSourceTree ||
      state.workspace.eligibilityDigest !==
        toolInput.expectedEligibilityDigest ||
      state.workspace.workspaceDigest !== toolInput.expectedWorkspaceDigest
    )
      return {
        type: "denied",
        reason: "The AppSpec approval subject is stale.",
      };
    return approvalRequestDecision({
      phase: "appspec",
      toolName: "accept_app_spec",
      toolInput,
      githubSource: state.githubSource,
      subjectDigest: toolInput.expectedArtifactDigest,
    });
  },
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
    if (!validBuildReadyAppSpec(artifact.content))
      throw new Error(
        "AppSpec artifact is not a complete build-ready AppSpec.",
      );
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
      current.githubSource === undefined
        ? undefined
        : assertApprovalReceipt({
            actual:
              approvalReceipt ??
              (() => {
                throw new Error(
                  "The GitHub-bound AppSpec approval receipt is missing.",
                );
              })(),
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
    appBuilderWorkflowState.update((latest) => {
      assertExactWorkflowState(latest, current, "AppSpec acceptance");
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
    });
    return { ...accepted, reused: false };
  },
});
