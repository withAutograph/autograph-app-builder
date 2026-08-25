import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  appBuilderWorkflowState,
  assertPublicationJournalStatus,
} from "@/lib/agent/workflow-state";
import {
  readLocalPublicationJournal,
  deriveLocalPublicationProposal,
  verifyPublishedChangeSet,
} from "@/lib/repository/node-local-publication";
import {
  assertCanonicalLocalPublicationJournal,
  exactProposalMatch,
  proposalFromJournal,
} from "@/lib/repository/local-publication";

function publicationWorkflow() {
  const workflow = appBuilderWorkflowState.get();
  if (
    workflow.phase !== "reviewed" &&
    workflow.phase !== "publication_pending" &&
    workflow.phase !== "publication_failed" &&
    workflow.phase !== "published_local"
  )
    throw new Error(
      "An exact separately reviewed change set is required before local publication.",
    );
  return workflow;
}

function assertJournalMatchesWorkflow(
  workflow: ReturnType<typeof publicationWorkflow>,
  destinationPath: string,
  expectedReviewDigest: string,
  journal: NonNullable<Awaited<ReturnType<typeof readLocalPublicationJournal>>>,
) {
  if (
    destinationPath !== workflow.sourceReceipt.sourcePath ||
    destinationPath !== journal.destinationPath ||
    expectedReviewDigest !== workflow.reviewReceipt.digest ||
    journal.sourceReceiptDigest !== workflow.sourceReceipt.digest ||
    journal.reviewDigest !== workflow.reviewReceipt.digest ||
    journal.changeSetDigest !== workflow.reviewReceipt.changeSetDigest ||
    journal.baseSha !== workflow.sourceReceipt.sourceSha ||
    journal.sourceTree !== workflow.sourceReceipt.sourceTree ||
    journal.contractDigest !== workflow.sourceReceipt.contractDigest
  )
    throw new Error(
      "The durable local-publication journal does not belong to the current workflow.",
    );
  if (workflow.phase === "reviewed")
    throw new Error(
      "A reviewed workflow must not have a durable local-publication journal.",
    );
  assertPublicationJournalStatus(workflow.phase, journal.status);
  assertCanonicalLocalPublicationJournal(journal);
  if (workflow.phase === "publication_pending") {
    if (
      !exactProposalMatch(
        proposalFromJournal(journal),
        workflow.publicationProposal,
      ) ||
      journal.publishedByCallId !== workflow.publicationCallId
    )
      throw new Error(
        "The pending workflow does not have its exact publication journal.",
      );
    return;
  }
  const expectedStatus =
    workflow.phase === "publication_failed" ? "failed" : "succeeded";
  if (
    journal.status !== expectedStatus ||
    workflow.publicationReceipt.digest !== journal.digest
  )
    throw new Error(
      "The terminal workflow does not have its exact terminal publication journal.",
    );
}

const digest = z.string().regex(/^[0-9a-f]{64}$/u);

export async function exactLocalPublicationProposal(input: {
  destinationPath: string;
  expectedReviewDigest: string;
}) {
  if (process.env.APP_BUILDER_LOCAL_PUBLICATION !== "1")
    throw new Error(
      "Local publication is disabled until APP_BUILDER_LOCAL_PUBLICATION=1 is explicitly configured.",
    );
  const workflow = publicationWorkflow();
  if (workflow.reviewReceipt.digest !== input.expectedReviewDigest)
    throw new Error(
      "The reviewed change-set receipt changed before local publication.",
    );
  if (workflow.sourceReceipt.sourceKind !== "existing-repository")
    throw new Error(
      "Local publication accepts only the original existing-repository source.",
    );
  const proposal = await deriveLocalPublicationProposal({
    destinationPath: input.destinationPath,
    sourceReceipt: workflow.sourceReceipt,
    review: workflow.reviewReceipt,
  });
  if (
    proposal.destinationPath !== workflow.sourceReceipt.sourcePath ||
    proposal.sourceReceiptDigest !== workflow.sourceReceipt.digest ||
    proposal.baseSha !== workflow.sourceReceipt.sourceSha ||
    workflow.workspace.sourceTree !== workflow.sourceReceipt.sourceTree ||
    workflow.workspace.sourceSha !== workflow.sourceReceipt.sourceSha
  )
    throw new Error(
      "The selected destination is not the exact original source checkout.",
    );
  return proposal;
}

export default defineTool({
  description:
    "Read the exact local-publication proposal for an explicitly selected allowed existing checkout. It verifies destination identity, base SHA, clean approved paths, and preimages without writing, committing, or publishing remotely.",
  inputSchema: z.strictObject({
    destinationPath: z.string().min(1),
    expectedReviewDigest: digest,
  }),
  async execute(input) {
    const workflow = publicationWorkflow();
    const durable = await readLocalPublicationJournal(input.destinationPath);
    assertPublicationJournalStatus(workflow.phase, durable?.status);
    if (durable !== undefined)
      assertJournalMatchesWorkflow(
        workflow,
        input.destinationPath,
        input.expectedReviewDigest,
        durable,
      );
    if (workflow.phase === "publication_pending" && durable === undefined)
      return {
        ...workflow.publicationProposal,
        workflowPhase: workflow.phase,
        transactionWindow: "before-journal" as const,
        retryAllowed: false,
      };
    if (workflow.phase === "publication_failed" && durable === undefined) {
      assertCanonicalLocalPublicationJournal(workflow.publicationReceipt);
      if (workflow.publicationReceipt.reason !== "precondition-failed")
        throw new Error(
          "Only a canonical pre-journal precondition failure may omit its durable journal.",
        );
      return {
        ...workflow.publicationReceipt,
        workflowPhase: workflow.phase,
        durableJournal: "absent" as const,
        retryAllowed: false,
      };
    }
    if (durable?.status === "succeeded") {
      if (
        input.expectedReviewDigest !== durable.reviewDigest ||
        input.destinationPath !== durable.destinationPath
      )
        throw new Error(
          "The durable local-publication success does not match this status request.",
        );
      await verifyPublishedChangeSet({
        receipt: durable,
        sourceReceipt: workflow.sourceReceipt,
        review: workflow.reviewReceipt,
      });
      return {
        ...durable,
        workflowPhase: workflow.phase,
        recoveryAllowed: workflow.phase === "publication_pending",
      };
    }
    if (durable?.status === "pending" || durable?.status === "failed")
      return {
        ...durable,
        workflowPhase: workflow.phase,
        retryAllowed: false,
        recoveryAllowed:
          workflow.phase === "publication_pending" &&
          durable.status === "failed",
      };
    const proposal = await exactLocalPublicationProposal(input);
    return { ...proposal, workflowPhase: workflow.phase };
  },
});
