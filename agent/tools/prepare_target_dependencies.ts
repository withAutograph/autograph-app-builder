import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { exactPrototypeArtifact } from "@/lib/agent/prototype-artifacts";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  assertExactWorkflowState,
  assertUpstreamMutationAllowed,
  sha256,
} from "@/lib/agent/workflow-state";
import {
  ARRUSTED_TARGET_SHA,
  ARRUSTED_TARGET_TREE,
  materializeOfflineDependencies,
} from "@/lib/repository/dependency-cache";
import {
  materializePlanningOverlay,
  targetExecutionBinding,
} from "@/lib/repository/target-planning";

export default defineTool({
  description:
    "Materialize the fixed verified offline dependency closure into the builder-owned planning overlay. Approval is bound to the accepted AppSpec; no target command, network, apply, validation, or prepared-target mutation is available.",
  inputSchema: z.object({
    expectedAppSpecDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  approval: always(),
  async execute({ expectedAppSpecDigest }, ctx) {
    const current = appBuilderWorkflowState.get();
    assertUpstreamMutationAllowed(current, "target dependency preparation");
    if (current.phase === "empty" || current.phase === "prepared")
      throw new Error(
        "Accept a build-ready AppSpec before preparing target dependencies.",
      );
    if (current.appSpec.digest !== expectedAppSpecDigest)
      throw new Error(
        "The accepted AppSpec changed before dependency preparation.",
      );
    exactPrototypeArtifact(current.artifacts, {
      path: current.appSpec.artifactPath,
      digest: current.appSpec.digest,
      revision: current.appSpec.artifactRevision,
      sessionId: ctx.session.id,
    });
    await materializePlanningOverlay({
      sandbox: await ctx.getSandbox(),
      artifactRevision: current.appSpec.artifactRevision,
      appId: current.appSpec.appId,
      appSpecContent: current.appSpec.content,
      appSpecDigest: current.appSpec.digest,
    });
    const cache = await materializeOfflineDependencies({
      sandbox: await ctx.getSandbox(),
      artifactRevision: current.appSpec.artifactRevision,
    });
    const execution = targetExecutionBinding(cache);

    if (current.phase !== "app_spec_accepted") {
      const receipt = current.dependencyReceipt;
      if (
        receipt.imageDigest !== execution.imageDigest ||
        receipt.dependencyCacheDigest !== execution.dependencyCacheDigest ||
        receipt.cacheManifestDigest !== cache.manifestDigest ||
        receipt.cacheContentDigest !== cache.contentDigest
      )
        throw new Error(
          "The offline dependency cache changed after its durable receipt.",
        );
      return { ...receipt, reused: true };
    }

    const unsigned = {
      version: 1 as const,
      sourceSha: current.workspace.sourceSha,
      eligibilityDigest: current.workspace.eligibilityDigest,
      workspaceDigest: current.workspace.workspaceDigest,
      imageDigest: execution.imageDigest,
      dependencyCacheDigest: execution.dependencyCacheDigest,
      appSpecDigest: current.appSpec.digest,
      artifactRevision: current.appSpec.artifactRevision,
      targetSha: ARRUSTED_TARGET_SHA,
      targetTree: ARRUSTED_TARGET_TREE,
      cacheManifestDigest: cache.manifestDigest,
      cacheContentDigest: cache.contentDigest,
      preparedByCallId: ctx.callId,
    };
    const dependencyReceipt = {
      ...unsigned,
      digest: sha256(JSON.stringify(unsigned)),
    };
    appBuilderWorkflowState.update((latest) => {
      assertExactWorkflowState(latest, current, "dependency receipt recording");
      return {
        version: APP_BUILDER_WORKFLOW_VERSION,
        phase: "dependencies_prepared",
        preparedByCallId: current.preparedByCallId,
        workspace: current.workspace,
        sourceReceipt: current.sourceReceipt,
        artifacts: current.artifacts,
        appSpec: current.appSpec,
        dependencyReceipt,
      };
    });
    return { ...dependencyReceipt, reused: false };
  },
});
