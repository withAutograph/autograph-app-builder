import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  freshBootstrapDigest,
  freshBootstrapIdentitySchema,
} from "@/lib/agent/fresh-bootstrap-schema";
import { currentFreshBootstrapCapability } from "@/lib/agent/fresh-bootstrap-capability";
import {
  appBuilderWorkflowState,
  updateExactWorkflow,
  assertFreshBootstrapJournalStatus,
} from "@/lib/agent/workflow-state";
import {
  exactFreshBootstrapProposalMatch,
  proposalFromFreshBootstrapJournal,
} from "@/lib/repository/fresh-bootstrap";
import {
  deriveFreshBootstrapProposal,
  readFreshBootstrapJournal,
  verifyFreshBootstrap,
} from "@/lib/repository/node-fresh-bootstrap";
import { freshBootstrapSourceWorkspace } from "@/lib/agent/fresh-bootstrap-source";

function freshWorkflow() {
  const workflow = appBuilderWorkflowState.get();
  if (
    workflow.phase !== "reviewed" &&
    workflow.phase !== "fresh_bootstrap_pending" &&
    workflow.phase !== "fresh_bootstrap_failed" &&
    workflow.phase !== "published_fresh_bootstrap"
  )
    throw new Error("An exact reviewed fresh-template change set is required.");
  if (workflow.sourceReceipt.sourceKind !== "fresh-template")
    throw new Error(
      "Fresh bootstrap is unavailable for existing-repository sources.",
    );
  return workflow;
}

const inputSchema = z.strictObject({
  expectedReviewDigest: freshBootstrapDigest,
  destinationPath: z.string().startsWith("/"),
  expectedPrestate: z.enum(["absent", "empty-directory"]),
  repositoryIdentity: freshBootstrapIdentitySchema,
});

export default defineTool({
  description:
    "Read or derive the exact approval-bound proposal for atomically publishing the reviewed fresh-template result as a new local repository. It fails closed unless the mise-owned host capability is enabled; it may reconcile durable workflow state but never mutates a target, provider, release, or remote.",
  inputSchema,
  async execute(input, ctx) {
    const capability = await currentFreshBootstrapCapability();
    const workflow = freshWorkflow();
    if (workflow.reviewReceipt.digest !== input.expectedReviewDigest)
      throw new Error(
        "The reviewed change set changed before fresh-bootstrap status.",
      );
    const relativeRoot = workflow.applyReceipt.applyRoot.replace(
      /^\/workspace\//u,
      "",
    );
    const sandbox = await ctx.getSandbox();
    const readOverlayFile = async (path: string) =>
      await sandbox.readBinaryFile({ path: `${relativeRoot}/${path}` });
    const sourceWorkspace = await freshBootstrapSourceWorkspace({
      sandbox,
      receipt: workflow.sourceReceipt,
      workspace: workflow.workspace,
    });
    const proposal =
      workflow.phase === "reviewed"
        ? await deriveFreshBootstrapProposal({
            capability,
            destinationPath: input.destinationPath,
            expectedPrestate: input.expectedPrestate,
            repositoryIdentity: input.repositoryIdentity,
            sourceReceipt: workflow.sourceReceipt,
            review: workflow.reviewReceipt,
            protectedPaths: [process.cwd()],
            readOverlayFile,
            sourceWorkspace,
          })
        : workflow.phase === "fresh_bootstrap_pending"
          ? workflow.freshBootstrapProposal
          : proposalFromFreshBootstrapJournal(workflow.freshBootstrapReceipt);
    if (
      proposal.destinationPath !== input.destinationPath ||
      JSON.stringify(proposal.repositoryIdentity) !==
        JSON.stringify(input.repositoryIdentity) ||
      proposal.destinationPrestate.kind !== input.expectedPrestate
    )
      throw new Error(
        "Fresh-bootstrap status inputs differ from the exact proposal.",
      );
    const journal = await readFreshBootstrapJournal({ capability, proposal });
    assertFreshBootstrapJournalStatus(workflow.phase, journal?.status);
    if (journal === undefined)
      return {
        ...proposal,
        workflowPhase: workflow.phase,
        retryAllowed: workflow.phase === "reviewed",
      };
    if (
      !exactFreshBootstrapProposalMatch(
        proposalFromFreshBootstrapJournal(journal),
        proposal,
      )
    )
      throw new Error(
        "The fresh-bootstrap journal belongs to another proposal.",
      );
    if (journal.status === "succeeded") {
      await verifyFreshBootstrap({
        capability,
        receipt: journal,
        sourceReceipt: workflow.sourceReceipt,
        review: workflow.reviewReceipt,
        readOverlayFile,
        sourceWorkspace,
      });
      if (workflow.phase !== "published_fresh_bootstrap")
        updateExactWorkflow({
          expected: workflow,
          operation: "fresh-bootstrap success reconciliation",
          transition: (current) => {
            if (
              current.phase !== "reviewed" &&
              current.phase !== "fresh_bootstrap_pending" &&
              current.phase !== "fresh_bootstrap_failed"
            )
              throw new Error(
                "The workflow cannot reconcile fresh-bootstrap success.",
              );
            return {
              ...current,
              phase: "published_fresh_bootstrap",
              freshBootstrapReceipt: journal,
            };
          },
        });
      return {
        ...journal,
        workflowPhase: "published_fresh_bootstrap",
        reused: true,
      };
    }
    if (
      journal.status === "failed" &&
      workflow.phase !== "fresh_bootstrap_failed"
    )
      updateExactWorkflow({
        expected: workflow,
        operation: "fresh-bootstrap failure reconciliation",
        transition: (current) => {
          if (
            current.phase !== "reviewed" &&
            current.phase !== "fresh_bootstrap_pending"
          )
            throw new Error(
              "The workflow cannot reconcile fresh-bootstrap failure.",
            );
          return {
            ...current,
            phase: "fresh_bootstrap_failed",
            freshBootstrapReceipt: journal,
          };
        },
      });
    if (journal.status === "pending" && workflow.phase === "reviewed")
      updateExactWorkflow({
        expected: workflow,
        operation: "fresh-bootstrap pending reconciliation",
        transition: (current) => {
          if (current.phase !== "reviewed")
            throw new Error(
              "The workflow cannot reconcile fresh-bootstrap pending state.",
            );
          return {
            ...current,
            phase: "fresh_bootstrap_pending",
            freshBootstrapProposal: proposal,
            freshBootstrapCallId: journal.publishedByCallId,
          };
        },
      });
    return {
      ...journal,
      workflowPhase:
        journal.status === "failed"
          ? "fresh_bootstrap_failed"
          : "fresh_bootstrap_pending",
      retryAllowed: false,
      recoveryAllowed: true,
    };
  },
});
