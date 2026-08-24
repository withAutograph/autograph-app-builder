import { defineTool } from "eve/tools";
import { z } from "zod";

import { prototypeArtifactReceipt } from "@/lib/agent/prototype-artifacts";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  workflowWorkspace,
} from "@/lib/agent/workflow-state";
import { inspectPreparedSandboxWorkspace } from "@/lib/repository/supported-template";

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
    state.phase === "reviewed"
      ? {
          appSpec: {
            appId: state.appSpec.appId,
            artifactPath: state.appSpec.artifactPath,
            digest: state.appSpec.digest,
            artifactRevision: state.appSpec.artifactRevision,
            acceptedByCallId: state.appSpec.acceptedByCallId,
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
    state.phase === "reviewed"
      ? { dependencies: { digest: state.dependencyReceipt.digest } }
      : {}),
    ...(state.phase === "identity_resolved" ||
    state.phase === "planned" ||
    state.phase === "apply_failed" ||
    state.phase === "applied" ||
    state.phase === "validation_pending" ||
    state.phase === "validation_failed" ||
    state.phase === "validated" ||
    state.phase === "reviewed"
      ? { identity: { digest: state.identityReceipt.digest } }
      : {}),
    ...(state.phase === "planned" ||
    state.phase === "apply_failed" ||
    state.phase === "applied" ||
    state.phase === "validation_pending" ||
    state.phase === "validation_failed" ||
    state.phase === "validated" ||
    state.phase === "reviewed"
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
    state.phase === "reviewed"
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
    ...(state.phase === "validated" || state.phase === "reviewed"
      ? {
          validation: {
            status: state.validationReceipt.status,
            digest: state.validationReceipt.digest,
          },
        }
      : {}),
    ...(state.phase === "reviewed"
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
    const observed = await inspectPreparedSandboxWorkspace(
      await ctx.getSandbox(),
    );
    if (durable.phase === "empty") {
      if (observed.state === "absent") return durable;
      const recovered = {
        version: APP_BUILDER_WORKFLOW_VERSION,
        phase: "prepared" as const,
        preparedByCallId: "recovered-from-sandbox",
        workspace: observed.workspace,
        artifacts: [],
      };
      appBuilderWorkflowState.update(() => recovered);
      return statusReceipt(recovered, true);
    }
    if (observed.state === "absent")
      throw new Error(
        "The durable workflow receipt exists but its sandbox workspace is missing.",
      );
    if (
      JSON.stringify(workflowWorkspace(durable)) !==
      JSON.stringify(observed.workspace)
    )
      throw new Error(
        "The durable workflow receipt does not match the sandbox workspace.",
      );
    return statusReceipt(durable, false);
  },
});
