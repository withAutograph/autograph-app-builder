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
  recordPlannedDirectProductionAuthoring,
  requestDirectProductionGrant,
  restoreDirectProductionRevisionPredecessor,
} from "../../lib/agent/direct-production-state";
import { assertApprovedPrivateApplySession } from "../../lib/agent/private-apply-authority";
import { appBuilderWorkflowState } from "../../lib/agent/workflow-state";
import { repositoryAccessRuntimeForSession } from "../../lib/agent/deployment-repository-access-runtime";
import { resolveRepositoryAccessForTool } from "../../lib/agent/repository-access-tool";
import { parseRepositoryReference } from "../../lib/integrations/repository-access";

const managedReleaseUnavailable = "managed-release-unavailable" as const;

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
    "For an explicit request to release a private Arrusted app to Production, read its directProduction subject. Use it before Build for a new app or an eligible revision to this session's already live app. Builder can approve presentation edits or a checked addition of one optional text field to the existing database. A revision reuses the saved repository, app, data, and access. A plan with an acquired Arrusted default branch already has its verified destination; repeating that same repository is allowed. For a new starter-backed plan, supply destination with the explicitly chosen Arrusted repository and resolve any normal GitHub connection or installation choice in the same session. For a new app, a read-only storageKind hint of postgres reflects an authored .config/app-specs/<app-id>.cue; none reflects removing an existing planned CUE. Pass the subject to apply_app_creation for a single Build and release approval. For an already approved private build, read the subject without arguments and pass it back here to present its Production release approval. This records the user decision and does not publish, provision or merge by itself.",
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
      if (repository.toLowerCase() !== ARRUSTED_PRODUCTION_REPOSITORY.toLowerCase()) {
        return { status: managedReleaseUnavailable };
      }
    }
    if (input.destination !== undefined && starterPlan !== undefined) {
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
    let subject = directProductionSubjectForPlan(ctx);
    if (subject === undefined && input.directProduction === undefined) {
      await restoreDirectProductionRevisionPredecessor(ctx);
      subject = directProductionSubjectForPlan(ctx);
    }
    const requestedInstallation = input.destination?.selectedInstallationId ?? undefined;
    if (
      requestedInstallation !== undefined &&
      subject !== undefined &&
      requestedInstallation !== subject.installationId
    ) {
      return {
        status: managedReleaseUnavailable,
        guidance:
          "The app's verified Arrusted installation differs from the selection. Read the release subject for the current plan without a destination to use its verified installation.",
      };
    }
    if (subject === undefined) {
      return starterPlan === undefined
        ? { status: managedReleaseUnavailable }
        : {
            status: "production-destination-required" as const,
            guidance:
              "Pass the creator’s selected Arrusted repository in destination to verify Production delivery for this same starter-backed app.",
          };
    }
    if (input.directProduction === undefined) {
      const planned = appBuilderWorkflowState.get().phase === "planned";
      const review =
        planned && subject.revision === undefined && input.storageKind !== undefined
          ? { ...subject, storageKind: input.storageKind }
          : subject;
      if (planned) {
        recordPlannedDirectProductionAuthoring(subject);
      }
      const result = {
        status: "review-production-release" as const,
        directProduction: review,
        description: describeDirectProductionSubject(review),
      };
      return planned
        ? {
            ...result,
            guidance:
              subject.revision === undefined
                ? "This is the scope of the current draft, before Build. Continue drafting the accepted app. If its implementation includes the app CUE, read this subject with storageKind postgres, then submit the subject and implementation together for the combined Build approval. A visual prototype is optional."
                : "Submit this subject with apply_app_creation and an empty implementationFiles list for the combined revision approval. The planned revision already contains its changes. After publication, follow read_github_pr_delivery to verify or prepare the existing setup, then finish-github-pr-delivery to deliver the reviewed revision.",
          }
        : result;
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
