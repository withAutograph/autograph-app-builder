import { defineTool } from "eve/tools";
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
  assertExactDependencyTargetBinding,
  bootstrapLiveTemplateDependencies,
  inspectDependencyCache,
  materializeOfflineDependencies,
  dependencyTargetForWorkspace,
} from "@/lib/repository/dependency-cache";
import {
  materializePlanningOverlay,
  targetExecutionBinding,
} from "@/lib/repository/target-planning";
import { SOURCE_RECEIPT_VERSION } from "@/lib/repository/source-receipt";
import { hasTestCapability } from "@/lib/testing/test-capability";
import { inspectSourceBoundSandboxWorkspace } from "@/lib/repository/arrusted-template";

export default defineTool({
  description:
    "After a complete AppSpec is recorded, bootstrap a fresh canonical template from its locked dependencies once, seal that closure, and materialize it into the builder-owned planning overlay. Target commands run only after the sandbox network policy is restored to deny-all; no provider or target-repository mutation is available.",
  inputSchema: z.object({
    expectedAppSpecDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
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
    const sandbox = await ctx.getSandbox();
    await inspectSourceBoundSandboxWorkspace({
      sandbox,
      receipt: current.sourceReceipt,
      expectedWorkspace: current.workspace,
    });
    if (
      current.sourceReceipt.version === SOURCE_RECEIPT_VERSION &&
      !hasTestCapability("simulated-target")
    )
      await bootstrapLiveTemplateDependencies({
        sandbox,
        target: current.workspace,
      });
    const observedCache = await inspectDependencyCache(
      sandbox,
      process.env,
      current.workspace,
      current.sourceReceipt.version === SOURCE_RECEIPT_VERSION,
    );
    assertExactDependencyTargetBinding({
      workspace: current.workspace,
      sourceReceipt: current.sourceReceipt,
      cache: observedCache,
      ...(current.phase === "app_spec_accepted"
        ? {}
        : { dependencyReceipt: current.dependencyReceipt }),
    });
    await materializePlanningOverlay({
      sandbox,
      artifactRevision: current.appSpec.artifactRevision,
      appId: current.appSpec.appId,
      appSpecContent: current.appSpec.content,
      appSpecDigest: current.appSpec.digest,
    });
    const cache = await materializeOfflineDependencies({
      sandbox,
      artifactRevision: current.appSpec.artifactRevision,
      target: current.workspace,
      preferLiveTemplate:
        current.sourceReceipt.version === SOURCE_RECEIPT_VERSION,
    });
    assertExactDependencyTargetBinding({
      workspace: current.workspace,
      sourceReceipt: current.sourceReceipt,
      cache,
      ...(current.phase === "app_spec_accepted"
        ? {}
        : { dependencyReceipt: current.dependencyReceipt }),
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

    const dependencyTarget = dependencyTargetForWorkspace(
      cache,
      current.workspace,
    );
    const unsigned = {
      version: 2 as const,
      sourceSha: current.workspace.sourceSha,
      sourceTree: current.workspace.sourceTree,
      sourceReceiptDigest: current.sourceReceipt.digest,
      eligibilityDigest: current.workspace.eligibilityDigest,
      workspaceDigest: current.workspace.workspaceDigest,
      imageDigest: execution.imageDigest,
      dependencyCacheDigest: execution.dependencyCacheDigest,
      appSpecDigest: current.appSpec.digest,
      artifactRevision: current.appSpec.artifactRevision,
      targetSha: dependencyTarget.sha,
      targetTree: dependencyTarget.tree,
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
        ...(current.githubSource === undefined
          ? {}
          : { githubSource: current.githubSource }),
        artifacts: current.artifacts,
        appSpec: current.appSpec,
        dependencyReceipt,
      };
    });
    return { ...dependencyReceipt, reused: false };
  },
});
