import { defineTool } from "eve/tools";
import { getSourceBoundSandbox } from "@/lib/agent/source-bound-sandbox";
import { z } from "zod";

import { prototypeArtifactReceipt } from "@/lib/agent/prototype-artifacts";
import { appBuilderWorkflowState, workflowWorkspace } from "@/lib/agent/workflow-state";
import {
  inspectPreparedSandboxWorkspace,
  samePreparedWorkspaceSourceContext,
} from "@/lib/repository/supported-template";
import { SOURCE_RECEIPT_VERSION } from "@/lib/repository/source-receipt";
import { inspectSourceBoundSandboxWorkspace } from "@/lib/repository/arrusted-template";
import { canAutoSelectDevelopmentSource } from "@/lib/repository/development-source";
import { hasTestCapability } from "@/lib/testing/test-capability";

const isReviewedPhase = (
  state: ReturnType<typeof appBuilderWorkflowState.get>,
): state is Extract<
  ReturnType<typeof appBuilderWorkflowState.get>,
  {
    phase: "reviewed" | "publication_pending" | "publication_failed" | "published_local";
  }
> =>
  state.phase === "reviewed" ||
  state.phase === "publication_pending" ||
  state.phase === "publication_failed" ||
  state.phase === "published_local";

const unplannedAppNextAction = (): string =>
  "No canonical implementation proposal exists yet. For an existing app, author complete replacement contents and pass them as existingAppChanges to accept_app_spec. Planning creates a proposal without applying app files; normal Build approval still precedes apply_app_creation.";

type StatusState = Exclude<ReturnType<typeof appBuilderWorkflowState.get>, { phase: "empty" }>;
type PhaseState<P extends StatusState["phase"]> = Extract<StatusState, { phase: P }>;
type StateWithAppSpec = StatusState & Pick<PhaseState<"app_spec_accepted">, "appSpec">;
type StateWithDependencies = StateWithAppSpec &
  Pick<PhaseState<"dependencies_prepared">, "dependencyReceipt">;
type StateWithIdentity = StateWithDependencies &
  Pick<PhaseState<"identity_resolved">, "identityReceipt">;
type StateWithProposal = StateWithIdentity & Pick<PhaseState<"planned">, "proposal">;
type StateWithApply = StateWithProposal & Pick<PhaseState<"applied">, "applyReceipt">;

const hasValidationOrReview = (state: StatusState): state is StateWithApply =>
  state.phase === "validation_pending" ||
  state.phase === "validation_failed" ||
  state.phase === "validated" ||
  isReviewedPhase(state);

const hasAppliedOrLater = (state: StatusState): state is StateWithApply =>
  state.phase === "applied" || hasValidationOrReview(state);

const hasProposalOrLater = (state: StatusState): state is StateWithProposal =>
  state.phase === "planned" || state.phase === "apply_failed" || hasAppliedOrLater(state);

const hasIdentityOrLater = (state: StatusState): state is StateWithIdentity =>
  state.phase === "identity_resolved" || hasProposalOrLater(state);

const hasDependenciesOrLater = (state: StatusState): state is StateWithDependencies =>
  state.phase === "dependencies_prepared" || hasIdentityOrLater(state);

const hasAppSpecOrLater = (state: StatusState): state is StateWithAppSpec =>
  state.phase === "app_spec_accepted" || hasDependenciesOrLater(state);

interface StatusReceipt {
  artifacts: ReturnType<typeof prototypeArtifactReceipt>[];
  phase: StatusState["phase"];
  preparedByCallId: StatusState["preparedByCallId"];
  recovered: boolean;
  version: StatusState["version"];
  workspace: StatusState["workspace"];
  nextAction?: string;
  appSpec?: Pick<
    PhaseState<"app_spec_accepted">["appSpec"],
    | "acceptedByCallId"
    | "appId"
    | "artifactPath"
    | "artifactRevision"
    | "digest"
    | "approvalReceipt"
  >;
  dependencies?: Pick<PhaseState<"dependencies_prepared">["dependencyReceipt"], "digest">;
  identity?: Pick<PhaseState<"identity_resolved">["identityReceipt"], "digest">;
  proposal?: Pick<PhaseState<"planned">["proposal"], "digest">;
  apply?:
    | (Pick<PhaseState<"apply_failed">["applyFailure"], "digest" | "reason" | "status"> & {
        recoveryRequired: boolean;
      })
    | Pick<PhaseState<"applied">["applyReceipt"], "changedContentDigest" | "digest" | "status">;
  validation?:
    | (Pick<
        PhaseState<"validation_failed">["validationFailure"],
        "digest" | "reason" | "status"
      > & { recoveryRequired: boolean })
    | (Pick<PhaseState<"validation_pending">["validationAttempt"], "digest" | "status"> & {
        recoveryRequired: boolean;
      })
    | Pick<PhaseState<"validated">["validationReceipt"], "digest" | "status">;
  review?: Pick<PhaseState<"reviewed">["reviewReceipt"], "changeSetDigest" | "digest">;
}

