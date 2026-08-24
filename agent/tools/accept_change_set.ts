import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { exactNormalizedChangeSet } from "./change_set_status";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
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
    "Accept the exact previously displayed normalized change set after successful validation. This separate approval recomputes the canonical applied-overlay proposal and records a durable reviewed receipt; it never executes, validates, publishes, or mutates the prepared source.",
  inputSchema: z.strictObject({ changeSet: changeSetPayload }),
  approval: always(),
  async execute({ changeSet: expectedChangeSet }, ctx) {
    const state = appBuilderWorkflowState.get();
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
      if (
        JSON.stringify(state.reviewReceipt) !== JSON.stringify(expectedReceipt)
      )
        throw new Error(
          "The reviewed change-set receipt no longer matches the canonical overlay.",
        );
      return { ...state.reviewReceipt, reused: true };
    }
    const receipt = createReviewedChangeSetReceipt(changeSet, ctx.callId);
    appBuilderWorkflowState.update((latest) => {
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
