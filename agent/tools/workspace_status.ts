import { defineTool } from "eve/tools";
import { getSourceBoundSandbox } from "@/lib/agent/source-bound-sandbox";
import type { AcceptedAppSpec, AppBuilderWorkflowState } from "@/lib/agent/workflow-state";
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
  state: AppBuilderWorkflowState,
): state is
  | Extract<AppBuilderWorkflowState, { phase: `publication_${string}` }>
  | Extract<AppBuilderWorkflowState, { phase: "reviewed" | "published_local" }> =>
  state.phase.startsWith("publication_") ||
  state.phase === "reviewed" ||
  state.phase === "published_local";

const unplannedAppNextAction = (): string =>
  "No canonical implementation proposal exists yet. For an existing app, author complete replacement contents and pass them as existingAppChanges to accept_app_spec. Planning creates a proposal without applying app files; normal Build approval still precedes apply_app_creation.";

type AppliedOrLaterState =
  | Extract<AppBuilderWorkflowState, { phase: "applied" | "validated" }>
  | Extract<AppBuilderWorkflowState, { phase: "validation_pending" | "validation_failed" }>;

const isAppliedOrLaterPhase = (state: AppBuilderWorkflowState): state is AppliedOrLaterState =>
  ["applied", "validation_pending", "validation_failed", "validated"].includes(state.phase);

const appSpecReceipt = (appSpec: AcceptedAppSpec) => {
  const { acceptedByCallId, appId, approvalReceipt, artifactPath, artifactRevision, digest } =
    appSpec;
  const receipt = { acceptedByCallId, appId, artifactPath, artifactRevision, digest };
  if (approvalReceipt !== undefined) {
    Object.assign(receipt, { approvalReceipt });
  }
  return receipt;
};

const hasAppSpec = (
  state: Exclude<AppBuilderWorkflowState, { phase: "empty" }>,
): state is Extract<AppBuilderWorkflowState, { appSpec: unknown }> => "appSpec" in state;

interface StatusReceipt {
  artifacts: ReturnType<typeof prototypeArtifactReceipt>[];
  phase: AppBuilderWorkflowState["phase"];
  preparedByCallId: string;
  recovered: boolean;
  version: number;
  workspace: AppBuilderWorkflowState["workspace"];
  nextAction?: string;
  appSpec?: {
    acceptedByCallId: string;
    appId: string;
    artifactPath: string;
    artifactRevision: string;
    digest: string;
    approvalReceipt?: unknown;
  };
  dependencies?: { digest: string };
  identity?: { digest: string };
  proposal?: { digest: string };
  apply?: {
    digest: string;
    reason?: string;
    recoveryRequired?: true;
    status: string;
    changedContentDigest?: string;
  };
  validation?: { digest: string; reason?: string; recoveryRequired?: true; status: string };
  review?: { changeSetDigest: string; digest: string };
}

const addPreparationReceipt = (
  state: Exclude<AppBuilderWorkflowState, { phase: "empty" }>,
  receipt: StatusReceipt,
  appSpec: ReturnType<typeof appSpecReceipt> | undefined,
): boolean => {
  if (state.phase === "app_spec_accepted") {
    receipt.nextAction = unplannedAppNextAction();
    if (appSpec !== undefined) {
      receipt.appSpec = appSpec;
    }
    return true;
  }
  if (state.phase === "dependencies_prepared") {
    receipt.nextAction = unplannedAppNextAction();
    if (appSpec !== undefined) {
      receipt.appSpec = appSpec;
    }
    receipt.dependencies = { digest: state.dependencyReceipt.digest };
    return true;
  }
  if (state.phase === "identity_resolved") {
    receipt.nextAction = unplannedAppNextAction();
    if (appSpec !== undefined) {
      receipt.appSpec = appSpec;
    }
    receipt.dependencies = { digest: state.dependencyReceipt.digest };
    receipt.identity = { digest: state.identityReceipt.digest };
    return true;
  }
  return false;
};

const addLaterReceipt = (
  state: Exclude<AppBuilderWorkflowState, { phase: "empty" }>,
  receipt: StatusReceipt,
  appSpec: ReturnType<typeof appSpecReceipt> | undefined,
): void => {
  if (state.phase === "planned" || state.phase === "apply_failed") {
    if (appSpec !== undefined) {
      receipt.appSpec = appSpec;
    }
    receipt.dependencies = { digest: state.dependencyReceipt.digest };
    receipt.identity = { digest: state.identityReceipt.digest };
    receipt.proposal = { digest: state.proposal.digest };
    if (state.phase === "apply_failed") {
      receipt.apply = {
        digest: state.applyFailure.digest,
        recoveryRequired: true,
        status: state.applyFailure.status,
      };
      if (state.applyFailure.reason !== undefined) {
        receipt.apply.reason = state.applyFailure.reason;
      }
    }
    return;
  }
  if (!isAppliedOrLaterPhase(state) && !isReviewedPhase(state)) {
    return;
  }
  if (appSpec !== undefined) {
    receipt.appSpec = appSpec;
  }
  receipt.dependencies = { digest: state.dependencyReceipt.digest };
  receipt.identity = { digest: state.identityReceipt.digest };
  receipt.proposal = { digest: state.proposal.digest };
  receipt.apply = { digest: state.applyReceipt.digest, status: state.applyReceipt.status };
  if (state.applyReceipt.changedContentDigest !== undefined) {
    receipt.apply.changedContentDigest = state.applyReceipt.changedContentDigest;
  }
  if (state.phase === "validation_pending") {
    receipt.validation = {
      digest: state.validationAttempt.digest,
      recoveryRequired: true,
      status: state.validationAttempt.status,
    };
  } else if (state.phase === "validation_failed") {
    receipt.validation = {
      digest: state.validationFailure.digest,
      recoveryRequired: true,
      status: state.validationFailure.status,
    };
    if (state.validationFailure.reason !== undefined) {
      receipt.validation.reason = state.validationFailure.reason;
    }
  } else if (state.phase === "validated" || isReviewedPhase(state)) {
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
};

const statusReceipt = (
  state: Exclude<AppBuilderWorkflowState, { phase: "empty" }>,
  recovered: boolean,
) => {
  const receipt: StatusReceipt = {
    artifacts: state.artifacts.map(prototypeArtifactReceipt),
    phase: state.phase,
    preparedByCallId: state.preparedByCallId,
    recovered,
    version: state.version,
    workspace: state.workspace,
  };

  const appSpec = hasAppSpec(state) ? appSpecReceipt(state.appSpec) : undefined;
  addPreparationReceipt(state, receipt, appSpec);
  addLaterReceipt(state, receipt, appSpec);

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
    const workspaceInput: Parameters<typeof inspectSourceBoundSandboxWorkspace>[0] = {
      expectedWorkspace: durable.workspace,
      receipt: durable.sourceReceipt,
      sandbox,
    };
    if (durable.githubSource !== undefined) {
      workspaceInput.githubSource = durable.githubSource;
    }
    const observed = await inspectSourceBoundSandboxWorkspace(workspaceInput);
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
