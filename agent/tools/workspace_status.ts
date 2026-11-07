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

type NonEmptyWorkflowState = Exclude<
  ReturnType<typeof appBuilderWorkflowState.get>,
  { phase: "empty" }
>;
type AppSpecWorkflowState = Extract<NonEmptyWorkflowState, { appSpec: object }>;

interface WorkspaceStatusReceipt {
  artifacts: ReturnType<typeof prototypeArtifactReceipt>[];
  phase: NonEmptyWorkflowState["phase"];
  preparedByCallId: string;
  recovered: boolean;
  version: number;
  workspace: NonEmptyWorkflowState["workspace"];
  nextAction?: string;
  appSpec?: object;
  dependencies?: object;
  identity?: object;
  proposal?: object;
  apply?: object;
  validation?: object;
  review?: object;
}

const unplannedAppNextAction = (): string =>
  "No canonical implementation proposal exists yet. For an existing app, author complete replacement contents and pass them as existingAppChanges to accept_app_spec. Planning creates a proposal without applying app files; normal Build approval still precedes apply_app_creation.";

const statusReceipt = (state: NonEmptyWorkflowState, recovered: boolean) => {
  const receipt: WorkspaceStatusReceipt = {
    artifacts: state.artifacts.map(prototypeArtifactReceipt),
    phase: state.phase,
    preparedByCallId: state.preparedByCallId,
    recovered,
    version: state.version,
    workspace: state.workspace,
  };
  const includeAppSpec = (appSpec: AppSpecWorkflowState["appSpec"]) => {
    const summary = {
      acceptedByCallId: appSpec.acceptedByCallId,
      appId: appSpec.appId,
      artifactPath: appSpec.artifactPath,
      artifactRevision: appSpec.artifactRevision,
      digest: appSpec.digest,
    };
    receipt.appSpec =
      appSpec.approvalReceipt === undefined
        ? summary
        : { ...summary, approvalReceipt: appSpec.approvalReceipt };
  };

  switch (state.phase) {
    case "app_spec_accepted": {
      receipt.nextAction = unplannedAppNextAction();
      includeAppSpec(state.appSpec);
      break;
    }
    case "dependencies_prepared": {
      receipt.nextAction = unplannedAppNextAction();
      includeAppSpec(state.appSpec);
      receipt.dependencies = { digest: state.dependencyReceipt.digest };
      break;
    }
    case "identity_resolved": {
      receipt.nextAction = unplannedAppNextAction();
      includeAppSpec(state.appSpec);
      receipt.dependencies = { digest: state.dependencyReceipt.digest };
      receipt.identity = { digest: state.identityReceipt.digest };
      break;
    }
    case "planned": {
      includeAppSpec(state.appSpec);
      receipt.dependencies = { digest: state.dependencyReceipt.digest };
      receipt.identity = { digest: state.identityReceipt.digest };
      receipt.proposal = { digest: state.proposal.digest };
      break;
    }
    case "apply_failed": {
      includeAppSpec(state.appSpec);
      receipt.dependencies = { digest: state.dependencyReceipt.digest };
      receipt.identity = { digest: state.identityReceipt.digest };
      receipt.proposal = { digest: state.proposal.digest };
      receipt.apply = {
        digest: state.applyFailure.digest,
        reason: state.applyFailure.reason,
        recoveryRequired: true,
        status: state.applyFailure.status,
      };
      break;
    }
    case "applied": {
      includeAppSpec(state.appSpec);
      receipt.dependencies = { digest: state.dependencyReceipt.digest };
      receipt.identity = { digest: state.identityReceipt.digest };
      receipt.proposal = { digest: state.proposal.digest };
      receipt.apply = {
        changedContentDigest: state.applyReceipt.changedContentDigest,
        digest: state.applyReceipt.digest,
        status: state.applyReceipt.status,
      };
      break;
    }
    case "validation_pending": {
      includeAppSpec(state.appSpec);
      receipt.dependencies = { digest: state.dependencyReceipt.digest };
      receipt.identity = { digest: state.identityReceipt.digest };
      receipt.proposal = { digest: state.proposal.digest };
      receipt.apply = {
        changedContentDigest: state.applyReceipt.changedContentDigest,
        digest: state.applyReceipt.digest,
        status: state.applyReceipt.status,
      };
      receipt.validation = {
        digest: state.validationAttempt.digest,
        recoveryRequired: true,
        status: state.validationAttempt.status,
      };
      break;
    }
    case "validation_failed": {
      includeAppSpec(state.appSpec);
      receipt.dependencies = { digest: state.dependencyReceipt.digest };
      receipt.identity = { digest: state.identityReceipt.digest };
      receipt.proposal = { digest: state.proposal.digest };
      receipt.apply = {
        changedContentDigest: state.applyReceipt.changedContentDigest,
        digest: state.applyReceipt.digest,
        status: state.applyReceipt.status,
      };
      receipt.validation = {
        digest: state.validationFailure.digest,
        reason: state.validationFailure.reason,
        recoveryRequired: true,
        status: state.validationFailure.status,
      };
      break;
    }
    case "validated":
    case "reviewed":
    case "publication_pending":
    case "publication_failed":
    case "published_local": {
      includeAppSpec(state.appSpec);
      receipt.dependencies = { digest: state.dependencyReceipt.digest };
      receipt.identity = { digest: state.identityReceipt.digest };
      receipt.proposal = { digest: state.proposal.digest };
      receipt.apply = {
        changedContentDigest: state.applyReceipt.changedContentDigest,
        digest: state.applyReceipt.digest,
        status: state.applyReceipt.status,
      };
      receipt.validation = {
        digest: state.validationReceipt.digest,
        status: state.validationReceipt.status,
      };
      if (state.phase !== "validated") {
        receipt.review = {
          changeSetDigest: state.reviewReceipt.changeSetDigest,
          digest: state.reviewReceipt.digest,
        };
      }
      break;
    }
    case "branch_publication_failed":
    case "branch_publication_pending":
    case "fresh_bootstrap_failed":
    case "fresh_bootstrap_pending":
    case "prepared":
    case "published_branch_worktree":
    case "published_fresh_bootstrap":
    case "ui_accepted":
    case "ui_previewed": {
      break;
    }
    default: {
      break;
    }
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
    const sourceInspection = {
      expectedWorkspace: durable.workspace,
      receipt: durable.sourceReceipt,
      sandbox,
    };
    const inspection =
      durable.githubSource === undefined
        ? sourceInspection
        : { ...sourceInspection, githubSource: durable.githubSource };
    const observed = await inspectSourceBoundSandboxWorkspace(inspection);
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
