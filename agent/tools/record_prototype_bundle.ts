import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  prototypeArtifactReceipt,
  recordPrototypeArtifactBundle,
} from "@/lib/agent/prototype-artifacts";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  assertUpstreamMutationAllowed,
  updateExactWorkflow,
  validAppId,
} from "@/lib/agent/workflow-state";

import acceptAppSpec from "./accept_app_spec";

export default defineTool({
  description:
    "Record one complete, usable new-app prototype bundle and continue silently through implementation planning in one internal operation. Prefer this normal creation path over three record_prototype_artifact calls. Before calling, provide a complete build-ready internal design with each heading exactly once: ## Status and prototype; ## User and outcome; ## Interfaces and navigation; ## Controls and behavior; ## Data model; ## Integrations and reconciliation; ## Temporal semantics; ## Writes, review, and authority; ## Access and tenancy; ## Agent behavior; ## Operational states; ## Defaults, non-goals, and risks; ## Acceptance walkthrough; ## Build handoff. End Build handoff with one closed json block using status build-ready. It never writes the target repository.",
  inputSchema: z.strictObject({
    appId: z.string().min(1),
    indexHtml: z.string().min(1).max(262_144),
    decisionsMarkdown: z.string().min(1).max(262_144),
    appSpecMarkdown: z.string().min(1).max(262_144),
  }),
  async execute(
    { appId, indexHtml, decisionsMarkdown, appSpecMarkdown },
    ctx,
  ) {
    if (!validAppId(appId))
      throw new Error("App id must be one lowercase kebab-case segment.");
    const current = appBuilderWorkflowState.get();
    assertUpstreamMutationAllowed(current, "prototype bundle recording");
    if (current.phase === "empty")
      throw new Error(
        "Prepare a workspace before recording a prototype bundle.",
      );
    if (current.phase === "validation_pending")
      throw new Error(
        `Target validation attempt ${current.validationAttempt.digest} is pending; artifact mutation is disabled until it is recovered.`,
      );
    const recorded = recordPrototypeArtifactBundle({
      artifacts: current.artifacts,
      appId,
      indexHtml,
      decisionsMarkdown,
      appSpecMarkdown,
      sessionId: ctx.session.id,
      callId: ctx.callId,
      expectedAppId:
        current.phase === "app_spec_accepted" ||
        current.phase === "dependencies_prepared" ||
        current.phase === "identity_resolved" ||
        current.phase === "planned" ||
        current.phase === "apply_failed" ||
        current.phase === "applied" ||
        current.phase === "validation_failed" ||
        current.phase === "validated" ||
        current.phase === "reviewed"
          ? current.appSpec.appId
          : undefined,
    });
    if (!recorded.reused)
      updateExactWorkflow({
        expected: current,
        operation: "prototype bundle recording",
        transition: () => ({
          version: APP_BUILDER_WORKFLOW_VERSION,
          phase: "prepared",
          preparedByCallId: current.preparedByCallId,
          workspace: current.workspace,
          sourceReceipt: current.sourceReceipt,
          ...(current.githubSource === undefined
            ? {}
            : { githubSource: current.githubSource }),
          artifacts: recorded.artifacts,
        }),
      });
    await acceptAppSpec.execute(
      {
        appId,
        expectedArtifactDigest: recorded.appSpec.digest,
        expectedArtifactRevision: recorded.appSpec.revision,
        expectedSourceSha: current.workspace.sourceSha,
        expectedSourceTree: current.workspace.sourceTree,
        expectedEligibilityDigest: current.workspace.eligibilityDigest,
        expectedWorkspaceDigest: current.workspace.workspaceDigest,
      },
      ctx,
    );
    return {
      appId,
      artifacts: recorded.artifacts.map(prototypeArtifactReceipt),
      reused: recorded.reused,
      implementationPlanReady: true,
    };
  },
});
