import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

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
  inputSchema: z.object({
    appId: z.string().min(1),
    expectedArtifactDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    expectedArtifactRevision: z.string().regex(/^[0-9a-f]{64}$/u),
    expectedSourceSha: z.string().regex(/^[0-9a-f]{40}$/u),
    expectedEligibilityDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    expectedWorkspaceDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  approval: always(),
  async execute(
    {
      appId,
      expectedArtifactDigest,
      expectedArtifactRevision,
      expectedSourceSha,
      expectedEligibilityDigest,
      expectedWorkspaceDigest,
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
      workspace.eligibilityDigest !== expectedEligibilityDigest ||
      workspace.workspaceDigest !== expectedWorkspaceDigest
    )
      throw new Error(
        "The prepared workspace receipt changed before AppSpec acceptance.",
      );
    const accepted = {
      appId,
      artifactPath: artifact.path,
      content: artifact.content,
      digest: artifact.digest,
      acceptedByCallId: ctx.callId,
      artifactRevision: artifact.revision,
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
    )
      return { ...current.appSpec, reused: true };
    appBuilderWorkflowState.update((latest) => {
      assertExactWorkflowState(latest, current, "AppSpec acceptance");
      return {
        version: APP_BUILDER_WORKFLOW_VERSION,
        phase: "app_spec_accepted",
        workspace,
        sourceReceipt: current.sourceReceipt,
        preparedByCallId: current.preparedByCallId,
        artifacts: current.artifacts,
        appSpec: accepted,
      };
    });
    return { ...accepted, reused: false };
  },
});
