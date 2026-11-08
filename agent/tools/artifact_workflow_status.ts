import { defineTool } from "eve/tools";
import { z } from "zod";

import { prototypeArtifactReceipt } from "@/lib/agent/prototype-artifacts";
import {
  appBuilderWorkflowState,
  assertCurrentGitHubDraftProposal,
} from "@/lib/agent/workflow-state";
import { approvalReceiptForDraftProposal } from "@/lib/agent/approval-receipt";

const isFreshBootstrapPhase = (state: ReturnType<typeof appBuilderWorkflowState.get>) =>
  state.phase === "fresh_bootstrap_pending" ||
  state.phase === "fresh_bootstrap_failed" ||
  state.phase === "published_fresh_bootstrap";

const isBranchOrFreshPublication = (state: ReturnType<typeof appBuilderWorkflowState.get>) =>
  state.phase === "branch_publication_pending" ||
  state.phase === "branch_publication_failed" ||
  state.phase === "published_branch_worktree" ||
  isFreshBootstrapPhase(state);

const isLocalOrLaterPublication = (state: ReturnType<typeof appBuilderWorkflowState.get>) =>
  state.phase === "published_local" || isBranchOrFreshPublication(state);

const isReviewedPhase = (
  state: ReturnType<typeof appBuilderWorkflowState.get>,
): state is Extract<
  ReturnType<typeof appBuilderWorkflowState.get>,
  {
    phase:
      | "reviewed"
      | "publication_pending"
      | "publication_failed"
      | "published_local"
      | "branch_publication_pending"
      | "branch_publication_failed"
      | "published_branch_worktree"
      | "fresh_bootstrap_pending"
      | "fresh_bootstrap_failed"
      | "published_fresh_bootstrap";
  }
> =>
  state.phase === "reviewed" ||
  state.phase === "publication_pending" ||
  state.phase === "publication_failed" ||
  isLocalOrLaterPublication(state);

const acceptedUIReference = (state: ReturnType<typeof appBuilderWorkflowState.get>) => {
  if (!("appSpec" in state) || state.appSpec.uiRevision === undefined) {
    return {};
  }
  return {
    acceptedUIReference: {
      appId: state.appSpec.appId,
      revision: state.appSpec.uiRevision,
    },
  };
};

interface AppSpecSummary {
  artifactRevision: string;
  digest: string;
  path: string;
  uiRevision?: string;
}

type WorkflowState = ReturnType<typeof appBuilderWorkflowState.get>;
type PhaseState<P extends WorkflowState["phase"]> = Extract<WorkflowState, { phase: P }>;

interface WorkflowPhaseSummaries {
  appSpec?: AppSpecSummary;
  dependencies?: Pick<PhaseState<"dependencies_prepared">["dependencyReceipt"], "digest">;
  identity?: Pick<PhaseState<"identity_resolved">["identityReceipt"], "digest">;
  proposal?: Pick<PhaseState<"planned">["proposal"], "digest">;
  apply?:
    | (Pick<PhaseState<"apply_failed">["applyFailure"], "digest" | "reason" | "status"> & {
        recoveryRequired: boolean;
      })
    | Pick<PhaseState<"applied">["applyReceipt"], "changedContentDigest" | "digest" | "status">;
  validation?:
    | (Pick<PhaseState<"validation_pending">["validationAttempt"], "digest" | "status"> & {
        recoveryRequired: boolean;
      })
    | (Pick<
        PhaseState<"validation_failed">["validationFailure"],
        "digest" | "reason" | "status"
      > & { recoveryRequired: boolean })
    | Pick<PhaseState<"validated">["validationReceipt"], "digest" | "status">;
  review?: Pick<PhaseState<"reviewed">["reviewReceipt"], "changeSetDigest" | "digest">;
}

interface WorkflowStatusPreview {
  artifacts: ReturnType<typeof prototypeArtifactReceipt>[];
  uiPreview?: Pick<
    Extract<ReturnType<typeof appBuilderWorkflowState.get>, { uiPreview: unknown }>["uiPreview"],
    "appId" | "revision" | "sourceDigest"
  >;
}

const appSpecSummary = (appSpec: {
  artifactRevision: string;
  artifactPath: string;
  digest: string;
  uiRevision?: string;
}): AppSpecSummary => {
  const summary: AppSpecSummary = {
    artifactRevision: appSpec.artifactRevision,
    digest: appSpec.digest,
    path: appSpec.artifactPath,
  };
  if (appSpec.uiRevision !== undefined) {
    summary.uiRevision = appSpec.uiRevision;
  }
  return summary;
};

