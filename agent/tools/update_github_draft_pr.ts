import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import {
  approvalReceiptSchema,
  approvalTargetFromExistingDraftUpdate,
  assertApprovalReceipt,
} from "@/lib/agent/approval-receipt";
import { githubPublicationRuntimeForSession } from "@/lib/agent/deployment-github-publication-runtime";
import { publicationContentSourceForReviewedWorkflow } from "@/lib/agent/github-publication-content-source";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { appBaselineState } from "@/lib/agent/app-baseline-state";
import { assertExistingAppReviewScope } from "@/lib/repository/reviewed-change-set";

export default defineTool({
  approval: always(),
  description:
    "After separate approval, update the existing open draft PR branch with only the current reviewed app-owned diff. Reject a moved PR branch, changed reviewed files, different repository, or a PR that is no longer an open draft.",
  async execute(input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (
      state.phase !== "reviewed" ||
      state.githubSource === undefined ||
      state.existingDraftUpdate === undefined
    ) {
      throw new Error(
        "Seal a proposal for the reviewed app changes and existing draft PR before requesting update approval.",
      );
    }
    const binding = state.existingDraftUpdate;
    if (
      binding.proposal.digest !== input.expectedProposalDigest ||
      binding.githubSourceDigest !== state.githubSource.digest ||
      binding.reviewDigest !== state.reviewReceipt.digest ||
      binding.proposal.repositoryId !== state.githubSource.repository.repositoryId
    ) {
      throw new Error(
        "The selected repository or reviewed draft update changed. Review and seal a new proposal before approval.",
      );
    }
    assertExistingAppReviewScope(
      state.reviewReceipt,
      state.appSpec.appId,
      state.sourceReceipt.sourceKind,
      appBaselineState.get()?.receipt,
    );
    assertApprovalReceipt({
      actual: input.approvalReceipt,
      phase: "draft_update",
      subjectDigest: binding.proposal.digest,
      target: approvalTargetFromExistingDraftUpdate(binding.proposal),
    });
    const sandbox = await ctx.getSandbox();
    const contentSource = publicationContentSourceForReviewedWorkflow({ sandbox, state });
    const runtime = await githubPublicationRuntimeForSession(ctx.session.auth);
    return await runtime.updateExistingDraft({
      contentSource,
      proposal: binding.proposal,
      review: state.reviewReceipt,
    });
  },
  inputSchema: z.strictObject({
    approvalReceipt: approvalReceiptSchema,
    expectedProposalDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
});
