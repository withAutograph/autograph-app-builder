import { defineTool } from "eve/tools";
import { z } from "zod";

import { exactNormalizedChangeSet } from "./change_set_status";
import { assertAtomicReviewedChangeSetReuse } from "@/lib/agent/reviewed-change-set-reuse";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  assertExactWorkflowState,
  assertUpstreamMutationAllowed,
} from "@/lib/agent/workflow-state";
import { createReviewedChangeSetReceipt } from "@/lib/repository/reviewed-change-set";

const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const file = z.strictObject({
  mode: z.string().regex(/^[0-7]{3,4}$/u),
  digest,
});
const change = z.strictObject({
  path: z.string().min(1),
  kind: z.enum(["added", "modified", "deleted"]),
  before: file.optional(),
  after: file.optional(),
});
const changeSetPayload = z.strictObject({
  digest,
  approvedPaths: z.array(z.string().min(1)),
  changes: z.array(change),
});

export default defineTool({
  description:
    "Automatically record the exact normalized change set after successful validation. This internal operation recomputes the canonical applied-overlay proposal and records a durable reviewed receipt; it never executes, validates, publishes, or mutates the prepared source.",
  inputSchema: z.strictObject({
    changeSet: changeSetPayload,
  }),
  async execute({ changeSet: expectedChangeSet }, ctx) {
    const state = appBuilderWorkflowState.get();
    assertUpstreamMutationAllowed(state, "reviewed change-set acceptance");
    if (state.phase !== "validated" && state.phase !== "reviewed")
      throw new Error(
        "Read a passed exact target-validation change set before accepting it.",
      );
    const changeSet = await exactNormalizedChangeSet({
      state,
      sessionId: ctx.session.id,
      sandbox: await ctx.getSandbox(),
    });
    const expectedPayload = {
      digest: changeSet.digest,
      approvedPaths: changeSet.approvedPaths,
      changes: changeSet.changes,
    };
    if (JSON.stringify(expectedPayload) !== JSON.stringify(expectedChangeSet))
      throw new Error(
        "The normalized change set changed before review acceptance.",
      );
    if (state.phase === "reviewed") {
      const expectedReceipt = createReviewedChangeSetReceipt(
        changeSet,
        state.reviewReceipt.reviewedByCallId,
      );
      appBuilderWorkflowState.update((latest) => {
        assertExactWorkflowState(latest, state, "reviewed change-set reuse");
        assertAtomicReviewedChangeSetReuse({
          latest:
            latest.phase === "reviewed"
              ? {
                  phase: latest.phase,
                  applyDigest: latest.applyReceipt.digest,
                  validationDigest: latest.validationReceipt.digest,
                  reviewReceipt: latest.reviewReceipt,
                }
              : { phase: latest.phase },
          expectedApplyDigest: state.applyReceipt.digest,
          expectedValidationDigest: state.validationReceipt.digest,
          expectedReviewReceipt: expectedReceipt,
        });
        return latest;
      });
      return { ...expectedReceipt, reused: true };
    }
    const receipt = createReviewedChangeSetReceipt(changeSet, ctx.callId);
    appBuilderWorkflowState.update((latest) => {
      assertExactWorkflowState(latest, state, "reviewed change-set acceptance");
      if (
        latest.phase !== "validated" ||
        latest.validationReceipt.digest !== state.validationReceipt.digest ||
        latest.applyReceipt.digest !== state.applyReceipt.digest
      )
        throw new Error(
          "The workflow changed concurrently before change-set acceptance.",
        );
      return {
        version: APP_BUILDER_WORKFLOW_VERSION,
        phase: "reviewed",
        preparedByCallId: latest.preparedByCallId,
        workspace: latest.workspace,
        sourceReceipt: latest.sourceReceipt,
        ...(latest.githubSource === undefined
          ? {}
          : { githubSource: latest.githubSource }),
        artifacts: latest.artifacts,
        appSpec: latest.appSpec,
        dependencyReceipt: latest.dependencyReceipt,
        identityReceipt: latest.identityReceipt,
        proposal: latest.proposal,
        applyReceipt: latest.applyReceipt,
        validationReceipt: latest.validationReceipt,
        reviewReceipt: receipt,
      };
    });
    return { ...receipt, reused: false };
  },
});
