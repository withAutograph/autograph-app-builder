import { hostedOperatorCallbackExecution } from "@/lib/provisioning/hosted-operator-callback-owner";
import { updatePublishedDraftRepair } from "@/lib/agent/published-draft-repair-publication";
import {
  currentDraftCandidateSource,
  draftCompletionInstallation,
} from "@/lib/agent/published-draft-repair";
import { createHash } from "node:crypto";

import { defineTool } from "eve/tools";
import { getSourceBoundSandbox } from "@/lib/agent/source-bound-sandbox";
import { always } from "eve/tools/approval";
import { z } from "zod";

import {
  approvalReceiptSchema,
  approvalTargetFromExistingDraftReconciliation,
  assertApprovalReceipt,
} from "@/lib/agent/approval-receipt";
import { githubPublicationRuntimeForSession } from "@/lib/agent/deployment-github-publication-runtime";
import {
  draftReconciliationState,
  publishedDraftRepairCompletions,
  draftReconciliationCompletions,
  retainDraftReconciliationCompletion,
  updateExactDraftReconciliation,
} from "@/lib/agent/draft-reconciliation-state";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { recordPublishedReconciliationForSession } from "@/lib/agent/published-app-source";
import { assertReconciliationCompletionOwnerForSession } from "@/lib/agent/compiled-operator-artifacts";
import { inspectDraftReconciliation } from "@/lib/repository/sandbox-draft-reconciliation";

const missingCompletion = () => ({
  status: "completion_context_missing" as const,
  recoveryRequired: true,
  nextAction:
    "The original approved proposal, reviews and exact compiled release association are unavailable. No GitHub write was attempted. Preserve this published head and resolve its source-recording context; do not republish it.",
});

