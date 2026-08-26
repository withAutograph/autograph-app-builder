import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { freshBootstrapProposalSchema } from "@/lib/agent/fresh-bootstrap-schema";
import {
  currentFreshBootstrapCapability,
  configuredFreshBootstrapEvalHooks,
  currentFreshBootstrapTestHooks,
} from "@/lib/agent/fresh-bootstrap-capability";
import {
  appBuilderWorkflowState,
  assertExactWorkflowState,
} from "@/lib/agent/workflow-state";
import {
  assertExactFreshBootstrapProposal,
  exactFreshBootstrapProposalMatch,
} from "@/lib/repository/fresh-bootstrap";
import {
  deriveFreshBootstrapProposal,
  publishFreshBootstrap,
} from "@/lib/repository/node-fresh-bootstrap";

export default defineTool({
  description:
    "After a separate approval, atomically publish the exact reviewed fresh-template result to the approved absent or exact-empty local destination as one parentless SHA-1 Git commit. GitHub publication, remotes, release activation, and arbitrary target mutation remain unavailable.",
  inputSchema: z.strictObject({ publication: freshBootstrapProposalSchema }),
  approval: always(),
  async execute({ publication: expected }, ctx) {
    const capability = await currentFreshBootstrapCapability();
    const workflow = appBuilderWorkflowState.get();
    if (
      workflow.phase !== "reviewed" ||
      workflow.sourceReceipt.sourceKind !== "fresh-template"
    )
      throw new Error(
        "Initial fresh bootstrap requires the exact reviewed fresh-template phase.",
      );
    assertExactFreshBootstrapProposal(expected);
    const relativeRoot = workflow.applyReceipt.applyRoot.replace(
      /^\/workspace\//u,
      "",
    );
    const readOverlayFile = (path: string) =>
      ctx
        .getSandbox()
        .then((sandbox) =>
          sandbox.readBinaryFile({ path: `${relativeRoot}/${path}` }),
        );
    const proposal = await deriveFreshBootstrapProposal({
      capability,
      destinationPath: expected.destinationPath,
      expectedPrestate: expected.destinationPrestate.kind,
      repositoryIdentity: expected.repositoryIdentity,
      sourceReceipt: workflow.sourceReceipt,
      review: workflow.reviewReceipt,
      protectedPaths: [process.cwd()],
      readOverlayFile,
    });
    if (!exactFreshBootstrapProposalMatch(proposal, expected))
      throw new Error("Fresh-bootstrap preconditions changed after approval.");
    let pendingWorkflow:
      ReturnType<typeof appBuilderWorkflowState.get> | undefined;
    const result = await publishFreshBootstrap({
      capability,
      proposal,
      sourceReceipt: workflow.sourceReceipt,
      review: workflow.reviewReceipt,
      publishedByCallId: ctx.callId,
      readOverlayFile,
      hooks: {
        ...configuredFreshBootstrapEvalHooks(),
        ...currentFreshBootstrapTestHooks(),
        afterPendingJournal: () => {
          appBuilderWorkflowState.update((current) => {
            assertExactWorkflowState(
              current,
              workflow,
              "fresh-bootstrap pending recording",
            );
            if (current.phase !== "reviewed")
              throw new Error(
                "The reviewed workflow changed before fresh bootstrap.",
              );
            return {
              ...current,
              phase: "fresh_bootstrap_pending",
              freshBootstrapProposal: proposal,
              freshBootstrapCallId: ctx.callId,
            };
          });
          pendingWorkflow = appBuilderWorkflowState.get();
        },
      },
    });
    if (pendingWorkflow === undefined)
      throw new Error(
        "Durable fresh-bootstrap intent was not bound to workflow state.",
      );
    const exactPending = pendingWorkflow;
    appBuilderWorkflowState.update((current) => {
      assertExactWorkflowState(
        current,
        exactPending,
        "fresh-bootstrap terminal recording",
      );
      if (
        current.phase !== "fresh_bootstrap_pending" ||
        current.freshBootstrapCallId !== ctx.callId ||
        !exactFreshBootstrapProposalMatch(
          current.freshBootstrapProposal,
          proposal,
        )
      )
        throw new Error(
          "The pending fresh-bootstrap workflow changed before terminal recording.",
        );
      return result.ok
        ? {
            ...current,
            phase: "published_fresh_bootstrap",
            freshBootstrapReceipt: result.receipt,
          }
        : {
            ...current,
            phase: "fresh_bootstrap_failed",
            freshBootstrapReceipt: result.receipt,
          };
    });
    return result.receipt;
  },
});
