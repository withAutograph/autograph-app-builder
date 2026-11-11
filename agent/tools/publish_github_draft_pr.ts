/* oxlint-disable github/filenames-match-regex, unicorn/filename-case -- Eve derives the public tool identifier from this existing filename. */
import { hostedOperatorCallbackExecution } from "@/lib/provisioning/hosted-operator-callback-owner";
import { defineTool } from "eve/tools";
import { defineState } from "eve/context";
import { z } from "zod";

import {
  approvalReceiptSchema,
  approvalTargetFromDraftProposal,
  assertApprovalReceipt,
} from "@/lib/agent/approval-receipt";
import { githubPublicationRuntimeForSession } from "@/lib/agent/deployment-github-publication-runtime";
import { publicationContentSourceForReviewedWorkflow } from "@/lib/agent/github-publication-content-source";
import {
  appBuilderWorkflowState,
  assertCurrentGitHubDraftProposal,
  assertExactWorkflowState,
  updateExactWorkflow,
} from "@/lib/agent/workflow-state";
import { appBaselineState } from "@/lib/agent/app-baseline-state";
import { recordPublishedAppSourceForSession } from "@/lib/agent/published-app-source";
import { assertExistingAppReviewScope } from "@/lib/repository/reviewed-change-set";
import { firstAppRegistrationPaths } from "@/lib/repository/github-destination-review";
import { currentDirectProductionGrant } from "@/lib/agent/direct-production-state";

const directPublicationCalls = defineState<
  { callId: string; proposalDigest: string; grantDigest: string }[]
>("autograph-app-builder.direct-production-publication-calls.v1", () => []);

const currentDraftReleaseGrant = (
  state: ReturnType<typeof appBuilderWorkflowState.get>,
  ctx: Parameters<typeof currentDirectProductionGrant>[0],
) => {
  const proposal = state.phase === "reviewed" ? state.githubDraftProposal?.proposal : undefined;
  return state.phase === "reviewed" &&
    state.githubDestinationReview !== undefined &&
    proposal !== undefined
    ? currentDirectProductionGrant(ctx, {
        appId: state.appSpec.appId,
        repositoryId: proposal.repositoryId,
        repositoryFullName: `${proposal.owner}/${proposal.name}`,
        baseBranch: proposal.baseBranch,
        installationId: state.githubDestinationReview.installation.installationId,
      })
    : undefined;
};