export default defineTool({
  approval: always(),
  description:
    "After separate exact proposal approval, update the same open draft PR with the reviewed merge commit, or verify that this exact approved merge already succeeded and finish its original release recording. Recovery reads no current candidate bytes and never writes Git. Optional recordCurrentEquivalentRelease associates this verified publication only with the exact equivalent current compiled capture, without modifying Git or selecting another release. Fresh publication still requires the exact validated checkout. This never force pushes or deploys.",
  // oxlint-disable-next-line eslint/complexity -- Completion recovery and fresh publication have distinct approval, ownership and candidate preconditions.
  async execute(input, ctx) {
    const candidate = draftReconciliationState.get();
    if (
      publishedDraftRepairCompletions
        .get()
        .some((entry) => entry.proposal.digest === input.expectedProposalDigest)
    ) {
      if (input.recordCurrentEquivalentRelease === true) {
        throw new Error(
          "Resume this exact approved repair through update_github_draft_pr; it records its retained repair release.",
        );
      }
      return await updatePublishedDraftRepair({
        ctx,
        expectedProposalDigest: input.expectedProposalDigest,
        approvalReceipt: input.approvalReceipt,
      });
    }

    const state = appBuilderWorkflowState.get();
    let completion = draftReconciliationCompletions
      .get()
      .find((entry) => entry.proposal.digest === input.expectedProposalDigest);
    const sealedBeforeApproval = completion?.preparation === "sealed-before-approval";
    if (completion === undefined) {
      const githubSource = currentDraftCandidateSource(state, candidate);
      // Legacy recovery uses only canonical retained metadata, never "latest" or a Git-derived approval.
      if (
        // oxlint-disable-next-line sonarjs/expression-complexity -- Every retained legacy source, review and capture must name the same approved result.
        candidate?.proposal?.digest !== input.expectedProposalDigest ||
        candidate.kind === "published-draft-repair" ||
        candidate.review === undefined ||
        candidate.validation?.compilation === undefined ||
        state.phase !== "reviewed" ||
        githubSource === undefined ||
        state.reviewReceipt.digest !== candidate.originalReviewDigest ||
        state.appSpec.appId !== candidate.appId ||
        state.reviewReceipt.appSpecDigest !== state.appSpec.digest ||
        candidate.validation.resolvedTree !== candidate.proposal.resolvedTree ||
        candidate.review.resolvedTree !== candidate.proposal.resolvedTree
      ) {
        return missingCompletion();
      }
      completion = {
        preparation: "legacy-recording-only",
        proposal: candidate.proposal,
        review: candidate.review,
        appId: state.appSpec.appId,
        appReview: {
          appSpecDigest: state.reviewReceipt.appSpecDigest,
          changeSetDigest: state.reviewReceipt.changeSetDigest,
          digest: state.reviewReceipt.digest,
        },
        root: candidate.root,
        githubSourceDigest: candidate.githubSourceDigest,
        compilation: candidate.validation.compilation,
        ...(candidate.publishedOrigin === undefined
          ? {}
          : { publishedOrigin: candidate.publishedOrigin }),
        ...(candidate.publicationScope === undefined
          ? {}
          : { publicationScope: candidate.publicationScope }),
      };
    }
    const { proposal, review } = completion;
    assertApprovalReceipt({
      actual: input.approvalReceipt,
      phase: "draft_update",
      subjectDigest: proposal.digest,
      target: approvalTargetFromExistingDraftReconciliation(proposal),
    });
    if (!sealedBeforeApproval) {
      // This legacy branch is read-only in Git, even if the current checkout is still valid.
      retainDraftReconciliationCompletion(completion);
    }
    const session = {
      completion,
      adapterSessionId: ctx.session.id,
      callbackExecution: hostedOperatorCallbackExecution(ctx.session),
      sessionAuth: ctx.session.auth,
    };
    await assertReconciliationCompletionOwnerForSession(session);
    const runtime = await githubPublicationRuntimeForSession(
      ctx.session.auth,
      draftCompletionInstallation(completion),
    );
    const inspected = await runtime.inspectAppliedExistingDraftReconciliation({ proposal, review });
    const finish = async (
      publication: Parameters<typeof recordPublishedReconciliationForSession>[0]["publication"],
    ) => {
      try {
        const recording = await recordPublishedReconciliationForSession({
          ...session,
          publication,
          ...(input.recordCurrentEquivalentRelease === true
            ? { recordCurrentEquivalentRelease: true as const }
            : {}),
        });
        if (recording.status === "selection-changed") {
          return {
            ...publication,
            appSourceRecording: {
              status: "selection-changed" as const,
              recoveryRequired: true,
              nextAction:
                "The verified historical publication is unchanged, but its association was not recorded for the current selected release. Continue ordinary planning with the current accepted specification and selected capture; no GitHub write was attempted.",
            },
          };
        }
        return { ...publication, appSourceRecording: { status: recording.status } };
      } catch {
        return {
          ...publication,
          appSourceRecording: {
            status: "unavailable" as const,
            recoveryRequired: true,
            nextAction:
              "Resume this approved draft reconciliation to record its original release for Preview; the GitHub update already succeeded. No further GitHub write is needed.",
          },
        };
      }
    };
    if (inspected.applied) {
      return await finish(inspected.observation);
    }
    if (input.recordCurrentEquivalentRelease === true) {
      return {
        status: "publication_not_verified" as const,
        recoveryRequired: true,
        nextAction:
          "This approved publication was not verified as already applied. No GitHub write or current-release association was attempted. Preserve its existing reconciliation context.",
      };
    }
    if (!sealedBeforeApproval) {
      return missingCompletion();
    }
    // Fresh publication retains every mutable candidate/review check after the read-only recovery decision.
    const githubSource = currentDraftCandidateSource(state, candidate);
    if (
      // oxlint-disable-next-line sonarjs/expression-complexity -- Fresh writes retain the complete sealed candidate and current workflow authority binding.
      candidate === null ||
      candidate.kind === "published-draft-repair" ||
      candidate.proposal?.digest !== proposal.digest ||
      candidate.review?.digest !== review.digest ||
      candidate.validation === undefined ||
      state.phase !== "reviewed" ||
      githubSource === undefined ||
      state.reviewReceipt.digest !== candidate.originalReviewDigest ||
      state.appSpec.appId !== completion.appId ||
      state.appSpec.digest !== completion.appReview.appSpecDigest ||
      githubSource.repository.repositoryId !== proposal.repositoryId ||
      candidate.githubSourceDigest !== completion.githubSourceDigest ||
      candidate.root !== completion.root ||
      state.reviewReceipt.digest !== completion.appReview.digest
    ) {
      throw new Error(
        "The approved draft reconciliation is unavailable or no longer matches the selected app. Review and seal its current merge before requesting approval.",
      );
    }
    const sandbox = await getSourceBoundSandbox(ctx);
    const observed = await inspectDraftReconciliation({ prepared: candidate, sandbox });
    if (
      observed.unresolvedConflicts.length > 0 ||
      observed.resolvedTree !== proposal.resolvedTree ||
      observed.resolvedTree !== candidate.validation.resolvedTree
    ) {
      throw new Error(
        "The reconciled checkout changed after validation and approval. Rerun checks, review both diffs, and request approval for the new result.",
      );
    }
    const changes = new Map(review.baseChanges.map((change) => [change.path, change]));
    const relativeRoot = candidate.root.slice(candidate.workspaceRoot.length + 1);
    const contentSource = {
      async readFile(path: string) {
        const expected = changes.get(path);
        if (expected?.after === undefined) {
          return null;
        }
        const bytes = await sandbox.readBinaryFile({ path: `${relativeRoot}/${path}` });
        if (
          bytes === null ||
          createHash("sha256").update(bytes).digest("hex") !== expected.after.digest
        ) {
          throw new Error(
            `The resolved file ${path} changed after review. Rerun validation and review both diffs before updating the draft.`,
          );
        }
        return { bytes, digest: expected.after.digest, mode: expected.after.mode };
      },
      // oxlint-disable-next-line eslint/require-await -- preserve async content-source interface.
      async readFreshTree() {
        throw new Error("A fresh repository tree is unavailable for draft reconciliation.");
      },
    };
    await assertReconciliationCompletionOwnerForSession(session);
    const publication = await runtime.reconcileExistingDraft({ contentSource, proposal, review });
    updateExactDraftReconciliation({
      expected: candidate,
      operation: "recording the provider-verified published merge",
      transition: (current) =>
        current === null ? null : { ...current, publishedReconciliation: proposal },
    });
    return await finish(publication);
  },
  inputSchema: z.strictObject({
    approvalReceipt: approvalReceiptSchema,
    expectedProposalDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    recordCurrentEquivalentRelease: z.literal(true).optional(),
  }),
});
// oxlint-disable github/filenames-match-regex -- Eve tool discovery requires the public snake_case tool name.
