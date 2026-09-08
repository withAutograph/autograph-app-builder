import { always } from "eve/tools/approval";
import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  appBuilderWorkflowState,
  updateExactWorkflow,
} from "@/lib/agent/workflow-state";
import {
  assertExactBranchWorktreeProposal,
  exactBranchWorktreeProposalMatch,
} from "@/lib/repository/branch-worktree-publication";
import { publishReviewedChangeSetToBranchWorktree } from "@/lib/repository/node-branch-worktree-publication";
import { branchWorktreePublicationProposalSchema } from "@/lib/agent/branch-worktree-publication-schema";
import { exactBranchWorktreePublicationProposal } from "./branch_worktree_publication_status";
import { hasTestCapability } from "@/lib/testing/test-capability";

export default defineTool({
  description:
    "After a separate approval, create one deterministic branch and builder-owned worktree at the exact reviewed base and apply only the approved postimages there. It never mutates the original checkout, commits, pushes, publishes remotely, or invokes a provider or release operation.",
  inputSchema: z.strictObject({
    publication: branchWorktreePublicationProposalSchema,
  }),
  approval: always(),
  async execute({ publication: expected }, ctx) {
    if (process.env.APP_BUILDER_BRANCH_WORKTREE_PUBLICATION !== "1")
      throw new Error("Branch-worktree publication is disabled on this host.");
    const workflow = appBuilderWorkflowState.get();
    if (workflow.phase !== "reviewed")
      throw new Error(
        "Initial branch-worktree publication requires the exact reviewed phase; use status and explicit recovery for an existing attempt.",
      );
    assertExactBranchWorktreeProposal(expected);
    const proposal = await exactBranchWorktreePublicationProposal({
      expectedReviewDigest: expected.reviewDigest,
    });
    if (!exactBranchWorktreeProposalMatch(proposal, expected))
      throw new Error("Publication preconditions changed after approval.");
    let pendingWorkflow:
      ReturnType<typeof appBuilderWorkflowState.get> | undefined;
    const relativeRoot = workflow.applyReceipt.applyRoot.replace(
      /^\/workspace\//u,
      "",
    );
    const result = await publishReviewedChangeSetToBranchWorktree({
      proposal,
      sourceReceipt: workflow.sourceReceipt,
      review: workflow.reviewReceipt,
      publishedByCallId: ctx.callId,
      readOverlayFile: (path) =>
        ctx
          .getSandbox()
          .then((sandbox) =>
            sandbox.readBinaryFile({ path: `${relativeRoot}/${path}` }),
          ),
      hooks: {
        beforePendingJournal:
          hasTestCapability("simulated-publication") &&
          workflow.appSpec.appId ===
            "branch-publication-pre-journal-interruption"
            ? () => {
                throw new Error(
                  "Fixture interruption before durable branch publication intent.",
                );
              }
            : undefined,
        afterPendingJournal: () => {
          updateExactWorkflow({
            expected: workflow,
            operation: "branch publication pending recording",
            transition: (current) => {
              if (current.phase !== "reviewed")
                throw new Error(
                  "The reviewed workflow changed before publication.",
                );
              return {
                ...current,
                phase: "branch_publication_pending",
                branchPublicationProposal: proposal,
                branchPublicationCallId: ctx.callId,
              };
            },
          });
          pendingWorkflow = appBuilderWorkflowState.get();
        },
        ...(hasTestCapability("simulated-publication") &&
        workflow.appSpec.appId === "branch-publication-lost-response"
          ? {
              beforeTerminalJournal: () => {
                throw new Error(
                  "Fixture interruption after branch-worktree side effects.",
                );
              },
              preserveNonterminalJournal: true,
            }
          : {}),
        ...(hasTestCapability("simulated-publication") &&
        workflow.appSpec.appId === "branch-publication-partial-failure"
          ? {
              afterPathMutation: (_path: string, index: number) => {
                if (index === 0)
                  throw new Error(
                    "Fixture partial branch-worktree apply failure.",
                  );
              },
            }
          : {}),
      },
    });
    if (pendingWorkflow === undefined)
      throw new Error(
        "The durable branch publication intent was not bound to workflow state.",
      );
    const exactPendingWorkflow = pendingWorkflow;
    updateExactWorkflow({
      expected: exactPendingWorkflow,
      operation: "branch publication terminal recording",
      transition: (current) => {
        if (
          current.phase !== "branch_publication_pending" ||
          current.branchPublicationCallId !== ctx.callId ||
          !exactBranchWorktreeProposalMatch(
            current.branchPublicationProposal,
            proposal,
          )
        )
          throw new Error(
            "The pending publication workflow changed before terminal recording.",
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
      },
    });
    return result;
  },
});
