import { defineTool } from "eve/tools";
import { z } from "zod";

import { prototypeArtifactReceipt } from "@/lib/agent/prototype-artifacts";
import {
  appBuilderWorkflowState,
  workflowWorkspace,
} from "@/lib/agent/workflow-state";
import { inspectSourceBoundSandboxWorkspace } from "@/lib/repository/arrusted-template";
import { canAutoSelectDevelopmentSource } from "@/lib/repository/development-source";
import { inspectPreparedSandboxWorkspace } from "@/lib/repository/supported-template";
import { hasTestCapability } from "@/lib/testing/test-capability";

function isReviewedPhase(
  state: ReturnType<typeof appBuilderWorkflowState.get>
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
  recovered: boolean
) {
  return {
    artifacts: state.artifacts.map(prototypeArtifactReceipt),
    phase: state.phase,
    preparedByCallId: state.preparedByCallId,
    recovered,
    version: state.version,
    workspace: state.workspace,
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
            acceptedByCallId: state.appSpec.acceptedByCallId,
            appId: state.appSpec.appId,
            artifactPath: state.appSpec.artifactPath,
            artifactRevision: state.appSpec.artifactRevision,
            digest: state.appSpec.digest,
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
  };
}

export default defineTool({
  description:
    "Report the durable App Builder workflow phase and verify any prepared repository workspace without mutating it.",
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
    const sandbox = await ctx.getSandbox();
    if (durable.phase === "empty") {
      const observed = await inspectPreparedSandboxWorkspace(sandbox);
      if (observed.state === "absent") return durable;
      throw new Error(
        "The sandbox workspace cannot be recovered without its original durable source receipt."
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
        "The durable workflow receipt does not match the sandbox workspace."
      );
    return {
      ...statusReceipt(durable, false),
      workspace: observed,
    };
  },
  inputSchema: z.object({}),
});
