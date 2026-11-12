import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  ARRUSTED_PRODUCTION_REPOSITORY,
  describeDirectProductionSubject,
  directProductionSubjectSchema,
} from "../../lib/agent/direct-production-authorization";
import {
  directProductionSubjectForPlan,
  freshTemplateProductionPlan,
  recordDirectProductionGrant,
  recordFreshTemplateProductionDestination,
  requestDirectProductionGrant,
} from "../../lib/agent/direct-production-state";
import { assertApprovedPrivateApplySession } from "../../lib/agent/private-apply-authority";
import { appBuilderWorkflowState } from "../../lib/agent/workflow-state";
import { repositoryAccessRuntimeForSession } from "../../lib/agent/deployment-repository-access-runtime";
import { resolveRepositoryAccessForTool } from "../../lib/agent/repository-access-tool";
import { parseRepositoryReference } from "../../lib/integrations/repository-access";

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
    "For an explicit request to release a private Arrusted app to Production, read its directProduction subject. For a starter-backed plan, supply destination with the explicitly chosen Arrusted repository and resolve any normal GitHub connection or installation choice in the same session. This keeps the existing starter source. For a new plan, a read-only storageKind hint of postgres reflects an authored .config/app-specs/<app-id>.cue; none reflects removing an existing planned CUE. Pass the subject to apply_app_creation with those implementation files for a single Build and release approval. For an already approved private build, read the subject without arguments and pass it back here to present its one Production release approval. This records the user decision and does not publish, provision or merge by itself.",
  inputSchema: z
    .strictObject({
      directProduction: directProductionSubjectSchema.optional(),
      destination: z
        .strictObject({
          repository: z.string().min(3).max(221),
          selectedInstallationId: z
            .string()
            .regex(/^[1-9][0-9]*$/u)
            .nullable()
            .optional(),
        })
        .optional(),
      storageKind: z.enum(["none", "postgres"]).optional(),
    })
    .refine(
      ({ destination, directProduction, storageKind }) =>
        directProduction === undefined || (destination === undefined && storageKind === undefined),
      "Select the destination and storage before requesting Production approval.",
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
  async execute(input, ctx) {
    const starterPlan = freshTemplateProductionPlan(ctx);
    if (input.destination !== undefined) {
      const repository = parseRepositoryReference(input.destination.repository).fullName;
      if (
        starterPlan === undefined ||
        repository.toLowerCase() !== ARRUSTED_PRODUCTION_REPOSITORY.toLowerCase()
      ) {
        return { status: "managed-release-unavailable" as const };
      }
      const access = await resolveRepositoryAccessForTool(
        {
          repository: ARRUSTED_PRODUCTION_REPOSITORY,
          selectedInstallationId: input.destination.selectedInstallationId ?? undefined,
        },
        ctx,
        await repositoryAccessRuntimeForSession(ctx.session.auth),
      );
      if (access.kind === "selection") {
        return access.access;
      }
      ctx.abortSignal?.throwIfAborted();
      recordFreshTemplateProductionDestination(ctx, starterPlan, access.receipt);
    }
    const subject = directProductionSubjectForPlan(ctx);
    if (subject === undefined) {
      return starterPlan === undefined
        ? { status: "managed-release-unavailable" as const }
        : {
            status: "production-destination-required" as const,
            guidance:
              "Pass the creator’s selected Arrusted repository in destination to verify Production delivery for this same starter-backed app.",
          };
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