const statusReceipt = (state: StatusState, recovered: boolean) => {
  const receipt: StatusReceipt = {
    artifacts: state.artifacts.map(prototypeArtifactReceipt),
    phase: state.phase,
    preparedByCallId: state.preparedByCallId,
    recovered,
    version: state.version,
    workspace: state.workspace,
  };
  if (
    state.phase === "app_spec_accepted" ||
    state.phase === "dependencies_prepared" ||
    state.phase === "identity_resolved"
  ) {
    receipt.nextAction = unplannedAppNextAction();
  }
  if (hasAppSpecOrLater(state)) {
    const appSpec: NonNullable<StatusReceipt["appSpec"]> = {
      acceptedByCallId: state.appSpec.acceptedByCallId,
      appId: state.appSpec.appId,
      artifactPath: state.appSpec.artifactPath,
      artifactRevision: state.appSpec.artifactRevision,
      digest: state.appSpec.digest,
    };
    if (state.appSpec.approvalReceipt !== undefined) {
      appSpec.approvalReceipt = state.appSpec.approvalReceipt;
    }
    receipt.appSpec = appSpec;
  }
  if (hasDependenciesOrLater(state)) {
    receipt.dependencies = { digest: state.dependencyReceipt.digest };
  }
  if (hasIdentityOrLater(state)) {
    receipt.identity = { digest: state.identityReceipt.digest };
  }
  if (hasProposalOrLater(state)) {
    receipt.proposal = { digest: state.proposal.digest };
  }
  if (state.phase === "apply_failed") {
    receipt.apply = {
      digest: state.applyFailure.digest,
      reason: state.applyFailure.reason,
      recoveryRequired: true,
      status: state.applyFailure.status,
    };
  }
  if (hasAppliedOrLater(state)) {
    receipt.apply = {
      changedContentDigest: state.applyReceipt.changedContentDigest,
      digest: state.applyReceipt.digest,
      status: state.applyReceipt.status,
    };
  }
  if (state.phase === "validation_pending") {
    receipt.validation = {
      digest: state.validationAttempt.digest,
      recoveryRequired: true,
      status: state.validationAttempt.status,
    };
  }
  if (state.phase === "validation_failed") {
    receipt.validation = {
      digest: state.validationFailure.digest,
      reason: state.validationFailure.reason,
      recoveryRequired: true,
      status: state.validationFailure.status,
    };
  }
  if (state.phase === "validated" || isReviewedPhase(state)) {
    receipt.validation = {
      digest: state.validationReceipt.digest,
      status: state.validationReceipt.status,
    };
  }
  if (isReviewedPhase(state)) {
    receipt.review = {
      changeSetDigest: state.reviewReceipt.changeSetDigest,
      digest: state.reviewReceipt.digest,
    };
  }
  return receipt;
};

export default defineTool({
  description:
    "Report the durable App Builder workflow phase and verify any prepared repository workspace without mutating it. When the accepted AppSpec has no canonical proposal yet, nextAction gives the normal planning step; it is advisory and grants no build approval.",
  async execute(_input, ctx) {
    const durable = appBuilderWorkflowState.get();
    if (hasTestCapability("simulated-target")) {
      return durable.phase === "empty"
        ? durable
        : {
            ...statusReceipt(durable, false),
            workspace: workflowWorkspace(durable),
          };
    }
    const sandbox = await getSourceBoundSandbox(ctx);
    if (durable.phase === "empty") {
      const observed = await inspectPreparedSandboxWorkspace(sandbox);
      if (observed.state === "absent") {
        return durable;
      }
      throw new Error(
        "The sandbox workspace cannot be recovered without its original durable source receipt.",
      );
    }
    const inspectionInput: Parameters<typeof inspectSourceBoundSandboxWorkspace>[0] = {
      expectedWorkspace: durable.workspace,
      receipt: durable.sourceReceipt,
      sandbox,
    };
    if (durable.githubSource !== undefined) {
      inspectionInput.githubSource = durable.githubSource;
    }
    const observed = await inspectSourceBoundSandboxWorkspace(inspectionInput);
    if (
      !canAutoSelectDevelopmentSource() &&
      durable.githubSource === undefined &&
      (durable.sourceReceipt.version === SOURCE_RECEIPT_VERSION
        ? JSON.stringify(workflowWorkspace(durable)) !== JSON.stringify(observed)
        : !samePreparedWorkspaceSourceContext(observed, durable.workspace))
    ) {
      throw new Error("The durable workflow receipt does not match the sandbox workspace.");
    }
    return {
      ...statusReceipt(durable, false),
      workspace: observed,
    };
  },
  inputSchema: z.object({}),
});
