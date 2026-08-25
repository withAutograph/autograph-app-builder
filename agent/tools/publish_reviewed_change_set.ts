import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import {
  appBuilderWorkflowState,
  assertExactWorkflowState,
} from "@/lib/agent/workflow-state";
import {
  readLocalPublicationJournal,
  publishReviewedChangeSet,
  verifyPublishedChangeSet,
} from "@/lib/repository/node-local-publication";
import type {
  LocalPublicationFailureReceipt,
  LocalPublicationProposal,
  LocalPublicationSuccessReceipt,
} from "@/lib/repository/local-publication";
import {
  assertCanonicalLocalPublicationJournal,
  assertExactDurablePublicationSuccess,
  assertExactProposal,
  exactProposalMatch,
  proposalFromJournal,
} from "@/lib/repository/local-publication";
import { exactLocalPublicationProposal } from "./local_publication_status";

const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const file = z.strictObject({
  mode: z.string().regex(/^[0-7]{3,4}$/u),
  digest,
});
const change = z.strictObject({
  path: z.string().min(1),
  kind: z.enum(["added", "modified", "deleted"]),
  before: file.optional(),
  after: file.optional(),
});
const publication = z.strictObject({
  digest,
  destinationPath: z.string().min(1),
  rootIdentity: z.strictObject({ device: z.string(), inode: z.string() }),
  gitDirectoryPath: z.string().min(1),
  gitDirectoryIdentity: z.strictObject({
    device: z.string(),
    inode: z.string(),
  }),
  sourceReceiptDigest: digest,
  sourceTree: z.string().regex(/^[0-9a-f]{40}$/u),
  contractDigest: digest,
  baseSha: z.string().regex(/^[0-9a-f]{40}$/u),
  headReference: z.string().min(1),
  indexFileDigest: digest,
  remoteDigest: digest,
  reviewDigest: digest,
  changeSetDigest: digest,
  approvedPaths: z.array(z.string().min(1)),
  executionPaths: z.array(z.string().min(1)),
  changes: z.array(change),
  intendedOutcome: z.literal("apply-reviewed-change-set-locally"),
  preconditionStatusDigest: digest,
  unrelatedProjectionDigest: digest,
  version: z.literal(2),
});

