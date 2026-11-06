import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { appBuilderWorkflowState, updateExactWorkflow } from "@/lib/agent/workflow-state";
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
import { hasTestCapability } from "@/lib/testing/test-capability";

const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const file = z.strictObject({
  digest,
  mode: z.string().regex(/^[0-7]{3,4}$/u),
});
const change = z.strictObject({
  after: file.optional(),
  before: file.optional(),
  kind: z.enum(["added", "modified", "deleted"]),
  path: z.string().min(1),
});
const publication = z.strictObject({
  approvedPaths: z.array(z.string().min(1)),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/u),
  changeSetDigest: digest,
  changes: z.array(change),
  contractDigest: digest,
  destinationPath: z.string().min(1),
  digest,
  executionPaths: z.array(z.string().min(1)),
  gitDirectoryIdentity: z.strictObject({
    device: z.string(),
    inode: z.string(),
  }),
  gitDirectoryPath: z.string().min(1),
  headReference: z.string().min(1),
  indexFileDigest: digest,
  intendedOutcome: z.literal("apply-reviewed-change-set-locally"),
  preconditionStatusDigest: digest,
  remoteDigest: digest,
  reviewDigest: digest,
  rootIdentity: z.strictObject({ device: z.string(), inode: z.string() }),
  sourceReceiptDigest: digest,
  sourceTree: z.string().regex(/^[0-9a-f]{40}$/u),
  unrelatedProjectionDigest: digest,
  version: z.literal(2),
});
const publicationInterruptionAppId = "publication-interruption";
const publicationFailureRecoveryAppId = "publication-failure-recovery";

const simulatedPublicationCapability = "simulated-publication";
const publicationWorkflowChangedMessage =
  "The publication workflow changed before terminal recording.";
const isSimulatedPublication = (appId: string, expected: string): boolean =>
  hasTestCapability(simulatedPublicationCapability) && appId === expected;

const recordRecoveredSuccess = async (
  workflow: Extract<
    ReturnType<typeof appBuilderWorkflowState.get>,
    { phase: "published_local" | "publication_pending" }
  >,
  expected: LocalPublicationProposal,
  stored: LocalPublicationSuccessReceipt,
) => {
  const matches = (actual: LocalPublicationProposal) => exactProposalMatch(actual, expected);
  if (!matches(proposalFromJournal(stored))) {
    throw new Error(
      "The local-publication retry does not exactly match the durable success proposal.",
    );
  }
  if (workflow.reviewReceipt.digest !== stored.reviewDigest) {
    throw new Error("The reviewed receipt changed after local publication.");
  }
  assertCanonicalLocalPublicationJournal(stored);
  if (
    workflow.phase === "publication_pending" &&
    (stored.publishedByCallId !== workflow.publicationCallId ||
      stored.sourceReceiptDigest !== workflow.sourceReceipt.digest)
  ) {
    throw new Error("The durable success does not exactly bind the pending workflow.");
  }
  await verifyPublishedChangeSet({
    receipt: stored,
    review: workflow.reviewReceipt,
    sourceReceipt: workflow.sourceReceipt,
  });
  if (workflow.phase === "publication_pending") {
    updateExactWorkflow({
      expected: workflow,
      operation: "local-publication success recovery",
      transition: (current) => {
        if (
          current.phase !== "publication_pending" ||
          current.publicationCallId !== workflow.publicationCallId ||
          !exactProposalMatch(current.publicationProposal, expected)
        ) {
          throw new Error("The publication workflow changed before success recovery.");
        }
        return { ...current, phase: "published_local", publicationReceipt: stored };
      },
    });
  }
  return { ...stored, reused: true };
};

const recordRecoveredFailure = (
  workflow: Extract<
    ReturnType<typeof appBuilderWorkflowState.get>,
    { phase: "publication_pending" }
  >,
  expected: LocalPublicationProposal,
  stored: LocalPublicationFailureReceipt,
) => {
  assertCanonicalLocalPublicationJournal(stored);
  if (
    !exactProposalMatch(proposalFromJournal(stored), expected) ||
    stored.publishedByCallId !== workflow.publicationCallId ||
    stored.sourceReceiptDigest !== workflow.sourceReceipt.digest ||
    stored.reviewDigest !== workflow.reviewReceipt.digest
  ) {
    throw new Error("The durable failed publication does not exactly bind the pending workflow.");
  }
  updateExactWorkflow({
    expected: workflow,
    operation: "local-publication failure recovery",
    transition: (current) => {
      if (
        current.phase !== "publication_pending" ||
        current.publicationCallId !== workflow.publicationCallId ||
        !exactProposalMatch(current.publicationProposal, expected)
      ) {
        throw new Error("The publication workflow changed before failure recovery.");
      }
      return { ...current, phase: "publication_failed", publicationReceipt: stored };
    },
  });
  return { ...stored, reused: true, terminalizedFailure: true };
};

