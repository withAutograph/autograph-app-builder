import { defineTool } from "eve/tools";
import { z } from "zod";

import { prototypeArtifactReceipt } from "@/lib/agent/prototype-artifacts";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";

type WorkflowState = ReturnType<typeof appBuilderWorkflowState.get>;

const isReviewedPhase = (
  state: WorkflowState,
): state is Extract<WorkflowState, { reviewReceipt: unknown }> => "reviewReceipt" in state;

const acceptedUIReference = (
  state: ReturnType<typeof appBuilderWorkflowState.get>,
): { appId: string; revision: string } | undefined => {
  if (!("appSpec" in state) || state.appSpec.uiRevision === undefined) {
    return undefined;
  }
  return { appId: state.appSpec.appId, revision: state.appSpec.uiRevision };
};

const appSpecSummary = (appSpec: {
  artifactRevision: string;
  artifactPath: string;
  digest: string;
  uiRevision?: string;
}) => {
  const summary = {
    artifactRevision: appSpec.artifactRevision,
    digest: appSpec.digest,
    path: appSpec.artifactPath,
  };
  return appSpec.uiRevision === undefined
    ? summary
    : { ...summary, uiRevision: appSpec.uiRevision };
};

interface WorkflowDetails {
  publication?: {
    callId?: string;
    proposalDigest?: string;
    digest?: string;
    recoveryRequired?: boolean;
    status: string;
  };
  branchPublication?: {
    callId?: string;
    proposalDigest?: string;
    branchName?: string;
    digest?: string;
    recoveryRequired?: boolean;
    status: string;
    worktreePath?: string;
  };
  freshBootstrap?: {
    callId?: string;
    destinationPath?: string;
    digest?: string;
    githubOutcome: "unavailable";
    proposalDigest: string;
    recoveryRequired?: boolean;
    status: string;
  };
}

type WorkflowStatusDetails = WorkflowDetails & {
  artifacts: ReturnType<typeof prototypeArtifactReceipt>[];
  phase: Exclude<WorkflowState["phase"], "empty">;
  sessionId: string;
  version: number;
  workspace: {
    eligibilityDigest: string;
    sourceSha: string;
    sourceTree: string;
    workspaceDigest: string;
  };
  uiPreview?: { appId: string; revision: string; sourceDigest: string };
  acceptedUIReference?: { appId: string; revision: string };
  appSpec?: ReturnType<typeof appSpecSummary>;
  dependencies?: { digest: string };
  identity?: { digest: string };
  proposal?: { digest: string };
  apply?: {
    digest: string;
    reason?: string;
    recoveryRequired?: boolean;
    status: string;
    changedContentDigest?: string;
  };
  validation?: { digest: string; reason?: string; recoveryRequired?: boolean; status: string };
  review?: { changeSetDigest: string; digest: string };
};

const publicationDetails = (state: WorkflowState): WorkflowDetails => {
  const details: WorkflowDetails = {};
  if (state.phase === "publication_pending") {
    details.publication = {
      callId: state.publicationCallId,
      proposalDigest: state.publicationProposal.digest,
      status: "pending",
    };
  } else if (state.phase === "publication_failed" || state.phase === "published_local") {
    details.publication = {
      digest: state.publicationReceipt.digest,
      recoveryRequired: state.publicationReceipt.recoveryRequired,
      status: state.publicationReceipt.status,
    };
  }
  if (state.phase === "branch_publication_pending") {
    details.branchPublication = {
      callId: state.branchPublicationCallId,
      proposalDigest: state.branchPublicationProposal.digest,
      status: "pending",
    };
  } else if (
    state.phase === "branch_publication_failed" ||
    state.phase === "published_branch_worktree"
  ) {
    details.branchPublication = {
      branchName: state.branchPublicationReceipt.branchName,
      digest: state.branchPublicationReceipt.digest,
      recoveryRequired: state.branchPublicationReceipt.recoveryRequired,
      status: state.branchPublicationReceipt.status,
      worktreePath: state.branchPublicationReceipt.worktreePath,
    };
  }
  if (state.phase === "fresh_bootstrap_pending") {
    details.freshBootstrap = {
      callId: state.freshBootstrapCallId,
      githubOutcome: "unavailable",
      proposalDigest: state.freshBootstrapProposal.digest,
      status: "pending",
    };
  } else if (
    state.phase === "fresh_bootstrap_failed" ||
    state.phase === "published_fresh_bootstrap"
  ) {
    details.freshBootstrap = {
      destinationPath: state.freshBootstrapReceipt.destinationPath,
      digest: state.freshBootstrapReceipt.digest,
      githubOutcome: "unavailable",
      proposalDigest: state.freshBootstrapReceipt.proposalDigest,
      recoveryRequired: state.freshBootstrapReceipt.recoveryRequired,
      status: state.freshBootstrapReceipt.status,
    };
  }
  return details;
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
    const workflowDetails = publicationDetails(state);
    const details = {
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
    };
    const result: WorkflowStatusDetails = { ...details };
    if ("uiPreview" in state) {
      result.uiPreview = {
        appId: state.uiPreview.appId,
        revision: state.uiPreview.revision,
        sourceDigest: state.uiPreview.sourceDigest,
      };
    }
    const acceptedReference = acceptedUIReference(state);
    if (acceptedReference) {
      result.acceptedUIReference = acceptedReference;
    }
    if ("appSpec" in state) {
      result.appSpec = appSpecSummary(state.appSpec);
    }
    if ("dependencyReceipt" in state) {
      result.dependencies = { digest: state.dependencyReceipt.digest };
    }
    if ("identityReceipt" in state) {
      result.identity = { digest: state.identityReceipt.digest };
    }
    if ("proposal" in state) {
      result.proposal = { digest: state.proposal.digest };
    }
    if ("applyFailure" in state) {
      result.apply = { digest: state.applyFailure.digest, status: state.applyFailure.status };
      if (state.applyFailure.reason !== undefined) {
        result.apply.reason = state.applyFailure.reason;
      }
      result.apply.recoveryRequired = true;
    } else if ("applyReceipt" in state) {
      result.apply = {
        digest: state.applyReceipt.digest,
        status: state.applyReceipt.status,
      };
      if (state.applyReceipt.changedContentDigest !== undefined) {
        result.apply.changedContentDigest = state.applyReceipt.changedContentDigest;
      }
    }
    if ("validationAttempt" in state) {
      result.validation = {
        digest: state.validationAttempt.digest,
        recoveryRequired: true,
        status: state.validationAttempt.status,
      };
    } else if ("validationFailure" in state) {
      result.validation = {
        digest: state.validationFailure.digest,
        reason: state.validationFailure.reason,
        recoveryRequired: true,
        status: state.validationFailure.status,
      };
    } else if ("validationReceipt" in state) {
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
    Object.assign(result, workflowDetails);
    return result;
  },
  inputSchema: z.object({}),
});
