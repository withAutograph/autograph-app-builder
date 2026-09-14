import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { freshBootstrapProposalSchema } from "@/lib/agent/fresh-bootstrap-schema";
import {
  currentFreshBootstrapCapability,
  configuredFreshBootstrapEvalHooks,
  currentFreshBootstrapTestHooks,
} from "@/lib/agent/fresh-bootstrap-capability";
import { appBuilderWorkflowState, updateExactWorkflow } from "@/lib/agent/workflow-state";
import {
  assertExactFreshBootstrapProposal,
  exactFreshBootstrapProposalMatch,
} from "@/lib/repository/fresh-bootstrap";
import {
  deriveFreshBootstrapProposal,
  publishFreshBootstrap,
} from "@/lib/repository/node-fresh-bootstrap";
import { freshBootstrapSourceWorkspace } from "@/lib/agent/fresh-bootstrap-source";

export default defineTool({
  approval: always(),
  description:
    "After a separate approval, atomically publish the exact reviewed fresh-template result to the approved absent or exact-empty local destination as one parentless SHA-1 Git commit. GitHub publication, remotes, release activation, and arbitrary target mutation remain unavailable.",
  async execute({ publication: expected }, ctx) {
    const capability = await currentFreshBootstrapCapability();
    const workflow = appBuilderWorkflowState.get();
    if (workflow.phase !== "reviewed" || workflow.sourceReceipt.sourceKind !== "fresh-template")
      {throw new Error("Initial fresh bootstrap requires the exact reviewed fresh-template phase.");}
    assertExactFreshBootstrapProposal(expected);
    const relativeRoot = workflow.applyReceipt.applyRoot.replace(/^\/workspace\//u, "");
    const sandbox = await ctx.getSandbox();
    const readOverlayFile = async (path: string) =>
      await sandbox.readBinaryFile({ path: `${relativeRoot}/${path}` });
    const sourceWorkspace = await freshBootstrapSourceWorkspace({
      receipt: workflow.sourceReceipt,
      sandbox,
      workspace: workflow.workspace,
    });
    const proposal = await deriveFreshBootstrapProposal({
      capability,
      destinationPath: expected.destinationPath,
      expectedPrestate: expected.destinationPrestate.kind,
      protectedPaths: [process.cwd()],
      readOverlayFile,
      repositoryIdentity: expected.repositoryIdentity,
      review: workflow.reviewReceipt,
      sourceReceipt: workflow.sourceReceipt,
      sourceWorkspace,
    });
    if (!exactFreshBootstrapProposalMatch(proposal, expected))
      {throw new Error("Fresh-bootstrap preconditions changed after approval.");}
    let pendingWorkflow: ReturnType<typeof appBuilderWorkflowState.get> | undefined;
    const result = await publishFreshBootstrap({
      capability,
      hooks: {
        ...configuredFreshBootstrapEvalHooks(),
        ...currentFreshBootstrapTestHooks(),
        afterPendingJournal: () => {
          updateExactWorkflow({
            expected: workflow,
            operation: "fresh-bootstrap pending recording",
            transition: (current) => {
              if (current.phase !== "reviewed")
                {throw new Error("The reviewed workflow changed before fresh bootstrap.");}
              return {
                ...current,
                freshBootstrapCallId: ctx.callId,
                freshBootstrapProposal: proposal,
                phase: "fresh_bootstrap_pending",
              };
            },
          });
          pendingWorkflow = appBuilderWorkflowState.get();
        },
      },
      proposal,
      publishedByCallId: ctx.callId,
      readOverlayFile,
      review: workflow.reviewReceipt,
      sourceReceipt: workflow.sourceReceipt,
      sourceWorkspace,
    });
    if (pendingWorkflow === undefined)
      {throw new Error("Durable fresh-bootstrap intent was not bound to workflow state.");}
    const exactPending = pendingWorkflow;
    updateExactWorkflow({
      expected: exactPending,
      operation: "fresh-bootstrap terminal recording",
      transition: (current) => {
        if (
          current.phase !== "fresh_bootstrap_pending" ||
          current.freshBootstrapCallId !== ctx.callId ||
          !exactFreshBootstrapProposalMatch(current.freshBootstrapProposal, proposal)
        )
          {throw new Error(
            "The pending fresh-bootstrap workflow changed before terminal recording.",
          );}
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
  inputSchema: z.strictObject({ publication: freshBootstrapProposalSchema }),
});