type PublicationWorkflow = ReturnType<typeof appBuilderWorkflowState.get>;
type PublishReviewedChangeSetInput = Parameters<typeof publishReviewedChangeSet>[0];

const resolvePublicationRecovery = async (
  workflow: PublicationWorkflow,
  expected: LocalPublicationProposal,
) => {
  const durable = await readLocalPublicationJournal(expected.destinationPath);
  if (workflow.phase === "published_local") {
    assertExactDurablePublicationSuccess(workflow.publicationReceipt, durable);
  }
  if (workflow.phase === "published_local" || durable?.status === "succeeded") {
    const stored = workflow.phase === "published_local" ? workflow.publicationReceipt : durable;
    if (stored?.status !== "succeeded") {
      throw new Error("Durable success does not match a pending publication workflow.");
    }
    return { durable, result: await recordRecoveredSuccess(workflow, expected, stored) };
  }
  if (workflow.phase === "publication_pending" && durable?.status === "failed") {
    return { durable, result: recordRecoveredFailure(workflow, expected, durable) };
  }
  return { durable, result: null };
};

const assertPublicationCanStart = (
  workflow: PublicationWorkflow,
  durable: Awaited<ReturnType<typeof readLocalPublicationJournal>>,
) => {
  if (
    workflow.phase === "publication_pending" ||
    workflow.phase === "publication_failed" ||
    durable?.status === "pending" ||
    durable?.status === "failed"
  ) {
    throw new Error(
      "The prior local-publication attempt is recovery-required and will not be rerun automatically.",
    );
  }
};

const buildPublicationHooks = (
  appId: string,
): NonNullable<PublishReviewedChangeSetInput["hooks"]> => {
  const hooks: NonNullable<PublishReviewedChangeSetInput["hooks"]> = {};
  if (isSimulatedPublication(appId, publicationInterruptionAppId)) {
    hooks.afterPendingJournal = () => {
      throw new Error("Fixture interruption after durable publication pending.");
    };
    hooks.preservePendingOnFailure = true;
  }
  if (isSimulatedPublication(appId, publicationFailureRecoveryAppId)) {
    hooks.afterMutation = () => {
      throw new Error("Fixture failure after local publication mutation.");
    };
  }
  return hooks;
};

const verifyTerminalJournal = (
  result: Awaited<ReturnType<typeof publishReviewedChangeSet>>,
  terminalJournal: Awaited<ReturnType<typeof readLocalPublicationJournal>>,
) => {
  if (result.ok) {
    if (
      terminalJournal?.status !== "succeeded" ||
      terminalJournal.digest !== result.receipt.digest
    ) {
      throw new Error(
        "The successful publication journal was not durably read back; workflow remains pending.",
      );
    }
    return;
  }
  if (result.receipt.reason === "precondition-failed") {
    if (terminalJournal !== undefined) {
      throw new Error(
        "A pre-journal precondition failure unexpectedly created a durable journal; workflow remains pending.",
      );
    }
    return;
  }
  if (terminalJournal?.status !== "failed" || terminalJournal.digest !== result.receipt.digest) {
    throw new Error(
      "The failed publication journal was not durably read back; workflow remains pending.",
    );
  }
};

const isExpectedPendingWorkflow = (
  current: PublicationWorkflow,
  workflow: Extract<PublicationWorkflow, { phase: "publication_pending" }>,
  proposal: LocalPublicationProposal,
  callId: string,
): boolean => {
  if (current.phase !== "publication_pending") {
    return false;
  }
  return (
    current.publicationCallId === callId &&
    current.publicationProposal.digest === proposal.digest &&
    current.sourceReceipt.digest === workflow.sourceReceipt.digest &&
    current.reviewReceipt.digest === workflow.reviewReceipt.digest
  );
};

const isExpectedReviewedWorkflow = (
  current: PublicationWorkflow,
  workflow: Extract<PublicationWorkflow, { phase: "reviewed" }>,
  proposal: LocalPublicationProposal,
  expected: LocalPublicationProposal,
): boolean => {
  if (current.phase !== "reviewed") {
    return false;
  }
  return (
    current.sourceReceipt.digest === workflow.sourceReceipt.digest &&
    current.reviewReceipt.digest === workflow.reviewReceipt.digest &&
    exactProposalMatch(proposal, expected)
  );
};

const isTerminalRecoveryFixture = (appId: string): boolean =>
  isSimulatedPublication(appId, "publication-success-recovery") ||
  isSimulatedPublication(appId, "publication-failure-recovery");

const recordPublicationTerminal = (
  workflow: Extract<PublicationWorkflow, { phase: "publication_pending" }>,
  proposal: LocalPublicationProposal,
  callId: string,
  result: Awaited<ReturnType<typeof publishReviewedChangeSet>>,
) => {
  updateExactWorkflow({
    expected: workflow,
    operation: "local-publication terminal recording",
    transition: (current) => {
      if (!isExpectedPendingWorkflow(current, workflow, proposal, callId)) {
        throw new Error(publicationWorkflowChangedMessage);
      }
      return result.ok
        ? { ...current, phase: "published_local", publicationReceipt: result.receipt }
        : { ...current, phase: "publication_failed", publicationReceipt: result.receipt };
    },
  });
};

