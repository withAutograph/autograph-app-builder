/* oxlint-disable github/filenames-match-regex, unicorn/filename-case -- Eve derives the public tool identifier from this existing filename. */
import { always } from "eve/tools/approval";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { appBuilderWorkflowState, updateExactWorkflow } from "@/lib/agent/workflow-state";
import {
  assertExactBranchWorktreeProposal,
  exactBranchWorktreeProposalMatch,
} from "@/lib/repository/branch-worktree-publication";
import { publishReviewedChangeSetToBranchWorktree } from "@/lib/repository/node-branch-worktree-publication";
import { branchWorktreePublicationProposalSchema } from "@/lib/agent/branch-worktree-publication-schema";
import { exactBranchWorktreePublicationProposal } from "./branch_worktree_publication_status";
import { hasTestCapability } from "@/lib/testing/test-capability";

const SIMULATED_PUBLICATION_CAPABILITY = "simulated-publication";

export default defineTool({
  approval: always(),
  description:
    "After a separate approval, create one deterministic branch and builder-owned worktree at the exact reviewed base and apply only the approved postimages there. It never mutates the original checkout, commits, pushes, publishes remotely, or invokes a provider or release operation.",
  async execute({ publication: expected }, ctx) {
    if (process.env.APP_BUILDER_BRANCH_WORKTREE_PUBLICATION !== "1") {
      throw new Error("Branch-worktree publication is disabled on this host.");
    }
    const workflow = appBuilderWorkflowState.get();
    if (workflow.phase !== "reviewed") {
      throw new Error(
        "Initial branch-worktree publication requires the exact reviewed phase; use status and explicit recovery for an existing attempt.",
      );
    }
    assertExactBranchWorktreeProposal(expected);
    const proposal = await exactBranchWorktreePublicationProposal({
      expectedReviewDigest: expected.reviewDigest,
    });
    if (!exactBranchWorktreeProposalMatch(proposal, expected)) {
      throw new Error("Publication preconditions changed after approval.");
    }
    let pendingWorkflow: ReturnType<typeof appBuilderWorkflowState.get> | undefined;
    const relativeRoot = workflow.applyReceipt.applyRoot.replace(/^\/workspace\//u, "");
    const hooks: NonNullable<
      Parameters<typeof publishReviewedChangeSetToBranchWorktree>[0]["hooks"]
    > = {
      afterPendingJournal: () => {
        updateExactWorkflow({
          expected: workflow,
          operation: "branch publication pending recording",
          transition: (current) => {
            if (current.phase !== "reviewed") {
              throw new Error("The reviewed workflow changed before publication.");
            }
            return {
              ...current,
              branchPublicationCallId: ctx.callId,
              branchPublicationProposal: proposal,
              phase: "branch_publication_pending",
            };
          },
        });
        pendingWorkflow = appBuilderWorkflowState.get();
      },
      beforePendingJournal:
        hasTestCapability(SIMULATED_PUBLICATION_CAPABILITY) &&
        workflow.appSpec.appId === "branch-publication-pre-journal-interruption"
          ? () => {
              throw new Error("Fixture interruption before durable branch publication intent.");
            }
          : undefined,
    };
    if (
      hasTestCapability(SIMULATED_PUBLICATION_CAPABILITY) &&
      workflow.appSpec.appId === "branch-publication-lost-response"
    ) {
      hooks.beforeTerminalJournal = () => {
        throw new Error("Fixture interruption after branch-worktree side effects.");
      };
      hooks.preserveNonterminalJournal = true;
    }
    if (
      hasTestCapability(SIMULATED_PUBLICATION_CAPABILITY) &&
      workflow.appSpec.appId === "branch-publication-partial-failure"
    ) {
      hooks.afterPathMutation = (_path: string, index: number) => {
        if (index === 0) {
          throw new Error("Fixture partial branch-worktree apply failure.");
        }
      };
    }
    const result = await publishReviewedChangeSetToBranchWorktree({
      hooks,
      proposal,
      publishedByCallId: ctx.callId,
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
      readOverlayFile: (path) =>
        ctx
          .getSandbox()
          // oxlint-disable-next-line github/no-then -- Preserve the existing promise sequencing and settlement behavior.
          .then((sandbox) => sandbox.readBinaryFile({ path: `${relativeRoot}/${path}` })),
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
      readOverlayFileStream: (path) =>
        // oxlint-disable-next-line github/no-then -- Preserve the existing promise sequencing and settlement behavior.
        ctx.getSandbox().then((sandbox) => sandbox.readFile({ path: `${relativeRoot}/${path}` })),
      review: workflow.reviewReceipt,
      sourceReceipt: workflow.sourceReceipt,
    });
    if (pendingWorkflow === undefined) {
      throw new Error("The durable branch publication intent was not bound to workflow state.");
    }
    const exactPendingWorkflow = pendingWorkflow;
    updateExactWorkflow({
      expected: exactPendingWorkflow,
      operation: "branch publication terminal recording",
      transition: (current) => {
        if (
          current.phase !== "branch_publication_pending" ||
          current.branchPublicationCallId !== ctx.callId ||
          !exactBranchWorktreeProposalMatch(current.branchPublicationProposal, proposal)
        ) {
          throw new Error("The pending publication workflow changed before terminal recording.");
        }
        return result.status === "succeeded"
          ? {
              ...current,
              branchPublicationReceipt: result,
              phase: "published_branch_worktree",
            }
          : {
              ...current,
              branchPublicationReceipt: result,
              phase: "branch_publication_failed",
            };
      },
    });
    return result;
  },
  inputSchema: z.strictObject({
    publication: branchWorktreePublicationProposalSchema,
  }),
});