export default defineTool({
  description:
    "Apply one exact separately reviewed change set to one approved existing local checkout. This approval-bound operation writes only approved paths, never commits or changes Git history, and never publishes remotely.",
  inputSchema: z.strictObject({ publication }),
  approval: always(),
  async execute({ publication: expected }, ctx) {
    if (process.env.APP_BUILDER_LOCAL_PUBLICATION !== "1")
      throw new Error(
        "Local publication is disabled until APP_BUILDER_LOCAL_PUBLICATION=1 is explicitly configured.",
      );
    const workflow = appBuilderWorkflowState.get();
    if (
      workflow.phase !== "reviewed" &&
      workflow.phase !== "publication_pending" &&
      workflow.phase !== "publication_failed" &&
      workflow.phase !== "published_local"
    )
      throw new Error(
        "An exact reviewed change set is required before local publication.",
      );
    assertExactProposal(expected);
    const matches = (actual: LocalPublicationProposal) =>
      exactProposalMatch(actual, expected);
    const durable = await readLocalPublicationJournal(expected.destinationPath);
    // A successful destination necessarily has approved dirty paths. Reuse must
    // therefore happen before normal clean-path proposal derivation.
    if (workflow.phase === "published_local")
      assertExactDurablePublicationSuccess(
        workflow.publicationReceipt,
        durable,
      );
    if (
      workflow.phase === "published_local" ||
      durable?.status === "succeeded"
    ) {
      const stored: LocalPublicationSuccessReceipt =
        workflow.phase === "published_local"
          ? workflow.publicationReceipt
          : (durable as LocalPublicationSuccessReceipt);
      if (!matches(proposalFromJournal(stored)))
        throw new Error(
          "The local-publication retry does not exactly match the durable success proposal.",
        );
      if (workflow.reviewReceipt.digest !== stored.reviewDigest)
        throw new Error(
          "The reviewed receipt changed after local publication.",
        );
      assertCanonicalLocalPublicationJournal(stored);
      if (
        workflow.phase === "publication_pending" &&
        (stored.publishedByCallId !== workflow.publicationCallId ||
          stored.sourceReceiptDigest !== workflow.sourceReceipt.digest)
      )
        throw new Error(
          "The durable success does not exactly bind the pending workflow.",
        );
      await verifyPublishedChangeSet({
        receipt: stored,
        sourceReceipt: workflow.sourceReceipt,
        review: workflow.reviewReceipt,
      });
      if (workflow.phase === "publication_pending") {
        appBuilderWorkflowState.update((current) => {
          assertExactWorkflowState(
            current,
            workflow,
            "local-publication success recovery",
          );
          if (
            current.phase !== "publication_pending" ||
            current.publicationCallId !== workflow.publicationCallId ||
            !exactProposalMatch(current.publicationProposal, expected)
          )
            throw new Error(
              "The publication workflow changed before success recovery.",
            );
          return {
            ...current,
            phase: "published_local",
            publicationReceipt: stored,
          };
        });
      } else if (workflow.phase !== "published_local") {
        throw new Error(
          "Durable success does not match a pending publication workflow.",
        );
      }
      return { ...stored, reused: true };
    }
    if (
      workflow.phase === "publication_pending" &&
      durable?.status === "failed"
    ) {
      const stored: LocalPublicationFailureReceipt = durable;
      assertCanonicalLocalPublicationJournal(stored);
      if (
        !matches(proposalFromJournal(stored)) ||
        stored.publishedByCallId !== workflow.publicationCallId ||
        stored.sourceReceiptDigest !== workflow.sourceReceipt.digest ||
        stored.reviewDigest !== workflow.reviewReceipt.digest
      )
        throw new Error(
          "The durable failed publication does not exactly bind the pending workflow.",
        );
      appBuilderWorkflowState.update((current) => {
        assertExactWorkflowState(
          current,
          workflow,
          "local-publication failure recovery",
        );
        if (
          current.phase !== "publication_pending" ||
          current.publicationCallId !== workflow.publicationCallId ||
          !exactProposalMatch(current.publicationProposal, expected)
        )
          throw new Error(
            "The publication workflow changed before failure recovery.",
          );
        return {
          ...current,
          phase: "publication_failed",
          publicationReceipt: stored,
        };
      });
      return {
        ...stored,
        reused: true,
        terminalizedFailure: true,
      };
    }
    if (
      workflow.phase === "publication_pending" ||
      workflow.phase === "publication_failed" ||
      durable?.status === "pending" ||
      durable?.status === "failed"
    )
      throw new Error(
        "The prior local-publication attempt is recovery-required and will not be rerun automatically.",
      );
    const proposal = await exactLocalPublicationProposal({
      destinationPath: expected.destinationPath,
      expectedReviewDigest: expected.reviewDigest,
    });
    if (!matches(proposal))
      throw new Error(
        "The destination preconditions or reviewed change set changed before approval.",
      );
    // The workflow aggregate owns publication authority. Persist pending before
    // reading the canonical overlay or touching the destination.
    appBuilderWorkflowState.update((current) => {
      assertExactWorkflowState(
        current,
        workflow,
        "local-publication pending recording",
      );
      if (
        current.phase !== "reviewed" ||
        current.sourceReceipt.digest !== workflow.sourceReceipt.digest ||
        current.reviewReceipt.digest !== workflow.reviewReceipt.digest ||
        !exactProposalMatch(proposal, expected)
      )
        throw new Error(
          "The reviewed workflow changed before publication pending could be recorded.",
        );
      return {
        ...current,
        phase: "publication_pending",
        publicationProposal: proposal,
        publicationCallId: ctx.callId,
      };
    });
    if (
      process.env.APP_BUILDER_TEST_MODEL === "1" &&
      workflow.appSpec.appId === "publication-pre-journal-interruption"
    )
      throw new Error(
        "Fixture interruption after workflow pending and before durable publication journal.",
      );
    const relativeRoot = workflow.applyReceipt.applyRoot.replace(
      /^\/workspace\//u,
      "",
    );
    const result = await publishReviewedChangeSet({
      proposal,
      sourceReceipt: workflow.sourceReceipt,
      review: workflow.reviewReceipt,
      publishedByCallId: ctx.callId,
      readOverlayFile: (path) =>
        process.env.APP_BUILDER_TEST_MODEL === "1" &&
        workflow.appSpec.appId === "publication-precondition-failure"
          ? Promise.resolve(null)
          : ctx
              .getSandbox()
              .then((sandbox) =>
                sandbox.readBinaryFile({ path: `${relativeRoot}/${path}` }),
              ),
      ...(process.env.APP_BUILDER_TEST_MODEL === "1" &&
      workflow.appSpec.appId === "publication-interruption"
        ? {
            hooks: {
              afterPendingJournal: () => {
                throw new Error(
                  "Fixture interruption after durable publication pending.",
                );
              },
              preservePendingOnFailure: true,
            },
          }
        : {}),
      ...(process.env.APP_BUILDER_TEST_MODEL === "1" &&
      workflow.appSpec.appId === "publication-failure-recovery"
        ? {
            hooks: {
              afterMutation: () => {
                throw new Error(
                  "Fixture failure after local publication mutation.",
                );
              },
            },
          }
        : {}),
    });
    const terminalJournal = await readLocalPublicationJournal(
      expected.destinationPath,
    );
    if (result.ok) {
      if (
        terminalJournal?.status !== "succeeded" ||
        terminalJournal.digest !== result.receipt.digest
      )
        throw new Error(
          "The successful publication journal was not durably read back; workflow remains pending.",
        );
    } else if (result.receipt.reason === "precondition-failed") {
      if (terminalJournal !== undefined)
        throw new Error(
          "A pre-journal precondition failure unexpectedly created a durable journal; workflow remains pending.",
        );
    } else if (
      terminalJournal?.status !== "failed" ||
      terminalJournal.digest !== result.receipt.digest
    )
      throw new Error(
        "The failed publication journal was not durably read back; workflow remains pending.",
      );
    if (
      process.env.APP_BUILDER_TEST_MODEL === "1" &&
      (workflow.appSpec.appId === "publication-success-recovery" ||
        workflow.appSpec.appId === "publication-failure-recovery")
    )
      throw new Error(
        "Fixture interruption after durable terminal publication journal and before workflow terminal CAS.",
      );
    appBuilderWorkflowState.update((current) => {
      const expectedPending = {
        ...workflow,
        phase: "publication_pending" as const,
        publicationProposal: proposal,
        publicationCallId: ctx.callId,
      };
      assertExactWorkflowState(
        current,
        expectedPending,
        "local-publication terminal recording",
      );
      if (
        current.phase !== "publication_pending" ||
        current.publicationCallId !== ctx.callId ||
        current.publicationProposal.digest !== proposal.digest ||
        current.sourceReceipt.digest !== workflow.sourceReceipt.digest ||
        current.reviewReceipt.digest !== workflow.reviewReceipt.digest
      )
        throw new Error(
          "The pending publication workflow changed before terminal recording.",
        );
      return result.ok
        ? {
            ...current,
            phase: "published_local",
            publicationReceipt: result.receipt,
          }
        : {
            ...current,
            phase: "publication_failed",
            publicationReceipt: result.receipt,
          };
    });
    if (!result.ok)
      throw new Error(
        `Local publication failed with ${result.receipt.reason}; ${result.receipt.recoveryRequired ? "recovery is required" : "no destination mutation was accepted"}.`,
      );
    return { ...result.receipt, reused: false };
  },
});