const runPublication = async (
  workflow: Extract<PublicationWorkflow, { phase: "reviewed" }>,
  proposal: LocalPublicationProposal,
  callId: string,
  getSandbox: () => Promise<{
    readBinaryFile: (input: { path: string }) => Promise<Uint8Array | null>;
  }>,
): Promise<Awaited<ReturnType<typeof publishReviewedChangeSet>>> => {
  if (
    hasTestCapability(simulatedPublicationCapability) &&
    workflow.appSpec.appId === "publication-pre-journal-interruption"
  ) {
    throw new Error(
      "Fixture interruption after workflow pending and before durable publication journal.",
    );
  }
  const relativeRoot = workflow.applyReceipt.applyRoot.replace(/^\/workspace\//u, "");
  const hooks = buildPublicationHooks(workflow.appSpec.appId);
  const input: PublishReviewedChangeSetInput = {
    proposal,
    publishedByCallId: callId,
    readOverlayFile: async (path) => {
      if (
        hasTestCapability(simulatedPublicationCapability) &&
        workflow.appSpec.appId === "publication-precondition-failure"
      ) {
        return null;
      }
      const sandbox = await getSandbox();
      return await sandbox.readBinaryFile({ path: `${relativeRoot}/${path}` });
    },
    review: workflow.reviewReceipt,
    sourceReceipt: workflow.sourceReceipt,
  };
  if (Object.keys(hooks).length > 0) {
    input.hooks = hooks;
  }
  return await publishReviewedChangeSet(input);
};

export default defineTool({
  approval: always(),
  description:
    "Apply one exact separately reviewed change set to one approved existing local checkout. This approval-bound operation writes only approved paths, never commits or changes Git history, and never publishes remotely.",
  async execute({ publication: expected }, ctx) {
    if (process.env.APP_BUILDER_LOCAL_PUBLICATION !== "1") {
      throw new Error(
        "Local publication is disabled until APP_BUILDER_LOCAL_PUBLICATION=1 is explicitly configured.",
      );
    }
    const workflow = appBuilderWorkflowState.get();
    if (
      workflow.phase !== "reviewed" &&
      workflow.phase !== "publication_pending" &&
      workflow.phase !== "publication_failed" &&
      workflow.phase !== "published_local"
    ) {
      throw new Error("An exact reviewed change set is required before local publication.");
    }
    assertExactProposal(expected);
    const recovery = await resolvePublicationRecovery(workflow, expected);
    const { durable } = recovery;
    // A successful destination necessarily has approved dirty paths. Reuse must
    // therefore happen before normal clean-path proposal derivation.
    if (recovery.result !== null) {
      return recovery.result;
    }
    assertPublicationCanStart(workflow, durable);
    const proposal = await exactLocalPublicationProposal({
      destinationPath: expected.destinationPath,
      expectedReviewDigest: expected.reviewDigest,
    });
    if (!exactProposalMatch(proposal, expected)) {
      throw new Error(
        "The destination preconditions or reviewed change set changed before approval.",
      );
    }
    // The workflow aggregate owns publication authority. Persist pending before
    // reading the canonical overlay or touching the destination.
    updateExactWorkflow({
      expected: workflow,
      operation: "local-publication pending recording",
      transition: (current) => {
        if (!isExpectedReviewedWorkflow(current, workflow, proposal, expected)) {
          throw new Error(
            "The reviewed workflow changed before publication pending could be recorded.",
          );
        }
        return {
          ...current,
          phase: "publication_pending",
          publicationCallId: ctx.callId,
          publicationProposal: proposal,
        };
      },
    });
    const pendingWorkflow = {
      ...workflow,
      phase: "publication_pending" as const,
      publicationCallId: ctx.callId,
      publicationProposal: proposal,
    };
    const getSandbox = async () => await ctx.getSandbox();
    const result = await runPublication(workflow, proposal, ctx.callId, getSandbox);
    const terminalJournal = await readLocalPublicationJournal(expected.destinationPath);
    verifyTerminalJournal(result, terminalJournal);
    if (isTerminalRecoveryFixture(workflow.appSpec.appId)) {
      throw new Error(
        "Fixture interruption after durable terminal publication journal and before workflow terminal CAS.",
      );
    }
    recordPublicationTerminal(pendingWorkflow, proposal, ctx.callId, result);
    if (!result.ok) {
      throw new Error(
        `Local publication failed with ${result.receipt.reason}; ${result.receipt.recoveryRequired ? "recovery is required" : "no destination mutation was accepted"}.`,
      );
    }
    return { ...result.receipt, reused: false };
  },
  inputSchema: z.strictObject({ publication }),
});
