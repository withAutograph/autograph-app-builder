import { defineTool } from "eve/tools";
import { z } from "zod";

import { prototypeArtifactReceipt } from "@/lib/agent/prototype-artifacts";
import {
  appBuilderWorkflowState,
  workflowWorkspace,
} from "@/lib/agent/workflow-state";
import { inspectPreparedSandboxWorkspace } from "@/lib/repository/supported-template";
import { inspectSourceBoundSandboxWorkspace } from "@/lib/repository/arrusted-template";
import { canAutoSelectDevelopmentSource } from "@/lib/repository/development-source";

function isReviewedPhase(
  state: ReturnType<typeof appBuilderWorkflowState.get>,
): state is Extract<
  ReturnType<typeof appBuilderWorkflowState.get>,
  {
    phase:
      | "reviewed"
      | "publication_pending"
      | "publication_failed"
      | "published_local";
  }
> {
  return (
    state.phase === "reviewed" ||
    state.phase === "publication_pending" ||
    state.phase === "publication_failed" ||
    state.phase === "published_local"
  );
}

function statusReceipt(
  state: Exclude<
    ReturnType<typeof appBuilderWorkflowState.get>,
    { phase: "empty" }
  >,
  recovered: boolean,
) {
  return {
    version: state.version,
    phase: state.phase,
    recovered,
    preparedByCallId: state.preparedByCallId,
    workspace: state.workspace,
    artifacts: state.artifacts.map(prototypeArtifactReceipt),
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
            appId: state.appSpec.appId,
            artifactPath: state.appSpec.artifactPath,
            digest: state.appSpec.digest,
            artifactRevision: state.appSpec.artifactRevision,
            acceptedByCallId: state.appSpec.acceptedByCallId,
            ...(state.appSpec.approvalReceipt === undefined
              ? {}
              : { approvalReceipt: state.appSpec.approvalReceipt }),
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
            status: state.applyFailure.status,
            digest: state.applyFailure.digest,
            reason: state.applyFailure.reason,
            recoveryRequired: true,
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
            status: state.applyReceipt.status,
            digest: state.applyReceipt.digest,
            changedContentDigest: state.applyReceipt.changedContentDigest,
          },
        }
      : {}),
    ...(state.phase === "validation_pending"
      ? {
          validation: {
            status: state.validationAttempt.status,
            digest: state.validationAttempt.digest,
            recoveryRequired: true,
          },
        }
      : {}),
    ...(state.phase === "validation_failed"
      ? {
          validation: {
            status: state.validationFailure.status,
            digest: state.validationFailure.digest,
            reason: state.validationFailure.reason,
            recoveryRequired: true,
          },
        }
      : {}),
    ...(state.phase === "validated" || isReviewedPhase(state)
      ? {
          validation: {
            status: state.validationReceipt.status,
            digest: state.validationReceipt.digest,
          },
        }
      : {}),
    ...(isReviewedPhase(state)
      ? {
          review: {
            digest: state.reviewReceipt.digest,
            changeSetDigest: state.reviewReceipt.changeSetDigest,
          },
        }
      : {}),
  };
}

export default defineTool({
  description:
    "Report the durable App Builder workflow phase and verify any prepared repository workspace without mutating it.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const durable = appBuilderWorkflowState.get();
    const sandbox = await ctx.getSandbox();
    if (durable.phase === "empty") {
      const observed = await inspectPreparedSandboxWorkspace(sandbox);
      if (observed.state === "absent") return durable;
      throw new Error(
        "The sandbox workspace cannot be recovered without its original durable source receipt.",
      );
    }
    const observed = await inspectSourceBoundSandboxWorkspace({
      sandbox,
      receipt: durable.sourceReceipt,
      expectedWorkspace: durable.workspace,
      ...(durable.githubSource === undefined
        ? {}
        : { githubSource: durable.githubSource }),
    });
    if (
      !canAutoSelectDevelopmentSource() &&
      JSON.stringify(workflowWorkspace(durable)) !== JSON.stringify(observed)
    )
      throw new Error(
        "The durable workflow receipt does not match the sandbox workspace.",
      );
    return {
      ...statusReceipt(durable, false),
      workspace: observed,
    };
  },
});
