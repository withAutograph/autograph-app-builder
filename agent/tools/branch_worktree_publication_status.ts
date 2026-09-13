import { defineTool } from "eve/tools";
import { z } from "zod";

import { appBuilderWorkflowState, updateExactWorkflow } from "@/lib/agent/workflow-state";
import {
  exactBranchWorktreeProposalMatch,
  proposalFromBranchJournal,
} from "@/lib/repository/branch-worktree-publication";
import {
  deriveBranchWorktreePublicationProposal,
  readBranchWorktreePublicationJournal,
  verifyBranchWorktreePublication,
} from "@/lib/repository/node-branch-worktree-publication";
import { branchPublicationDigest } from "@/lib/agent/branch-worktree-publication-schema";

const branchWorkflow = () => {
  const workflow = appBuilderWorkflowState.get();
  if (
    workflow.phase !== "reviewed" &&
    workflow.phase !== "branch_publication_pending" &&
    workflow.phase !== "branch_publication_failed" &&
    workflow.phase !== "published_branch_worktree"
  )
    throw new Error(
      "An exact separately reviewed change set is required before branch-worktree publication.",
    );
  return workflow;
};

export const exactBranchWorktreePublicationProposal = (input: { expectedReviewDigest: string }) => {
  const workflow = branchWorkflow();
  if (workflow.reviewReceipt.digest !== input.expectedReviewDigest)
    throw new Error("The reviewed change-set receipt changed before publication.");
  return deriveBranchWorktreePublicationProposal({
    review: workflow.reviewReceipt,
    sourceReceipt: workflow.sourceReceipt,
  });
};

export default defineTool({
  description:
    "Read the exact proposal for creating a deterministic builder-owned branch and worktree from the reviewed existing repository. This verifies source SHA, index, remote, status, review, paths, modes, digests, and collision absence without writing.",
  async execute(input) {
    const workflow = branchWorkflow();
    if (workflow.reviewReceipt.digest !== input.expectedReviewDigest)
      throw new Error("The reviewed receipt changed before publication status.");
    const proposal = await (() => {
      if (workflow.phase === "reviewed") return exactBranchWorktreePublicationProposal(input);
      if (workflow.phase === "branch_publication_pending")
        return workflow.branchPublicationProposal;
      return proposalFromBranchJournal(workflow.branchPublicationReceipt);
    })();
    const journal = await readBranchWorktreePublicationJournal(proposal);
    if (journal === undefined) {
      if (workflow.phase === "branch_publication_pending")
        updateExactWorkflow({
          expected: workflow,
          operation: "pre-journal branch publication reconciliation",
          transition: (current) => {
            if (current.phase !== "branch_publication_pending")
              throw new Error(
                "The publication workflow changed before pre-journal reconciliation.",
              );
            const {
              branchPublicationProposal: _proposal,
              branchPublicationCallId: _callId,
              ...reviewed
            } = current;
            void _proposal;
            void _callId;
            return { ...reviewed, phase: "reviewed" };
          },
        });
      if (workflow.phase === "reviewed") return { ...proposal, workflowPhase: workflow.phase };
      if (workflow.phase === "branch_publication_pending")
        return {
          ...proposal,
          retryAllowed: true,
          transactionWindow: "before-journal" as const,
          workflowPhase: "reviewed" as const,
        };
      return {
        ...proposal,
        retryAllowed: false,
        transactionWindow: "journal-missing" as const,
        workflowPhase: workflow.phase,
      };
    }
    if (!exactBranchWorktreeProposalMatch(proposalFromBranchJournal(journal), proposal))
      throw new Error("The durable branch-worktree journal belongs to a different proposal.");
    if (journal.status === "succeeded") {
      await verifyBranchWorktreePublication({
        receipt: journal,
        review: workflow.reviewReceipt,
        sourceReceipt: workflow.sourceReceipt,
      });
      if (
        workflow.phase === "reviewed" ||
        workflow.phase === "branch_publication_pending" ||
        workflow.phase === "branch_publication_failed"
      )
        updateExactWorkflow({
          expected: workflow,
          operation: "branch publication success reconciliation",
          transition: (current) => {
            if (
              current.phase !== "reviewed" &&
              current.phase !== "branch_publication_pending" &&
              current.phase !== "branch_publication_failed"
            )
              throw new Error("The publication workflow changed before reconciliation.");
            return {
              ...current,
              branchPublicationReceipt: journal,
              phase: "published_branch_worktree",
            };
          },
        });
      return {
        ...journal,
        reused: true,
        workflowPhase: "published_branch_worktree",
      };
    }
    if (journal.status === "pending" && workflow.phase === "reviewed")
      updateExactWorkflow({
        expected: workflow,
        operation: "branch publication pending reconciliation",
        transition: (current) => {
          if (current.phase !== "reviewed")
            throw new Error("The publication workflow changed before pending reconciliation.");
          return {
            ...current,
            branchPublicationCallId: journal.publishedByCallId,
            branchPublicationProposal: proposal,
            phase: "branch_publication_pending",
          };
        },
      });
    if (
      journal.status === "failed" &&
      (workflow.phase === "reviewed" || workflow.phase === "branch_publication_pending")
    )
      updateExactWorkflow({
        expected: workflow,
        operation: "branch publication failure reconciliation",
        transition: (current) => {
          if (current.phase !== "reviewed" && current.phase !== "branch_publication_pending")
            throw new Error("The publication workflow changed before reconciliation.");
          return {
            ...current,
            branchPublicationReceipt: journal,
            phase: "branch_publication_failed",
          };
        },
      });
    return {
      ...journal,
      recoveryAllowed: true,
      retryAllowed: false,
      workflowPhase: journal.status === "failed" ? "branch_publication_failed" : workflow.phase,
    };
  },
  inputSchema: z.strictObject({
    expectedReviewDigest: branchPublicationDigest,
  }),
});
