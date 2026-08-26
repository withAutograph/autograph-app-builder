import { defineTool } from "eve/tools";
import { z } from "zod";

import { exactPrototypeArtifact } from "@/lib/agent/prototype-artifacts";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import {
  inspectApplyOverlay,
  inspectFixtureApplyOverlay,
} from "@/lib/repository/target-apply";
import { targetContractDigest } from "@/lib/repository/target-planning";
import {
  createReviewedChangeSetReceipt,
  deriveNormalizedChangeSet,
} from "@/lib/repository/reviewed-change-set";
import { hasTestCapability } from "@/lib/testing/test-capability";

export async function exactNormalizedChangeSet(input: {
  state: Extract<
    ReturnType<typeof appBuilderWorkflowState.get>,
    { phase: "validated" | "reviewed" }
  >;
  sessionId: string;
  sandbox: Parameters<typeof inspectApplyOverlay>[0];
}): Promise<ReturnType<typeof deriveNormalizedChangeSet>> {
  const { state } = input;
  if (
    state.proposal.digest !== state.applyReceipt.proposalDigest ||
    state.proposal.contractDigest !==
      targetContractDigest(state.proposal.target.contract) ||
    state.workspace.sourceSha !== state.applyReceipt.sourceSha ||
    state.workspace.eligibilityDigest !==
      state.applyReceipt.eligibilityDigest ||
    state.workspace.workspaceDigest !== state.applyReceipt.workspaceDigest ||
    state.appSpec.digest !== state.applyReceipt.appSpecDigest ||
    state.appSpec.artifactPath !== state.applyReceipt.appSpecPath ||
    state.appSpec.artifactRevision !== state.applyReceipt.artifactRevision ||
    state.dependencyReceipt.digest !==
      state.applyReceipt.dependencyReceiptDigest ||
    state.identityReceipt.digest !== state.applyReceipt.identityDigest ||
    state.dependencyReceipt.imageDigest !== state.applyReceipt.imageDigest ||
    state.dependencyReceipt.dependencyCacheDigest !==
      state.applyReceipt.dependencyCacheDigest
  )
    throw new Error(
      "The validated workflow bindings no longer match the exact apply receipt.",
    );
  exactPrototypeArtifact(input.state.artifacts, {
    path: input.state.appSpec.artifactPath,
    digest: input.state.appSpec.digest,
    revision: input.state.appSpec.artifactRevision,
    sessionId: input.sessionId,
  });
  const fixture = hasTestCapability("simulated-target");
  const observed = fixture
    ? await inspectFixtureApplyOverlay(
        input.sandbox,
        input.state.applyReceipt.applyRoot,
        input.state.appSpec.appId,
      )
    : await inspectApplyOverlay(
        input.sandbox,
        input.state.applyReceipt.applyRoot,
      );
  if (observed.treeDigest !== input.state.applyReceipt.postTreeDigest)
    throw new Error(
      "The canonical applied overlay changed after its validation receipt.",
    );
  return deriveNormalizedChangeSet(
    input.state.applyReceipt,
    input.state.validationReceipt,
    input.state.proposal.contractDigest,
    input.state.sourceReceipt.contractDigest,
  );
}

export default defineTool({
  description:
    "Read the exact normalized change-set proposal from the canonical applied overlay after successful validation. This tool never executes a target command, uses validation overlays, mutates a workspace, or publishes.",
  inputSchema: z.object({
    expectedValidationDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  async execute({ expectedValidationDigest }, ctx) {
    const state = appBuilderWorkflowState.get();
    if (state.phase !== "validated" && state.phase !== "reviewed")
      throw new Error(
        "A passed exact target-validation receipt is required before change-set review.",
      );
    if (state.validationReceipt.digest !== expectedValidationDigest)
      throw new Error(
        "The target-validation receipt changed before change-set review.",
      );
    const changeSet = await exactNormalizedChangeSet({
      state,
      sessionId: ctx.session.id,
      sandbox: await ctx.getSandbox(),
    });
    if (
      state.phase === "reviewed" &&
      JSON.stringify(state.reviewReceipt) !==
        JSON.stringify(
          createReviewedChangeSetReceipt(
            changeSet,
            state.reviewReceipt.reviewedByCallId,
          ),
        )
    )
      throw new Error(
        "The reviewed change-set receipt no longer matches the canonical overlay.",
      );
    return { ...changeSet, reviewed: state.phase === "reviewed" };
  },
});