const githubDraftPublicationSummary = (state: ReturnType<typeof appBuilderWorkflowState.get>) => {
  if (state.phase !== "reviewed" || state.githubDraftProposal === undefined) {
    return {};
  }
  const proposal = state.githubDraftProposal.proposal;
  const binding = {
    binding: state.githubDraftProposal,
    expectedProposalDigest: proposal.digest,
    reviewDigest: state.reviewReceipt.digest,
    changeSetDigest: state.reviewReceipt.changeSetDigest,
    sourceReceiptDigest: state.sourceReceipt.digest,
    githubSource: state.githubSource,
    destinationReview: state.githubDestinationReview,
  };
  try {
    assertCurrentGitHubDraftProposal(binding);
  } catch {
    return {};
  }
  return {
    githubDraftPublication: {
      nextCall: {
        tool: "publish_github_draft_pr" as const,
        arguments: {
          expectedProposalDigest: proposal.digest,
          approvalReceipt: approvalReceiptForDraftProposal(proposal),
        },
      },
    },
  };
};

export default defineTool({
  description:
    "Return session-bound artifact workflow receipt metadata without artifact content or mutation. uiPreview.revision is the current component-backed UI revision for accept_ui_preview expectedRevision and record_ui_preview baseRevision. artifacts[].revision identifies a document artifact and must not be used as a UI revision. After AppSpec acceptance, the full uiPreview object may be absent; acceptedUIReference and appSpec.uiRevision preserve the UI revision accepted with that AppSpec. This is historical acceptance metadata, not the current component-backed UI revision or source. Its absence from uiPreview is expected and does not mean the design is missing or should be regenerated. Actual UI source changes still follow normal preview, validation, and acceptance. A planned phase continues through the ordinary private implementation path and separate Build approval; no approval is implied. For an exact retained sealed draft, githubDraftPublication.nextCall restores the canonical publication input, including legacy seals whose tool result lacked an approvalReceipt. This is reviewed subject metadata, not consent or publication status; use the existing publication or recovery flow and its native approval.",
  execute(_input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (state.phase === "empty") {
      return {
        phase: state.phase,
        sessionId: ctx.session.id,
        version: state.version,
      };
    }
    if (state.artifacts.some(({ sessionId }) => sessionId !== ctx.session.id)) {
      throw new Error("Prototype artifact state belongs to a different session.");
    }
    const githubDraftPublication = githubDraftPublicationSummary(state);
    let publication = {};
    if (state.phase === "publication_pending") {
      publication = {
        publication: {
          callId: state.publicationCallId,
          proposalDigest: state.publicationProposal.digest,
          status: "pending",
        },
      };
    } else if (state.phase === "publication_failed" || state.phase === "published_local") {
      publication = {
        publication: {
          digest: state.publicationReceipt.digest,
          recoveryRequired: state.publicationReceipt.recoveryRequired,
          status: state.publicationReceipt.status,
        },
      };
    }
    let branchPublication = {};
    if (state.phase === "branch_publication_pending") {
      branchPublication = {
        branchPublication: {
          callId: state.branchPublicationCallId,
          proposalDigest: state.branchPublicationProposal.digest,
          status: "pending",
        },
      };
    } else if (
      state.phase === "branch_publication_failed" ||
      state.phase === "published_branch_worktree"
    ) {
      branchPublication = {
        branchPublication: {
          branchName: state.branchPublicationReceipt.branchName,
          digest: state.branchPublicationReceipt.digest,
          recoveryRequired: state.branchPublicationReceipt.recoveryRequired,
          status: state.branchPublicationReceipt.status,
          worktreePath: state.branchPublicationReceipt.worktreePath,
        },
      };
    }
    let freshBootstrap = {};
    if (state.phase === "fresh_bootstrap_pending") {
      freshBootstrap = {
        freshBootstrap: {
          callId: state.freshBootstrapCallId,
          githubOutcome: "unavailable",
          proposalDigest: state.freshBootstrapProposal.digest,
          status: "pending",
        },
      };
    } else if (
      state.phase === "fresh_bootstrap_failed" ||
      state.phase === "published_fresh_bootstrap"
    ) {
      freshBootstrap = {
        freshBootstrap: {
          destinationPath: state.freshBootstrapReceipt.destinationPath,
          digest: state.freshBootstrapReceipt.digest,
          githubOutcome: "unavailable",
          proposalDigest: state.freshBootstrapReceipt.proposalDigest,
          recoveryRequired: state.freshBootstrapReceipt.recoveryRequired,
          status: state.freshBootstrapReceipt.status,
        },
      };
    }
    const preview: WorkflowStatusPreview = {
      artifacts: state.artifacts.map(prototypeArtifactReceipt),
    };
    if ("uiPreview" in state) {
      preview.uiPreview = {
        appId: state.uiPreview.appId,
        revision: state.uiPreview.revision,
        sourceDigest: state.uiPreview.sourceDigest,
      };
    }
    const result = {
      ...preview,
      ...acceptedUIReference(state),
      phase: state.phase,
      sessionId: ctx.session.id,
      version: state.version,
      workspace: {
        eligibilityDigest: state.workspace.eligibilityDigest,
        sourceSha: state.workspace.sourceSha,
        sourceTree: state.workspace.sourceTree,
        workspaceDigest: state.workspace.workspaceDigest,
      },
    };
    const summaries: WorkflowPhaseSummaries = {};
    if (
      state.phase === "app_spec_accepted" ||
      state.phase === "dependencies_prepared" ||
      state.phase === "identity_resolved" ||
      state.phase === "planned" ||
      state.phase === "apply_failed" ||
      state.phase === "applied" ||
      state.phase === "validation_pending" ||
      state.phase === "validation_failed" ||
      state.phase === "validated" ||
      isReviewedPhase(state)
    ) {
      summaries.appSpec = appSpecSummary(state.appSpec);
    }
    if (
      state.phase === "dependencies_prepared" ||
      state.phase === "identity_resolved" ||
      state.phase === "planned" ||
      state.phase === "apply_failed" ||
      state.phase === "applied" ||
      state.phase === "validation_pending" ||
      state.phase === "validation_failed" ||
      state.phase === "validated" ||
      isReviewedPhase(state)
    ) {
      summaries.dependencies = { digest: state.dependencyReceipt.digest };
    }
    if (
      state.phase === "identity_resolved" ||
      state.phase === "planned" ||
      state.phase === "apply_failed" ||
      state.phase === "applied" ||
      state.phase === "validation_pending" ||
      state.phase === "validation_failed" ||
      state.phase === "validated" ||
      isReviewedPhase(state)
    ) {
      summaries.identity = { digest: state.identityReceipt.digest };
    }
    if (
      state.phase === "planned" ||
      state.phase === "apply_failed" ||
      state.phase === "applied" ||
      state.phase === "validation_pending" ||
      state.phase === "validation_failed" ||
      state.phase === "validated" ||
      isReviewedPhase(state)
    ) {
      summaries.proposal = { digest: state.proposal.digest };
    }
    if (state.phase === "apply_failed") {
      summaries.apply = {
        digest: state.applyFailure.digest,
        reason: state.applyFailure.reason,
        recoveryRequired: true,
        status: state.applyFailure.status,
      };
    }
    if (
      state.phase === "applied" ||
      state.phase === "validation_pending" ||
      state.phase === "validation_failed" ||
      state.phase === "validated" ||
      isReviewedPhase(state)
    ) {
      summaries.apply = {
        changedContentDigest: state.applyReceipt.changedContentDigest,
        digest: state.applyReceipt.digest,
        status: state.applyReceipt.status,
      };
    }
    if (state.phase === "validation_pending") {
      summaries.validation = {
        digest: state.validationAttempt.digest,
        recoveryRequired: true,
        status: state.validationAttempt.status,
      };
    }
    if (state.phase === "validation_failed") {
      summaries.validation = {
        digest: state.validationFailure.digest,
        reason: state.validationFailure.reason,
        recoveryRequired: true,
        status: state.validationFailure.status,
      };
    }
    if (state.phase === "validated" || isReviewedPhase(state)) {
      summaries.validation = {
        digest: state.validationReceipt.digest,
        status: state.validationReceipt.status,
      };
    }
    if (isReviewedPhase(state)) {
      summaries.review = {
        changeSetDigest: state.reviewReceipt.changeSetDigest,
        digest: state.reviewReceipt.digest,
      };
    }
    return { ...result, ...summaries, ...githubDraftPublication, ...publication, ...branchPublication, ...freshBootstrap };
  },
  inputSchema: z.object({}),
});
