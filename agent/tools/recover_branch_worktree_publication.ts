import { always } from "eve/tools/approval";
import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  appBuilderWorkflowState,
  assertExactWorkflowState,
} from "@/lib/agent/workflow-state";
import {
  exactBranchWorktreeProposalMatch,
  proposalFromBranchJournal,
} from "@/lib/repository/branch-worktree-publication";
import { recoverBranchWorktreePublication } from "@/lib/repository/node-branch-worktree-publication";
import {
  branchPublicationDigest,
  branchWorktreePublicationProposalSchema,
} from "@/lib/agent/branch-worktree-publication-schema";

export default defineTool({
  description:
    "After a distinct recovery approval, inspect and safely complete the exact durable branch-worktree intent. Recovery is bound to the failed or pending journal digest and refuses conflicting branch, worktree, source, index, remote, status, path, mode, or content state.",
  inputSchema: z.strictObject({
    publication: branchWorktreePublicationProposalSchema,
    expectedJournalDigest: branchPublicationDigest,
  }),
  approval: always(),
  async execute({ publication, expectedJournalDigest }, ctx) {
    if (process.env.APP_BUILDER_BRANCH_WORKTREE_PUBLICATION !== "1")
      throw new Error(
        "Branch-worktree publication recovery is disabled on this host.",
      );
    const workflow = appBuilderWorkflowState.get();
    if (
      workflow.phase !== "branch_publication_pending" &&
      workflow.phase !== "branch_publication_failed"
    )
      throw new Error(
        "Branch-worktree recovery requires a pending or failed durable intent.",
      );
    const expectedProposal =
      workflow.phase === "branch_publication_pending"
        ? workflow.branchPublicationProposal
        : proposalFromBranchJournal(workflow.branchPublicationReceipt);
    if (!exactBranchWorktreeProposalMatch(publication, expectedProposal))
      throw new Error(
        "The recovery proposal changed after its durable intent.",
      );
    const relativeRoot = workflow.applyReceipt.applyRoot.replace(
      /^\/workspace\//u,
      "",
    );
    const result = await recoverBranchWorktreePublication({
      proposal: expectedProposal,
      sourceReceipt: workflow.sourceReceipt,
      review: workflow.reviewReceipt,
      recoveredByCallId: ctx.callId,
      expectedJournalDigest,
      readOverlayFile: (path) =>
        ctx
          .getSandbox()
          .then((sandbox) =>
            sandbox.readBinaryFile({ path: `${relativeRoot}/${path}` }),
          ),
    });
    appBuilderWorkflowState.update((current) => {
      assertExactWorkflowState(
        current,
        workflow,
        "branch publication recovery recording",
      );
      if (
        current.phase !== "branch_publication_pending" &&
        current.phase !== "branch_publication_failed"
      )
        throw new Error(
          "The branch publication workflow changed before recovery recording.",
        );
      return result.status === "succeeded"
        ? {
            ...current,
            phase: "published_branch_worktree",
            branchPublicationReceipt: result,
          }
        : {
            ...current,
            phase: "branch_publication_failed",
            branchPublicationReceipt: result,
          };
    });
    return result;
  },
});
