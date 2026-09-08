import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  appBuilderWorkflowState,
  updateExactWorkflow,
} from "@/lib/agent/workflow-state";
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

function branchWorkflow() {
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
}

export async function exactBranchWorktreePublicationProposal(input: {
  expectedReviewDigest: string;
}) {
  const workflow = branchWorkflow();
  if (workflow.reviewReceipt.digest !== input.expectedReviewDigest)
    throw new Error(
      "The reviewed change-set receipt changed before publication.",
    );
  return deriveBranchWorktreePublicationProposal({
    sourceReceipt: workflow.sourceReceipt,
    review: workflow.reviewReceipt,
  });
}

export default defineTool({
  description:
    "Read the exact proposal for creating a deterministic builder-owned branch and worktree from the reviewed existing repository. This verifies source SHA, index, remote, status, review, paths, modes, digests, and collision absence without writing.",
  inputSchema: z.strictObject({
    expectedReviewDigest: branchPublicationDigest,
  }),
  async execute(input) {
    const workflow = branchWorkflow();
    if (workflow.reviewReceipt.digest !== input.expectedReviewDigest)
      throw new Error(
        "The reviewed receipt changed before publication status.",
      );
    const proposal =
      workflow.phase === "reviewed"
        ? await exactBranchWorktreePublicationProposal(input)
        : workflow.phase === "branch_publication_pending"
          ? workflow.branchPublicationProposal
          : proposalFromBranchJournal(workflow.branchPublicationReceipt);
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
      return workflow.phase === "reviewed"
        ? { ...proposal, workflowPhase: workflow.phase }
        : workflow.phase === "branch_publication_pending"
          ? {
              ...proposal,
              workflowPhase: "reviewed" as const,
              transactionWindow: "before-journal" as const,
              retryAllowed: true,
            }
          : {
              ...proposal,
              workflowPhase: workflow.phase,
              transactionWindow: "journal-missing" as const,
              retryAllowed: false,
            };
    }
    if (
      !exactBranchWorktreeProposalMatch(
        proposalFromBranchJournal(journal),
        proposal,
      )
    )
      throw new Error(
        "The durable branch-worktree journal belongs to a different proposal.",
      );
    if (journal.status === "succeeded") {
      await verifyBranchWorktreePublication({
        receipt: journal,
        sourceReceipt: workflow.sourceReceipt,
        review: workflow.reviewReceipt,
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
              throw new Error(
                "The publication workflow changed before reconciliation.",
              );
            return {
              ...current,
              phase: "published_branch_worktree",
              branchPublicationReceipt: journal,
            };
          },
        });
      return {
        ...journal,
        workflowPhase: "published_branch_worktree",
        reused: true,
      };
    }
    if (journal.status === "pending" && workflow.phase === "reviewed")
      updateExactWorkflow({
        expected: workflow,
        operation: "branch publication pending reconciliation",
        transition: (current) => {
          if (current.phase !== "reviewed")
            throw new Error(
              "The publication workflow changed before pending reconciliation.",
            );
          return {
            ...current,
            phase: "branch_publication_pending",
            branchPublicationProposal: proposal,
            branchPublicationCallId: journal.publishedByCallId,
          };
        },
      });
    if (
      journal.status === "failed" &&
      (workflow.phase === "reviewed" ||
        workflow.phase === "branch_publication_pending")
    )
      updateExactWorkflow({
        expected: workflow,
        operation: "branch publication failure reconciliation",
        transition: (current) => {
          if (
            current.phase !== "reviewed" &&
            current.phase !== "branch_publication_pending"
          )
            throw new Error(
              "The publication workflow changed before reconciliation.",
            );
          return {
            ...current,
            phase: "branch_publication_failed",
            branchPublicationReceipt: journal,
          };
        },
      });
    return {
      ...journal,
      workflowPhase:
        journal.status === "failed"
          ? "branch_publication_failed"
          : workflow.phase,
      retryAllowed: false,
      recoveryAllowed: true,
    };
  },
});