export default defineTool({
  approval(ctx) {
    const { toolInput: input } = ctx;
    const state = appBuilderWorkflowState.get();
    const grant = currentDraftReleaseGrant(state, ctx);
    if (input === undefined || state.phase !== "reviewed" || grant === undefined) {
      return "user-approval";
    }
    const proposal = assertCurrentGitHubDraftProposal({
      binding: state.githubDraftProposal,
      changeSetDigest: state.reviewReceipt.changeSetDigest,
      destinationReview: state.githubDestinationReview,
      expectedProposalDigest: input.expectedProposalDigest,
      githubSource: state.githubSource,
      reviewDigest: state.reviewReceipt.digest,
      sourceReceiptDigest: state.sourceReceipt.digest,
    });
    assertApprovalReceipt({
      actual: input.approvalReceipt,
      phase: "publication",
      subjectDigest: proposal.digest,
      target: approvalTargetFromDraftProposal(proposal),
    });
    const existing = directPublicationCalls.get().find((call) => call.callId === ctx.callId);
    if (existing === undefined) {
      directPublicationCalls.update((calls) => [
        ...calls,
        { callId: ctx.callId, grantDigest: grant.digest, proposalDigest: proposal.digest },
      ]);
    } else if (
      existing.grantDigest !== grant.digest ||
      existing.proposalDigest !== proposal.digest
    ) {
      throw new Error("The draft publication no longer matches its release approval.");
    }
    return "approved";
  },
  description:
    "Invoke this tool with the canonical approvalReceipt and proposal digest returned by seal_github_draft_pr_proposal to publish under the current Production release approval or request the ordinary Eve approval control. The receipt describes the reviewed subject; it is not prior user consent. Do not wait for a separate approval-request tool or ask the user to supply a receipt. After a reviewed-path-changed rejection, refresh and review the changes, reseal the proposal, and obtain fresh publication approval; this operation verifies branch and pull-request absence before recovering the rejected attempt. GitHub decides whether the account can write the repository and reports any real conflict or permission error. Approval is required only for this outward effect.",
  async execute(input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (state.phase !== "reviewed" || state.githubDraftProposal === undefined) {
      throw new Error(
        "Choose a repository and finish the implementation plan before opening a draft pull request.",
      );
    }
    if (input.expectedProposalDigest !== state.githubDraftProposal.proposal.digest) {
      throw new Error(
        "The publication request names a different draft-PR proposal. Reopen the current sealed proposal before approving publication.",
      );
    }
    let selectedInstallationId: string | undefined;
    if (state.githubSource === undefined) {
      if (
        state.sourceReceipt.sourceKind !== "fresh-template" ||
        state.githubDestinationReview === undefined
      ) {
        throw new Error("Restore the selected GitHub source before publishing its draft.");
      }
      assertCurrentGitHubDraftProposal({
        binding: state.githubDraftProposal,
        changeSetDigest: state.reviewReceipt.changeSetDigest,
        destinationReview: state.githubDestinationReview,
        expectedProposalDigest: input.expectedProposalDigest,
        reviewDigest: state.reviewReceipt.digest,
        sourceReceiptDigest: state.sourceReceipt.digest,
      });
      selectedInstallationId = state.githubDestinationReview.installation.installationId;
    }
    assertApprovalReceipt({
      actual: input.approvalReceipt,
      phase: "publication",
      subjectDigest: state.githubDraftProposal.proposal.digest,
      target: approvalTargetFromDraftProposal(state.githubDraftProposal.proposal),
    });
    assertExistingAppReviewScope(
      state.reviewReceipt,
      state.appSpec.appId,
      state.sourceReceipt.sourceKind,
      appBaselineState.get()?.receipt,
      firstAppRegistrationPaths(state.githubDestinationReview, state.appSpec.appId),
    );
    const directCall = directPublicationCalls.get().find((call) => call.callId === ctx.callId);
    const assertEffectCurrent = () => {
      ctx.abortSignal?.throwIfAborted();
      assertExactWorkflowState(
        appBuilderWorkflowState.get(),
        state,
        "draft pull request publication",
      );
      if (
        directCall?.proposalDigest !== input.expectedProposalDigest ||
        currentDraftReleaseGrant(state, ctx)?.digest !== directCall.grantDigest
      ) {
        throw new Error("The draft publication no longer matches its release approval.");
      }
    };
    if (directCall !== undefined) {
      assertEffectCurrent();
      selectedInstallationId = state.githubDestinationReview?.installation.installationId;
    }
    const sandbox = await ctx.getSandbox();
    const contentSource = publicationContentSourceForReviewedWorkflow({
      sandbox,
      state,
    });
    const runtime =
      selectedInstallationId === undefined
        ? await githubPublicationRuntimeForSession(ctx.session.auth)
        : await githubPublicationRuntimeForSession(ctx.session.auth, { selectedInstallationId });
    const request: Parameters<typeof runtime.publishDraftPullRequest>[0] = {
      approvalReceipt: input.approvalReceipt,
      approvedByCallId: ctx.callId,
      contentSource,
      expectedProposalDigest: state.githubDraftProposal.proposal.digest,
      review: state.reviewReceipt,
    };
    if (directCall !== undefined) {
      assertEffectCurrent();
      request.assertEffectCurrent = assertEffectCurrent;
    }
    const publication = await runtime.publishDraftPullRequest(request);
    try {
      const recording = await recordPublishedAppSourceForSession({
        appId: state.appSpec.appId,
        appSpecDigest: state.appSpec.digest,
        backendKind: state.appBackendKind,
        root: state.applyReceipt.applyRoot,
        adapterSessionId: ctx.session.id,
        callbackExecution: hostedOperatorCallbackExecution(ctx.session),
        sessionAuth: ctx.session.auth,
        callId: ctx.callId,
        review: state.reviewReceipt,
        publication,
      });
      if (
        publication.status === "succeeded" &&
        publication.proposalDigest === state.githubDraftProposal.proposal.digest
      ) {
        ctx.abortSignal?.throwIfAborted();
        updateExactWorkflow({
          expected: state,
          operation: "record the verified current draft publication",
          transition: () => ({
            ...state,
            publishedGitHubDraftProposalDigest: publication.proposalDigest,
          }),
        });
      }
      const result = { ...publication, appSourceRecording: { status: recording.status } };
      return directCall !== undefined &&
        publication.status === "succeeded" &&
        recording.status === "recorded"
        ? { ...result, nextCall: { tool: "read_github_pr_delivery" as const, input: {} } }
        : result;
    } catch {
      return {
        ...publication,
        appSourceRecording: {
          status: "unavailable" as const,
          recoveryRequired: true,
          nextAction:
            "Resume this approved publication to record its source for Preview; the GitHub publication already succeeded. Preview source preparation remains unavailable until recording succeeds.",
        },
      };
    }
  },
  inputSchema: z.strictObject({
    approvalReceipt: approvalReceiptSchema,
    expectedProposalDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
});
