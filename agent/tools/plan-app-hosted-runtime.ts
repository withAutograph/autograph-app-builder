import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { runnableSelectedApp } from "@/lib/agent/runnable-selected-app";
import { getBuilderSandboxId } from "@/lib/sandbox/builder-sandbox";
import { defineTool } from "eve/tools";
import { authorizeHostedNeonForTool } from "@/lib/agent/hosted-neon-authorization";
import { z } from "zod";
import { hostedOperatorClientForSession } from "@/lib/provisioning/hosted-operator-client";
import type { OperatorSelection } from "@/lib/provisioning/hosted-operator-contract";
import {
  HostedOperatorError,
  hostedOperatorAuthSignupPolicyInputSchema,
} from "@/lib/provisioning/hosted-operator-contract";
import { withAppPublicationGuidance } from "@/lib/provisioning/hosted-operator-published-app-delivery";
import { normalActorProgramSchema } from "@/lib/provisioning/hosted-operator-normal-actor-program";
import { reportContinuityPlanningFailure } from "@/lib/provisioning/hosted-operator-consent-diagnostic";
import type { ContinuityPlanningStage } from "@/lib/provisioning/hosted-operator-consent-diagnostic";

export default defineTool({
  description:
    "Read the protected operator's concrete Preview resource/access plan. To restore an existing deployment using an equivalent currently selected release, retained publication recovery and verified source association may precede validation or publication of a newer candidate; failure of a newer candidate does not block this restoration path. Use inspect_github_draft_pr_reconciliation with kind publication-recovery and copy its returned nextCall through normal approval and verification. For delivery of changed source, publish the technically validated and reviewed source through the existing separately approved draft publication/update path and verify appSourceRecording is recorded; recover unavailable recording through that same approved publication. For app_source_publication_required, first call inspect_github_draft_pr_reconciliation with kind publication-recovery to discover retained completion context for this accepted app even if the current candidate failed. Copy its exact nextCall to the normal reconciliation tool; listed receipt metadata grants no approval, and the tool still requires normal approval, exact provider verification and equivalent current-release matching. If no retained context is available, continue normal publication recovery in this same session without inventing a publication or republishing an already accepted result. Then plan again. Initial Auth/resource bootstrap may happen first. Hosted behavior remains unassessed until the delivered app is exercised. For signup, supply the product-approved organization, eligibility and initial app roles in authSignupPolicy; ordinary users are members, never owners. The policy is bound to the selected Auth resource, app and verified public origin and is persisted before signup is offered. Do not restrict ordinary signup to normalActorProgram test participants. For accepted product requirements needing named additional participants, derive normalActorProgram separately. After gateway_delivery_failed, plan again for the same app/session and accepted participant program to select the current trusted Gateway source; submit the returned plan and operation reference to prepare-app-hosted-runtime through its existing approval flow. An identical operation retains its durable approval; changed plans need ordinary approval. Unknown alias or hostname assignment outcomes require reconciliation. For a manual data export, use operation export with the explicitly requested customerId; the server freezes the currently prepared app resource and release plus private owner-only destination. Submit its exact request and returned plan to export-app-hosted-data for separate data-export approval. For the explicitly requested manual continuity exercise, operation continuity resolves the current owned app checkout and prepared runtime. Submit its exact plan/request to run-app-continuity-tests for separate approval. It runs one app-authored suite through an owned managed process, briefly publishes an isolated Gateway target, then closes that runtime and removes only its own configuration rows; it does not redeploy the native app or prove later native continuity. This planning call does not allocate resources or create accounts.",
  // oxlint-disable-next-line eslint/complexity, sonarjs/cognitive-complexity -- Best-effort continuity diagnostic guards preserve the existing operation and authorization branches.
  async execute(input, ctx) {
    const blocked = (code: HostedOperatorError["code"], selection?: OperatorSelection) =>
      withAppPublicationGuidance({
        appId: input.appId,
        authenticatedBehavior: "unassessed" as const,
        code,
        status: "blocked" as const,
        ...(selection === undefined ? {} : { approvedPreviewTarget: selection }),
      });
    let operator;
    try {
      operator = await hostedOperatorClientForSession(ctx.session.auth, ctx.session.id);
    } catch (error) {
      try {
        if (input.operation === "continuity") {
          reportContinuityPlanningFailure(ctx.session.id, "tool_client_resolution", error);
        }
      } catch {
        /* Diagnostic context lookup must preserve the original failure. */
      }
      return blocked(error instanceof HostedOperatorError ? error.code : "operator_unavailable");
    }
    const { operation } = input;
    if (operation === "prepare") {
      // Leave Eve's authorization control flow outside the ordinary blocked-result catch.
      const authorizationFailure = await authorizeHostedNeonForTool(ctx, operator);
      if (authorizationFailure !== null) {
        return blocked(authorizationFailure);
      }
    }
    let continuityStage: ContinuityPlanningStage = "tool_preview_target";
    try {
      const selection = await operator.resolvePreviewTarget(
        {
          action: "resolve-preview-target",
          appId: input.appId,
          sessionId: operator.sessionId ?? ctx.session.id,
        },
        ctx.abortSignal,
      );
      if (
        (input.projectId !== undefined && input.projectId !== selection.projectId) ||
        (input.branch !== undefined && input.branch !== selection.branch)
      ) {
        return blocked("resource_mismatch", selection);
      }
      if (operation === "continuity") {
        continuityStage = "tool_local_sandbox";
        const sandbox = await ctx.getSandbox();
        continuityStage = "tool_selected_app";
        const selected = await runnableSelectedApp({
          appId: input.appId,
          sandbox,
          state: appBuilderWorkflowState.get(),
        });
        continuityStage = "tool_sandbox_identity";
        const runtime = { sandboxId: getBuilderSandboxId(sandbox), root: selected.root };
        continuityStage = "tool_plan_request";
        return await operator.planContinuity(selection, runtime, ctx.callId, ctx.abortSignal);
      }
      if (operation === "export") {
        if (input.customerId === undefined) {
          return blocked("resource_mismatch", selection);
        }
        return await operator.planTenantExport(
          selection,
          input.customerId,
          ctx.callId,
          ctx.abortSignal,
        );
      }
      const result = await operator.request(
        {
          action: "plan",
          ...(input.authSignupPolicy === undefined
            ? {}
            : { authSignupPolicy: input.authSignupPolicy }),
          ...(input.normalActorProgram === undefined
            ? {}
            : { normalActorProgram: input.normalActorProgram }),
          operation,
          selection,
        },
        ctx.abortSignal,
      );
      return withAppPublicationGuidance(result);
    } catch (error) {
      try {
        if (operation === "continuity") {
          reportContinuityPlanningFailure(ctx.session.id, continuityStage, error);
        }
      } catch {
        /* Diagnostic context lookup must preserve the original failure. */
      }
      return blocked(error instanceof HostedOperatorError ? error.code : "operator_unavailable");
    }
  },
  inputSchema: z.strictObject({
    appId: z.string().min(1),
    authSignupPolicy: hostedOperatorAuthSignupPolicyInputSchema
      .extend({
        appPath: z
          .string()
          .regex(/^\/(?!\/)[^?#\\]*$/u)
          .default("/"),
      })
      .optional(),
    branch: z.string().min(1).optional(),
    environment: z.literal("preview"),
    operation: z.enum(["prepare", "cleanup", "export", "continuity"]),
    customerId: z.string().min(1).optional(),
    normalActorProgram: normalActorProgramSchema.optional(),
    projectId: z.string().min(1).optional(),
  }),
});
