import { defineTool } from "eve/tools";
import { z } from "zod";

import { prototypeArtifactReceipt } from "@/lib/agent/prototype-artifacts";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";

export default defineTool({
  description:
    "Return session-bound artifact workflow receipt metadata without artifact content or mutation.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (state.phase === "empty")
      return {
        version: state.version,
        phase: state.phase,
        sessionId: ctx.session.id,
      };
    if (state.artifacts.some(({ sessionId }) => sessionId !== ctx.session.id))
      throw new Error(
        "Prototype artifact state belongs to a different session.",
      );
    return {
      version: state.version,
      sessionId: ctx.session.id,
      phase: state.phase,
      artifacts: state.artifacts.map(prototypeArtifactReceipt),
      workspace: {
        sourceSha: state.workspace.sourceSha,
        eligibilityDigest: state.workspace.eligibilityDigest,
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
      state.phase === "validated"
        ? {
            appSpec: {
              path: state.appSpec.artifactPath,
              digest: state.appSpec.digest,
              artifactRevision: state.appSpec.artifactRevision,
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
      state.phase === "validated"
        ? { dependencies: { digest: state.dependencyReceipt.digest } }
        : {}),
      ...(state.phase === "identity_resolved" ||
      state.phase === "planned" ||
      state.phase === "apply_failed" ||
      state.phase === "applied" ||
      state.phase === "validation_pending" ||
      state.phase === "validation_failed" ||
      state.phase === "validated"
        ? { identity: { digest: state.identityReceipt.digest } }
        : {}),
      ...(state.phase === "planned" ||
      state.phase === "apply_failed" ||
      state.phase === "applied" ||
      state.phase === "validation_pending" ||
      state.phase === "validation_failed" ||
      state.phase === "validated"
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
      state.phase === "validated"
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
      ...(state.phase === "validated"
        ? {
            validation: {
              status: state.validationReceipt.status,
              digest: state.validationReceipt.digest,
            },
          }
        : {}),
    };
  },
});
