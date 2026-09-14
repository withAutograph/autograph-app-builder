import { defineTool } from "eve/tools";
import { z } from "zod";

import { prototypeArtifactReceipt } from "@/lib/agent/prototype-artifacts";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";

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
  state.phase === "published_local" ||
  state.phase === "branch_publication_pending" ||
  state.phase === "branch_publication_failed" ||
  state.phase === "published_branch_worktree" ||
  state.phase === "fresh_bootstrap_pending" ||
  state.phase === "fresh_bootstrap_failed" ||
  state.phase === "published_fresh_bootstrap";

export default defineTool({
  description:
    "Return session-bound artifact workflow receipt metadata without artifact content or mutation.",
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
    return {
      artifacts: state.artifacts.map(prototypeArtifactReceipt),
      phase: state.phase,
      sessionId: ctx.session.id,
      version: state.version,
      workspace: {
        eligibilityDigest: state.workspace.eligibilityDigest,
        sourceSha: state.workspace.sourceSha,
        sourceTree: state.workspace.sourceTree,
        workspaceDigest: state.workspace.workspaceDigest,
      },
      ...(state.phase === "app_spec_accepted" ||
      state.phase === "dependencies_prepared" ||
      state.phase === "identity_resolved" ||
      state.phase === "planned" ||
      state.phase === "apply_failed" ||
      state.phase === "applied" ||
      state.phase === "validation_pending" ||
      state.phase === "validation_failed" ||
      state.phase === "validated" ||
      isReviewedPhase(state)
        ? {
            appSpec: {
              artifactRevision: state.appSpec.artifactRevision,
              digest: state.appSpec.digest,
              path: state.appSpec.artifactPath,
            },
          }
        : {}),
      ...(state.phase === "dependencies_prepared" ||
      state.phase === "identity_resolved" ||
      state.phase === "planned" ||
      state.phase === "apply_failed" ||
      state.phase === "applied" ||
      state.phase === "validation_pending" ||
      state.phase === "validation_failed" ||
      state.phase === "validated" ||
      isReviewedPhase(state)
        ? { dependencies: { digest: state.dependencyReceipt.digest } }
        : {}),
      ...(state.phase === "identity_resolved" ||
      state.phase === "planned" ||
      state.phase === "apply_failed" ||
      state.phase === "applied" ||
      state.phase === "validation_pending" ||
      state.phase === "validation_failed" ||
      state.phase === "validated" ||
      isReviewedPhase(state)
        ? { identity: { digest: state.identityReceipt.digest } }
        : {}),
      ...(state.phase === "planned" ||
      state.phase === "apply_failed" ||
      state.phase === "applied" ||
      state.phase === "validation_pending" ||
      state.phase === "validation_failed" ||
      state.phase === "validated" ||
      isReviewedPhase(state)
        ? { proposal: { digest: state.proposal.digest } }
        : {}),
      ...(state.phase === "apply_failed"
        ? {
            apply: {
              digest: state.applyFailure.digest,
              reason: state.applyFailure.reason,
              recoveryRequired: true,
              status: state.applyFailure.status,
            },
          }
        : {}),
      ...(state.phase === "applied" ||
      state.phase === "validation_pending" ||
      state.phase === "validation_failed" ||
      state.phase === "validated" ||
      isReviewedPhase(state)
        ? {
            apply: {
              changedContentDigest: state.applyReceipt.changedContentDigest,
              digest: state.applyReceipt.digest,
              status: state.applyReceipt.status,
            },
          }
        : {}),
      ...(state.phase === "validation_pending"
        ? {
            validation: {
              digest: state.validationAttempt.digest,
              recoveryRequired: true,
              status: state.validationAttempt.status,
            },
          }
        : {}),
      ...(state.phase === "validation_failed"
        ? {
            validation: {
              digest: state.validationFailure.digest,
              reason: state.validationFailure.reason,
              recoveryRequired: true,
              status: state.validationFailure.status,
            },
          }
        : {}),
      ...(state.phase === "validated" || isReviewedPhase(state)
        ? {
            validation: {
              digest: state.validationReceipt.digest,
              status: state.validationReceipt.status,
            },
          }
        : {}),
      ...(isReviewedPhase(state)
        ? {
            review: {
              changeSetDigest: state.reviewReceipt.changeSetDigest,
              digest: state.reviewReceipt.digest,
            },
          }
        : {}),
      ...publication,
      ...branchPublication,
      ...freshBootstrap,
    };
  },
  inputSchema: z.object({}),
});
