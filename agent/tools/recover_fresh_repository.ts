import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { freshBootstrapDigest } from "@/lib/agent/fresh-bootstrap-schema";
import { currentFreshBootstrapCapability } from "@/lib/agent/fresh-bootstrap-capability";
import { appBuilderWorkflowState, updateExactWorkflow } from "@/lib/agent/workflow-state";
import {
  exactFreshBootstrapProposalMatch,
  proposalFromFreshBootstrapJournal,
} from "@/lib/repository/fresh-bootstrap";
import { recoverFreshBootstrap } from "@/lib/repository/node-fresh-bootstrap";
import { freshBootstrapSourceWorkspace } from "@/lib/agent/fresh-bootstrap-source";

export default defineTool({
  approval: always(),
  description:
    "After a separate recovery approval, reconcile only the exact durable fresh-bootstrap journal and its exact stage/destination layout. It never resets or adopts an unrelated lease, stage, destination, or repository.",
  async execute(input, ctx) {
    const capability = await currentFreshBootstrapCapability();
    const workflow = appBuilderWorkflowState.get();
    if (
      (workflow.phase !== "fresh_bootstrap_pending" &&
        workflow.phase !== "fresh_bootstrap_failed") ||
      workflow.sourceReceipt.sourceKind !== "fresh-template"
    )
      throw new Error("Fresh-bootstrap recovery requires an exact pending or failed workflow.");
    const proposal =
      workflow.phase === "fresh_bootstrap_pending"
        ? workflow.freshBootstrapProposal
        : proposalFromFreshBootstrapJournal(workflow.freshBootstrapReceipt);
    if (proposal.digest !== input.expectedProposalDigest)
      throw new Error("The fresh-bootstrap proposal changed before recovery approval.");
    if (
      workflow.phase === "fresh_bootstrap_failed" &&
      workflow.freshBootstrapReceipt.digest !== input.expectedJournalDigest
    )
      throw new Error("The failed fresh-bootstrap journal changed before recovery approval.");
    const relativeRoot = workflow.applyReceipt.applyRoot.replace(/^\/workspace\//u, "");
    const sandbox = await ctx.getSandbox();
    const sourceWorkspace = await freshBootstrapSourceWorkspace({
      receipt: workflow.sourceReceipt,
      sandbox,
      workspace: workflow.workspace,
    });
    const result = await recoverFreshBootstrap({
      capability,
      expectedJournalDigest: input.expectedJournalDigest,
      proposal,
      publishedByCallId: ctx.callId,
      readOverlayFile: async (path) =>
        await sandbox.readBinaryFile({ path: `${relativeRoot}/${path}` }),
      review: workflow.reviewReceipt,
      sourceReceipt: workflow.sourceReceipt,
      sourceWorkspace,
    });
    updateExactWorkflow({
      expected: workflow,
      operation: "fresh-bootstrap recovery recording",
      transition: (current) => {
        if (
          current.phase !== "fresh_bootstrap_pending" &&
          current.phase !== "fresh_bootstrap_failed"
        )
          throw new Error("The fresh-bootstrap workflow phase changed during recovery.");
        const currentProposal =
          current.phase === "fresh_bootstrap_pending"
            ? current.freshBootstrapProposal
            : proposalFromFreshBootstrapJournal(current.freshBootstrapReceipt);
        if (!exactFreshBootstrapProposalMatch(currentProposal, proposal))
          throw new Error("The fresh-bootstrap workflow changed during recovery.");
        return result.ok
          ? {
              ...current,
              freshBootstrapReceipt: result.receipt,
              phase: "published_fresh_bootstrap",
            }
          : {
              ...current,
              freshBootstrapReceipt: result.receipt,
              phase: "fresh_bootstrap_failed",
            };
      },
    });
    return result.receipt;
  },
  inputSchema: z.strictObject({
    expectedJournalDigest: freshBootstrapDigest,
    expectedProposalDigest: freshBootstrapDigest,
  }),
});
