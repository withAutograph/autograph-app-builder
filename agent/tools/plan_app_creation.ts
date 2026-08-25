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
  type TargetIdentityReceipt,
} from "@/lib/agent/workflow-state";
import { inspectDependencyCache } from "@/lib/repository/dependency-cache";
import {
  executeTargetIdentityAndPlanning,
  fixtureTargetCommandExecutor,
  sandboxTargetCommandExecutor,
  targetExecutionBinding,
} from "@/lib/repository/target-planning";

export default defineTool({
  description:
    "Run the two fixed read-only target commands for app identity and canonical planning. Approval is bound to the accepted AppSpec; no apply, validation, target write, network, arbitrary shell, arguments, cwd, or environment are available.",
  inputSchema: z.object({
    expectedAppSpecDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  approval: always(),
  async execute({ expectedAppSpecDigest }, ctx) {
    const current = appBuilderWorkflowState.get();
    assertUpstreamMutationAllowed(current, "target identity and planning");
    if (
      current.phase === "empty" ||
      current.phase === "prepared" ||
      current.phase === "app_spec_accepted"
    )
      throw new Error(
        "Prepare the approved offline dependency closure before running target planning.",
      );
    if (current.appSpec.digest !== expectedAppSpecDigest)
      throw new Error("The accepted AppSpec changed before target planning.");
    exactPrototypeArtifact(current.artifacts, {
      path: current.appSpec.artifactPath,
      digest: current.appSpec.digest,
      revision: current.appSpec.artifactRevision,
      sessionId: ctx.session.id,
    });
    const sandbox = await ctx.getSandbox();
    const cache = await inspectDependencyCache(sandbox);
    const execution = targetExecutionBinding(cache);
    if (
      current.dependencyReceipt.imageDigest !== execution.imageDigest ||
      current.dependencyReceipt.dependencyCacheDigest !==
        execution.dependencyCacheDigest ||
      current.dependencyReceipt.cacheManifestDigest !== cache.manifestDigest ||
      current.dependencyReceipt.cacheContentDigest !== cache.contentDigest
    )
      throw new Error(
        "The offline dependency cache changed after its durable receipt.",
      );
    if (
      current.phase === "planned" ||
      current.phase === "apply_failed" ||
      current.phase === "applied" ||
      current.phase === "validation_pending" ||
      current.phase === "validation_failed" ||
      current.phase === "validated" ||
      current.phase === "reviewed"
    )
      return { ...current.proposal, reused: true };

    const binding = {
      sourceSha: current.workspace.sourceSha,
      eligibilityDigest: current.workspace.eligibilityDigest,
      workspaceDigest: current.workspace.workspaceDigest,
      imageDigest: execution.imageDigest,
      dependencyCacheDigest: execution.dependencyCacheDigest,
      appSpecDigest: current.appSpec.digest,
      artifactRevision: current.appSpec.artifactRevision,
    };
    let identityReceipt: TargetIdentityReceipt | undefined =
      current.phase === "identity_resolved"
        ? current.identityReceipt
        : undefined;
    let workflowBeforeProposal = current;
    const result = await executeTargetIdentityAndPlanning({
      sandbox,
      executor: execution.fixture
        ? fixtureTargetCommandExecutor()
        : sandboxTargetCommandExecutor(sandbox),
      appId: current.appSpec.appId,
      appSpecContent: current.appSpec.content,
      appSpecDigest: current.appSpec.digest,
      artifactRevision: current.appSpec.artifactRevision,
      onIdentity(identity) {
        if (identityReceipt !== undefined) {
          if (
            JSON.stringify(identityReceipt.identity) !==
            JSON.stringify(identity)
          )
            throw new Error(
              "Target identity changed after its durable receipt.",
            );
          return;
        }
        const unsigned = {
          version: 1 as const,
          ...binding,
          identity,
          resolvedByCallId: ctx.callId,
        };
        identityReceipt = {
          ...unsigned,
          digest: sha256(JSON.stringify(unsigned)),
        };
        const identityState = {
          version: APP_BUILDER_WORKFLOW_VERSION,
          phase: "identity_resolved",
          preparedByCallId: current.preparedByCallId,
          workspace: current.workspace,
          sourceReceipt: current.sourceReceipt,
          artifacts: current.artifacts,
          appSpec: current.appSpec,
          dependencyReceipt: current.dependencyReceipt,
          identityReceipt: identityReceipt!,
        } as const;
        appBuilderWorkflowState.update((latest) => {
          assertExactWorkflowState(
            latest,
            current,
            "target identity receipt recording",
          );
          return identityState;
        });
        workflowBeforeProposal = identityState;
      },
    });
    if (identityReceipt === undefined)
      throw new Error("Target identity receipt was not recorded.");
    const recordedIdentity = identityReceipt;
    const unsigned = {
      version: 1 as const,
      ...binding,
      identityDigest: recordedIdentity.digest,
      contractDigest: result.contractDigest,
      target: result.proposal,
      plannedByCallId: ctx.callId,
    };
    const proposal = { ...unsigned, digest: sha256(JSON.stringify(unsigned)) };
    appBuilderWorkflowState.update((latest) => {
      assertExactWorkflowState(
        latest,
        workflowBeforeProposal,
        "target proposal recording",
      );
      return {
        version: APP_BUILDER_WORKFLOW_VERSION,
        phase: "planned",
        preparedByCallId: current.preparedByCallId,
        workspace: current.workspace,
        sourceReceipt: current.sourceReceipt,
        artifacts: current.artifacts,
        appSpec: current.appSpec,
        dependencyReceipt: current.dependencyReceipt,
        identityReceipt: recordedIdentity,
        proposal,
      };
    });
    return { ...proposal, reused: false };
  },
});
