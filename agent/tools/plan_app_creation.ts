import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { exactPrototypeArtifact } from "@/lib/agent/prototype-artifacts";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  sha256,
  type TargetIdentityReceipt,
} from "@/lib/agent/workflow-state";
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
    if (current.phase === "empty" || current.phase === "prepared")
      throw new Error(
        "Accept a build-ready AppSpec before running target planning.",
      );
    if (current.appSpec.digest !== expectedAppSpecDigest)
      throw new Error("The accepted AppSpec changed before target planning.");
    exactPrototypeArtifact(current.artifacts, {
      path: current.appSpec.artifactPath,
      digest: current.appSpec.digest,
      revision: current.appSpec.artifactRevision,
      sessionId: ctx.session.id,
    });
    if (current.phase === "planned")
      return { ...current.proposal, reused: true };

    const execution = targetExecutionBinding();
    const binding = {
      sourceSha: current.workspace.sourceSha,
      eligibilityDigest: current.workspace.eligibilityDigest,
      workspaceDigest: current.workspace.workspaceDigest,
      imageDigest: execution.imageDigest,
      dependencyCacheDigest: execution.dependencyCacheDigest,
      appSpecDigest: current.appSpec.digest,
      artifactRevision: current.appSpec.artifactRevision,
    };
    const sandbox = await ctx.getSandbox();
    let identityReceipt: TargetIdentityReceipt | undefined =
      current.phase === "identity_resolved"
        ? current.identityReceipt
        : undefined;
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
        appBuilderWorkflowState.update(() => ({
          version: APP_BUILDER_WORKFLOW_VERSION,
          phase: "identity_resolved",
          preparedByCallId: current.preparedByCallId,
          workspace: current.workspace,
          artifacts: current.artifacts,
          appSpec: current.appSpec,
          identityReceipt: identityReceipt!,
        }));
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
    appBuilderWorkflowState.update(() => ({
      version: APP_BUILDER_WORKFLOW_VERSION,
      phase: "planned",
      preparedByCallId: current.preparedByCallId,
      workspace: current.workspace,
      artifacts: current.artifacts,
      appSpec: current.appSpec,
      identityReceipt: recordedIdentity,
      proposal,
    }));
    return { ...proposal, reused: false };
  },
});
