import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  describeDirectProductionSubject,
  directProductionSubjectSchema,
} from "../../lib/agent/direct-production-authorization";
import {
  directProductionSubjectForPlan,
  recordDirectProductionGrant,
  requestDirectProductionGrant,
} from "../../lib/agent/direct-production-state";
import { assertApprovedPrivateApplySession } from "../../lib/agent/private-apply-authority";
import { appBuilderWorkflowState } from "../../lib/agent/workflow-state";

const approvedPrivateBuild = (subject: z.infer<typeof directProductionSubjectSchema>) => {
  const state = appBuilderWorkflowState.get();
  if (state.phase !== "applied" && state.phase !== "validated" && state.phase !== "reviewed") {
    throw new Error("Build the app privately before requesting its Production release.");
  }
  assertApprovedPrivateApplySession({
    appId: subject.appId,
    appSpecDigest: subject.appSpecDigest,
    proposalDigest: subject.proposalDigest,
    sessionId: subject.sessionId,
    workspaceId: subject.buildWorkspaceId,
  });
};

export default defineTool({
  availableInSubagents: false,
  description:
    "For an explicit request to release a private Arrusted app to Production, read its directProduction subject. For a new plan, a read-only storageKind hint of postgres reflects an authored .config/app-specs/<app-id>.cue; none reflects removing an existing planned CUE. Pass the subject to apply_app_creation with those implementation files for a single Build and release approval. For an already approved private build, read the subject without arguments and pass it back here to present its one Production release approval. This records the user decision and does not publish, provision or merge by itself.",
  inputSchema: z
    .strictObject({
      directProduction: directProductionSubjectSchema.optional(),
      storageKind: z.enum(["none", "postgres"]).optional(),
    })
    .refine(
      ({ directProduction, storageKind }) =>
        directProduction === undefined || storageKind === undefined,
      "A storage hint is only for reading a planned release subject.",
    ),
  approval(ctx) {
    const subject = ctx.toolInput?.directProduction;
    if (subject === undefined) {
      return "not-applicable";
    }
    approvedPrivateBuild(subject);
    return requestDirectProductionGrant(ctx, {
      callId: ctx.callId,
      toolName: "release-app-production",
      subject,
    });
  },
  execute(input, ctx) {
    const subject = directProductionSubjectForPlan(ctx);
    if (subject === undefined) {
      return { status: "managed-release-unavailable" as const };
    }
    if (input.directProduction === undefined) {
      const storageKind =
        appBuilderWorkflowState.get().phase === "planned" ? input.storageKind : undefined;
      const review = storageKind === undefined ? subject : { ...subject, storageKind };
      return {
        status: "review-production-release" as const,
        directProduction: review,
        description: describeDirectProductionSubject(review),
      };
    }
    approvedPrivateBuild(subject);
    recordDirectProductionGrant(ctx, {
      callId: ctx.callId,
      toolName: "release-app-production",
      subject: input.directProduction,
    });
    return { status: "production-release-approved" as const };
  },
});
