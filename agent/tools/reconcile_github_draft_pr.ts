/* oxlint-disable unicorn/filename-case -- Eve derives the public tool identifier from this existing filename. */
import { resolveDraftReviewedWorkflow } from "@/lib/agent/draft-reviewed-lineage";
import { draftInspectionRecoveryForSession } from "@/lib/agent/prepare-published-draft-repair";
import { hostedOperatorCallbackExecution } from "@/lib/provisioning/hosted-operator-callback-owner";
import { updatePublishedDraftRepair } from "@/lib/agent/published-draft-repair-publication";
import {
  currentDraftCandidateSource,
  draftCompletionInstallation,
} from "@/lib/agent/published-draft-repair";
import { createHash } from "node:crypto";

import { defineTool } from "eve/tools";
import { getSourceBoundSandbox } from "@/lib/agent/source-bound-sandbox";
import { defineState } from "eve/context";
import { currentDirectProductionGrant } from "@/lib/agent/direct-production-state";
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
  samePersistedDraftCandidate,
  updateExactDraftReconciliation,
} from "@/lib/agent/draft-reconciliation-state";
import type {
  DraftReconciliationCandidate,
  DraftReconciliationCompletion,
} from "@/lib/agent/draft-reconciliation-state";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import type { AppBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { recordPublishedReconciliationForSession } from "@/lib/agent/published-app-source";
import { assertReconciliationCompletionOwnerForSession } from "@/lib/agent/compiled-operator-artifacts";
import { inspectDraftReconciliation } from "@/lib/repository/sandbox-draft-reconciliation";

const directReconciliationCalls = defineState<
  { callId: string; grantDigest: string; proposalDigest: string }[]
>("autograph-app-builder.direct-production-reconciliation-calls.v1", () => []);

const directReconciliationGrant = (
  ctx: Parameters<typeof currentDirectProductionGrant>[0],
  proposalDigest: string,
): ReturnType<typeof currentDirectProductionGrant> => {
  const candidate = draftReconciliationState.get();
  if (candidate === null || candidate.proposal?.digest !== proposalDigest) {
    return undefined;
  }
  const grant = currentDirectProductionGrant(ctx, {
    appId: candidate.appId,
    repositoryId: candidate.repositoryId,
  });
  return grant?.subject.revision?.reconciliation?.digest === proposalDigest ? grant : undefined;
};

const missingCompletion = () => ({
  status: "completion_context_missing" as const,
  recoveryRequired: true,
  nextAction:
    "The original approved proposal, reviews and exact compiled release association are unavailable. No GitHub write was attempted. Preserve this published head and resolve its source-recording context; do not republish it.",
});

const matchingApprovedCandidate = (
  workflow: AppBuilderWorkflowState,
  candidate: DraftReconciliationCandidate | null,
  completion: DraftReconciliationCompletion,
) => {
  const state = resolveDraftReviewedWorkflow(workflow, candidate) ?? workflow;
  const githubSource = currentDraftCandidateSource(workflow, candidate);
  const { proposal, review, appReview } = completion;
  if (
    // oxlint-disable-next-line sonarjs/expression-complexity -- Check the full retained approval binding before treating a candidate as current.
    candidate === null ||
    candidate.kind === "published-draft-repair" ||
    candidate.proposal?.digest !== proposal.digest ||
    candidate.review?.digest !== review.digest ||
    candidate.validation === undefined ||
    state.phase !== "reviewed" ||
    githubSource === undefined ||
    state.reviewReceipt.digest !== candidate.originalReviewDigest ||
    state.appSpec.appId !== completion.appId ||
    state.appSpec.digest !== appReview.appSpecDigest ||
    githubSource.repository.repositoryId !== proposal.repositoryId ||
    candidate.githubSourceDigest !== completion.githubSourceDigest ||
    candidate.root !== completion.root ||
    state.reviewReceipt.digest !== appReview.digest
  ) {
    return null;
  }
  return { candidate, validation: candidate.validation };
};

const retainPublishedReconciliation = (
  candidate: DraftReconciliationCandidate,
  proposal: DraftReconciliationCompletion["proposal"],
) => {
  updateExactDraftReconciliation({
    expected: candidate,
    operation: "recording the provider-verified published merge",
    transition: (current) =>
      current === null ? null : { ...current, publishedReconciliation: proposal },
  });
};

export default defineTool({
  approval(ctx) {
    const input = ctx.toolInput;
    if (input === undefined || input.recordCurrentEquivalentRelease === true) {
      return "user-approval";
    }
    const { expectedProposalDigest, approvalReceipt } = input;
    const grant = directReconciliationGrant(ctx, expectedProposalDigest);
    const proposal = draftReconciliationState.get()?.proposal;
    if (grant === undefined || proposal === undefined) {
      return "user-approval";
    }
    assertApprovalReceipt({
      actual: approvalReceipt,
      phase: "draft_update",
      subjectDigest: proposal.digest,
      target: approvalTargetFromExistingDraftReconciliation(proposal),
    });
    const prior = directReconciliationCalls.get().find((call) => call.callId === ctx.callId);
    if (prior === undefined) {
      directReconciliationCalls.update((calls) => [
        ...calls,
        { callId: ctx.callId, proposalDigest: proposal.digest, grantDigest: grant.digest },
      ]);
    } else if (prior.proposalDigest !== proposal.digest || prior.grantDigest !== grant.digest) {
      throw new Error("The reviewed draft update no longer matches its Production approval.");
    }
    return "approved";
  },
  description:
    "With the exact Production approval for an eligible schema correction, or a separate exact proposal approval, update the same owned open PR with the reviewed merge commit, or verify that this exact approved merge already succeeded and finish its original release recording. A server-sealed returnToDraft proposal explicitly returns the exact owned Ready PR to draft before publishing the correction; ordinary draft proposals cannot change Ready PRs. The same Production approval can cover Ready and merge for its exact corrected draft. Other corrected revisions need fresh Ready/merge approval. Recovery reads no current candidate bytes and never writes Git. Optional recordCurrentEquivalentRelease associates this verified publication only with the exact equivalent current compiled capture, without modifying Git or selecting another release. Fresh publication still requires the exact validated checkout. This never force pushes or deploys.",
  // oxlint-disable-next-line eslint/complexity -- Completion recovery and fresh publication have distinct approval, ownership and candidate preconditions.
  async execute(input, ctx) {
    ctx.abortSignal?.throwIfAborted();
    const candidate = draftReconciliationState.get();
    const directCall = directReconciliationCalls.get().find((call) => call.callId === ctx.callId);
    const assertEffectCurrent = () => {
      ctx.abortSignal?.throwIfAborted();
      if (
        directCall !== undefined &&
        (directCall.proposalDigest !== input.expectedProposalDigest ||
          directReconciliationGrant(ctx, input.expectedProposalDigest)?.digest !==
            directCall.grantDigest)
      ) {
        throw new Error("The reviewed draft update no longer matches its Production approval.");
      }
    };
    assertEffectCurrent();
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
      const { expectedProposalDigest, approvalReceipt } = input;
      return await updatePublishedDraftRepair({
        approvalReceipt,
        ctx,
        expectedProposalDigest,
      });
    }

    const workflow = appBuilderWorkflowState.get();
    const state = resolveDraftReviewedWorkflow(workflow, candidate) ?? workflow;
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
      const retained: DraftReconciliationCompletion = {
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
      };
      if (candidate.publishedOrigin !== undefined) {
        retained.publishedOrigin = candidate.publishedOrigin;
      }
      if (candidate.publicationScope !== undefined) {
        retained.publicationScope = candidate.publicationScope;
      }
      completion = retained;
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
    const recovery = draftInspectionRecoveryForSession({
      ctx,
      appId: completion.appId,
      appSpecDigest: completion.appReview.appSpecDigest,
      root: completion.root,
      pullRequestNumber: proposal.pullRequestNumber,
      priorPublishedProposalDigest:
        completion.publishedOrigin?.publicationProposalDigest ??
        completion.publicationScope?.proposal.digest,
    });
    const inspected = await runtime.inspectAppliedExistingDraftReconciliation({
      proposal,
      recovery,
      review,
    });
    const finish = async (
      publication: Parameters<typeof recordPublishedReconciliationForSession>[0]["publication"],
    ) => {
      try {
        const recordingInput: Parameters<typeof recordPublishedReconciliationForSession>[0] = {
          ...session,
          publication,
        };
        if (input.recordCurrentEquivalentRelease === true) {
          recordingInput.recordCurrentEquivalentRelease = true;
        }
        const recording = await recordPublishedReconciliationForSession(recordingInput);
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
      // A successful Git write can outlive its local delivery projection. Only restore it for
      // the still-current approved candidate; historical recording remains independently valid.
      await assertReconciliationCompletionOwnerForSession(session);
      assertEffectCurrent();
      const current = matchingApprovedCandidate(
        appBuilderWorkflowState.get(),
        draftReconciliationState.get(),
        completion,
      );
      if (
        current !== null &&
        [
          samePersistedDraftCandidate(current.candidate, candidate),
          current.candidate.appId === completion.appId,
          current.candidate.repositoryId === proposal.repositoryId,
          current.candidate.pullRequestNumber === proposal.pullRequestNumber,
          current.candidate.publishedOrigin?.digest === completion.publishedOrigin?.digest,
          current.candidate.publicationScope?.publication.digest ===
            completion.publicationScope?.publication.digest,
          current.validation.resolvedTree === proposal.resolvedTree,
          current.candidate.publishedReconciliation?.digest !== proposal.digest,
        ].every(Boolean)
      ) {
        retainPublishedReconciliation(current.candidate, proposal);
      }
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
    const current = matchingApprovedCandidate(workflow, candidate, completion);
    if (current === null) {
      throw new Error(
        "The approved draft reconciliation is unavailable or no longer matches the selected app. Review and seal its current merge before requesting approval.",
      );
    }
    const sandbox = await getSourceBoundSandbox(ctx);
    const observed = await inspectDraftReconciliation({ prepared: current.candidate, sandbox });
    if (
      observed.unresolvedConflicts.length > 0 ||
      observed.resolvedTree !== proposal.resolvedTree ||
      observed.resolvedTree !== current.validation.resolvedTree
    ) {
      throw new Error(
        "The reconciled checkout changed after validation and approval. Rerun checks, review both diffs, and request approval for the new result.",
      );
    }
    const changes = new Map(review.baseChanges.map((change) => [change.path, change]));
    const { root, workspaceRoot } = current.candidate;
    const relativeRoot = root.slice(workspaceRoot.length + 1);
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
    const publication = await runtime.reconcileExistingDraft({
      assertEffectCurrent,
      contentSource,
      proposal,
      recovery,
      review,
    });
    retainPublishedReconciliation(current.candidate, proposal);
    return await finish(publication);
  },
  inputSchema: z.strictObject({
    approvalReceipt: approvalReceiptSchema,
    expectedProposalDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    recordCurrentEquivalentRelease: z.literal(true).optional(),
  }),
});
// oxlint-disable github/filenames-match-regex -- Eve tool discovery requires the public snake_case tool name.
