import { defineTool } from "eve/tools";
import { z } from "zod";

import { prototypeArtifactReceipt } from "@/lib/agent/prototype-artifacts";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";

const jsonValueSchema = z.json();

type JsonValue = z.infer<typeof jsonValueSchema>;

interface WorkflowStatusResult {
  acceptedUIReference?: JsonValue;
  appSpec?: JsonValue;
  apply?: JsonValue;
  artifacts: JsonValue;
  branchPublication?: JsonValue;
  dependencies?: JsonValue;
  freshBootstrap?: JsonValue;
  identity?: JsonValue;
  phase: JsonValue;
  proposal?: JsonValue;
  publication?: JsonValue;
  review?: JsonValue;
  sessionId: JsonValue;
  uiPreview?: JsonValue;
  validation?: JsonValue;
  version: JsonValue;
  workspace: JsonValue;
}

interface AcceptedUIReference {
  acceptedUIReference?: { appId: string; revision: string };
}

interface AppSpecSummary {
  artifactRevision: string;
  digest: string;
  path: string;
  uiRevision?: string;
}

type WorkflowState = ReturnType<typeof appBuilderWorkflowState.get>;

const isPublishedFreshPhase = (state: WorkflowState) => state.phase === "published_fresh_bootstrap";

const isBranchOrFreshPhase = (state: WorkflowState) =>
  state.phase === "published_branch_worktree" ||
  state.phase === "fresh_bootstrap_pending" ||
  state.phase === "fresh_bootstrap_failed" ||
  isPublishedFreshPhase(state);

const isPublishedOrBranchPhase = (state: WorkflowState) =>
  state.phase === "published_local" ||
  state.phase === "branch_publication_pending" ||
  state.phase === "branch_publication_failed" ||
  isBranchOrFreshPhase(state);

const isReviewedPhase = (
  state: WorkflowState,
): state is Extract<WorkflowState, { reviewReceipt: unknown }> =>
  state.phase === "reviewed" ||
  state.phase === "publication_pending" ||
  state.phase === "publication_failed" ||
  isPublishedOrBranchPhase(state);

const hasValidationReceiptPhase = (state: WorkflowState) =>
  state.phase === "validated" || isReviewedPhase(state);

const hasValidationFailurePhase = (state: WorkflowState) =>
  state.phase === "validation_failed" || hasValidationReceiptPhase(state);

const hasValidationAttemptPhase = (state: WorkflowState) =>
  state.phase === "validation_pending" || hasValidationFailurePhase(state);

const hasApplyReceiptPhase = (
  state: WorkflowState,
): state is Extract<WorkflowState, { applyReceipt: unknown }> =>
  state.phase === "applied" || hasValidationAttemptPhase(state);

const hasApplyPhase = (state: WorkflowState) =>
  state.phase === "apply_failed" || hasApplyReceiptPhase(state);

const hasProposalPhase = (
  state: WorkflowState,
): state is Extract<WorkflowState, { proposal: unknown }> =>
  state.phase === "planned" || hasApplyPhase(state);

const hasIdentityPhase = (
  state: WorkflowState,
): state is Extract<WorkflowState, { identityReceipt: unknown }> =>
  state.phase === "identity_resolved" || hasProposalPhase(state);

const hasDependenciesPhase = (
  state: WorkflowState,
): state is Extract<WorkflowState, { dependencyReceipt: unknown }> =>
  state.phase === "dependencies_prepared" || hasIdentityPhase(state);

const hasAppSpecPhase = (
  state: WorkflowState,
): state is Extract<WorkflowState, { appSpec: unknown }> =>
  state.phase === "app_spec_accepted" || hasDependenciesPhase(state);

const acceptedUIReference = (state: ReturnType<typeof appBuilderWorkflowState.get>) => {
  if (!("appSpec" in state) || state.appSpec.uiRevision === undefined) {
    return {};
  }
  const reference: AcceptedUIReference = {};
  reference.acceptedUIReference = {
    appId: state.appSpec.appId,
    revision: state.appSpec.uiRevision,
  };
  return reference;
};

const appSpecSummary = (appSpec: {
  artifactRevision: string;
  artifactPath: string;
  digest: string;
  uiRevision?: string;
}) => {
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

export default defineTool({
  description:
    "Return session-bound artifact workflow receipt metadata without artifact content or mutation. uiPreview.revision is the current component-backed UI revision for accept_ui_preview expectedRevision and record_ui_preview baseRevision. artifacts[].revision identifies a document artifact and must not be used as a UI revision. After AppSpec acceptance, the full uiPreview object may be absent; acceptedUIReference and appSpec.uiRevision preserve the UI revision accepted with that AppSpec. This is historical acceptance metadata, not the current component-backed UI revision or source. Its absence from uiPreview is expected and does not mean the design is missing or should be regenerated. Actual UI source changes still follow normal preview, validation, and acceptance. A planned phase continues through the ordinary private implementation path and separate Build approval; no approval is implied.",
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
    const artifacts = state.artifacts.map(prototypeArtifactReceipt);
    const preview: Pick<WorkflowStatusResult, "uiPreview"> = {};
    if ("uiPreview" in state) {
      preview.uiPreview = {
        appId: state.uiPreview.appId,
        revision: state.uiPreview.revision,
        sourceDigest: state.uiPreview.sourceDigest,
      };
    }
    const result: WorkflowStatusResult = {
      artifacts,
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
    if (hasAppSpecPhase(state)) {
      result.appSpec = { ...appSpecSummary(state.appSpec) };
    }
    if (hasDependenciesPhase(state)) {
      result.dependencies = { digest: state.dependencyReceipt.digest };
    }
    if (hasIdentityPhase(state)) {
      result.identity = { digest: state.identityReceipt.digest };
    }
    if (hasProposalPhase(state)) {
      result.proposal = { digest: state.proposal.digest };
    }
    if (state.phase === "apply_failed") {
      result.apply = {
        digest: state.applyFailure.digest,
        reason: state.applyFailure.reason,
        recoveryRequired: true,
        status: state.applyFailure.status,
      };
    } else if (hasApplyReceiptPhase(state)) {
      result.apply = {
        changedContentDigest: state.applyReceipt.changedContentDigest,
        digest: state.applyReceipt.digest,
        status: state.applyReceipt.status,
      };
    }
    if (state.phase === "validation_pending") {
      result.validation = {
        digest: state.validationAttempt.digest,
        recoveryRequired: true,
        status: state.validationAttempt.status,
      };
    } else if (state.phase === "validation_failed") {
      result.validation = {
        digest: state.validationFailure.digest,
        reason: state.validationFailure.reason,
        recoveryRequired: true,
        status: state.validationFailure.status,
      };
    } else if (state.phase === "validated" || isReviewedPhase(state)) {
      result.validation = {
        digest: state.validationReceipt.digest,
        status: state.validationReceipt.status,
      };
    }
    if (isReviewedPhase(state)) {
      result.review = {
        changeSetDigest: state.reviewReceipt.changeSetDigest,
        digest: state.reviewReceipt.digest,
      };
    }
    return { ...result, ...publication, ...branchPublication, ...freshBootstrap };
  },
  inputSchema: z.object({}),
});
